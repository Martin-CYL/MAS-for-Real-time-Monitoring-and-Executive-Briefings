import { afterEach, describe, expect, test } from "bun:test"
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { AgentCoordinator } from "./agent"
import { NoopAnalyticsReporter } from "./analytics"
import { AsyncQueue } from "./async-queue"
import { BriefingWorkflow, runPython } from "./briefing-workflow"
import type { SandboxRunner } from "./briefing-sandbox"
import { createChatCommands } from "./chat-commands"
import { EventStore } from "./event-store"
import type { HarnessEvent, HarnessTurn } from "./harness-types"
import { ChatOrchestrator } from "./orchestrator"
import { timestamped } from "./transcript"

/**
 * The workflow with the real briefing Skill: real brief.py records, merges,
 * handoff and provenance checks, the English renderer and the validator. The
 * agents are played by this test with fixed synthetic pages, so it shows the
 * deterministic path end to end, not what a model would research or write.
 *
 * The Skill is not part of this repository. Point BRIEFING_SKILL_DIR at a
 * copy of `us-china-ai-chip-briefing` with multi-agent support to run it.
 */

/** The OS sandbox check has its own test (briefing-sandbox.test.ts); here it answers as an enforcing host would. */
const ENFORCING_SANDBOX: SandboxRunner = async () => ({
  exitCode: 0,
  stdout: ["write own task directory=allowed", "write another task directory=denied", "read another task directory=denied",
    "write workflow state=denied", "read workflow state=denied", "read Codex credentials=denied"].join("\n"),
  stderr: "",
})

const SKILL_DIR = process.env.BRIEFING_SKILL_DIR
const skillTest = SKILL_DIR && existsSync(path.join(SKILL_DIR, "scripts", "merge_runs.py")) ? test : test.skip

class FakeCodex {
  readonly turns: Array<{ chatId: string; content: string; events: AsyncQueue<HarnessEvent>; open: boolean }> = []
  async startSession() {}
  stopSession() {}
  stopAll() {}
  getResourceCounts() { return {} }
  async startTurn(args: { chatId: string; content: string }): Promise<HarnessTurn> {
    const turn = { chatId: args.chatId, content: args.content, events: new AsyncQueue<HarnessEvent>(), open: true }
    this.turns.push(turn)
    const end = () => { turn.open = false; turn.events.finish() }
    return { provider: "codex", stream: turn.events, interrupt: async () => end(), close: end }
  }
  finish(chatId: string, text = "done") {
    const turn = [...this.turns].reverse().find((entry) => entry.chatId === chatId && entry.open)
    if (!turn) return
    turn.events.push({ type: "transcript", entry: timestamped({ kind: "assistant_text", text }) })
    turn.events.push({ type: "transcript", entry: timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "" }) })
    turn.open = false
    turn.events.finish()
  }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

// The validator checks dates against the real clock, so the synthetic window ends today, as a real run's would.
const TODAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Hong_Kong" }).format(new Date())

const US_RULE = "The Synthetic Commerce Agency today issued a proposed rule that would require licences for synthetic accelerator exports. Comments are due by April 9, 2030."
const CN_REPORT = "Synthetic Daily reported that Synthetic Foundry Co. halted shipments of synthetic wafers to a synthetic buyer on March 6, 2030, citing licensing uncertainty."

describe("briefing workflow with the real Skill scripts", () => {
  skillTest("records travel scout → lead → chief intact, a proposal written as law and tampering are caught, review rework is routed and resubmitted, and the English report is built and validated", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "nex-briefing-skill-data-"))
    const projectDir = await mkdtemp(path.join(tmpdir(), "nex-briefing-skill-project-"))
    const home = await mkdtemp(path.join(tmpdir(), "nex-briefing-skill-home-"))
    const skill = path.join(projectDir, ".agents", "skills", "us-china-ai-chip-briefing")
    await cp(SKILL_DIR!, skill, { recursive: true, filter: (source) => !source.includes("__pycache__") })
    await writeFile(path.join(skill, "references", "roles", "workflow.json"), JSON.stringify({ discovery: false }))
    const store = new EventStore(dataDir)
    await store.initialize()
    const project = await store.openProject(projectDir)
    const codex = new FakeCodex()
    const agent = new AgentCoordinator({ store, onStateChange: () => {}, codexManager: codex as never,
      generateTitle: async () => ({ title: null, usedFallback: true, failureMessage: null }) })
    const orchestrator = new ChatOrchestrator({ store, agent, commands: createChatCommands({ store, agent, analytics: NoopAnalyticsReporter }), push: () => {} })
    const workflow = new BriefingWorkflow({ chats: orchestrator, settleGraceMs: 10, home, sandboxRunner: ENFORCING_SANDBOX, log: () => {} })
    agent.orchestration = orchestrator
    agent.briefing = workflow
    agent.onChatSettled = (chatId) => { orchestrator.handleChatSettled(chatId); workflow.handleChatSettled(chatId) }
    store.onTurnStarted = (chatId) => orchestrator.handleTurnStarted(chatId)
    cleanups.push(async () => {
      workflow.dispose(); orchestrator.dispose(); agent.dispose()
      for (const dir of [dataDir, projectDir, home]) await rm(dir, { recursive: true, force: true })
    })

    const brief = async (...args: string[]) => {
      const result = await runPython([path.join(skill, "scripts", "brief.py"), ...args], { cwd: skill, timeoutMs: 60_000 })
      if (result.exitCode !== 0 && args[0] !== "build") throw new Error(`brief.py ${args.join(" ")}: ${result.stdout}${result.stderr}`)
      return result.stdout
    }
    const page = async (name: string, body: string) => {
      const file = path.join(home, name)
      await writeFile(file, body)
      return file
    }
    const json = async (file: string) => JSON.parse(await readFile(file, "utf8"))
    const done = (output: Record<string, unknown>) => JSON.stringify({ status: "complete", summary: "Synthetic summary.", ...output })

    const root = await store.createChat(project.id)
    await agent.send({ type: "chat.send", chatId: root.id, provider: "codex", content: "Run the multi-agent briefing" })
    const started = await workflow.start(root.id, projectDir, { request: "Synthetic weekly briefing", discovery: false })
    const runDir = started.runDir
    const chief = started.chiefChatId
    await writeFile(path.join(runDir, "plan.json"), JSON.stringify({ focus: "Synthetic", countries: {
      us: { brief: "US side", categories: ["export_controls_sanctions"], cases: ["A001"] },
      cn: { brief: "China side", categories: ["semiconductor_supply_chain"], cases: ["A002"] } } }))
    expect(await workflow.submit(chief, projectDir, { kind: "plan" })).toMatchObject({ accepted: true })
    const us = await workflow.delegate(chief, projectDir, { role: "lead", country: "us" })
    const cn = await workflow.delegate(chief, projectDir, { role: "lead", country: "cn" })

    // US scout: an official proposed rule.
    const usScout = await workflow.delegate(us.chatId!, projectDir, { role: "scout", topic: "Export controls", category: "export_controls_sanctions" })
    await brief("fetch", usScout.dir, "https://www.example.gov/proposed-rule", "--file", await page("rule.txt", US_RULE), "--route", "http_tool")
    await brief("event", usScout.dir, "add", "--title", "Synthetic agency proposes accelerator licence rule", "--date", TODAY, "--side", "us", "--source", "S001", "--materiality", "high", "--why", "Synthetic export-control link")
    await brief("event", usScout.dir, "decide", "E001", "include", "--reason", "Proposed rule in the window", "--proposed", "--link", "Export controls on accelerators", "--size", "Would add a licence requirement", "--new", "Issued in the window")
    // The controlled error: the page says "proposed rule", the claim says the rule was enacted.
    await brief("add-claim", usScout.dir, "E001", "S001", "--quote", "today issued a proposed rule that would require licences for synthetic accelerator exports", "--text", "The Synthetic Commerce Agency enacted a rule requiring licences for synthetic accelerator exports.", "--pub-date", TODAY)
    await brief("search", usScout.dir, "synthetic accelerator rule", "--found", "the proposed rule")
    await writeFile(path.join(usScout.dir, "narrative.md"), "E001: the agency proposed a licence rule (C002). It is a proposal, not yet in force; comments are due in April. Watch for the final rule.")
    expect(await workflow.submit(usScout.chatId!, projectDir, {})).toMatchObject({ accepted: false }) // no output.json yet
    await writeFile(path.join(usScout.dir, "output.json"), done({ task_id: usScout.taskId }))
    const wrongState = await workflow.submit(usScout.chatId!, projectDir, {})
    expect(wrongState.accepted).toBe(false)
    expect((wrongState.problems as string[]).join("\n")).toContain("STATUS_WORDING: C001: its event is marked proposed")
    // The prescribed fix: withdraw the claim, record what the page says.
    await brief("withdraw", usScout.dir, "C001", "--reason", "The source shows a proposed rule, not an enacted one")
    await brief("add-claim", usScout.dir, "E001", "S001", "--quote", "today issued a proposed rule that would require licences for synthetic accelerator exports", "--text", "The Synthetic Commerce Agency issued a proposed rule that would require licences for synthetic accelerator exports.", "--pub-date", TODAY)
    expect(await workflow.submit(usScout.chatId!, projectDir, {})).toMatchObject({ accepted: true })
    codex.finish(usScout.chatId!)

    // China scout: a media report, plus the same US rule seen from the China side (a duplicate across branches).
    const cnScout = await workflow.delegate(cn.chatId!, projectDir, { role: "scout", topic: "Foundry supply", category: "semiconductor_supply_chain" })
    await brief("fetch", cnScout.dir, "https://www.reuters.com/synthetic-foundry", "--file", await page("cn.txt", CN_REPORT), "--route", "http_tool")
    await brief("fetch", cnScout.dir, "https://www.example.gov/proposed-rule", "--file", await page("rule2.txt", US_RULE), "--route", "http_tool")
    await brief("event", cnScout.dir, "add", "--title", "Synthetic foundry halts wafer shipments", "--date", TODAY, "--side", "cn", "--source", "S001", "--materiality", "high", "--why", "Supply-chain response")
    await brief("event", cnScout.dir, "decide", "E001", "include", "--reason", "Reported supply response", "--link", "Supply chain", "--size", "Halts shipments", "--new", "Reported in the window")
    await brief("add-claim", cnScout.dir, "E001", "S001", "--quote", "halted shipments of synthetic wafers to a synthetic buyer", "--text", "According to Reuters, Synthetic Foundry Co. halted shipments of synthetic wafers to a synthetic buyer.", "--pub-date", TODAY)
    await brief("event", cnScout.dir, "add", "--title", "Synthetic agency proposes accelerator licence rule", "--date", TODAY, "--side", "us", "--source", "S002", "--materiality", "medium", "--why", "Context for the halt")
    await brief("event", cnScout.dir, "decide", "E002", "track", "--reason", "US rule, covered by the US lead", "--link", "l", "--size", "s", "--new", "n")
    await brief("search", cnScout.dir, "synthetic foundry wafers", "--found", "the halt")
    await writeFile(path.join(cnScout.dir, "narrative.md"), "E001: according to Reuters the foundry halted wafer shipments (C001). E002 is the US proposal that may explain it; that link is not established.")
    await writeFile(path.join(cnScout.dir, "output.json"), done({ task_id: cnScout.taskId }))
    expect(await workflow.submit(cnScout.chatId!, projectDir, {})).toMatchObject({ accepted: true })
    codex.finish(cnScout.chatId!)

    // Leads: wait (merge), consolidate, submit.
    for (const lead of [us, cn]) {
      const waited = await workflow.wait(lead.chatId!, projectDir, {})
      expect(waited.tasks[0]).toMatchObject({ state: "accepted", merged: true })
      await brief("search", lead.dir, `lead check ${lead.taskId}`)
      const events = (await json(path.join(lead.dir, "events.json"))).events
      await writeFile(path.join(lead.dir, "narrative.md"), `Country view covering ${events.map((event: { id: string }) => event.id).join(", ")}. The proposal is not yet in force, and the reported halt is attributed to Reuters only.`)
      await writeFile(path.join(lead.dir, "output.json"), done({ task_id: lead.taskId }))
      expect(await workflow.submit(lead.chatId!, projectDir, {})).toMatchObject({ accepted: true })
      codex.finish(lead.chatId!)
    }
    const leads = await workflow.wait(chief, projectDir, {})
    expect(leads.tasks.map((task) => task.state)).toEqual(["accepted", "accepted"])

    // The chief's run now holds both branches; the shared US rule was joined, not duplicated.
    const merged = await json(path.join(runDir, "events.json"))
    const rule = merged.events.filter((event: { title: string }) => event.title === "Synthetic agency proposes accelerator licence rule")
    expect(rule).toHaveLength(1)
    expect(rule[0].proposed).toBe(true)
    expect(rule[0].provenance.map((entry: { task: string }) => entry.task)).toEqual(["us-s01", "us-lead", "cn-s01", "cn-lead"])
    const ledger = await json(path.join(runDir, "evidence_ledger.json"))
    expect(ledger.claims.map((claim: { text: string }) => claim.text)).toEqual([
      "The Synthetic Commerce Agency issued a proposed rule that would require licences for synthetic accelerator exports.",
      "According to Reuters, Synthetic Foundry Co. halted shipments of synthetic wafers to a synthetic buyer.",
    ])
    // The withdrawn wording travelled up as withdrawn, with its reason, not as a live claim.
    expect(ledger.withdrawn.map((entry: { claim: { text: string }; reason: string }) => [entry.claim.text, entry.reason])).toEqual([
      ["The Synthetic Commerce Agency enacted a rule requiring licences for synthetic accelerator exports.",
        "withdrawn in us-lead: withdrawn in us-s01: The source shows a proposed rule, not an enacted one"],
    ])

    // Chief: settle the merge, decide carried-over cases, write the analysis.
    for (const event of merged.events as Array<{ id: string; case_id?: string; title: string; merge_conflicts?: unknown[] }>) {
      if (event.case_id) {
        await brief("event", runDir, "decide", event.id, "track", "--reason", "No update found in this synthetic window", "--side", event.case_id === "A002" ? "cn" : "us",
          "--materiality", "medium", "--link", "Carried-over case", "--size", "Unchanged", "--new", "No new information")
      } else if (event.merge_conflicts?.length) {
        await brief("event", runDir, "decide", event.id, "include", "--reason", "Both branches report the proposal; US lead holds the primary source")
      }
    }
    const included = (await json(path.join(runDir, "events.json"))).events.filter((event: { decision: string }) => event.decision === "include")
    await writeFile(path.join(runDir, "report.json"), JSON.stringify({
      thesis: { lead: "A synthetic licence rule is proposed", emphasis: "and a foundry has reportedly paused shipments" },
      deck: "A synthetic agency proposed a licence rule; a foundry reportedly halted shipments. The link between them is not established.",
      questions: ["Will the rule be finalised?", "Will other foundries follow?", "Which buyers are affected?"],
      judgments: [1, 2, 3].map((index) => ({ title: `Judgment ${index}`, text: `Synthetic judgment ${index}.` })),
      stories: included.map((event: { id: string }, index: number) => ({ event: event.id, chapter: "Policy and supply",
        title: index === 0 ? "A licence rule is proposed" : "A foundry reportedly pauses shipments",
        impact: index === 0 ? "Exporters may need licences once a final rule is issued." : "Buyers may face supply gaps if the pause lasts.", watch: "The comment deadline" })),
      management_view: "A final rule or a second foundry pause would change this view.",
    }))

    // Seeded tampering: the US lead's accepted claim is "upgraded" from proposed to enacted after the handoff.
    const usLedgerFile = path.join(us.dir, "evidence_ledger.json")
    const original = await readFile(usLedgerFile, "utf8")
    await writeFile(usLedgerFile, original.replace("issued a proposed rule that would require", "enacted a rule that requires"))
    const refused = await workflow.submit(chief, projectDir, { kind: "draft" })
    expect(refused.accepted).toBe(false)
    expect((refused.problems as string[]).join("\n")).toContain("TASK_RECORD_CHANGED")
    await writeFile(usLedgerFile, original)

    const draft = await workflow.submit(chief, projectDir, { kind: "draft" })
    expect(draft).toMatchObject({ accepted: true, provenance: "PASS", reviewTask: "review-1" })
    const html = await readFile(path.join(runDir, "report.html"), "utf8")
    expect(html).toContain("<html lang=\"en\">")
    expect(html).toContain("issued a proposed rule that would require licences")
    expect(html).toContain("class=\"st pending\"")
    expect(html).toContain("class=\"st reported\"")
    const qa = await json(path.join(runDir, "qa", "review_report.json"))
    expect(qa.readiness).not.toBe("BLOCKED")

    const ruleClaim = (await json(path.join(runDir, "evidence_ledger.json"))).claims
      .find((claim: { text: string }) => claim.text.startsWith("The Synthetic Commerce Agency issued")).id
    const reviewer = workflow.getRun(started.runId)!.tasks.find((task) => task.id === "review-1")!
    await writeFile(path.join(runDir, reviewer.dir, "findings.json"), JSON.stringify({
      verdict: "rework", summary: "The rule story omits its comment deadline.",
      findings: [{ id: "R001", severity: "major", category: "omission", target: { claim_id: ruleClaim },
        problem: "The story does not say when comments are due, which the source states.", evidence: "Source text: 'Comments are due by April 9, 2030.'" }],
    }))
    expect(await workflow.submit(reviewer.chatId!, projectDir, {})).toMatchObject({ accepted: true, verdict: "rework" })
    codex.finish(reviewer.chatId!)
    const review = await workflow.wait(chief, projectDir, { taskIds: ["review-1"] })
    expect(review.stage).toBe("rework")
    expect((review.tasks[0]!.output as { findings: Array<{ responsible: string[] }> }).findings[0]!.responsible).toEqual(["us-s01", "us-lead"])

    // Targeted rework to the responsible lead, who adds the missing fact from the saved page.
    await workflow.delegate(chief, projectDir, { role: "lead", reworkOf: "us-lead", findings: ["R001"] })
    const leadEvent = (await json(path.join(us.dir, "events.json"))).events.find((event: { title: string }) => event.title === "Synthetic agency proposes accelerator licence rule").id
    await brief("add-claim", us.dir, leadEvent, "S001", "--quote", "Comments are due by April 9, 2030", "--text", "Comments on the proposed rule are due by April 9, 2030.", "--pub-date", TODAY)
    expect(await workflow.submit(us.chatId!, projectDir, {})).toMatchObject({ accepted: true })
    codex.finish(us.chatId!)
    await workflow.wait(chief, projectDir, { taskIds: ["us-lead"] })
    expect((await json(path.join(runDir, "evidence_ledger.json"))).claims.map((claim: { text: string }) => claim.text))
      .toContain("Comments on the proposed rule are due by April 9, 2030.")

    expect(await workflow.submit(chief, projectDir, { kind: "draft" })).toMatchObject({ accepted: true, provenance: "PASS", reviewTask: "review-2" })
    expect(await readFile(path.join(runDir, "report.html"), "utf8")).toContain("Comments on the proposed rule are due by April 9, 2030.")
    const second = workflow.getRun(started.runId)!.tasks.find((task) => task.id === "review-2")!
    expect(second.chatId).not.toBe(reviewer.chatId)
    await writeFile(path.join(runDir, second.dir, "findings.json"), JSON.stringify({ verdict: "pass", summary: "The deadline is now stated.", findings: [],
      previous: [{ key: "review-1/R001", status: "resolved", note: "The deadline claim is in the report with its quote." }] }))
    expect(await workflow.submit(second.chatId!, projectDir, {})).toMatchObject({ accepted: true, verdict: "pass" })
    const final = workflow.getRun(started.runId)!
    expect(["ready_for_human_review", "incomplete"]).toContain(final.status)
    expect(final.final).toMatchObject({ provenance: "PASS" })
    // Human sign-off stays mandatory: the form exists, nothing claims verification, and the summary says so.
    expect(existsSync(path.join(runDir, "qa", "signoff.md"))).toBe(true)
    expect(await readFile(path.join(runDir, "report.html"), "utf8")).not.toMatch(/\bverified\b/i)
    expect(await readFile(path.join(runDir, "qa", "workflow_summary.md"), "utf8")).toContain("Human sign-off is still required")
    expect(final.reviewRounds).toBe(2)
  }, 60_000)
})
