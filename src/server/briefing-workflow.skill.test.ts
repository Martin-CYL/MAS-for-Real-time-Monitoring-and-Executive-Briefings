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
  skillTest("records travel scout → lead → chief intact, claims are checked independently, a proposal written as law and tampering are caught, review rework is routed and resubmitted, and the English report is built and validated", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "nex-briefing-skill-data-"))
    const projectDir = await mkdtemp(path.join(tmpdir(), "nex-briefing-skill-project-"))
    const home = await mkdtemp(path.join(tmpdir(), "nex-briefing-skill-home-"))
    const skill = path.join(projectDir, ".agents", "skills", "us-china-ai-chip-briefing")
    await cp(SKILL_DIR!, skill, { recursive: true, filter: (source) => !source.includes("__pycache__") })
    await writeFile(path.join(skill, "references", "roles", "workflow.json"), JSON.stringify({ discovery: false, verification: { enabled: true, claims_per_verifier: 4 } }))
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
      workflow.dispose()
      // Turns left open end, and their last transcript writes land, before the data directory goes.
      for (let quiet = 0, tick = 0; tick < 200 && quiet < 3; tick += 1) {
        for (const turn of codex.turns) if (turn.open) { turn.open = false; turn.events.finish() }
        await Bun.sleep(5)
        quiet = agent.getActiveStatuses().size === 0 && store.getResourceCounts().storeQueuedWrites === 0 ? quiet + 1 : 0
      }
      orchestrator.dispose(); agent.dispose()
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

    // Independent verification: the first draft starts it. Each verifier finds the page itself and records its own evidence.
    const verifying = await workflow.submit(chief, projectDir, { kind: "draft" })
    expect((verifying.problems as string[])[0]).toContain("Independent verification of")
    const verifiers = workflow.getRun(started.runId)!.tasks.filter((task) => task.role === "verifier")
    expect(verifiers.length).toBeGreaterThan(0)
    const pages = {
      rule: { url: "https://www.example.gov/proposed-rule", body: US_RULE, quote: "today issued a proposed rule that would require licences for synthetic accelerator exports",
        text: "The Synthetic Commerce Agency issued a proposed rule on licences for synthetic accelerator exports.", side: "us" },
      halt: { url: "https://www.reuters.com/synthetic-foundry", body: CN_REPORT, quote: "halted shipments of synthetic wafers to a synthetic buyer",
        text: "According to Reuters, Synthetic Foundry Co. halted shipments of synthetic wafers to a synthetic buyer.", side: "cn" },
    }
    const assigned: string[] = []
    for (const verifier of verifiers) {
      const dir = path.join(runDir, verifier.dir)
      const claims = (verifier.assignment.claims as Array<{ claim_id: string; text: string }>)
      expect(JSON.stringify(claims)).not.toMatch(/reuters\.com|example\.gov|sources/)
      const results = []
      for (const [index, claim] of claims.entries()) {
        assigned.push(claim.claim_id)
        const found = claim.text.includes("Reuters") ? pages.halt : pages.rule
        await brief("fetch", dir, found.url, "--file", await page(`verify-${claim.claim_id}.txt`, found.body), "--route", "http_tool")
        const source = `S${String(index + 1).padStart(3, "0")}`
        await brief("event", dir, "add", "--title", `Check of ${claim.claim_id}`, "--date", TODAY, "--side", found.side, "--source", source)
        await brief("add-claim", dir, `E${String(index + 1).padStart(3, "0")}`, source, "--quote", found.quote, "--text", found.text, "--pub-date", TODAY)
        results.push({ claim_id: claim.claim_id, verdict: "confirmed", evidence: [`C${String(index + 1).padStart(3, "0")}`], note: "Found on the saved page." })
      }
      // A verdict without its own evidence is refused by the Skill's check, then the real one is accepted.
      await writeFile(path.join(dir, "verification.json"), JSON.stringify({ results: results.map((result) => ({ ...result, evidence: ["C099"] })) }))
      expect((await workflow.submit(verifier.chatId!, projectDir, {})).problems).toEqual(expect.arrayContaining([expect.stringContaining("VERIFICATION_EVIDENCE")]))
      await writeFile(path.join(dir, "verification.json"), JSON.stringify({ results }))
      expect(await workflow.submit(verifier.chatId!, projectDir, {})).toMatchObject({ accepted: true })
      codex.finish(verifier.chatId!)
    }
    await workflow.wait(chief, projectDir, {})
    const checks = (await json(path.join(runDir, "claim_verification.json"))).claims
    expect(Object.keys(checks).sort()).toEqual([...assigned].sort())
    for (const check of Object.values(checks) as Array<{ status: string }>) expect(["independent", "media_only"]).toContain(check.status)

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
    // Carried-over cases with no source read as such, not as media reports.
    expect(html).toContain("<i class=\"dot u\"></i>No supporting source located")
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
    expect(await readFile(path.join(runDir, "qa", "workflow_summary.md"), "utf8")).toContain("Independent verification:")
  }, 60_000)

  skillTest("the gap round finds gaps by the Skill's rules, reopens the leads, and checks what they report against their records", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "nex-briefing-gaps-data-"))
    const projectDir = await mkdtemp(path.join(tmpdir(), "nex-briefing-gaps-project-"))
    const home = await mkdtemp(path.join(tmpdir(), "nex-briefing-gaps-home-"))
    const skill = path.join(projectDir, ".agents", "skills", "us-china-ai-chip-briefing")
    await cp(SKILL_DIR!, skill, { recursive: true, filter: (source) => !source.includes("__pycache__") })
    await writeFile(path.join(skill, "references", "roles", "workflow.json"), JSON.stringify({ discovery: false, gap_round: { enabled: true, max_gaps_pursued: 4 } }))
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
      workflow.dispose()
      for (let quiet = 0, tick = 0; tick < 200 && quiet < 3; tick += 1) {
        for (const turn of codex.turns) if (turn.open) { turn.open = false; turn.events.finish() }
        await Bun.sleep(5)
        quiet = agent.getActiveStatuses().size === 0 && store.getResourceCounts().storeQueuedWrites === 0 ? quiet + 1 : 0
      }
      orchestrator.dispose(); agent.dispose()
      for (const dir of [dataDir, projectDir, home]) await rm(dir, { recursive: true, force: true })
    })
    const brief = async (...args: string[]) => {
      const result = await runPython([path.join(skill, "scripts", "brief.py"), ...args], { cwd: skill, timeoutMs: 60_000 })
      if (result.exitCode !== 0) throw new Error(`brief.py ${args.join(" ")}: ${result.stdout}${result.stderr}`)
      return result.stdout
    }
    const page = async (name: string, body: string) => {
      const file = path.join(home, name)
      await writeFile(file, body)
      return file
    }
    const json = async (file: string) => JSON.parse(await readFile(file, "utf8"))
    const done = (output: Record<string, unknown>) => JSON.stringify({ status: "complete", summary: "Synthetic summary.", ...output })
    const narrative = (dir: string, ids: string) => writeFile(path.join(dir, "narrative.md"),
      `Country view covering ${ids}. The proposal is not yet in force, and the reported halt is attributed to Reuters only. Watch the final rule.`)

    const root = await store.createChat(project.id)
    await agent.send({ type: "chat.send", chatId: root.id, provider: "codex", content: "Run the multi-agent briefing" })
    const started = await workflow.start(root.id, projectDir, { request: "Synthetic weekly briefing", discovery: false })
    const { runDir, chiefChatId: chief } = started
    await writeFile(path.join(runDir, "plan.json"), JSON.stringify({ focus: "Synthetic", countries: {
      us: { brief: "US side", categories: ["export_controls_sanctions"], cases: ["A001"] },
      cn: { brief: "China side", categories: ["semiconductor_supply_chain"], cases: ["A002"] } } }))
    expect(await workflow.submit(chief, projectDir, { kind: "plan" })).toMatchObject({ accepted: true })
    const us = await workflow.delegate(chief, projectDir, { role: "lead", country: "us" })
    const cn = await workflow.delegate(chief, projectDir, { role: "lead", country: "cn" })

    // First round, each lead on its own: an official US proposal, a media-only China report. Neither follows its case.
    await brief("fetch", us.dir, "https://www.example.gov/proposed-rule", "--file", await page("rule.txt", US_RULE), "--route", "http_tool")
    await brief("event", us.dir, "add", "--title", "Synthetic agency proposes accelerator licence rule", "--date", TODAY, "--side", "us", "--source", "S001",
      "--materiality", "high", "--why", "Synthetic export-control link", "--category", "export_controls_sanctions")
    await brief("event", us.dir, "decide", "E001", "include", "--reason", "Proposed rule in the window", "--proposed", "--link", "Export controls", "--size", "A licence requirement", "--new", "Issued in the window")
    await brief("add-claim", us.dir, "E001", "S001", "--quote", "today issued a proposed rule that would require licences for synthetic accelerator exports",
      "--text", "The Synthetic Commerce Agency issued a proposed rule that would require licences for synthetic accelerator exports.", "--pub-date", TODAY)
    await narrative(us.dir, "E001")
    await writeFile(path.join(us.dir, "output.json"), done({ task_id: us.taskId }))
    expect(await workflow.submit(us.chatId!, projectDir, {})).toMatchObject({ accepted: true })
    codex.finish(us.chatId!)
    await brief("fetch", cn.dir, "https://www.reuters.com/synthetic-foundry", "--file", await page("cn.txt", CN_REPORT), "--route", "http_tool")
    await brief("event", cn.dir, "add", "--title", "Synthetic foundry halts wafer shipments", "--date", TODAY, "--side", "cn", "--source", "S001", "--materiality", "high", "--why", "Supply-chain response")
    await brief("event", cn.dir, "decide", "E001", "include", "--reason", "Reported supply response", "--link", "Supply chain", "--size", "Halts shipments", "--new", "Reported in the window")
    await brief("add-claim", cn.dir, "E001", "S001", "--quote", "halted shipments of synthetic wafers to a synthetic buyer",
      "--text", "According to Reuters, Synthetic Foundry Co. halted shipments of synthetic wafers to a synthetic buyer.", "--pub-date", TODAY)
    await narrative(cn.dir, "E001")
    await writeFile(path.join(cn.dir, "output.json"), done({ task_id: cn.taskId }))
    expect(await workflow.submit(cn.chatId!, projectDir, {})).toMatchObject({ accepted: true })
    codex.finish(cn.chatId!)
    await workflow.wait(chief, projectDir, {})

    // The first draft submission runs the real gap check on the merged records.
    const listed = await workflow.submit(chief, projectDir, { kind: "draft" })
    const gaps = listed.gaps as Array<{ gap_id: string; type: string; side: string; lead_task: string | null }>
    expect(gaps.map((gap) => `${gap.type}:${gap.side}`).sort()).toEqual(["case_unfollowed:cn", "case_unfollowed:us", "category_empty:cn", "single_source:cn"])
    const id = (type: string, side: string) => gaps.find((gap) => gap.type === type && gap.side === side)!.gap_id
    const [usCase, cnCase, cnMedia, cnCategory] = [id("case_unfollowed", "us"), id("case_unfollowed", "cn"), id("single_source", "cn"), id("category_empty", "cn")]
    await writeFile(path.join(runDir, "gap_plan.json"), JSON.stringify({ decisions: [
      { gap_id: usCase, action: "pursue", brief: "Check the Federal Register for the rule" },
      { gap_id: cnCase, action: "pursue", brief: "Check MOFCOM" },
      { gap_id: cnMedia, action: "pursue", brief: "Find the company's own notice" },
      { gap_id: cnCategory, action: "skip", reason: "The halt is a supply-chain story already; nothing else was material" },
    ] }))
    expect(await workflow.submit(chief, projectDir, { kind: "gap_plan" })).toMatchObject({ accepted: true, reopened: ["us-lead", "cn-lead"] })

    // US: a new case event, recorded with --case. China: two searches for the case, nothing found; the media-only
    // event is reported filled although no primary source was added, which the check must not accept.
    await brief("fetch", us.dir, "https://www.federalregister.gov/synthetic-affiliates", "--file",
      await page("fr.txt", "The Synthetic Commerce Agency today published a notice extending the synthetic affiliates rule suspension to 2030-05-10."), "--route", "http_tool")
    await brief("event", us.dir, "add", "--title", "Synthetic affiliates rule suspension extended", "--date", TODAY, "--side", "us", "--source", "S002",
      "--materiality", "medium", "--why", "Carried-over case", "--case", "A001")
    await brief("event", us.dir, "decide", "E002", "track", "--reason", "Suspension extended in the window", "--link", "Export controls", "--size", "Two more months", "--new", "Published in the window")
    await brief("add-claim", us.dir, "E002", "S002", "--quote", "published a notice extending the synthetic affiliates rule suspension",
      "--text", "The Synthetic Commerce Agency published a notice extending the synthetic affiliates rule suspension.", "--pub-date", TODAY)
    await writeFile(path.join(us.dir, "output.json"), done({ task_id: us.taskId, gap_results: [{ gap_id: usCase, outcome: "filled", event_ids: ["E002"] }] }))
    expect(await workflow.submit(us.chatId!, projectDir, {})).toMatchObject({ accepted: true })
    codex.finish(us.chatId!)
    await brief("search", cn.dir, "mofcom.gov.cn synthetic rare earth suspension", "--found", "nothing in the window")
    await brief("search", cn.dir, "MOFCOM announcement list March", "--found", "no new announcement")
    await writeFile(path.join(cn.dir, "output.json"), done({ task_id: cn.taskId, gap_results: [
      { gap_id: cnCase, outcome: "searched_none", searched: ["mofcom.gov.cn synthetic rare earth suspension", "MOFCOM announcement list March"], note: "No announcement" },
      { gap_id: cnMedia, outcome: "filled", event_ids: ["E001"] },
    ] }))
    expect(await workflow.submit(cn.chatId!, projectDir, {})).toMatchObject({ accepted: true })
    codex.finish(cn.chatId!)
    await workflow.wait(chief, projectDir, {})

    const ended = await workflow.submit(chief, projectDir, { kind: "draft" })
    expect((ended.problems as string[])[0]).toContain("The gap round has ended: 4 gap(s) listed")
    const report = await json(path.join(runDir, "gap_report.json"))
    const outcome = Object.fromEntries(report.gaps.map((gap: { gap_id: string; outcome: string }) => [gap.gap_id, gap.outcome]))
    expect(outcome).toEqual({ [usCase]: "filled", [cnCase]: "searched_none", [cnMedia]: "filled_unconfirmed", [cnCategory]: "skipped" })
    expect(report.gaps.find((gap: { gap_id: string }) => gap.gap_id === cnMedia).detail).toContain("none of the listed events or claims is new")
    // The new case event reached the chief's records with its case.
    const merged = (await json(path.join(runDir, "events.json"))).events as Array<{ case_id?: string; claim_ids?: string[]; provenance?: Array<{ task: string }> }>
    expect(merged.some((event) => event.case_id === "A001" && (event.claim_ids ?? []).length > 0 && event.provenance?.some((origin) => origin.task === "us-lead"))).toBe(true)
  }, 60_000)

  skillTest("source lanes: a lane records only its own evidence, and a media lead followed up by the official lane joins the reported event in the lead's records", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "nex-briefing-lanes-data-"))
    const projectDir = await mkdtemp(path.join(tmpdir(), "nex-briefing-lanes-project-"))
    const home = await mkdtemp(path.join(tmpdir(), "nex-briefing-lanes-home-"))
    const skill = path.join(projectDir, ".agents", "skills", "us-china-ai-chip-briefing")
    await cp(SKILL_DIR!, skill, { recursive: true, filter: (source) => !source.includes("__pycache__") })
    const config = JSON.parse(await readFile(path.join(skill, "references", "roles", "workflow.json"), "utf8"))
    await writeFile(path.join(skill, "references", "roles", "workflow.json"), JSON.stringify({ ...config, discovery: false, scout_mode: "lane", verification: { enabled: false } }))
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
      workflow.dispose()
      for (let quiet = 0, tick = 0; tick < 200 && quiet < 3; tick += 1) {
        for (const turn of codex.turns) if (turn.open) { turn.open = false; turn.events.finish() }
        await Bun.sleep(5)
        quiet = agent.getActiveStatuses().size === 0 && store.getResourceCounts().storeQueuedWrites === 0 ? quiet + 1 : 0
      }
      orchestrator.dispose(); agent.dispose()
      for (const dir of [dataDir, projectDir, home]) await rm(dir, { recursive: true, force: true })
    })
    const brief = async (...args: string[]) => {
      const result = await runPython([path.join(skill, "scripts", "brief.py"), ...args], { cwd: skill, timeoutMs: 60_000 })
      if (result.exitCode !== 0) throw new Error(`brief.py ${args.join(" ")}: ${result.stdout}${result.stderr}`)
      return result.stdout
    }
    const page = async (name: string, body: string) => {
      const file = path.join(home, name)
      await writeFile(file, body)
      return file
    }
    const json = async (file: string) => JSON.parse(await readFile(file, "utf8"))
    const done = (output: Record<string, unknown>) => JSON.stringify({ status: "complete", summary: "Synthetic summary.", ...output })
    const TITLE = "Synthetic agency adds synthetic foundry to entity list"
    const REPORT = "Synthetic Wire reported that the Synthetic Commerce Agency added Synthetic Foundry Co. to the synthetic entity list."
    const RULE = "The Synthetic Commerce Agency issued a final rule that adds Synthetic Foundry Co. to the synthetic entity list, effective on publication."
    const decide = (dir: string, id: string, decision = "include") => brief("event", dir, "decide", id, decision, "--reason", "Material listing in the window",
      "--link", "Export controls on a foundry", "--size", "Adds a licence requirement", "--new", "Issued in the window")

    const root = await store.createChat(project.id)
    await agent.send({ type: "chat.send", chatId: root.id, provider: "codex", content: "Run the multi-agent briefing" })
    const started = await workflow.start(root.id, projectDir, { request: "Synthetic weekly briefing", discovery: false })
    await writeFile(path.join(started.runDir, "plan.json"), JSON.stringify({ focus: "Synthetic", countries: {
      us: { brief: "US side", categories: ["export_controls_sanctions"] }, cn: { brief: "China side", categories: ["semiconductor_supply_chain"] } } }))
    expect(await workflow.submit(started.chiefChatId, projectDir, { kind: "plan" })).toMatchObject({ accepted: true })
    const us = await workflow.delegate(started.chiefChatId, projectDir, { role: "lead", country: "us" })
    expect(workflow.getRun(started.runId)!.budgets.scoutMode).toBe("lane")

    // First round: the media lane finds the report; the official lane, recording that report, is refused.
    const media = await workflow.delegate(us.chatId!, projectDir, { role: "scout", lane: "media", categories: ["export_controls_sanctions"] })
    const official = await workflow.delegate(us.chatId!, projectDir, { role: "scout", lane: "official", categories: ["export_controls_sanctions"] })
    for (const scout of [media, official]) {
      await brief("fetch", scout.dir, "https://www.reuters.com/synthetic-listing", "--file", await page(`report-${scout.taskId}.txt`, REPORT), "--route", "http_tool")
      await brief("event", scout.dir, "add", "--title", TITLE, "--date", TODAY, "--side", "us", "--source", "S001", "--materiality", "high", "--why", "Export controls on a foundry")
      await decide(scout.dir, "E001")
      await brief("add-claim", scout.dir, "E001", "S001", "--quote", "added Synthetic Foundry Co. to the synthetic entity list",
        "--text", "According to Synthetic Wire, the Synthetic Commerce Agency added Synthetic Foundry Co. to the synthetic entity list.", "--kind", "list", "--pub-date", TODAY)
      await brief("search", scout.dir, "synthetic entity list foundry", "--found", "the report")
      await writeFile(path.join(scout.dir, "narrative.md"), "E001: according to Synthetic Wire the agency listed the foundry (C001). The rule itself has not been located yet; watch the Federal Register.")
    }
    await writeFile(path.join(media.dir, "output.json"), done({ task_id: media.taskId,
      primary_leads: [{ event_id: "E001", agency: "Synthetic Commerce Agency", document_hint: "The final rule adding the foundry to the entity list" }] }))
    expect(await workflow.submit(media.chatId!, projectDir, {})).toMatchObject({ accepted: true })
    codex.finish(media.chatId!)
    await writeFile(path.join(official.dir, "output.json"), done({ task_id: official.taskId }))
    const refused = await workflow.submit(official.chatId!, projectDir, {})
    expect(refused.accepted).toBe(false)
    expect((refused.problems as string[]).join("\n")).toContain("LANE_EVIDENCE_TYPE: C001: recorded as 'news', but the official lane records only dataset, official_document")
    await brief("withdraw", official.dir, "C001", "--reason", "A news report; the media lane covers it")
    await decide(official.dir, "E001", "exclude")
    expect(await workflow.submit(official.chatId!, projectDir, {})).toMatchObject({ accepted: true })
    codex.finish(official.chatId!)

    // The lead gets the media lead in its own event IDs and sends it to an official follow-up.
    const first = await workflow.wait(us.chatId!, projectDir, {})
    const lead = first.primaryLeads![0]!
    expect(lead).toMatchObject({ lead_id: "L001", from_task: media.taskId, title: TITLE, date: TODAY, side: "us", agency: "Synthetic Commerce Agency" })
    const follow = await workflow.delegate(us.chatId!, projectDir, { role: "scout", lane: "official", primaryLeads: ["L001"] })
    await brief("fetch", follow.dir, "https://www.example.gov/final-rule", "--file", await page("rule.txt", RULE), "--route", "http_tool")
    await brief("event", follow.dir, "add", "--title", TITLE, "--date", TODAY, "--side", "us", "--source", "S001", "--materiality", "high", "--why", "Export controls on a foundry")
    await decide(follow.dir, "E001")
    await brief("add-claim", follow.dir, "E001", "S001", "--quote", "adds Synthetic Foundry Co. to the synthetic entity list",
      "--text", "The Synthetic Commerce Agency issued a final rule adding Synthetic Foundry Co. to the synthetic entity list.", "--kind", "list", "--pub-date", TODAY)
    await brief("search", follow.dir, "synthetic final rule entity list", "--found", "the rule")
    await writeFile(path.join(follow.dir, "narrative.md"), "E001: the agency's final rule adds the foundry to the entity list (C001), confirming the reported listing from the primary document.")
    await writeFile(path.join(follow.dir, "output.json"), done({ task_id: follow.taskId, lead_results: [{ lead_id: "L001", outcome: "found", event_id: "E001", note: "Final rule" }] }))
    expect(await workflow.submit(follow.chatId!, projectDir, {})).toMatchObject({ accepted: true })
    codex.finish(follow.chatId!)

    const second = await workflow.wait(us.chatId!, projectDir, {})
    expect(second.primaryLeads![0]!.follow_up).toMatchObject({ task_id: follow.taskId, state: "accepted", outcome: "found" })
    // One event in the lead's records, found by two lanes: the report and the primary document.
    const events = (await json(path.join(us.dir, "events.json"))).events.filter((event: { title: string }) => event.title === TITLE)
    const joined = events.find((event: { provenance: Array<{ task: string }> }) => event.provenance.some((origin) => origin.task === follow.taskId))
    expect(joined.provenance.map((origin: { task: string }) => origin.task)).toEqual(expect.arrayContaining([media.taskId, follow.taskId]))
    expect(joined.claim_ids).toHaveLength(2)
    const ledger = await json(path.join(us.dir, "evidence_ledger.json"))
    const types = ledger.claims.filter((claim: { id: string }) => joined.claim_ids.includes(claim.id))
      .flatMap((claim: { sources: Array<{ evidence_type: string }> }) => claim.sources.map((source) => source.evidence_type)).sort()
    expect(types).toEqual(["news", "official_document"])
  }, 60_000)
})
