import { createHash, randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import type { z } from "zod"
import {
  type BriefingCountry,
  type BriefingPlan,
  type BriefingReview,
  type BriefingRole,
  describeIssues,
  outputSchemaFor,
  planSchema,
  reviewSchema,
} from "./briefing-contracts"
import { parseFrontmatter, scanCodexSkills } from "./harness-skills"
import type { AgentChatStatus, AgentChatSummary, ChatOutcome } from "./orchestrator"

/**
 * The multi-agent workflow for the `us-china-ai-chip-briefing` Skill.
 *
 * The chats are ordinary Nex sub-chats, made and waited on through
 * `ChatOrchestrator`, so its depth and live-chat limits, reports and
 * cancellation all apply unchanged. What this adds is the briefing's own
 * rules, which a general chat tool cannot know:
 *
 *   - who may delegate what (chief → country leads → scouts; reviewer last),
 *     with per-run budgets, and a queue when the concurrency budget is full;
 *   - a task is finished only by an accepted submission. The Skill's
 *     `check_handoff.py` checks its records; a chat that ends without one is
 *     a failed task, never a silent success;
 *   - accepted records are merged upward by the Skill's `merge_runs.py`, only
 *     while the receiving agent is blocked in a briefing tool, so two writers
 *     never touch one run directory;
 *   - the draft is rendered and validated by the Skill's own renderer and
 *     validator, traced by `check_provenance.py`, then reviewed by a separate
 *     reviewer chat, with bounded rework and explicit final statuses.
 *
 * State lives in `<project>/runs/<run-id>/workflow.json`, rewritten after
 * every change, and `workflow.log.jsonl` keeps one line per transition.
 * Directory separation keeps agents' files apart by convention and by these
 * checks; it is not a sandbox.
 */

export const BRIEFING_SKILL_NAME = "us-china-ai-chip-briefing"
const WORKFLOW_SCHEMA = "nex-briefing-workflow/v1"
const DEFAULT_WAIT_MS = 30 * 60_000
const MAX_WAIT_MS = 60 * 60_000
const WAIT_SLICE_MS = 30_000
const SETTLE_GRACE_MS = 5_000
/**
 * How often active runs are re-checked with nobody calling a tool. Without it
 * a task whose provider request hangs is never timed out: deadlines are
 * otherwise judged only on a tool call or a chat settling.
 */
const WATCHDOG_MS = 60_000
const PYTHON_TIMEOUT_MS = 120_000
const DISCOVERY_TIMEOUT_MS = 240_000
const RECORD_FILES = ["run_config.json", "events.json", "evidence_ledger.json", "sources.json", "narrative.md", "output.json"]

export type BriefingStage =
  | "request_received"
  | "research_plan_created"
  | "country_tasks_assigned"
  | "topic_research_running"
  | "topic_research_completed"
  | "country_consolidation"
  | "cross_border_synthesis"
  | "editorial_draft_completed"
  | "render_and_validate"
  | "independent_review"
  | "rework"
  | "finalized"

export type BriefingRunStatus = "running" | "ready_for_human_review" | "incomplete" | "escalated" | "blocked" | "failed" | "cancelled"
export type BriefingTaskState = "queued" | "running" | "accepted" | "failed" | "cancelled"

export interface BriefingBudgets {
  maxScoutsPerLead: number
  maxConcurrentScouts: number
  maxTaskAttempts: number
  maxCrossBorderRequests: number
  maxReworkRounds: number
  maxDraftAttempts: number
  taskMinutes: Record<BriefingRole, number>
  discovery: boolean
  days: number
}

export const DEFAULT_BUDGETS: BriefingBudgets = {
  maxScoutsPerLead: 4,
  maxConcurrentScouts: 4,
  maxTaskAttempts: 2,
  maxCrossBorderRequests: 3,
  maxReworkRounds: 2,
  maxDraftAttempts: 4,
  taskMinutes: { scout: 30, lead: 90, cross_border: 30, reviewer: 30, chief: 240 },
  discovery: true,
  days: 7,
}

export interface CheckFinding {
  status: "PASS" | "FAIL" | "UNVERIFIED"
  code: string
  message: string
  [key: string]: unknown
}

export interface BriefingTask {
  id: string
  role: BriefingRole
  country?: BriefingCountry
  title: string
  /** The task that asked for this one. Its chat receives the result. */
  parentTaskId?: string
  /** The task whose run directory receives these records once accepted. */
  mergeInto?: string
  /** Relative to the run directory. The chief's is the run directory itself. */
  dir: string
  chatId?: string
  state: BriefingTaskState
  attempt: number
  retryOf?: string
  assignment: Record<string, unknown>
  createdAt: string
  startedAt?: string
  endedAt?: string
  deadlineAt?: string
  submissions: number
  lastRejection?: string[]
  accepted?: {
    at: string
    hashes: Record<string, string>
    output?: unknown
    findings: CheckFinding[]
    summary?: unknown
  } | null
  /** Earlier acceptances, when the task was reopened for rework. */
  previous?: Array<{ at: string; hashes: Record<string, string> }>
  merged?: boolean
  mergeResult?: unknown
  delivered?: boolean
  failure?: string
}

export interface BriefingRun {
  schema: typeof WORKFLOW_SCHEMA
  runId: string
  projectPath: string
  rootChatId: string
  runDir: string
  skillDir: string
  request: string
  window: { start: string; end: string }
  cutoff: string
  timezone: string
  budgets: BriefingBudgets
  run?: { provider?: string; model?: string; effort?: string }
  stage: BriefingStage
  status: BriefingRunStatus
  history: Array<{ stage: BriefingStage; at: string; note?: string }>
  tasks: BriefingTask[]
  plan?: BriefingPlan
  discovery?: { ok: boolean; note: string }
  draftAttempts: number
  reviewRounds: number
  reworkRounds: number
  crossBorderCount: number
  partialReason?: string
  draft?: { at: string; hashes: Record<string, string>; readiness?: string }
  final?: {
    at: string
    status: BriefingRunStatus
    readiness?: string
    provenance?: string
    reasons: string[]
    unresolvedFindings: unknown[]
  }
}

export interface PythonResult {
  exitCode: number
  stdout: string
  stderr: string
}

export type PythonRunner = (args: string[], options: { cwd: string; timeoutMs: number; signal?: AbortSignal }) => Promise<PythonResult>

/** The orchestrator, as far as the workflow needs it. `ChatOrchestrator` is one; tests may stand in. */
export interface BriefingChats {
  createChat(actorChatId: string, input: { message: string; title?: string; model?: string; effort?: string }): Promise<AgentChatSummary>
  sendMessage(actorChatId: string, input: { chatId: string; message: string }): Promise<unknown>
  waitForChats(actorChatId: string, input: { chatIds: string[]; mode?: "all" | "any"; timeoutMs?: number }, signal?: AbortSignal): Promise<{ timedOut: boolean; chats: ChatOutcome[] }>
  cancelChat(actorChatId: string, chatId: string): Promise<unknown>
  getChatSummary(chatId: string): AgentChatSummary | null
  getChatOutcome(chatId: string): ChatOutcome | null
}

export const runPython: PythonRunner = async (args, options) => {
  const subprocess = Bun.spawn(["python3", ...args], {
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  })
  const kill = () => subprocess.kill()
  const timer = setTimeout(kill, options.timeoutMs)
  options.signal?.addEventListener("abort", kill, { once: true })
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
      subprocess.exited,
    ])
    return { exitCode, stdout, stderr }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener("abort", kill)
  }
}

export function briefingWorkflowEnabled(env: Record<string, string | undefined> = process.env) {
  return env.NEX_BRIEFING_WORKFLOW === "1"
}

const ROLE_FILES: Record<BriefingRole, string> = {
  chief: "chief-editor.md",
  lead: "country-lead.md",
  scout: "topic-scout.md",
  cross_border: "country-lead.md",
  reviewer: "reviewer.md",
}

const ROLE_NAMES: Record<BriefingRole, string> = {
  chief: "Chief Editor",
  lead: "Country Lead",
  scout: "Topic Scout",
  cross_border: "Cross-border reply",
  reviewer: "Independent Reviewer",
}

const COUNTRY_NAMES: Record<BriefingCountry, string> = { us: "US", cn: "China" }

function iso(time: number) {
  return new Date(time).toISOString()
}

function isTerminal(state: BriefingTaskState) {
  return state === "accepted" || state === "failed" || state === "cancelled"
}

/** A chat state with nothing more to come: its last turn ended and nothing it started is still going. */
function chatIsDone(status: AgentChatStatus | undefined) {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "idle"
}

async function readJson<T = unknown>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T
  } catch {
    return null
  }
}

async function writeJsonAtomic(file: string, value: unknown) {
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  await rename(temp, file)
}

async function sha256(file: string) {
  return createHash("sha256").update(await readFile(file)).digest("hex")
}

/** SHA-256 of a task's record files and saved source texts, keyed by path relative to the task directory. */
export async function hashRecords(dir: string) {
  const hashes: Record<string, string> = {}
  for (const name of RECORD_FILES) {
    if (existsSync(path.join(dir, name))) hashes[name] = await sha256(path.join(dir, name))
  }
  const sources = path.join(dir, "sources")
  if (existsSync(sources)) {
    for (const name of (await readdir(sources)).sort()) {
      if (name.endsWith(".txt")) hashes[`sources/${name}`] = await sha256(path.join(sources, name))
    }
  }
  return hashes
}

/**
 * One section of a markdown file, by heading text, down to the next heading
 * of the same or a higher level. Role files name the sections they need, so
 * the shared rules are written once, in the Skill, and each agent gets only
 * its part.
 */
export function extractSection(markdown: string, heading: string): string | null {
  const lines = markdown.split(/\r?\n/)
  const start = lines.findIndex((line) => {
    const match = line.match(/^(#+)\s+(.*?)\s*$/)
    return match !== null && match[2] === heading
  })
  if (start < 0) return null
  const level = lines[start]!.match(/^(#+)/)![1]!.length
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    const match = lines[index]!.match(/^(#+)\s/)
    if (match && match[1]!.length <= level) {
      end = index
      break
    }
  }
  return lines.slice(start, end).join("\n").trim()
}

function stripFrontmatter(markdown: string) {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim()
}

export async function buildRoleInstructions(skillDir: string, role: BriefingRole) {
  const file = await readFile(path.join(skillDir, "references", "roles", ROLE_FILES[role]), "utf8")
  const meta = parseFrontmatter(file)
  const list = (value?: string) => (value ?? "").split("|").map((entry) => entry.trim()).filter(Boolean)
  const parts = [stripFrontmatter(file)]
  for (const ref of list(meta.includes)) {
    const [rel, heading] = ref.split("#", 2) as [string, string | undefined]
    const source = await readFile(path.join(skillDir, rel), "utf8")
    const body = heading ? extractSection(source, heading) : stripFrontmatter(source)
    if (body === null) throw new Error(`Role file ${ROLE_FILES[role]} names "${ref}", which is not in the Skill.`)
    parts.push(`<!-- from ${ref} -->\n${body}`)
  }
  const reads = list(meta.reads)
  if (reads.length > 0) parts.push(`Read when needed: ${reads.map((rel) => path.join(skillDir, rel)).join(", ")}`)
  return parts.join("\n\n")
}

export function locateBriefingSkill(cwd: string, home?: string) {
  const skill = scanCodexSkills({ cwd, home }).find((entry) => entry.name === BRIEFING_SKILL_NAME)
  if (!skill?.path) return null
  const dir = path.dirname(skill.path)
  return existsSync(path.join(dir, "scripts", "merge_runs.py")) && existsSync(path.join(dir, "references", "roles")) ? dir : null
}

class WorkflowError extends Error {}

interface Deps {
  chats: BriefingChats
  python?: PythonRunner
  now?: () => number
  log?: (line: string) => void
  /** Tests shorten it. How long a chat that went quiet is given before its task is judged. */
  settleGraceMs?: number
  /** Tests point it at a fixture home; production uses the real one. */
  home?: string
  /** Tests shorten it. See `WATCHDOG_MS`. */
  watchdogMs?: number
}

export class BriefingWorkflow {
  private readonly chats: BriefingChats
  private readonly python: PythonRunner
  private readonly now: () => number
  private readonly log: (line: string) => void
  private readonly settleGraceMs: number
  private readonly home?: string
  private readonly runs = new Map<string, BriefingRun>()
  private readonly locks = new Map<string, Promise<unknown>>()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private readonly scannedProjects = new Set<string>()
  private readonly watchdogMs: number
  private watchdog: ReturnType<typeof setInterval> | null = null

  constructor(deps: Deps) {
    this.chats = deps.chats
    this.python = deps.python ?? runPython
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? ((line) => console.log(line))
    this.settleGraceMs = deps.settleGraceMs ?? SETTLE_GRACE_MS
    this.home = deps.home
    this.watchdogMs = deps.watchdogMs ?? WATCHDOG_MS
  }

  dispose() {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    if (this.watchdog) clearInterval(this.watchdog)
    this.watchdog = null
  }

  /** Keeps time budgets enforced while any run is active, and stops once none is. */
  private armWatchdog() {
    if (this.watchdog) return
    this.watchdog = setInterval(() => {
      const active = [...this.runs.values()].filter((run) => run.status === "running")
      if (active.length === 0) {
        clearInterval(this.watchdog!)
        this.watchdog = null
        return
      }
      for (const run of active) {
        void this.withLock(run, () => this.reconcile(run)).catch((error) => {
          this.log(`[briefing] run=${run.runId} watchdog reconcile failed: ${error instanceof Error ? error.message : String(error)}`)
        })
      }
    }, this.watchdogMs)
    this.watchdog.unref?.()
  }

  // ── Lookup ─────────────────────────────────────────────────────────────

  /** Loads the runs of a project from disk once, so a restart picks them back up. */
  private async loadProject(projectPath: string) {
    if (this.scannedProjects.has(projectPath)) return
    this.scannedProjects.add(projectPath)
    const runsDir = path.join(projectPath, "runs")
    if (!existsSync(runsDir)) return
    for (const name of await readdir(runsDir)) {
      const run = await readJson<BriefingRun>(path.join(runsDir, name, "workflow.json"))
      if (run?.schema === WORKFLOW_SCHEMA && !this.runs.has(run.runId)) {
        this.runs.set(run.runId, run)
        if (run.status === "running") this.armWatchdog()
      }
    }
  }

  private findByChat(chatId: string) {
    for (const run of this.runs.values()) {
      const tasks = run.tasks.filter((task) => task.chatId === chatId)
      if (tasks.length > 0) return { run, tasks }
    }
    return null
  }

  private async requireActor(chatId: string, cwd: string, taskId?: string) {
    await this.loadProject(cwd)
    const found = this.findByChat(chatId)
    if (!found) throw new WorkflowError("This chat has no task in a briefing run. Only agents started by briefing_start or briefing_delegate can use this tool.")
    const open = found.tasks.filter((task) => !isTerminal(task.state))
    let task: BriefingTask | undefined
    if (taskId) {
      task = found.tasks.find((entry) => entry.id === taskId)
      if (!task) throw new WorkflowError(`Task ${taskId} is not assigned to this chat. Its tasks: ${found.tasks.map((entry) => entry.id).join(", ")}.`)
    } else if (open.length === 1) {
      task = open[0]
    } else if (open.length === 0) {
      task = found.tasks[found.tasks.length - 1]
    } else {
      throw new WorkflowError(`This chat has several open tasks (${open.map((entry) => entry.id).join(", ")}); pass taskId.`)
    }
    return { run: found.run, task: task! }
  }

  private task(run: BriefingRun, id: string) {
    const task = run.tasks.find((entry) => entry.id === id)
    if (!task) throw new WorkflowError(`Task ${id} is not in run ${run.runId}.`)
    return task
  }

  private taskDir(run: BriefingRun, task: BriefingTask) {
    return path.join(run.runDir, task.dir)
  }

  private children(run: BriefingRun, task: BriefingTask) {
    return run.tasks.filter((entry) => entry.parentTaskId === task.id)
  }

  private latestLead(run: BriefingRun, country: BriefingCountry) {
    return [...run.tasks].reverse().find((task) => task.role === "lead" && task.country === country)
  }

  // ── State ──────────────────────────────────────────────────────────────

  private async withLock<T>(run: BriefingRun, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(run.runId) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(action)
    this.locks.set(run.runId, next.catch(() => {}))
    return next
  }

  private async save(run: BriefingRun) {
    await writeJsonAtomic(path.join(run.runDir, "workflow.json"), run)
  }

  private async record(run: BriefingRun, event: Record<string, unknown>) {
    const line = { at: iso(this.now()), run: run.runId, ...event }
    this.log(`[briefing] ${Object.entries(line).filter(([key]) => key !== "at").map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`).join(" ")}`)
    await appendFile(path.join(run.runDir, "workflow.log.jsonl"), `${JSON.stringify(line)}\n`, "utf8")
  }

  private async setTaskState(run: BriefingRun, task: BriefingTask, state: BriefingTaskState, note?: string) {
    if (task.state === state && !note) return
    task.state = state
    if (isTerminal(state)) task.endedAt = iso(this.now())
    if (state === "failed" || state === "cancelled") task.failure = note ?? task.failure
    await this.record(run, { task: task.id, role: task.role, chat: task.chatId ?? null, state, ...(note ? { note } : {}) })
  }

  private async advance(run: BriefingRun, stage: BriefingStage, note?: string) {
    if (run.stage === stage) return
    run.stage = stage
    run.history.push({ stage, at: iso(this.now()), ...(note ? { note } : {}) })
    await this.record(run, { stage, ...(note ? { note } : {}) })
  }

  // ── Skill scripts ──────────────────────────────────────────────────────

  private async py(run: BriefingRun, args: string[], timeoutMs = PYTHON_TIMEOUT_MS) {
    const [script, ...rest] = args
    return this.python([path.join(run.skillDir, "scripts", script!), ...rest], { cwd: run.skillDir, timeoutMs })
  }

  private async initTaskDir(run: BriefingRun, task: BriefingTask) {
    const dir = this.taskDir(run, task)
    await mkdir(dir, { recursive: true })
    // A reviewer writes findings, not research records.
    if (task.role !== "reviewer" && !existsSync(path.join(dir, "run_config.json"))) {
      const result = await this.py(run, ["brief.py", "init", dir, "--end", run.window.end, "--days", String(this.days(run)),
        "--tz", run.timezone, "--cutoff", run.cutoff, "--lang", "en", "--no-cases"])
      if (result.exitCode !== 0) throw new WorkflowError(`brief.py init failed for ${task.id}: ${result.stderr || result.stdout}`)
    }
    await writeJsonAtomic(path.join(dir, "assignment.json"), {
      run_id: run.runId,
      task_id: task.id,
      role: task.role,
      ...(task.country ? { country: task.country } : {}),
      window: run.window,
      cutoff: run.cutoff,
      timezone: run.timezone,
      ...task.assignment,
    })
  }

  private days(run: BriefingRun) {
    return Math.round((Date.parse(run.window.end) - Date.parse(run.window.start)) / 86_400_000) + 1
  }

  private async checkHandoff(run: BriefingRun, task: BriefingTask) {
    const role = task.role === "chief" ? "chief" : task.role === "cross_border" ? "cross_border" : task.role
    const result = await this.py(run, ["check_handoff.py", this.taskDir(run, task), "--role", role, "--json"])
    const parsed = this.parseJson<{ outcome: string; findings: CheckFinding[]; summary?: unknown }>(result)
    if (!parsed) throw new WorkflowError(`check_handoff.py gave no result: ${result.stderr.trim().slice(-500)}`)
    return parsed
  }

  private parseJson<T>(result: PythonResult): T | null {
    const line = result.stdout.trim().split("\n").filter(Boolean).pop()
    if (!line) return null
    try {
      return JSON.parse(line) as T
    } catch {
      return null
    }
  }

  /** Merges accepted, unmerged tasks into `target`. Called only while target's own agent waits in a briefing tool. */
  private async mergeInto(run: BriefingRun, target: BriefingTask) {
    const pending = run.tasks.filter((task) => task.mergeInto === target.id && task.state === "accepted" && !task.merged)
    if (pending.length === 0) return []
    const args = ["merge_runs.py", this.taskDir(run, target), ...pending.flatMap((task) => ["--from", `${task.id}=${this.taskDir(run, task)}`]), "--json"]
    const parsed = this.parseJson<{ ok: boolean; error?: string; results?: Array<Record<string, unknown>> }>(await this.py(run, args))
    if (!parsed?.ok) throw new WorkflowError(`Merging ${pending.map((task) => task.id).join(", ")} into ${target.id} failed: ${parsed?.error ?? "no result"}`)
    for (const task of pending) {
      task.merged = true
      task.mergeResult = parsed.results?.find((entry) => entry.task === task.id)
      await this.record(run, { task: task.id, merged_into: target.id })
    }
    if (target.role === "lead" && run.stage === "topic_research_completed") await this.advance(run, "country_consolidation")
    return parsed.results ?? []
  }

  // ── Prompts ────────────────────────────────────────────────────────────

  private async prompt(run: BriefingRun, task: BriefingTask, extra = "") {
    const instructions = await buildRoleInstructions(run.skillDir, task.role === "cross_border" ? "lead" : task.role)
    const candidates = path.join(run.runDir, "discovery", "candidates.md")
    const header = [
      `You are the ${task.country ? `${COUNTRY_NAMES[task.country]} ` : ""}${ROLE_NAMES[task.role]} in Nex briefing run ${run.runId}.`,
      "",
      `- Task ID: ${task.id}`,
      `- TASK (your directory): ${this.taskDir(run, task)}`,
      `- RUN (run root): ${run.runDir}`,
      `- SKILL: ${run.skillDir}`,
      `- Window: ${run.window.start} to ${run.window.end} (${run.timezone}); cutoff ${run.cutoff}`,
      existsSync(candidates) ? `- Discovery candidates (unverified leads): ${candidates}` : "- Discovery candidates: none (sweep not run or unavailable)",
      `- Time budget: about ${run.budgets.taskMinutes[task.role]} minutes`,
      "",
      "Assignment:",
      "```json",
      JSON.stringify(task.assignment, null, 2),
      "```",
    ].join("\n")
    return [header, extra, instructions].filter(Boolean).join("\n\n")
  }

  // ── Launching ──────────────────────────────────────────────────────────

  private requesterChat(run: BriefingRun, task: BriefingTask) {
    return task.parentTaskId ? this.task(run, task.parentTaskId).chatId : run.rootChatId
  }

  private async launch(run: BriefingRun, task: BriefingTask) {
    const actor = this.requesterChat(run, task)
    if (!actor) throw new WorkflowError(`Task ${task.id} has no requesting chat.`)
    await this.initTaskDir(run, task)
    const created = await this.chats.createChat(actor, {
      message: await this.prompt(run, task),
      title: `Briefing · ${task.title}`,
      ...(run.run?.model ? { model: run.run.model } : {}),
      ...(run.run?.effort ? { effort: run.run.effort } : {}),
    })
    task.chatId = created.chatId
    task.startedAt = iso(this.now())
    task.deadlineAt = iso(this.now() + run.budgets.taskMinutes[task.role] * 60_000)
    await this.setTaskState(run, task, "running", `chat ${created.chatId}`)
    if (task.role === "scout") await this.advance(run, "topic_research_running")
  }

  /** Starts queued tasks while the budgets allow. A full Nex chat budget leaves them queued. */
  private async pump(run: BriefingRun) {
    for (const task of run.tasks.filter((entry) => entry.state === "queued")) {
      const parent = task.parentTaskId ? this.task(run, task.parentTaskId) : null
      if (run.status !== "running" || (parent && (parent.state === "failed" || parent.state === "cancelled"))) {
        await this.setTaskState(run, task, "cancelled", "its requester is no longer running")
        continue
      }
      if (task.role === "scout") {
        const running = run.tasks.filter((entry) => entry.role === "scout" && entry.state === "running").length
        if (running >= run.budgets.maxConcurrentScouts) continue
      }
      try {
        await this.launch(run, task)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (/still running, which is the limit/.test(message)) return
        await this.setTaskState(run, task, "failed", `could not start: ${message}`)
      }
    }
  }

  // ── Reconciling chats with tasks ───────────────────────────────────────

  /** A chat ran out of turns. Its tasks are judged after a short grace, since a report may be about to wake it. */
  handleChatSettled(chatId: string) {
    const found = this.findByChat(chatId)
    const parentRun = found?.run ?? [...this.runs.values()].find((run) => run.rootChatId === chatId)
    if (!parentRun) return
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      void this.withLock(parentRun, () => this.reconcile(parentRun)).catch((error) => {
        this.log(`[briefing] run=${parentRun.runId} reconcile failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, this.settleGraceMs)
    this.timers.add(timer)
  }

  private async reconcile(run: BriefingRun) {
    // A parent is judged only once its children are, so settle bottom-up until nothing changes.
    for (let pass = 0; pass < 4; pass += 1) {
      if (!(await this.judgeTasks(run))) break
    }
    const chief = run.tasks.find((task) => task.role === "chief")
    if (run.status === "running" && chief && (chief.state === "failed" || chief.state === "cancelled")) {
      run.status = chief.state === "cancelled" ? "cancelled" : "failed"
      await this.record(run, { status: run.status, note: chief.failure })
    }
    const scouts = run.tasks.filter((task) => task.role === "scout")
    if (run.stage === "topic_research_running" && scouts.length > 0 && scouts.every((task) => isTerminal(task.state))) {
      await this.advance(run, "topic_research_completed")
    }
    const leads = (["us", "cn"] as const).map((country) => this.latestLead(run, country))
    if (leads.every((lead) => lead && isTerminal(lead.state)) && ["country_tasks_assigned", "topic_research_running", "topic_research_completed", "country_consolidation"].includes(run.stage)) {
      await this.advance(run, "cross_border_synthesis")
    }
    await this.pump(run)
    await this.save(run)
  }

  /** Judges running tasks whose chats have ended. True when any task changed state. */
  private async judgeTasks(run: BriefingRun) {
    let changed = false
    for (const task of run.tasks.filter((entry) => entry.state === "queued")) {
      const parentChat = task.parentTaskId ? this.task(run, task.parentTaskId).chatId : undefined
      const status = parentChat ? this.chats.getChatSummary(parentChat)?.status : undefined
      if (status === "cancelled" || status === "failed") {
        await this.setTaskState(run, task, "cancelled", "its requester stopped before it started")
        changed = true
      }
    }
    for (const task of run.tasks.filter((entry) => entry.state === "running")) {
      if (!task.chatId) continue
      const summary = this.chats.getChatSummary(task.chatId)
      if (!summary) {
        await this.setTaskState(run, task, "failed", "its chat was deleted")
        changed = true
        continue
      }
      if (task.deadlineAt && Date.parse(task.deadlineAt) < this.now() && !chatIsDone(summary.status)) {
        await this.chats.cancelChat(this.requesterChat(run, task) ?? run.rootChatId, task.chatId).catch(() => {})
        await this.setTaskState(run, task, "failed", `timed out after ${run.budgets.taskMinutes[task.role]} minutes`)
        changed = true
        continue
      }
      if (!chatIsDone(summary.status)) continue
      if (summary.status !== "cancelled" && this.children(run, task).some((child) => !isTerminal(child.state))) continue
      changed = true
      if (summary.status === "cancelled") {
        await this.setTaskState(run, task, "cancelled", "its chat was stopped")
      } else if (summary.status === "failed") {
        const outcome = this.chats.getChatOutcome(task.chatId)
        await this.setTaskState(run, task, "failed", `turn failed: ${outcome?.finalMessage?.slice(0, 300) ?? "unknown error"}`)
      } else {
        await this.setTaskState(run, task, "failed", task.submissions > 0
          ? `turn ended after ${task.submissions} refused submission(s): ${(task.lastRejection ?? []).slice(0, 3).join("; ")}`
          : "turn ended without an accepted submission")
      }
    }
    return changed
  }

  // ── Tools ──────────────────────────────────────────────────────────────

  async start(actorChatId: string, cwd: string, input: {
    request: string
    end?: string
    days?: number
    timezone?: string
    discovery?: boolean
    model?: string
    effort?: string
  }) {
    await this.loadProject(cwd)
    if (this.findByChat(actorChatId)) throw new WorkflowError("This chat is already an agent in a briefing run; it cannot start another.")
    const actor = this.chats.getChatSummary(actorChatId)
    if (actor?.createdByChatId) {
      throw new WorkflowError("Start the multi-agent briefing from a chat the user started: the hierarchy needs all three levels of Nex sub-chats.")
    }
    const skillDir = locateBriefingSkill(cwd, this.home)
    if (!skillDir) throw new WorkflowError(`The ${BRIEFING_SKILL_NAME} Skill with multi-agent support (scripts/merge_runs.py, references/roles/) is not installed for this project.`)
    const budgets = await this.loadBudgets(skillDir)
    const stamp = new Date(this.now()).toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-")
    const runId = `mas-${stamp}-${randomBytes(2).toString("hex")}`
    const runDir = path.join(cwd, "runs", runId)
    await mkdir(runDir, { recursive: true })
    const days = input.days ?? budgets.days
    const timezone = input.timezone ?? "Asia/Hong_Kong"
    const init = await this.python([path.join(skillDir, "scripts", "brief.py"), "init", runDir, "--days", String(days), "--tz", timezone, "--lang", "en",
      ...(input.end ? ["--end", input.end] : [])], { cwd: skillDir, timeoutMs: PYTHON_TIMEOUT_MS })
    if (init.exitCode !== 0) throw new WorkflowError(`brief.py init failed: ${init.stderr || init.stdout}`)
    const config = await readJson<{ window: { start: string; end: string }; cutoff: string; timezone: string }>(path.join(runDir, "run_config.json"))
    if (!config) throw new WorkflowError("brief.py init wrote no run_config.json")
    const run: BriefingRun = {
      schema: WORKFLOW_SCHEMA,
      runId,
      projectPath: cwd,
      rootChatId: actorChatId,
      runDir,
      skillDir,
      request: input.request,
      window: config.window,
      cutoff: config.cutoff,
      timezone: config.timezone,
      budgets,
      run: { ...(input.model ? { model: input.model } : {}), ...(input.effort ? { effort: input.effort } : {}) },
      stage: "request_received",
      status: "running",
      history: [{ stage: "request_received", at: iso(this.now()) }],
      tasks: [],
      draftAttempts: 0,
      reviewRounds: 0,
      reworkRounds: 0,
      crossBorderCount: 0,
    }
    this.runs.set(runId, run)
    this.armWatchdog()
    await this.record(run, { stage: "request_received", window: run.window, cutoff: run.cutoff })
    if (input.discovery ?? budgets.discovery) {
      const sweep = await this.python([path.join(skillDir, "scripts", "discover.py"), "--start", run.window.start, "--end", run.window.end,
        "--out", path.join(runDir, "discovery"), "--tz", timezone], { cwd: skillDir, timeoutMs: DISCOVERY_TIMEOUT_MS })
      run.discovery = { ok: sweep.exitCode === 0, note: (sweep.exitCode === 0 ? sweep.stdout : sweep.stderr || sweep.stdout).trim().slice(-500) }
      await this.record(run, { discovery: run.discovery.ok ? "ok" : "unavailable", note: run.discovery.note.split("\n")[0] })
    } else {
      run.discovery = { ok: false, note: "discovery sweep not requested" }
    }
    const chief: BriefingTask = {
      id: "chief",
      role: "chief",
      title: "Chief Editor",
      dir: ".",
      state: "queued",
      attempt: 1,
      assignment: { request: input.request },
      createdAt: iso(this.now()),
      submissions: 0,
    }
    return this.withLock(run, async () => {
      // Added under the lock, so no reconcile can start it a second time.
      run.tasks.push(chief)
      await this.writeChiefAssignment(run, chief)
      const created = await this.chats.createChat(actorChatId, {
        message: await this.prompt(run, chief),
        title: "Briefing · Chief Editor",
        ...(run.run?.model ? { model: run.run.model } : {}),
        ...(run.run?.effort ? { effort: run.run.effort } : {}),
      })
      chief.chatId = created.chatId
      chief.startedAt = iso(this.now())
      chief.deadlineAt = iso(this.now() + budgets.taskMinutes.chief * 60_000)
      await this.setTaskState(run, chief, "running", `chat ${created.chatId}`)
      await this.save(run)
      return { runId, runDir, chiefChatId: created.chatId, window: run.window, cutoff: run.cutoff, discovery: run.discovery,
        next: "The Chief Editor runs as a sub-chat and reports back here when the run ends. End your turn now." }
    })
  }

  private async writeChiefAssignment(run: BriefingRun, chief: BriefingTask) {
    await writeJsonAtomic(path.join(run.runDir, "assignment.json"), {
      run_id: run.runId, task_id: chief.id, role: "chief", window: run.window, cutoff: run.cutoff, timezone: run.timezone, ...chief.assignment,
    })
  }

  private async loadBudgets(skillDir: string): Promise<BriefingBudgets> {
    const raw = await readJson<Record<string, unknown>>(path.join(skillDir, "references", "roles", "workflow.json")) ?? {}
    const number = (key: string, fallback: number) => (typeof raw[key] === "number" && (raw[key] as number) >= 0 ? raw[key] as number : fallback)
    const minutes = (raw.task_minutes ?? {}) as Partial<Record<BriefingRole, number>>
    return {
      maxScoutsPerLead: number("max_scouts_per_lead", DEFAULT_BUDGETS.maxScoutsPerLead),
      maxConcurrentScouts: Math.max(1, number("max_concurrent_scouts", DEFAULT_BUDGETS.maxConcurrentScouts)),
      maxTaskAttempts: Math.max(1, number("max_task_attempts", DEFAULT_BUDGETS.maxTaskAttempts)),
      maxCrossBorderRequests: number("max_cross_border_requests", DEFAULT_BUDGETS.maxCrossBorderRequests),
      maxReworkRounds: number("max_rework_rounds", DEFAULT_BUDGETS.maxReworkRounds),
      maxDraftAttempts: Math.max(1, number("max_draft_attempts", DEFAULT_BUDGETS.maxDraftAttempts)),
      taskMinutes: { ...DEFAULT_BUDGETS.taskMinutes, ...minutes },
      discovery: typeof raw.discovery === "boolean" ? raw.discovery : DEFAULT_BUDGETS.discovery,
      days: number("days", DEFAULT_BUDGETS.days),
    }
  }

  async delegate(actorChatId: string, cwd: string, input: {
    role: "lead" | "scout"
    country?: BriefingCountry
    topic?: string
    category?: string
    questions?: string[]
    cases?: string[]
    leads?: string[]
    brief?: string
    retryOf?: string
    reworkOf?: string
    findings?: string[]
    forTaskId?: string
  }) {
    const { run, task: requester } = await this.requireActor(actorChatId, cwd, input.forTaskId)
    return this.withLock(run, async () => {
      if (run.status !== "running") throw new WorkflowError(`Run ${run.runId} is ${run.status}; nothing more can be delegated.`)
      if (isTerminal(requester.state)) throw new WorkflowError(`Task ${requester.id} is ${requester.state}; it cannot delegate.`)
      if (input.reworkOf) return this.reopenForRework(run, requester, input.reworkOf, input.findings ?? [], input.brief ?? "")
      const previous = input.retryOf ? this.task(run, input.retryOf) : null
      if (previous) {
        if (previous.parentTaskId !== requester.id) throw new WorkflowError(`${previous.id} was not delegated by ${requester.id}.`)
        if (previous.state !== "failed" && previous.state !== "cancelled") throw new WorkflowError(`${previous.id} is ${previous.state}; only a failed or cancelled task is retried.`)
        if (previous.attempt >= run.budgets.maxTaskAttempts) throw new WorkflowError(`${previous.id} has used its ${run.budgets.maxTaskAttempts} attempts. Record the gap instead.`)
        if (run.tasks.some((task) => task.retryOf === previous.id)) throw new WorkflowError(`${previous.id} has already been retried.`)
      }
      let task: BriefingTask
      if (input.role === "lead") {
        if (requester.role !== "chief") throw new WorkflowError("Only the Chief Editor delegates country leads.")
        if (!run.plan) throw new WorkflowError("Submit the research plan first (write plan.json, then briefing_submit with kind plan).")
        const country = input.country ?? previous?.country
        if (!country) throw new WorkflowError("A lead needs country us or cn.")
        const existing = this.latestLead(run, country)
        if (existing && !previous) throw new WorkflowError(`The ${COUNTRY_NAMES[country]} lead is already ${existing.id} (${existing.state}). Retry a failed one with retryOf, or send rework with reworkOf.`)
        const plan = run.plan.countries[country]
        const attempt = previous ? previous.attempt + 1 : 1
        task = this.newTask(run, {
          id: attempt > 1 ? `${country}-lead-a${attempt}` : `${country}-lead`,
          role: "lead",
          country,
          title: `${COUNTRY_NAMES[country]} Lead`,
          parentTaskId: requester.id,
          mergeInto: requester.id,
          attempt,
          retryOf: previous?.id,
          assignment: {
            country,
            focus: run.plan.focus,
            brief: input.brief ? `${plan.brief}\n\n${input.brief}` : plan.brief,
            suggested_categories: plan.categories,
            cases: plan.cases,
            cross_border_watch: run.plan.cross_border_watch,
          },
        })
      } else {
        if (requester.role !== "lead" && requester.role !== "cross_border") throw new WorkflowError("Only a country lead delegates scouts.")
        const country = requester.country!
        const own = run.tasks.filter((entry) => entry.role === "scout" && entry.parentTaskId === requester.id && !entry.retryOf)
        if (!previous && own.length >= run.budgets.maxScoutsPerLead) {
          throw new WorkflowError(`${requester.id} has used its budget of ${run.budgets.maxScoutsPerLead} scouts. Fill the gap yourself or record it in gaps.`)
        }
        if (!previous && !input.topic?.trim()) throw new WorkflowError("A scout needs a topic.")
        const attempt = previous ? previous.attempt + 1 : 1
        const sequence = run.tasks.filter((entry) => entry.role === "scout" && entry.country === country && !entry.retryOf).length + 1
        task = this.newTask(run, {
          id: previous ? `${previous.id.replace(/-a\d+$/, "")}-a${attempt}` : `${country}-s${String(sequence).padStart(2, "0")}`,
          role: "scout",
          country,
          title: `${COUNTRY_NAMES[country]} Scout · ${(input.topic ?? String(previous?.assignment.topic ?? "")).slice(0, 40)}`,
          parentTaskId: requester.id,
          mergeInto: requester.id,
          attempt,
          retryOf: previous?.id,
          assignment: previous ? { ...previous.assignment, retry_note: input.brief ?? `Retry of ${previous.id}: ${previous.failure ?? ""}` } : {
            country,
            topic: input.topic,
            ...(input.category ? { category: input.category } : {}),
            questions: input.questions ?? [],
            cases: input.cases ?? [],
            discovery_leads: input.leads ?? [],
            ...(input.brief ? { brief: input.brief } : {}),
          },
        })
      }
      await this.record(run, { task: task.id, role: task.role, delegated_by: requester.id, state: "queued" })
      await this.pump(run)
      if (task.role === "lead" && run.stage === "research_plan_created" && (["us", "cn"] as const).every((country) => this.latestLead(run, country))) {
        await this.advance(run, "country_tasks_assigned")
      }
      await this.save(run)
      return { taskId: task.id, state: task.state, chatId: task.chatId ?? null, dir: this.taskDir(run, task),
        note: task.state === "queued" ? "Queued: it starts when a scout slot frees. briefing_wait covers queued tasks." : "Started. Use briefing_wait for its result." }
    })
  }

  private newTask(run: BriefingRun, fields: Omit<BriefingTask, "dir" | "state" | "createdAt" | "submissions">): BriefingTask {
    if (run.tasks.some((task) => task.id === fields.id)) throw new WorkflowError(`Task ${fields.id} already exists.`)
    const task: BriefingTask = { ...fields, dir: path.join("tasks", fields.id), state: "queued", createdAt: iso(this.now()), submissions: 0 }
    run.tasks.push(task)
    return task
  }

  /** Sends targeted rework to an accepted lead. Its chat keeps its context; its next acceptance replaces the last. */
  private async reopenForRework(run: BriefingRun, requester: BriefingTask, taskId: string, findings: string[], brief: string) {
    if (requester.role !== "chief") throw new WorkflowError("Only the Chief Editor sends rework.")
    if (run.stage !== "rework") throw new WorkflowError("Rework goes out after a review asks for it.")
    const target = this.task(run, taskId)
    if (target.role !== "lead" || target.state !== "accepted" || !target.chatId) throw new WorkflowError(`${taskId} is not an accepted lead task.`)
    const review = [...run.tasks].reverse().find((task) => task.role === "reviewer" && task.state === "accepted")
    const known = new Map(((review?.accepted?.output as { findings?: Array<{ id: string }> })?.findings ?? []).map((finding) => [finding.id, finding]))
    const unknown = findings.filter((id) => !known.has(id))
    if (findings.length === 0 || unknown.length > 0) throw new WorkflowError(`Name the review findings to fix (unknown: ${unknown.join(", ") || "none given"}).`)
    target.previous = [...(target.previous ?? []), { at: target.accepted!.at, hashes: target.accepted!.hashes }]
    target.accepted = null
    target.merged = false
    target.delivered = false
    target.deadlineAt = iso(this.now() + run.budgets.taskMinutes.lead * 60_000)
    await this.setTaskState(run, target, "running", `reopened for rework: ${findings.join(", ")}`)
    await this.chats.sendMessage(requester.chatId!, {
      chatId: target.chatId,
      message: [
        `Rework for task ${target.id} in briefing run ${run.runId}, requested by the Chief Editor after independent review.`,
        "Fix only what these findings concern, in your task directory, with brief.py (withdraw wrong claims; add corrected ones with add-claim).",
        "Then update narrative.md and output.json, run check_handoff.py --role lead, and call briefing_submit again.",
        "",
        "```json",
        JSON.stringify(findings.map((id) => known.get(id)), null, 2),
        "```",
        brief,
      ].join("\n"),
    })
    await this.save(run)
    return { taskId: target.id, state: target.state, chatId: target.chatId, dir: this.taskDir(run, target), note: "Sent to the lead's chat. Use briefing_wait for its resubmission." }
  }

  async crossBorder(actorChatId: string, cwd: string, input: {
    fromTaskId: string
    toCountry: BriefingCountry
    question: string
    eventIds: string[]
    scope: string
    evidenceRequired: string
  }) {
    const { run, task: chief } = await this.requireActor(actorChatId, cwd)
    return this.withLock(run, async () => {
      if (chief.role !== "chief") throw new WorkflowError("Cross-border requests go through the Chief Editor.")
      if (run.crossBorderCount >= run.budgets.maxCrossBorderRequests) throw new WorkflowError(`The run's budget of ${run.budgets.maxCrossBorderRequests} cross-border requests is used.`)
      const from = this.task(run, input.fromTaskId)
      const recordsDir = from.role === "chief" ? run.runDir : this.taskDir(run, from)
      const events = (await readJson<{ events: Array<{ id: string; title: string; date?: string; side?: string; proposed?: boolean }> }>(path.join(recordsDir, "events.json")))?.events ?? []
      const missing = input.eventIds.filter((id) => !events.some((event) => event.id === id))
      if (input.eventIds.length === 0 || missing.length > 0) {
        throw new WorkflowError(`Name the events the question rests on, as IDs in ${from.id}'s records (not found: ${missing.join(", ") || "none given"}).`)
      }
      const target = this.latestLead(run, input.toCountry)
      if (!target?.chatId || target.state === "failed" || target.state === "cancelled" || target.state === "queued") {
        throw new WorkflowError(`The ${COUNTRY_NAMES[input.toCountry]} lead is not available to answer.`)
      }
      run.crossBorderCount += 1
      const task = this.newTask(run, {
        id: `xb-${String(run.crossBorderCount).padStart(2, "0")}`,
        role: "cross_border",
        country: input.toCountry,
        title: `Cross-border → ${COUNTRY_NAMES[input.toCountry]}`,
        parentTaskId: chief.id,
        mergeInto: chief.id,
        attempt: 1,
        assignment: {
          question: input.question,
          scope: input.scope,
          evidence_required: input.evidenceRequired,
          from_task: from.id,
          context_events: events.filter((event) => input.eventIds.includes(event.id)),
        },
      })
      task.chatId = target.chatId
      await this.initTaskDir(run, task)
      task.startedAt = iso(this.now())
      task.deadlineAt = iso(this.now() + run.budgets.taskMinutes.cross_border * 60_000)
      await this.setTaskState(run, task, "running", `sent to ${target.id} (chat ${target.chatId})`)
      await this.chats.sendMessage(chief.chatId!, {
        chatId: target.chatId,
        message: [
          `Cross-border request ${task.id} for you, the ${COUNTRY_NAMES[input.toCountry]} lead, from the Chief Editor (raised by ${from.id}).`,
          `Work in ${this.taskDir(run, task)} (initialised; assignment.json has the question and context events).`,
          "Follow the cross-border section of your instructions: evidence in brief.py records, the answer in narrative.md,",
          `output.json with "answer" and "remaining_uncertainty", then briefing_submit with taskId ${task.id}.`,
          "",
          "```json",
          JSON.stringify(task.assignment, null, 2),
          "```",
        ].join("\n"),
      })
      await this.advance(run, "cross_border_synthesis")
      await this.save(run)
      return { taskId: task.id, state: task.state, toTask: target.id, note: "Use briefing_wait for the reply." }
    })
  }

  async submit(actorChatId: string, cwd: string, input: { kind?: "result" | "plan" | "draft" | "review"; taskId?: string; partialReason?: string }) {
    const { run, task } = await this.requireActor(actorChatId, cwd, input.taskId)
    return this.withLock(run, async () => {
      if (isTerminal(task.state)) throw new WorkflowError(`Task ${task.id} is already ${task.state}.`)
      task.submissions += 1
      const kind = input.kind ?? (task.role === "chief" ? "draft" : task.role === "reviewer" ? "review" : "result")
      let result: Record<string, unknown>
      if (task.role === "chief" && kind === "plan") result = await this.submitPlan(run, task)
      else if (task.role === "chief" && kind === "draft") result = await this.submitDraft(run, task, input.partialReason)
      else if (task.role === "reviewer") result = await this.submitReview(run, task)
      else if (task.role !== "chief") result = await this.submitResult(run, task)
      else throw new WorkflowError(`The Chief Editor submits kind plan or draft, not ${kind}.`)
      if (result.accepted === false) {
        task.lastRejection = (result.problems as string[] | undefined) ?? []
        await this.record(run, { task: task.id, submission: "refused", problems: task.lastRejection.length })
      }
      await this.save(run)
      return result
    })
  }

  private refuse(problems: string[], extra: Record<string, unknown> = {}) {
    return { accepted: false, problems: problems.slice(0, 40), ...extra, next: "Fix these in your records, then call briefing_submit again." }
  }

  private async readOutput(run: BriefingRun, task: BriefingTask, file: string, schema: z.ZodType) {
    const raw = await readJson(path.join(this.taskDir(run, task), file))
    if (raw === null) return { problems: [`${file} is missing or not valid JSON in ${this.taskDir(run, task)}`] }
    const parsed = schema.safeParse(raw)
    if (!parsed.success) return { problems: describeIssues(parsed.error).map((line) => `${file} ${line}`) }
    return { value: parsed.data as Record<string, unknown> }
  }

  private async accept(run: BriefingRun, task: BriefingTask, output: unknown, findings: CheckFinding[], summary?: unknown) {
    task.accepted = { at: iso(this.now()), hashes: await hashRecords(this.taskDir(run, task)), output, findings, summary }
    task.delivered = false
    await writeJsonAtomic(path.join(this.taskDir(run, task), "submission.json"), {
      task_id: task.id, accepted_at: task.accepted.at, hashes: task.accepted.hashes, findings, summary,
    })
    await this.setTaskState(run, task, "accepted")
  }

  private async submitResult(run: BriefingRun, task: BriefingTask) {
    const pending = this.children(run, task).filter((child) => !isTerminal(child.state))
    if (pending.length > 0) return this.refuse([`Wait for ${pending.map((child) => child.id).join(", ")} first (briefing_wait), or record them as gaps after they end.`])
    await this.mergeInto(run, task)
    const { value: output, problems } = await this.readOutput(run, task, "output.json", outputSchemaFor(task.role))
    if (!output) return this.refuse(problems!)
    const issues: string[] = []
    if (output.task_id !== task.id) issues.push(`output.json task_id is ${String(output.task_id)}, expected ${task.id}`)
    if (task.role === "lead") {
      const gaps = (output.gaps as Array<{ task_id?: string }>).map((gap) => gap.task_id)
      for (const child of this.children(run, task).filter((entry) => entry.state !== "accepted")) {
        const replaced = run.tasks.some((entry) => entry.retryOf === child.id && entry.state === "accepted")
        if (!replaced && !gaps.includes(child.id)) issues.push(`output.json gaps must list ${child.id} (${child.state}: ${child.failure ?? ""})`)
      }
    }
    const check = await this.checkHandoff(run, task)
    const fails = check.findings.filter((finding) => finding.status === "FAIL")
    issues.push(...fails.map((finding) => `${finding.code}: ${finding.message}`))
    if (issues.length > 0) return this.refuse(issues)
    await this.accept(run, task, output, check.findings.filter((finding) => finding.status !== "PASS"), check.summary)
    return { accepted: true, taskId: task.id, warnings: check.findings.filter((finding) => finding.status === "UNVERIFIED").map((finding) => `${finding.code}: ${finding.message}`).slice(0, 20),
      next: "Accepted. End your turn with a two-line summary; your records travel with the handoff." }
  }

  private async submitPlan(run: BriefingRun, task: BriefingTask) {
    if (run.plan) return this.refuse(["The plan is already accepted."])
    const { value, problems } = await this.readOutput(run, task, "plan.json", planSchema)
    if (!value) return this.refuse(problems!)
    const plan = value as BriefingPlan
    const categories = new Set(((await readJson<{ categories: Array<{ id: string }> }>(path.join(run.skillDir, "references", "roles", "categories.json")))?.categories ?? []).map((entry) => entry.id))
    const issues = (["us", "cn"] as const).flatMap((country) => plan.countries[country].categories
      .filter((category) => !categories.has(category))
      .map((category) => `countries.${country}.categories: unknown category "${category}" (see references/roles/categories.json)`))
    if (issues.length > 0) return this.refuse(issues)
    run.plan = plan
    await this.advance(run, "research_plan_created")
    return { accepted: true, next: "Delegate both country leads with briefing_delegate (role lead, country us and cn), then briefing_wait." }
  }

  private async submitDraft(run: BriefingRun, chief: BriefingTask, partialReason?: string) {
    if (!run.plan) return this.refuse(["Submit the plan first."])
    if (run.stage === "independent_review") return this.refuse(["The draft is under independent review; briefing_wait for the review task."])
    run.draftAttempts += 1
    if (run.draftAttempts > run.budgets.maxDraftAttempts) {
      await this.finalize(run, { reason: `draft refused ${run.budgets.maxDraftAttempts} times`, status: "blocked" })
      return { accepted: false, problems: ["Draft budget used up; the run is closed as blocked. Report this to the user."], runStatus: run.status }
    }
    const pending = run.tasks.filter((task) => task.id !== chief.id && !isTerminal(task.state))
    if (pending.length > 0) return this.refuse([`Still running: ${pending.map((task) => task.id).join(", ")}. briefing_wait for them first.`])
    const missing = (["us", "cn"] as const).filter((country) => this.latestLead(run, country)?.state !== "accepted")
    if (missing.length > 0) {
      if (!partialReason?.trim()) {
        return this.refuse([`No accepted ${missing.map((country) => COUNTRY_NAMES[country]).join(" and ")} lead research. Retry the lead (briefing_delegate with retryOf), or submit with partialReason to continue as a partial run.`])
      }
      run.partialReason = `${missing.map((country) => `${COUNTRY_NAMES[country]} lead research missing`).join("; ")}: ${partialReason.trim()}`
    }
    await this.mergeInto(run, chief)
    if (!existsSync(path.join(run.runDir, "report.json"))) return this.refuse(["report.json is missing in the run root."])
    const check = await this.checkHandoff(run, chief)
    const handoffFails = check.findings.filter((finding) => finding.status === "FAIL")
    if (handoffFails.length > 0) return this.refuse(handoffFails.map((finding) => `${finding.code}: ${finding.message}`))
    const provenance = this.parseJson<{ outcome: string; findings: CheckFinding[] }>(await this.py(run, ["check_provenance.py", run.runDir, "--json"]))
    if (!provenance) return this.refuse(["check_provenance.py gave no result"])
    if (provenance.outcome === "FAIL") {
      return this.refuse(provenance.findings.filter((finding) => finding.status === "FAIL").map((finding) => `${finding.code}: ${finding.message}`))
    }
    await this.advance(run, "render_and_validate", "draft build")
    const build = await this.py(run, ["brief.py", "build", run.runDir])
    const builtAt = existsSync(path.join(run.runDir, "report.html")) ? (await stat(path.join(run.runDir, "report.html"))).mtimeMs : 0
    if (build.stdout.includes("Not ready to build") || builtAt === 0) {
      return this.refuse(build.stdout.split("\n").filter((line) => line.startsWith("TODO")).concat(build.exitCode !== 0 && !build.stdout ? [build.stderr.slice(-500)] : []))
    }
    const qa = await readJson<{ readiness: string }>(path.join(run.runDir, "qa", "review_report.json"))
    if (!qa || qa.readiness === "BLOCKED") {
      return this.refuse(["The validator blocked the report (qa/review_report.md):", ...build.stdout.split("\n").filter((line) => /^\s*(FIX|\d+\.)/.test(line)).slice(0, 25)])
    }
    run.draft = { at: iso(this.now()), hashes: await this.draftHashes(run), readiness: qa.readiness }
    await this.advance(run, "editorial_draft_completed", `validator readiness ${qa.readiness}`)
    run.reviewRounds += 1
    const reviewer = this.newTask(run, {
      id: `review-${run.reviewRounds}`,
      role: "reviewer",
      title: `Independent Reviewer · round ${run.reviewRounds}`,
      parentTaskId: chief.id,
      attempt: 1,
      assignment: {
        round: run.reviewRounds,
        narratives: run.tasks.filter((task) => task.state === "accepted" && task.role !== "reviewer" && existsSync(path.join(this.taskDir(run, task), "narrative.md")))
          .map((task) => path.join(this.taskDir(run, task), "narrative.md")),
        partial: run.partialReason ?? null,
      },
    })
    await this.launch(run, reviewer)
    await this.advance(run, "independent_review", reviewer.id)
    return { accepted: true, readiness: qa.readiness, provenance: provenance.outcome, reviewTask: reviewer.id,
      next: `Draft built (${path.join(run.runDir, "report.html")}). Independent review ${reviewer.id} started: briefing_wait for it.` }
  }

  private async draftHashes(run: BriefingRun) {
    const hashes: Record<string, string> = {}
    for (const name of ["report.html", "report_ledger.json", "report.json", "evidence_ledger.json", "events.json", "coverage.json"]) {
      if (existsSync(path.join(run.runDir, name))) hashes[name] = await sha256(path.join(run.runDir, name))
    }
    return hashes
  }

  private async submitReview(run: BriefingRun, task: BriefingTask) {
    const { value, problems } = await this.readOutput(run, task, "findings.json", reviewSchema)
    if (!value) return this.refuse(problems!)
    const review = value as BriefingReview
    const ledger = await readJson<{ claims: Array<{ id: string; provenance?: Array<{ task: string }> }>; withdrawn?: Array<{ claim: { id: string; provenance?: Array<{ task: string }> } }> }>(path.join(run.runDir, "evidence_ledger.json"))
    const events = (await readJson<{ events: Array<{ id: string; provenance?: Array<{ task: string }> }> }>(path.join(run.runDir, "events.json")))?.events ?? []
    const claims = [...(ledger?.claims ?? []), ...(ledger?.withdrawn ?? []).map((entry) => entry.claim)]
    const issues: string[] = []
    for (const finding of review.findings) {
      if (finding.target.claim_id && !claims.some((claim) => claim.id === finding.target.claim_id)) issues.push(`${finding.id}: claim ${finding.target.claim_id} is not in RUN/evidence_ledger.json`)
      if (finding.target.event_id && !events.some((event) => event.id === finding.target.event_id)) issues.push(`${finding.id}: event ${finding.target.event_id} is not in RUN/events.json`)
    }
    if (issues.length > 0) return this.refuse(issues)
    const routed = review.findings.map((finding) => {
      const origin = finding.target.claim_id
        ? claims.find((claim) => claim.id === finding.target.claim_id)?.provenance
        : finding.target.event_id ? events.find((event) => event.id === finding.target.event_id)?.provenance : undefined
      const responsible = [...new Set((origin ?? []).map((entry) => entry.task))].filter((id) => run.tasks.some((entry) => entry.id === id))
      return { ...finding, responsible: responsible.length > 0 ? responsible : ["chief"] }
    })
    await this.accept(run, task, { ...review, findings: routed }, [])
    if (review.verdict === "pass") {
      await this.finalize(run, { reason: "independent review passed" })
    } else if (run.reworkRounds >= run.budgets.maxReworkRounds) {
      await this.finalize(run, { reason: `review still asks for rework after ${run.reworkRounds} round(s)`, status: "escalated", unresolved: routed })
    } else {
      run.reworkRounds += 1
      await this.advance(run, "rework", `round ${run.reworkRounds}: ${routed.length} finding(s)`)
    }
    return { accepted: true, verdict: review.verdict, next: "Accepted. End your turn with a one-line summary." }
  }

  /** Closes the run with a status that says exactly what is and is not established. */
  private async finalize(run: BriefingRun, input: { reason: string; status?: BriefingRunStatus; unresolved?: unknown[] }) {
    const reasons = [input.reason]
    let status: BriefingRunStatus = input.status ?? "ready_for_human_review"
    let readiness: string | undefined
    let provenanceOutcome: string | undefined
    if (run.draft) {
      const now = await this.draftHashes(run)
      const changed = Object.keys(run.draft.hashes).filter((name) => now[name] !== run.draft!.hashes[name])
      if (changed.length > 0) {
        status = "blocked"
        reasons.push(`changed after the reviewed draft was built: ${changed.join(", ")}`)
      }
      readiness = (await readJson<{ readiness: string }>(path.join(run.runDir, "qa", "review_report.json")))?.readiness
      const provenance = this.parseJson<{ outcome: string }>(await this.py(run, ["check_provenance.py", run.runDir, "--json"]))
      provenanceOutcome = provenance?.outcome ?? "not run"
      if (readiness === "BLOCKED" || provenanceOutcome === "FAIL" || provenanceOutcome === "not run") {
        status = "blocked"
        reasons.push(`validator ${readiness}, provenance ${provenanceOutcome}`)
      }
    } else if (status === "ready_for_human_review") {
      status = "blocked"
      reasons.push("no accepted draft")
    }
    if (status === "ready_for_human_review" && (run.partialReason || readiness === "INCOMPLETE")) {
      status = "incomplete"
      reasons.push(run.partialReason ?? "validator readiness INCOMPLETE")
    }
    run.status = status
    run.final = { at: iso(this.now()), status, readiness, provenance: provenanceOutcome, reasons, unresolvedFindings: input.unresolved ?? [] }
    await this.advance(run, "finalized", status)
    const chief = run.tasks.find((task) => task.role === "chief")
    if (chief && !isTerminal(chief.state)) await this.accept(run, chief, run.final, [])
    if (existsSync(path.join(run.runDir, "qa"))) await writeFile(path.join(run.runDir, "qa", "workflow_summary.md"), this.summaryMarkdown(run), "utf8")
    await this.record(run, { status, reasons })
  }

  private summaryMarkdown(run: BriefingRun) {
    const lines = [
      `# Multi-agent run ${run.runId}`,
      "",
      `- Status: **${run.status}**${run.final ? ` (${run.final.reasons.join("; ")})` : ""}`,
      `- Window: ${run.window.start} to ${run.window.end} (${run.timezone}); cutoff ${run.cutoff}`,
      `- Validator readiness: ${run.final?.readiness ?? "not run"}; provenance: ${run.final?.provenance ?? "not run"}`,
      `- Review rounds: ${run.reviewRounds}; rework rounds: ${run.reworkRounds}; cross-border requests: ${run.crossBorderCount}`,
      ...(run.partialReason ? [`- Missing input: ${run.partialReason}`] : []),
      "- Human sign-off is still required: qa/signoff.md. Mechanical checks and the agent review do not establish factual accuracy.",
      "",
      "| Task | Role | Chat | State | Started | Ended | Note |",
      "|---|---|---|---|---|---|---|",
      ...run.tasks.map((task) => `| ${task.id} | ${task.role}${task.country ? ` (${task.country})` : ""} | ${task.chatId ?? "—"} | ${task.state} | ${task.startedAt ?? "—"} | ${task.endedAt ?? "—"} | ${(task.failure ?? "").replace(/\|/g, "/")} |`),
      "",
      "## Stages",
      "",
      ...run.history.map((entry) => `- ${entry.at} ${entry.stage}${entry.note ? `: ${entry.note}` : ""}`),
    ]
    if (run.final?.unresolvedFindings.length) {
      lines.push("", "## Unresolved review findings", "", "```json", JSON.stringify(run.final.unresolvedFindings, null, 2), "```")
    }
    return `${lines.join("\n")}\n`
  }

  async wait(actorChatId: string, cwd: string, input: { taskIds?: string[]; timeoutSeconds?: number; forTaskId?: string }, signal?: AbortSignal) {
    const { run, task: actor } = await this.requireActor(actorChatId, cwd, input.forTaskId)
    const timeoutMs = Math.min(MAX_WAIT_MS, (input.timeoutSeconds ?? DEFAULT_WAIT_MS / 1000) * 1000)
    const deadline = this.now() + timeoutMs
    const ownTasks = run.tasks.filter((task) => task.chatId === actorChatId).map((task) => task.id)
    const targets = () => {
      const all = run.tasks.filter((task) => task.parentTaskId && ownTasks.includes(task.parentTaskId))
      if (input.taskIds?.length) return all.filter((task) => input.taskIds!.includes(task.id))
      return all.filter((task) => !task.delivered)
    }
    if (input.taskIds?.length) {
      const unknown = input.taskIds.filter((id) => !targets().some((task) => task.id === id))
      if (unknown.length > 0) throw new WorkflowError(`Not tasks delegated by this chat: ${unknown.join(", ")}.`)
    }
    let timedOut = false
    while (true) {
      await this.withLock(run, () => this.reconcile(run))
      const waiting = targets().filter((task) => !isTerminal(task.state))
      if (waiting.length === 0) break
      if (this.now() >= deadline) {
        timedOut = true
        break
      }
      const chatIds = [...new Set(waiting.map((task) => task.chatId).filter((id): id is string => Boolean(id) && id !== actorChatId))]
      const slice = Math.min(WAIT_SLICE_MS, deadline - this.now())
      if (chatIds.length > 0) {
        await this.chats.waitForChats(actorChatId, { chatIds, mode: "any", timeoutMs: slice }, signal)
      } else {
        await Bun.sleep(Math.min(1_000, slice))
      }
      signal?.throwIfAborted()
      // A chat that just ended may be about to submit or be woken; give it the same grace a settle gets.
      if (this.settleGraceMs > 0) await Bun.sleep(Math.min(this.settleGraceMs, 2_000))
    }
    return this.withLock(run, async () => {
      const merges = isTerminal(actor.state) ? [] : await this.mergeInto(run, actor).catch((error) => [{ error: error instanceof Error ? error.message : String(error) }])
      const ended = targets().filter((task) => isTerminal(task.state))
      // This call hands over the results, so the orchestrator's own report of those turns must not arrive as well.
      const delivered = [...new Set(ended.map((task) => task.chatId).filter((id): id is string => Boolean(id) && id !== actorChatId))]
      if (delivered.length > 0) await this.chats.waitForChats(actorChatId, { chatIds: delivered, mode: "all", timeoutMs: 0 }, signal).catch(() => {})
      const result = targets().map((task) => {
        if (isTerminal(task.state)) task.delivered = true
        return this.describeTask(run, task)
      })
      await this.save(run)
      return { timedOut, runStatus: run.status, stage: run.stage, tasks: result, merged: merges,
        ...(timedOut ? { note: "Timed out; nothing was stopped. Call briefing_wait again or check briefing_status." } : {}) }
    })
  }

  private describeTask(run: BriefingRun, task: BriefingTask) {
    return {
      taskId: task.id,
      role: task.role,
      ...(task.country ? { country: task.country } : {}),
      state: task.state,
      chatId: task.chatId ?? null,
      attempt: task.attempt,
      dir: this.taskDir(run, task),
      ...(task.failure ? { failure: task.failure } : {}),
      ...(task.accepted ? {
        output: task.accepted.output,
        summary: task.accepted.summary,
        checkFindings: task.accepted.findings.slice(0, 20),
        merged: task.merged ?? false,
      } : {}),
      ...(task.state === "running" && task.lastRejection?.length ? { lastRejection: task.lastRejection.slice(0, 5) } : {}),
    }
  }

  async status(actorChatId: string, cwd: string, input: { runId?: string }) {
    await this.loadProject(cwd)
    const run = input.runId ? this.runs.get(input.runId) : this.findByChat(actorChatId)?.run
      ?? [...this.runs.values()].filter((entry) => entry.rootChatId === actorChatId).pop()
    if (!run) throw new WorkflowError(input.runId ? `No briefing run ${input.runId} in this project.` : "This chat has no briefing run. Pass runId.")
    await this.withLock(run, () => this.reconcile(run))
    return {
      runId: run.runId,
      runDir: run.runDir,
      status: run.status,
      stage: run.stage,
      window: run.window,
      cutoff: run.cutoff,
      history: run.history,
      budgets: { ...run.budgets, draftAttempts: run.draftAttempts, reviewRounds: run.reviewRounds, reworkRounds: run.reworkRounds, crossBorderRequests: run.crossBorderCount },
      tasks: run.tasks.map((task) => ({ taskId: task.id, role: task.role, country: task.country, state: task.state, chatId: task.chatId ?? null, failure: task.failure })),
      ...(run.final ? { final: run.final } : {}),
      ...(run.partialReason ? { partialReason: run.partialReason } : {}),
    }
  }

  /** For tests and inspection. */
  getRun(runId: string) {
    return this.runs.get(runId) ?? null
  }
}
