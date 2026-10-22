import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { AgentCoordinator } from "./agent"
import { NoopAnalyticsReporter } from "./analytics"
import { AsyncQueue } from "./async-queue"
import { BriefingWorkflow, buildRoleInstructions, extractSection, type PythonRunner } from "./briefing-workflow"
import type { CodexRestriction, SandboxRunner } from "./briefing-sandbox"
import { createChatCommands } from "./chat-commands"
import { EventStore } from "./event-store"
import type { HarnessEvent, HarnessTurn } from "./harness-types"
import { BRIEFING_TOOLS } from "./nex-briefing-tools"
import { NEX_TOOL_NAMES, NEX_TOOLS, NexToolRuntime } from "./nex-tools"
import { ChatOrchestrator } from "./orchestrator"
import { timestamped } from "./transcript"

/**
 * The workflow against the real coordinator, store and orchestrator, with a
 * provider whose turns the test plays by hand (as in orchestrator.test.ts).
 * The Skill's Python scripts are replaced by `fakePython`, which keeps the
 * files the workflow reads; `briefing-workflow.skill.test.ts` runs the real
 * scripts. Nothing here calls a model: these tests show the workflow's rules
 * and handoffs, not what agents would do with them.
 */

interface FakeTurn { chatId: string; content: string; events: AsyncQueue<HarnessEvent>; open: boolean }

class FakeCodex {
  readonly turns: FakeTurn[] = []
  readonly sessions: Array<{ chatId: string; cwd: string; restriction?: CodexRestriction }> = []
  async startSession(args: { chatId: string; cwd: string; restriction?: CodexRestriction }) {
    this.sessions.push({ chatId: args.chatId, cwd: args.cwd, restriction: args.restriction })
  }
  stopSession() {}
  stopAll() {}
  getResourceCounts() { return {} }
  async startTurn(args: { chatId: string; content: string }): Promise<HarnessTurn> {
    const turn: FakeTurn = { chatId: args.chatId, content: args.content, events: new AsyncQueue(), open: true }
    this.turns.push(turn)
    const end = () => { turn.open = false; turn.events.finish() }
    return { provider: "codex", stream: turn.events, interrupt: async () => end(), close: end }
  }
  turnsFor(chatId: string) { return this.turns.filter((turn) => turn.chatId === chatId) }
  openTurn(chatId: string) { return [...this.turns].reverse().find((turn) => turn.chatId === chatId && turn.open) }
  finish(chatId: string, text = "done") {
    const turn = this.openTurn(chatId)
    if (!turn) throw new Error(`No open turn for ${chatId}`)
    turn.events.push({ type: "transcript", entry: timestamped({ kind: "assistant_text", text }) })
    turn.events.push({ type: "transcript", entry: timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "" }) })
    turn.open = false
    turn.events.finish()
  }
  /** A model request the provider reported, as Codex's token-count event reaches the transcript. */
  usage(chatId: string, tokens: { input: number; cached?: number; output: number }) {
    const turn = this.openTurn(chatId)!
    turn.events.push({ type: "transcript", entry: timestamped({ kind: "context_window_updated", usage: {
      usedTokens: tokens.input + tokens.output, lastInputTokens: tokens.input, lastCachedInputTokens: tokens.cached ?? 0,
      lastOutputTokens: tokens.output, lastReasoningOutputTokens: 0, compactsAutomatically: true,
    } }) })
  }

  fail(chatId: string, message: string) {
    const turn = this.openTurn(chatId)!
    turn.events.push({ type: "transcript", entry: timestamped({ kind: "result", subtype: "error", isError: true, durationMs: 0, result: message }) })
    turn.open = false
    turn.events.finish()
  }
}

async function until(condition: () => boolean, label = "condition") {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (condition()) return
    await Bun.sleep(5)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

/** The tool list a server with NEX_BRIEFING_WORKFLOW=1 offers. */
const NEX_TOOLS_WITH_BRIEFING = [...NEX_TOOLS, ...BRIEFING_TOOLS]

const ROLE_HEAD = (includes: string) => `---\nrole: x\nincludes: ${includes}\nreads: references/sources.md\n---\n`

async function writeFixtureSkill(projectDir: string, budgets: Record<string, unknown> = {}) {
  const skill = path.join(projectDir, ".agents", "skills", "us-china-ai-chip-briefing")
  await mkdir(path.join(skill, "references", "roles"), { recursive: true })
  await mkdir(path.join(skill, "scripts"), { recursive: true })
  await writeFile(path.join(skill, "SKILL.md"), "---\nname: us-china-ai-chip-briefing\ndescription: fixture\n---\n# Fixture\n\n## Ground rules\n\nGROUND-RULES-TEXT\n\n## Step 3. Select\n\nLINK-SIZE-NEW-TEXT\n\n## Step 5. Write\n\nTEMPLATE-WORKFLOW-TEXT\n")
  await writeFile(path.join(skill, "references", "sources.md"), "# Sources\n")
  await writeFile(path.join(skill, "references", "roles", "protocol.md"), "# Protocol\nPROTOCOL-TEXT\n")
  for (const [file, title] of [["chief-editor.md", "CHIEF-ROLE"], ["country-lead.md", "LEAD-ROLE"], ["topic-scout.md", "SCOUT-ROLE"], ["reviewer.md", "REVIEWER-ROLE"]]) {
    const includes = file === "reviewer.md" ? "SKILL.md#Step 3. Select" : "references/roles/protocol.md | SKILL.md#Ground rules | SKILL.md#Step 3. Select"
    await writeFile(path.join(skill, "references", "roles", file!), `${ROLE_HEAD(includes)}# ${title}\n`)
  }
  await writeFile(path.join(skill, "references", "roles", "categories.json"), JSON.stringify({ categories: [{ id: "export_controls_sanctions" }, { id: "ai_models_capabilities" }] }))
  await writeFile(path.join(skill, "references", "roles", "workflow.json"), JSON.stringify({ discovery: false, ...budgets }))
  for (const script of ["brief.py", "merge_runs.py", "check_handoff.py", "check_provenance.py", "discover.py"]) {
    await writeFile(path.join(skill, "scripts", script), "# replaced by fakePython in these tests\n")
  }
  return skill
}

/** Stands in for the Skill's scripts: same arguments, same files and JSON lines the workflow reads. */
function fakePython(calls: string[][]): PythonRunner {
  return async (args) => {
    calls.push(args)
    const script = path.basename(args[0]!)
    const ok = (value: unknown) => ({ exitCode: 0, stdout: `${JSON.stringify(value)}\n`, stderr: "" })
    if (script === "brief.py" && args[1] === "init") {
      const dir = args[2]!
      const end = args[args.indexOf("--end") + 1] ?? "2030-03-10"
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, "run_config.json"), JSON.stringify({
        report_date: end, window: { start: "2030-03-04", end }, timezone: "Asia/Hong_Kong", cutoff: "2030-03-10T18:00:00+08:00", language: "en",
      }))
      return { exitCode: 0, stdout: "initialised\n", stderr: "" }
    }
    if (script === "brief.py" && args[1] === "build") {
      const run = args[2]!
      if (existsSync(path.join(run, "fixture-not-ready"))) return { exitCode: 1, stdout: "Not ready to build:\nTODO 1 [4 analysis]: report.json: \"deck\" is empty\n", stderr: "" }
      await mkdir(path.join(run, "qa"), { recursive: true })
      await writeFile(path.join(run, "report.html"), "<html lang=\"en\">fixture</html>")
      const readiness = existsSync(path.join(run, "fixture-blocked")) ? "BLOCKED" : "READY_FOR_HUMAN_REVIEW"
      await writeFile(path.join(run, "qa", "review_report.json"), JSON.stringify({ readiness }))
      const fix = readiness === "BLOCKED" ? "FIX 1: GENERATION_REPORT_MISMATCH [generated_at] → generated_at is outside report_date\n" : ""
      return { exitCode: readiness === "BLOCKED" ? 1 : 2, stdout: `Wrote report\n${fix}`, stderr: "" }
    }
    if (script === "check_handoff.py") {
      const override = path.join(args[1]!, "fixture-handoff.json")
      if (existsSync(override)) return { exitCode: 1, stdout: await readFile(override, "utf8"), stderr: "" }
      return ok({ outcome: "PASS", findings: [{ status: "PASS", code: "HANDOFF_RECORDS", message: "ok" }], summary: { events: 1 } })
    }
    if (script === "merge_runs.py") {
      const target = args[1]!
      const from = args.filter((_, index) => args[index - 1] === "--from")
      await writeFile(path.join(target, "fixture-merged.txt"), `${from.join("\n")}\n`, { flag: "a" })
      return ok({ ok: true, results: from.map((spec) => ({ task: spec.split("=")[0], added: { events: ["E001"] } })) })
    }
    if (script === "check_provenance.py") {
      return ok({ outcome: existsSync(path.join(args[1]!, "fixture-provenance-fail")) ? "FAIL" : "PASS", findings: [] })
    }
    if (script === "discover.py") return { exitCode: 0, stdout: "swept\n", stderr: "" }
    return { exitCode: 2, stdout: "", stderr: `unexpected script ${script}` }
  }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

/** Answers the pre-run sandbox check as an enforcing host would. */
const ENFORCING_SANDBOX: SandboxRunner = async () => ({
  exitCode: 0,
  stdout: ["write own task directory=allowed", "write another task directory=denied", "read another task directory=denied",
    "write workflow state=denied", "read workflow state=denied", "read Codex credentials=denied"].join("\n"),
  stderr: "",
})

async function setup(options: {
  budgets?: Record<string, unknown>
  now?: () => number
  watchdogMs?: number
  sandboxRunner?: SandboxRunner
  usedPercent?: number | null
} = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "nex-briefing-data-"))
  const projectDir = await mkdtemp(path.join(tmpdir(), "nex-briefing-project-"))
  const home = await mkdtemp(path.join(tmpdir(), "nex-briefing-home-"))
  await writeFixtureSkill(projectDir, options.budgets)
  const store = new EventStore(dataDir)
  await store.initialize()
  const project = await store.openProject(projectDir)
  const codex = new FakeCodex()
  const agent = new AgentCoordinator({
    store,
    onStateChange: () => {},
    codexManager: codex as never,
    generateTitle: async () => ({ title: null, usedFallback: true, failureMessage: null }),
  })
  const orchestrator = new ChatOrchestrator({ store, agent, commands: createChatCommands({ store, agent, analytics: NoopAnalyticsReporter }), push: () => {} })
  const calls: string[][] = []
  const logs: string[] = []
  const workflow = new BriefingWorkflow({
    chats: orchestrator, python: fakePython(calls), settleGraceMs: 10, home, now: options.now, watchdogMs: options.watchdogMs,
    sandboxRunner: options.sandboxRunner ?? ENFORCING_SANDBOX, providerUsedPercent: () => options.usedPercent ?? null, log: (line) => logs.push(line),
  })
  agent.orchestration = orchestrator
  agent.briefing = workflow
  agent.onChatSettled = (chatId) => { orchestrator.handleChatSettled(chatId); workflow.handleChatSettled(chatId) }
  agent.onChatStopped = (chatId) => { orchestrator.handleChatStopped(chatId); workflow.handleChatSettled(chatId) }
  store.onTurnStarted = (chatId) => orchestrator.handleTurnStarted(chatId)
  cleanups.push(async () => {
    workflow.dispose()
    orchestrator.dispose()
    agent.dispose()
    for (const dir of [dataDir, projectDir, home]) await rm(dir, { recursive: true, force: true })
  })

  async function userChat() {
    const chat = await store.createChat(project.id)
    await agent.send({ type: "chat.send", chatId: chat.id, provider: "codex", content: "Run the multi-agent briefing" })
    await until(() => codex.turnsFor(chat.id).length === 1, "the user's turn")
    return chat.id
  }

  async function writeOutput(dir: string, value: Record<string, unknown>) {
    await writeFile(path.join(dir, "output.json"), JSON.stringify({ status: "complete", summary: "Synthetic summary.", ...value }))
  }

  /** Waits until the coordinator has stored `count` usage reports for a chat. */
  async function usageLanded(chatId: string, count: number) {
    await until(() => orchestrator.getUsageSince(chatId, 0).requests.length >= count, "usage in the transcript")
  }

  /** briefing_start, plan, and both leads delegated. Returns the chat and task handles. */
  async function startRun() {
    const root = await userChat()
    const started = await workflow.start(root, projectDir, { request: "Weekly briefing", end: "2030-03-10", discovery: false })
    const runDir = started.runDir
    const chief = started.chiefChatId
    await writeFile(path.join(runDir, "plan.json"), JSON.stringify({
      focus: "Synthetic focus",
      countries: { us: { brief: "US brief", categories: ["export_controls_sanctions"] }, cn: { brief: "CN brief", categories: ["ai_models_capabilities"] } },
    }))
    expect(await workflow.submit(chief, projectDir, { kind: "plan" })).toMatchObject({ accepted: true })
    const us = await workflow.delegate(chief, projectDir, { role: "lead", country: "us" })
    const cn = await workflow.delegate(chief, projectDir, { role: "lead", country: "cn" })
    return { root, chief, runDir, runId: started.runId, usLead: us.chatId!, cnLead: cn.chatId!, usDir: us.dir, cnDir: cn.dir }
  }

  /** A lead delegates one scout, the scout submits and ends, the lead waits and submits. */
  async function researchCountry(leadChat: string, leadDir: string, taskId: string) {
    const scout = await workflow.delegate(leadChat, projectDir, { role: "scout", topic: "Synthetic topic" })
    await writeOutput(scout.dir, { task_id: scout.taskId })
    expect(await workflow.submit(scout.chatId!, projectDir, {})).toMatchObject({ accepted: true })
    codex.finish(scout.chatId!, "Scout done.")
    const waited = await workflow.wait(leadChat, projectDir, {})
    await writeOutput(leadDir, { task_id: taskId })
    expect(await workflow.submit(leadChat, projectDir, {})).toMatchObject({ accepted: true })
    return { scout, waited }
  }

  return { store, project, projectDir, codex, orchestrator, workflow, calls, logs, userChat, startRun, researchCountry, writeOutput, usageLanded }
}

describe("briefing workflow", () => {
  test("is an opt-in mode: no chat sees the tools unless the server enables it", () => {
    expect(NEX_TOOL_NAMES).not.toContain("briefing_start")
    expect(BRIEFING_TOOLS.map((tool) => tool.name)).toEqual([
      "briefing_start", "briefing_delegate", "briefing_wait", "briefing_submit", "briefing_cross_border", "briefing_status",
    ])
    for (const tool of BRIEFING_TOOLS) expect(tool.description.length).toBeLessThanOrEqual(2048)
  })

  test("role instructions carry only the sections a role names", async () => {
    const { projectDir } = await setup()
    const skill = path.join(projectDir, ".agents", "skills", "us-china-ai-chip-briefing")
    const scout = await buildRoleInstructions(skill, "scout")
    expect(scout).toContain("SCOUT-ROLE")
    expect(scout).toContain("GROUND-RULES-TEXT")
    expect(scout).toContain("LINK-SIZE-NEW-TEXT")
    expect(scout).not.toContain("TEMPLATE-WORKFLOW-TEXT")
    expect(extractSection("# A\n\n## B\nb\n### C\nc\n## D\nd", "B")).toBe("## B\nb\n### C\nc")
  })

  test("chief → leads → scouts run as separate chats, three levels deep, and results return to the right parent", async () => {
    const { startRun, researchCountry, workflow, codex, store, projectDir, calls } = await setup()
    const run = await startRun()
    const chiefChat = store.getChat(run.chief)!
    expect(chiefChat).toMatchObject({ parentChatId: run.root, createdByChatId: run.root })
    expect(codex.turnsFor(run.chief)[0]!.content).toContain("CHIEF-ROLE")
    expect(store.getChat(run.usLead)).toMatchObject({ parentChatId: run.chief })
    expect(codex.turnsFor(run.usLead)[0]!.content).toContain("LEAD-ROLE")

    const us = await researchCountry(run.usLead, run.usDir, "us-lead")
    expect(store.getChat(us.scout.chatId!)).toMatchObject({ parentChatId: run.usLead })
    expect(codex.turnsFor(us.scout.chatId!)[0]!.content).toContain("SCOUT-ROLE")
    expect(codex.turnsFor(us.scout.chatId!)[0]!.content).not.toContain("TEMPLATE-WORKFLOW-TEXT")
    // The lead got the scout's accepted output, not just its last message, and its records were merged into the lead's run.
    expect(us.waited.tasks).toMatchObject([{ taskId: "us-s01", state: "accepted", output: { task_id: "us-s01", summary: "Synthetic summary." } }])
    expect(calls.some((args) => path.basename(args[0]!) === "merge_runs.py" && args[1] === run.usDir)).toBe(true)
    expect(await readFile(path.join(run.usDir, "fixture-merged.txt"), "utf8")).toContain("us-s01=")
    // Waiting claimed the result: it did not also arrive as a queued report.
    expect(store.getQueuedMessages(run.usLead).filter((message) => message.source?.kind === "report")).toHaveLength(0)

    await researchCountry(run.cnLead, run.cnDir, "cn-lead")
    codex.finish(run.usLead, "US research handed off.")
    codex.finish(run.cnLead, "China research handed off.")
    const leads = await workflow.wait(run.chief, projectDir, {})
    expect(leads.tasks.map((task) => [task.taskId, task.state])).toEqual([["us-lead", "accepted"], ["cn-lead", "accepted"]])
    const state = workflow.getRun(run.runId)!
    expect(state.history.map((entry) => entry.stage)).toEqual(expect.arrayContaining([
      "request_received", "research_plan_created", "country_tasks_assigned", "topic_research_running", "topic_research_completed", "cross_border_synthesis",
    ]))
    const saved = JSON.parse(await readFile(path.join(run.runDir, "workflow.json"), "utf8"))
    expect(saved.tasks.map((task: { id: string; chatId: string }) => task.id)).toEqual(["chief", "us-lead", "cn-lead", "us-s01", "cn-s01"])
    expect(new Set(saved.tasks.map((task: { chatId: string }) => task.chatId)).size).toBe(5)
    const log = await readFile(path.join(run.runDir, "workflow.log.jsonl"), "utf8")
    expect(log).toContain("\"task\":\"us-s01\"")
  })

  test("cross-border questions go to the other lead with their evidence and come back as a task", async () => {
    const { startRun, researchCountry, workflow, codex, projectDir, writeOutput } = await setup()
    const run = await startRun()
    await researchCountry(run.usLead, run.usDir, "us-lead")
    await researchCountry(run.cnLead, run.cnDir, "cn-lead")
    codex.finish(run.usLead)
    codex.finish(run.cnLead)
    await workflow.wait(run.chief, projectDir, {})
    await writeFile(path.join(run.usDir, "events.json"), JSON.stringify({ events: [{ id: "E001", title: "Synthetic US rule", proposed: true }] }))
    await expect(workflow.crossBorder(run.chief, projectDir, { fromTaskId: "us-lead", toCountry: "cn", question: "Q?", eventIds: ["E009"], scope: "s", evidenceRequired: "e" }))
      .rejects.toThrow("not found: E009")
    const request = await workflow.crossBorder(run.chief, projectDir, {
      fromTaskId: "us-lead", toCountry: "cn", question: "Which Chinese firms are named as affected?", eventIds: ["E001"], scope: "Named firms only", evidenceRequired: "Company or ministry statements",
    })
    expect(request).toMatchObject({ taskId: "xb-01", toTask: "cn-lead" })
    await until(() => codex.turnsFor(run.cnLead).length === 2, "the request reaching the China lead")
    expect(codex.turnsFor(run.cnLead)[1]!.content).toContain("Which Chinese firms are named as affected?")
    expect(codex.turnsFor(run.cnLead)[1]!.content).toContain("Synthetic US rule")
    const xbDir = path.join(run.cnDir, "xb-01")
    await writeOutput(xbDir, { task_id: "xb-01", answer: "None named in the window.", remaining_uncertainty: "Ministry statement pending." })
    expect(await workflow.submit(run.cnLead, projectDir, {})).toMatchObject({ accepted: true })
    codex.finish(run.cnLead)
    const reply = await workflow.wait(run.chief, projectDir, { taskIds: ["xb-01"] })
    expect(reply.tasks[0]).toMatchObject({ taskId: "xb-01", state: "accepted", output: { answer: "None named in the window." } })
  })

  test("draft → independent review → targeted rework → second review → ready for human review", async () => {
    const { startRun, researchCountry, workflow, codex, projectDir, store } = await setup()
    const run = await startRun()
    await researchCountry(run.usLead, run.usDir, "us-lead")
    await researchCountry(run.cnLead, run.cnDir, "cn-lead")
    codex.finish(run.usLead)
    codex.finish(run.cnLead)
    await workflow.wait(run.chief, projectDir, {})
    // The merged master records, as merge_runs.py leaves them: each claim knows its origin.
    await writeFile(path.join(run.runDir, "evidence_ledger.json"), JSON.stringify({ claims: [{ id: "C001", provenance: [{ task: "us-s01", id: "C001" }, { task: "us-lead", id: "C001" }] }] }))
    await writeFile(path.join(run.runDir, "events.json"), JSON.stringify({ events: [{ id: "E001", provenance: [{ task: "us-lead", id: "E001" }] }] }))
    await writeFile(path.join(run.runDir, "report.json"), "{}")
    const draft = await workflow.submit(run.chief, projectDir, { kind: "draft" })
    expect(draft).toMatchObject({ accepted: true, reviewTask: "review-1" })
    const reviewer = workflow.getRun(run.runId)!.tasks.find((task) => task.id === "review-1")!
    expect(store.getChat(reviewer.chatId!)).toMatchObject({ parentChatId: run.chief })
    expect(codex.turnsFor(reviewer.chatId!)[0]!.content).toContain("REVIEWER-ROLE")

    // The seeded problem: the claim says enacted where the source says proposed.
    const findings = {
      verdict: "rework", summary: "One legal-state error.",
      findings: [{ id: "R001", severity: "major", category: "fact_status", target: { claim_id: "C001" }, problem: "Claim says enacted; quote says proposed.", evidence: "sources/S001.txt" }],
    }
    await writeFile(path.join(run.runDir, reviewer.dir, "findings.json"), JSON.stringify({ ...findings, findings: [{ ...findings.findings[0], target: { claim_id: "C404" } }] }))
    expect(await workflow.submit(reviewer.chatId!, projectDir, {})).toMatchObject({ accepted: false, problems: ["R001: claim C404 is not in RUN/evidence_ledger.json"] })
    await writeFile(path.join(run.runDir, reviewer.dir, "findings.json"), JSON.stringify(findings))
    expect(await workflow.submit(reviewer.chatId!, projectDir, {})).toMatchObject({ accepted: true, verdict: "rework" })
    codex.finish(reviewer.chatId!)
    const review = await workflow.wait(run.chief, projectDir, { taskIds: ["review-1"] })
    expect(review.stage).toBe("rework")
    expect((review.tasks[0]!.output as { findings: Array<{ responsible: string[] }> }).findings[0]!.responsible).toEqual(["us-s01", "us-lead"])

    await workflow.delegate(run.chief, projectDir, { role: "lead", reworkOf: "us-lead", findings: ["R001"] })
    await until(() => codex.turnsFor(run.usLead).length === 2, "the rework message")
    expect(codex.turnsFor(run.usLead)[1]!.content).toContain("Claim says enacted; quote says proposed.")
    expect(await workflow.submit(run.usLead, projectDir, {})).toMatchObject({ accepted: true })
    codex.finish(run.usLead)
    await workflow.wait(run.chief, projectDir, { taskIds: ["us-lead"] })

    expect(await workflow.submit(run.chief, projectDir, { kind: "draft" })).toMatchObject({ accepted: true, reviewTask: "review-2" })
    const second = workflow.getRun(run.runId)!.tasks.find((task) => task.id === "review-2")!
    expect(second.chatId).not.toBe(reviewer.chatId)
    await writeFile(path.join(run.runDir, second.dir, "findings.json"), JSON.stringify({ verdict: "pass", summary: "Fixed.", findings: [] }))
    expect(await workflow.submit(second.chatId!, projectDir, {})).toMatchObject({ accepted: true })
    const final = workflow.getRun(run.runId)!
    expect(final.status).toBe("ready_for_human_review")
    expect(final.tasks.find((task) => task.id === "chief")!.state).toBe("accepted")
    const summary = await readFile(path.join(run.runDir, "qa", "workflow_summary.md"), "utf8")
    expect(summary).toContain("Human sign-off is still required")
    expect(summary).toContain("| us-s01 | scout (us) |")
  })

  test("rework is bounded: a review that still fails after the last round escalates", async () => {
    const { startRun, researchCountry, workflow, codex, projectDir } = await setup({ budgets: { max_rework_rounds: 0 } })
    const run = await startRun()
    await researchCountry(run.usLead, run.usDir, "us-lead")
    await researchCountry(run.cnLead, run.cnDir, "cn-lead")
    codex.finish(run.usLead)
    codex.finish(run.cnLead)
    await workflow.wait(run.chief, projectDir, {})
    await writeFile(path.join(run.runDir, "report.json"), "{}")
    await workflow.submit(run.chief, projectDir, { kind: "draft" })
    const reviewer = workflow.getRun(run.runId)!.tasks.find((task) => task.role === "reviewer")!
    await writeFile(path.join(run.runDir, reviewer.dir, "findings.json"), JSON.stringify({
      verdict: "rework", summary: "s", findings: [{ id: "R001", severity: "blocker", category: "omission", target: { section: "status table" }, problem: "p", evidence: "e" }],
    }))
    await workflow.submit(reviewer.chatId!, projectDir, {})
    const state = workflow.getRun(run.runId)!
    expect(state.status).toBe("escalated")
    expect(state.final!.unresolvedFindings).toHaveLength(1)
  })

  test("a refused handoff keeps the task open; a turn that ends without an accepted one is a failed task", async () => {
    const { startRun, workflow, codex, projectDir, writeOutput } = await setup()
    const run = await startRun()
    const scout = await workflow.delegate(run.usLead, projectDir, { role: "scout", topic: "t" })
    expect(await workflow.submit(scout.chatId!, projectDir, {})).toMatchObject({ accepted: false })
    await writeOutput(scout.dir, { task_id: scout.taskId, status: "partial" })
    expect((await workflow.submit(scout.chatId!, projectDir, {})).problems).toEqual(["output.json partial_reason: a partial result needs partial_reason"])
    await writeOutput(scout.dir, { task_id: scout.taskId })
    await writeFile(path.join(scout.dir, "fixture-handoff.json"), JSON.stringify({ outcome: "FAIL", findings: [{ status: "FAIL", code: "QUOTE_NOT_FOUND", message: "C001: quote not found" }] }))
    expect(await workflow.submit(scout.chatId!, projectDir, {})).toMatchObject({ accepted: false, problems: ["QUOTE_NOT_FOUND: C001: quote not found"] })
    codex.finish(scout.chatId!, "I think I am done.")
    const waited = await workflow.wait(run.usLead, projectDir, {})
    expect(waited.tasks[0]).toMatchObject({ taskId: "us-s01", state: "failed" })
    expect(waited.tasks[0]!.failure).toContain("refused submission")

    // The lead cannot hand off without naming the failed scout as a gap.
    await writeOutput(run.usDir, { task_id: "us-lead" })
    expect((await workflow.submit(run.usLead, projectDir, {})).problems).toEqual([expect.stringContaining("gaps must list us-s01")])
    await writeOutput(run.usDir, { task_id: "us-lead", gaps: [{ task_id: "us-s01", reason: "quote could not be located" }] })
    expect(await workflow.submit(run.usLead, projectDir, {})).toMatchObject({ accepted: true })
  })

  test("a failed sub-task can be retried once, and only once", async () => {
    const { startRun, workflow, codex, projectDir, writeOutput } = await setup()
    const run = await startRun()
    const scout = await workflow.delegate(run.usLead, projectDir, { role: "scout", topic: "t" })
    codex.fail(scout.chatId!, "provider error")
    const waited = await workflow.wait(run.usLead, projectDir, {})
    expect(waited.tasks[0]).toMatchObject({ state: "failed", failure: expect.stringContaining("provider error") })
    const retry = await workflow.delegate(run.usLead, projectDir, { role: "scout", retryOf: "us-s01" })
    expect(retry.taskId).toBe("us-s01-a2")
    await expect(workflow.delegate(run.usLead, projectDir, { role: "scout", retryOf: "us-s01" })).rejects.toThrow("already been retried")
    codex.finish(retry.chatId!, "gave up")
    expect((await workflow.wait(run.usLead, projectDir, {})).tasks[0]).toMatchObject({ taskId: "us-s01-a2", state: "failed" })
    await expect(workflow.delegate(run.usLead, projectDir, { role: "scout", retryOf: "us-s01-a2" })).rejects.toThrow("used its 2 attempts")
    await writeOutput(run.usDir, { task_id: "us-lead", gaps: [{ task_id: "us-s01-a2", reason: "two attempts failed" }] })
    expect((await workflow.submit(run.usLead, projectDir, {})).problems).toEqual([expect.stringContaining("gaps must list us-s01 ")])
    await writeOutput(run.usDir, { task_id: "us-lead", gaps: [{ task_id: "us-s01", reason: "failed" }, { task_id: "us-s01-a2", reason: "two attempts failed" }] })
    expect(await workflow.submit(run.usLead, projectDir, {})).toMatchObject({ accepted: true })
  })

  test("scouts beyond the concurrency budget queue and start as slots free; the per-lead budget is enforced", async () => {
    const { startRun, workflow, codex, projectDir, writeOutput } = await setup({ budgets: { max_concurrent_scouts: 1, max_scouts_per_lead: 2 } })
    const run = await startRun()
    const first = await workflow.delegate(run.usLead, projectDir, { role: "scout", topic: "one" })
    const second = await workflow.delegate(run.usLead, projectDir, { role: "scout", topic: "two" })
    expect(first.state).toBe("running")
    expect(second).toMatchObject({ state: "queued", chatId: null })
    await expect(workflow.delegate(run.usLead, projectDir, { role: "scout", topic: "three" })).rejects.toThrow("budget of 2 scouts")
    const third = await workflow.delegate(run.cnLead, projectDir, { role: "scout", topic: "cn one" })
    expect(third.state).toBe("queued")
    await writeOutput(first.dir, { task_id: first.taskId })
    await workflow.submit(first.chatId!, projectDir, {})
    codex.finish(first.chatId!)
    const waiting = workflow.wait(run.usLead, projectDir, {})
    await until(() => Boolean(workflow.getRun(run.runId)!.tasks.find((task) => task.id === "us-s02")!.chatId), "the queued scout to start")
    expect(workflow.getRun(run.runId)!.tasks.find((task) => task.id === "cn-s01")!.state).toBe("queued")
    const s2 = workflow.getRun(run.runId)!.tasks.find((task) => task.id === "us-s02")!
    await writeOutput(path.join(run.runDir, s2.dir), { task_id: "us-s02" })
    await workflow.submit(s2.chatId!, projectDir, {})
    codex.finish(s2.chatId!)
    expect((await waiting).tasks.map((task) => task.state)).toEqual(["accepted", "accepted"])
    await until(() => workflow.getRun(run.runId)!.tasks.find((task) => task.id === "cn-s01")!.state === "running", "the China scout to start")
  })

  test("roles and depth are enforced", async () => {
    const { startRun, workflow, projectDir, orchestrator } = await setup()
    const run = await startRun()
    const scout = await workflow.delegate(run.usLead, projectDir, { role: "scout", topic: "t" })
    await expect(workflow.delegate(scout.chatId!, projectDir, { role: "scout", topic: "deeper" })).rejects.toThrow("Only a country lead delegates scouts")
    await expect(workflow.delegate(run.usLead, projectDir, { role: "lead", country: "cn" })).rejects.toThrow("Only the Chief Editor delegates country leads")
    await expect(workflow.delegate(run.chief, projectDir, { role: "lead", country: "us" })).rejects.toThrow("already us-lead")
    // A scout sits at Nex's depth limit, so even the general chat tool refuses to go deeper.
    await expect(orchestrator.createChat(scout.chatId!, { message: "go deeper" })).rejects.toThrow("nest 3 deep")
    await expect(workflow.start(run.chief, projectDir, { request: "again" })).rejects.toThrow("already an agent")
    await expect(workflow.submit(run.root, projectDir, {})).rejects.toThrow("no task in a briefing run")
  })

  test("a draft needs both countries, or an explicit partial status that keeps the run from being marked ready", async () => {
    const { startRun, researchCountry, workflow, codex, projectDir } = await setup()
    const run = await startRun()
    await researchCountry(run.usLead, run.usDir, "us-lead")
    codex.finish(run.usLead)
    codex.fail(run.cnLead, "China lead crashed")
    await workflow.wait(run.chief, projectDir, {})
    await writeFile(path.join(run.runDir, "report.json"), "{}")
    expect((await workflow.submit(run.chief, projectDir, { kind: "draft" })).problems).toEqual([expect.stringContaining("No accepted China lead research")])
    expect(await workflow.submit(run.chief, projectDir, { kind: "draft", partialReason: "China lead failed twice" })).toMatchObject({ accepted: true })
    const reviewer = workflow.getRun(run.runId)!.tasks.find((task) => task.role === "reviewer")!
    await writeFile(path.join(run.runDir, reviewer.dir, "findings.json"), JSON.stringify({ verdict: "pass", summary: "s", findings: [] }))
    await workflow.submit(reviewer.chatId!, projectDir, {})
    expect(workflow.getRun(run.runId)!.status).toBe("incomplete")
  })

  test("validator and provenance failures refuse the draft; a draft changed after review is not marked ready", async () => {
    const { startRun, researchCountry, workflow, codex, projectDir, logs } = await setup()
    const run = await startRun()
    await researchCountry(run.usLead, run.usDir, "us-lead")
    await researchCountry(run.cnLead, run.cnDir, "cn-lead")
    codex.finish(run.usLead)
    codex.finish(run.cnLead)
    await workflow.wait(run.chief, projectDir, {})
    await writeFile(path.join(run.runDir, "report.json"), "{}")
    await writeFile(path.join(run.runDir, "fixture-not-ready"), "")
    expect((await workflow.submit(run.chief, projectDir, { kind: "draft" })).problems).toEqual([expect.stringContaining("\"deck\" is empty")])
    await rm(path.join(run.runDir, "fixture-not-ready"))
    await writeFile(path.join(run.runDir, "fixture-blocked"), "")
    expect((await workflow.submit(run.chief, projectDir, { kind: "draft" })).problems).toEqual(expect.arrayContaining([expect.stringContaining("validator blocked")]))
    expect(logs.some((line) => line.includes("submission=refused") && line.includes('codes=["GENERATION_REPORT_MISMATCH"]'))).toBe(true)
    await rm(path.join(run.runDir, "fixture-blocked"))
    await writeFile(path.join(run.runDir, "fixture-provenance-fail"), "")
    expect(await workflow.submit(run.chief, projectDir, { kind: "draft" })).toMatchObject({ accepted: false })
    await rm(path.join(run.runDir, "fixture-provenance-fail"))
    expect(await workflow.submit(run.chief, projectDir, { kind: "draft" })).toMatchObject({ accepted: true })
    await writeFile(path.join(run.runDir, "report.json"), "{\"edited\": true}")
    const reviewer = workflow.getRun(run.runId)!.tasks.find((task) => task.role === "reviewer")!
    await writeFile(path.join(run.runDir, reviewer.dir, "findings.json"), JSON.stringify({ verdict: "pass", summary: "s", findings: [] }))
    await workflow.submit(reviewer.chatId!, projectDir, {})
    expect(workflow.getRun(run.runId)!.final).toMatchObject({ status: "blocked", reasons: expect.arrayContaining([expect.stringContaining("report.json")]) })
  })

  test("stopping the chief stops its agents; their tasks and the run are cancelled, not counted as done", async () => {
    const { startRun, workflow, projectDir, orchestrator } = await setup({ budgets: { max_concurrent_scouts: 1 } })
    const run = await startRun()
    await workflow.delegate(run.usLead, projectDir, { role: "scout", topic: "one" })
    await workflow.delegate(run.usLead, projectDir, { role: "scout", topic: "two" })
    await orchestrator.cancelChat(run.root, run.chief)
    await until(() => workflow.getRun(run.runId)!.status === "cancelled", "the run to be cancelled")
    const states = Object.fromEntries(workflow.getRun(run.runId)!.tasks.map((task) => [task.id, task.state]))
    expect(states).toEqual({ "chief": "cancelled", "us-lead": "cancelled", "cn-lead": "cancelled", "us-s01": "cancelled", "us-s02": "cancelled" })
  })

  test("a task past its time budget is stopped and recorded as timed out", async () => {
    let clock = Date.parse("2030-03-10T00:00:00Z")
    const { startRun, workflow, projectDir } = await setup({ now: () => clock, budgets: { task_minutes: { scout: 1 } } })
    const run = await startRun()
    const scout = await workflow.delegate(run.usLead, projectDir, { role: "scout", topic: "slow" })
    clock += 2 * 60_000
    const waited = await workflow.wait(run.usLead, projectDir, {})
    expect(waited.tasks[0]).toMatchObject({ taskId: scout.taskId, state: "failed", failure: "timed out after 1 minutes" })
  })

  test("a task whose agent hangs is timed out even when no agent calls a tool", async () => {
    let clock = Date.parse("2030-03-10T00:00:00Z")
    const { startRun, workflow, projectDir } = await setup({ now: () => clock, budgets: { task_minutes: { scout: 1 } }, watchdogMs: 20 })
    const run = await startRun()
    const scout = await workflow.delegate(run.usLead, projectDir, { role: "scout", topic: "hangs" })
    // As in the live run: the scout's provider request never returns and every other agent is idle or blocked.
    clock += 2 * 60_000
    await until(() => workflow.getRun(run.runId)!.tasks.find((task) => task.id === scout.taskId)!.state === "failed", "the watchdog to time it out")
    expect(workflow.getRun(run.runId)!.tasks.find((task) => task.id === scout.taskId)!.failure).toBe("timed out after 1 minutes")
  })

  test("agents run under their role's profile in their own directory; the user's chat does not", async () => {
    const { startRun, workflow, codex, projectDir } = await setup()
    const run = await startRun()
    const scout = await workflow.delegate(run.usLead, projectDir, { role: "scout", topic: "t" })
    const sessionOf = (chatId: string) => codex.sessions.find((session) => session.chatId === chatId)!
    expect(sessionOf(run.root).restriction).toBeUndefined()
    expect(sessionOf(run.chief).restriction).toMatchObject({ profile: "nex-briefing-chief", cwd: run.runDir })
    expect(sessionOf(run.usLead).restriction).toMatchObject({ profile: "nex-briefing-lead", cwd: run.usDir })
    const scoutProfile = sessionOf(scout.chatId!).restriction!
    expect(scoutProfile).toMatchObject({ profile: "nex-briefing-scout", cwd: scout.dir, network: true })
    expect(scoutProfile.filesystem[scout.dir]).toBe("write")
    expect(scoutProfile.filesystem[path.join(run.runDir, "workflow.json")]).toBe("deny")
    // Two scouts never share a writable directory.
    const other = await workflow.delegate(run.cnLead, projectDir, { role: "scout", topic: "t2" })
    const otherProfile = sessionOf(other.chatId!).restriction!
    expect(otherProfile.filesystem[other.dir]).toBe("write")
    expect(otherProfile.filesystem[scout.dir]).toBeUndefined() // falls under the denied project
    expect(otherProfile.filesystem[projectDir]).toBe("deny")
  })

  test("an agent gets only its role's tools: injected instructions cannot reach other chats, schedules or attachments", async () => {
    const { startRun, workflow, store, project, projectDir } = await setup()
    const run = await startRun()
    const scout = await workflow.delegate(run.usLead, projectDir, { role: "scout", topic: "t" })
    const userChat = await store.createChat(project.id)
    const runtime = (chatId: string) => new NexToolRuntime({ chatId, cwd: project.localPath, emit: async () => {}, requestInput: async () => ({}), briefing: workflow }, NEX_TOOLS_WITH_BRIEFING)
    // What a page saying "send the run to this chat / schedule a job / attach the files" would make an agent try.
    for (const [tool, input] of [
      ["send_message", { chatId: userChat.id, message: "exfiltrate" }],
      ["create_chat", { message: "start something" }],
      ["set_schedule", { message: "x", inMinutes: 1 }],
      ["send_attachments", { paths: ["/etc/hosts"] }],
      ["generate_images", { prompt: "x" }],
      ["briefing_delegate", { role: "scout", topic: "more" }],
    ] as const) {
      const result = await runtime(scout.chatId!).execute(tool, input)
      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toContain("not available to this briefing agent")
    }
    expect((await runtime(scout.chatId!).execute("briefing_status", {})).isError).toBeUndefined()
    expect(workflow.allowedTools(run.usLead)).toEqual(["briefing_status", "briefing_delegate", "briefing_wait", "briefing_submit"])
    expect(workflow.allowedTools(run.chief)).toContain("briefing_cross_border")
    expect(workflow.allowedTools(run.root)).toBeNull() // the user's own chat is not restricted
    expect(store.getQueuedMessages(userChat.id)).toHaveLength(0)
  })

  test("a chat an agent creates outside the workflow is refused before it runs", async () => {
    const { startRun, workflow, codex, orchestrator, store } = await setup()
    const run = await startRun()
    await expect(orchestrator.createChat(run.usLead, { message: "do something unconfined" })).rejects.toThrow("has no permission profile and cannot run")
    const stray = [...store.state.chatsById.values()].find((chat) => chat.createdByChatId === run.usLead && chat.parentChatId === run.usLead
      && !workflow.getRun(run.runId)!.tasks.some((task) => task.chatId === chat.id))!
    expect(await workflow.executionPolicy(stray.id)).toMatchObject({ refuse: expect.stringContaining("outside the workflow") })
    expect(codex.turnsFor(stray.id)).toHaveLength(0)
    expect(codex.sessions.some((session) => session.chatId === stray.id)).toBe(false)
    expect(workflow.allowedTools(stray.id)).toEqual([])
  })

  test("a host that does not enforce the profile never starts a run", async () => {
    const leaky: SandboxRunner = async () => ({ exitCode: 0, stdout: "write own task directory=allowed\nwrite another task directory=allowed", stderr: "" })
    const { userChat, workflow, projectDir, codex } = await setup({ sandboxRunner: leaky })
    const root = await userChat()
    await expect(workflow.start(root, projectDir, { request: "x", end: "2030-03-10", discovery: false })).rejects.toThrow("sandbox is not enforced")
    expect(codex.sessions.filter((session) => session.restriction)).toHaveLength(0)
    const missing: SandboxRunner = async () => ({ exitCode: 127, stdout: "", stderr: "spawn codex ENOENT" })
    const second = await setup({ sandboxRunner: missing })
    await expect(second.workflow.start(await second.userChat(), second.projectDir, { request: "x", end: "2030-03-10", discovery: false })).rejects.toThrow("codex sandbox could not run")
  })

  test("a request stopped while the run is being prepared starts no agent", async () => {
    const stop = new AbortController()
    // The user stops the chat while the pre-run check is running.
    const stoppingCheck: SandboxRunner = async (...args) => {
      stop.abort()
      return ENFORCING_SANDBOX(...args)
    }
    const { userChat, workflow, projectDir, codex } = await setup({ sandboxRunner: stoppingCheck })
    const root = await userChat()
    await expect(workflow.start(root, projectDir, { request: "x", end: "2030-03-10", discovery: false }, stop.signal))
      .rejects.toThrow("Cancelled before any agent started")
    expect(codex.sessions.filter((session) => session.restriction)).toHaveLength(0)
    expect(await workflow.status(root, projectDir, {})).toMatchObject({ status: "cancelled", tasks: [] })
  })

  test("cross-border replies are written inside the answering lead's own directory", async () => {
    const { startRun, researchCountry, workflow, codex, projectDir } = await setup()
    const run = await startRun()
    await researchCountry(run.usLead, run.usDir, "us-lead")
    await researchCountry(run.cnLead, run.cnDir, "cn-lead")
    codex.finish(run.usLead)
    codex.finish(run.cnLead)
    await workflow.wait(run.chief, projectDir, {})
    await writeFile(path.join(run.usDir, "events.json"), JSON.stringify({ events: [{ id: "E001", title: "Synthetic rule" }] }))
    await workflow.crossBorder(run.chief, projectDir, { fromTaskId: "us-lead", toCountry: "cn", question: "q", eventIds: ["E001"], scope: "s", evidenceRequired: "e" })
    const xb = workflow.getRun(run.runId)!.tasks.find((task) => task.id === "xb-01")!
    expect(path.join(run.runDir, xb.dir)).toBe(path.join(run.cnDir, "xb-01"))
  })

  test("provider refusals are classified; a 403 halts new work and a chief lost to it ends the run as provider_unavailable", async () => {
    const { startRun, workflow, codex, projectDir } = await setup({ usedPercent: 79 })
    const run = await startRun()
    const scout = await workflow.delegate(run.usLead, projectDir, { role: "scout", topic: "t" })
    codex.fail(scout.chatId!, "unexpected status 403 Forbidden: <html><body>blocked</body></html>")
    const waited = await workflow.wait(run.usLead, projectDir, {})
    expect(waited.tasks[0]).toMatchObject({ state: "failed", failure: expect.stringContaining("provider error (forbidden, HTTP 403)") })
    expect(workflow.getRun(run.runId)!.provider).toMatchObject({ state: "halted", lastError: { class: "forbidden", status: 403, task: "us-s01" } })
    // Retrying into the same refusal is pointless: nothing new starts.
    await expect(workflow.delegate(run.usLead, projectDir, { role: "scout", retryOf: "us-s01" })).rejects.toThrow("provider refused this run")
    codex.fail(run.usLead, "unexpected status 403 Forbidden")
    codex.fail(run.cnLead, "unexpected status 403 Forbidden")
    // Each failed lead's report wakes the chief, whose next request meets the same refusal.
    for (let attempt = 0; attempt < 400 && workflow.getRun(run.runId)!.status === "running"; attempt += 1) {
      if (codex.openTurn(run.chief)) codex.fail(run.chief, "unexpected status 403 Forbidden")
      await Bun.sleep(5)
    }
    expect(workflow.getRun(run.runId)!.status).toBe("provider_unavailable")
    expect(await readFile(path.join(run.runDir, "qa", "workflow_summary.md"), "utf8")).toContain("Provider: halted (last error forbidden, HTTP 403")
  })

  test("a rate limit backs off new starts, then allows them again", async () => {
    let clock = Date.parse("2030-03-10T00:00:00Z")
    const { startRun, workflow, codex, projectDir } = await setup({ now: () => clock })
    const run = await startRun()
    const scout = await workflow.delegate(run.usLead, projectDir, { role: "scout", topic: "t" })
    codex.fail(scout.chatId!, "unexpected status 429 Too Many Requests")
    await workflow.wait(run.usLead, projectDir, {})
    expect(workflow.getRun(run.runId)!.provider).toMatchObject({ state: "backoff", until: "2030-03-10T00:01:00.000Z" })
    await expect(workflow.delegate(run.usLead, projectDir, { role: "scout", retryOf: "us-s01" })).rejects.toThrow("retry after 2030-03-10T00:01:00.000Z")
    clock += 61_000
    expect(await workflow.delegate(run.usLead, projectDir, { role: "scout", retryOf: "us-s01" })).toMatchObject({ taskId: "us-s01-a2", state: "running" })
  })

  test("token use is counted per task and per run, and a task over its budget is stopped", async () => {
    const { startRun, workflow, codex, projectDir, usageLanded } = await setup({ budgets: { token_budget: { run_fresh_tokens: 1_000_000, task_fresh_tokens: { scout: 10_000 } } } })
    const run = await startRun()
    const scout = await workflow.delegate(run.usLead, projectDir, { role: "scout", topic: "t" })
    codex.usage(scout.chatId!, { input: 6_000, cached: 4_000, output: 1_000 })
    codex.usage(run.usLead, { input: 3_000, cached: 0, output: 500 })
    await usageLanded(scout.chatId!, 1)
    await usageLanded(run.usLead, 1)
    let status = await workflow.status(run.usLead, projectDir, {})
    expect(status.tasks.find((task) => task.taskId === "us-s01")).toMatchObject({ freshTokens: 3_000, cachedInputTokens: 4_000 })
    expect(status.usage).toMatchObject({ input: 9_000, cachedInput: 4_000, output: 1_500, freshTokens: 6_500, requests: 2 })
    codex.usage(scout.chatId!, { input: 9_000, cached: 1_000, output: 1_000 })
    await usageLanded(scout.chatId!, 2)
    status = await workflow.status(run.usLead, projectDir, {})
    expect(status.tasks.find((task) => task.taskId === "us-s01")).toMatchObject({ state: "failed", failure: "task token budget exhausted (12000 of 10000 fresh tokens)" })
  })

  test("a run over its budget stops every agent; near the budget no new research starts but the review may", async () => {
    const { startRun, workflow, codex, projectDir, usageLanded } = await setup({ budgets: { token_budget: { run_fresh_tokens: 100_000 } } })
    const run = await startRun()
    codex.usage(run.chief, { input: 91_000, output: 0 })
    await usageLanded(run.chief, 1)
    await workflow.status(run.chief, projectDir, {})
    await expect(workflow.delegate(run.usLead, projectDir, { role: "scout", topic: "t" })).rejects.toThrow("no new research starts")
    codex.usage(run.chief, { input: 10_000, output: 0 })
    await usageLanded(run.chief, 2)
    const status = await workflow.status(run.chief, projectDir, {})
    expect(status.status).toBe("budget_exhausted")
    expect(status.tasks.map((task) => task.state)).toEqual(["cancelled", "cancelled", "cancelled"])
    expect(await readFile(path.join(run.runDir, "qa", "workflow_summary.md"), "utf8")).toContain("**budget_exhausted**")
  })

  test("after a restart an agent's chat is still recognised and confined before its first turn", async () => {
    const { startRun, workflow, projectDir, orchestrator } = await setup()
    const run = await startRun()
    const scout = await workflow.delegate(run.usLead, projectDir, { role: "scout", topic: "t" })
    const reloaded = new BriefingWorkflow({ chats: orchestrator, python: fakePython([]), settleGraceMs: 10, sandboxRunner: ENFORCING_SANDBOX, log: () => {} })
    const policy = await reloaded.executionPolicy(scout.chatId!, projectDir)
    expect(policy).toMatchObject({ restriction: { profile: "nex-briefing-scout", cwd: scout.dir } })
    expect(reloaded.allowedTools(scout.chatId!)).toEqual(["briefing_status", "briefing_submit"])
    reloaded.dispose()
  })

  test("the run survives a restart: a new controller reads workflow.json back", async () => {
    const { startRun, workflow, projectDir, orchestrator } = await setup()
    const run = await startRun()
    const reloaded = new BriefingWorkflow({ chats: orchestrator, python: fakePython([]), settleGraceMs: 10, sandboxRunner: ENFORCING_SANDBOX, log: () => {} })
    const status = await reloaded.status(run.chief, projectDir, {})
    expect(status).toMatchObject({ runId: run.runId, stage: "country_tasks_assigned" })
    expect(status.tasks.map((task) => task.taskId)).toEqual(["chief", "us-lead", "cn-lead"])
    reloaded.dispose()
    workflow.dispose()
  })

  test("the tools reach the workflow through the Nex tool runtime", async () => {
    const { startRun, workflow, store, project } = await setup()
    const run = await startRun()
    const runtime = new NexToolRuntime({
      chatId: run.chief,
      cwd: project.localPath,
      emit: async () => {},
      requestInput: async () => ({}),
      briefing: workflow,
    }, BRIEFING_TOOLS)
    const result = await runtime.execute("briefing_status", {})
    expect(result.isError).toBeUndefined()
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ runId: run.runId, status: "running" })
    const refused = await runtime.execute("briefing_delegate", { role: "scout", topic: "x" })
    expect(refused).toMatchObject({ isError: true, content: [{ text: "Only a country lead delegates scouts." }] })
    expect(store.getChat(run.chief)).toBeTruthy()
  })
})
