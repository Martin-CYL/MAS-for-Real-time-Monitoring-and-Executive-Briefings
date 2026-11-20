import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { scanCodexSkills } from "./harness-skills"
import { BRIEFING_SKILL_NAME, type PythonRunner, runPython } from "./briefing-workflow"

/**
 * Phase 0 of the briefing monitor (docs/briefing-monitor-design.md): a timer
 * that runs the Skill's incremental scan (`discover.py --monitor`) and logs
 * what it found. No model is called and no chat is opened. What is due, how
 * often, the alert rules and the daily digest all live in the Skill
 * (`references/monitor.json`); this only keeps the ticks going, one at a
 * time, and reports each one.
 */

const LOG_PREFIX = "[monitor]"
const DEFAULT_TICK_MINUTES = 15
const DEFAULT_SCAN_TIMEOUT_MINUTES = 10
/** A Skill's typo should not run the scan every second. */
const MIN_TICK_MS = 60_000
const FIRST_TICK_DELAY_MS = 10_000

export function briefingMonitorEnabled(env: Record<string, string | undefined> = process.env) {
  return env.NEX_BRIEFING_MONITOR === "1"
}

/** The briefing Skill, when it has the monitor (`scripts/monitor_scan.py`, `references/monitor.json`). */
export function locateMonitorSkill(cwd: string, home?: string) {
  const skill = scanCodexSkills({ cwd, home }).find((entry) => entry.name === BRIEFING_SKILL_NAME)
  if (!skill?.path) return null
  const dir = path.dirname(skill.path)
  return existsSync(path.join(dir, "scripts", "monitor_scan.py")) && existsSync(path.join(dir, "references", "monitor.json")) ? dir : null
}

export interface MonitorAlert {
  kind: string
  level: string
  message: string
  message_zh?: string
}

export interface MonitorSummary {
  at: string
  tiers: string[]
  boosted: string[]
  sources: number
  failed: string[]
  new: number
  new_relevant: number
  baseline: number
  page_changes: number
  alerts: MonitorAlert[]
  batch: string | null
  digest: { path: string; scans: number; items: number; official: number; alerts: number } | null
}

export type MonitorTickResult =
  | { outcome: "scanned"; summary: MonitorSummary }
  | { outcome: "failed"; reason: string }
  /** The previous tick is still running. */
  | { outcome: "skipped" }

/** The `MONITOR {json}` line the scan prints last. */
export function parseMonitorLine(stdout: string): MonitorSummary | { error: string } | null {
  const line = stdout.trim().split("\n").reverse().find((entry) => entry.startsWith("MONITOR "))
  if (!line) return null
  try {
    const parsed = JSON.parse(line.slice("MONITOR ".length)) as unknown
    return parsed && typeof parsed === "object" ? parsed as MonitorSummary | { error: string } : null
  } catch {
    return null
  }
}

export function describeSummary(summary: MonitorSummary) {
  const lines = [
    `tiers=${summary.tiers.join(",") || "-"}${summary.boosted.length ? ` boosted=${summary.boosted.join(",")}` : ""} `
    + `sources=${summary.sources} unavailable=${summary.failed.length ? summary.failed.join(",") : 0} `
    + `new=${summary.new_relevant}/${summary.new} baseline=${summary.baseline} page_changes=${summary.page_changes} alerts=${summary.alerts.length}`,
  ]
  for (const alert of summary.alerts) lines.push(`alert ${alert.level} ${alert.kind}: ${alert.message}`)
  if (summary.digest) {
    lines.push(`digest ${summary.digest.path}: ${summary.digest.official} official of ${summary.digest.items} new items, ${summary.digest.alerts} alerts, ${summary.digest.scans} scans`)
  }
  return lines
}

interface MonitorConfig {
  tickMs: number
  timeoutMs: number
}

export async function readMonitorConfig(skillDir: string): Promise<MonitorConfig> {
  const raw = JSON.parse(await readFile(path.join(skillDir, "references", "monitor.json"), "utf8")) as Record<string, unknown>
  const minutes = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback
  return {
    tickMs: Math.max(MIN_TICK_MS, minutes(raw.tick_minutes, DEFAULT_TICK_MINUTES) * 60_000),
    timeoutMs: minutes(raw.scan_timeout_minutes, DEFAULT_SCAN_TIMEOUT_MINUTES) * 60_000,
  }
}

interface Deps {
  /** The project whose `monitor/` directory holds the state, log, batches and digests. */
  projectDir: string
  skillDir: string
  python?: PythonRunner
  log?: (line: string) => void
  warn?: (line: string) => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  firstDelayMs?: number
  /** Extra arguments for the scan (tests: `--sources`, `--now`). */
  extraArgs?: string[]
}

export class BriefingMonitor {
  readonly monitorDir: string
  private readonly python: PythonRunner
  private readonly log: (line: string) => void
  private readonly warn: (line: string) => void
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private config: MonitorConfig | null = null
  private timer: unknown = null
  private running: Promise<MonitorTickResult> | null = null
  private abort: AbortController | null = null
  private stopped = false

  constructor(private readonly deps: Deps) {
    this.monitorDir = path.join(deps.projectDir, "monitor")
    this.python = deps.python ?? runPython
    this.log = deps.log ?? ((line) => console.log(`${LOG_PREFIX} ${line}`))
    this.warn = deps.warn ?? ((line) => console.warn(`${LOG_PREFIX} ${line}`))
    this.now = deps.now ?? Date.now
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  }

  async start() {
    this.config = await readMonitorConfig(this.deps.skillDir)
    this.log(`watching for ${this.deps.projectDir} every ${Math.round(this.config.tickMs / 60_000)} min; files in ${this.monitorDir}`)
    this.arm(this.deps.firstDelayMs ?? FIRST_TICK_DELAY_MS)
  }

  stop() {
    this.stopped = true
    if (this.timer !== null) this.clearTimer(this.timer)
    this.timer = null
    this.abort?.abort()
  }

  /** One scan. A tick that arrives while the last is running does nothing: the Skill decides what is due. */
  tick(): Promise<MonitorTickResult> {
    if (this.running) return Promise.resolve({ outcome: "skipped" })
    this.running = this.scan().finally(() => { this.running = null })
    return this.running
  }

  private arm(delayMs: number) {
    if (this.stopped) return
    this.timer = this.setTimer(() => {
      this.timer = null
      const startedAt = this.now()
      void this.tick().finally(() => {
        // The next tick is counted from when this one started, so a slow scan does not drift the schedule.
        const tickMs = this.config?.tickMs ?? DEFAULT_TICK_MINUTES * 60_000
        this.arm(Math.max(0, startedAt + tickMs - this.now()))
      })
    }, delayMs)
  }

  private async scan(): Promise<MonitorTickResult> {
    const config = this.config ?? await readMonitorConfig(this.deps.skillDir)
    this.abort = new AbortController()
    try {
      const result = await this.python(
        [path.join(this.deps.skillDir, "scripts", "discover.py"), "--monitor", "--dir", this.monitorDir, ...(this.deps.extraArgs ?? [])],
        { cwd: this.deps.skillDir, timeoutMs: config.timeoutMs, signal: this.abort.signal },
      )
      const parsed = parseMonitorLine(result.stdout)
      if (!parsed || "error" in parsed) {
        const reason = parsed && "error" in parsed
          ? parsed.error
          : `exit ${result.exitCode}: ${(result.stderr || result.stdout).trim().split("\n").slice(-3).join(" | ").slice(0, 400)}`
        this.warn(`scan failed: ${reason}`)
        return { outcome: "failed", reason }
      }
      for (const line of describeSummary(parsed)) this.log(line)
      return { outcome: "scanned", summary: parsed }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.warn(`scan failed: ${reason}`)
      return { outcome: "failed", reason }
    } finally {
      this.abort = null
    }
  }
}

/** The monitor for this server, or null with the reason logged. Only with `NEX_BRIEFING_MONITOR=1`. */
export async function startBriefingMonitor(env: Record<string, string | undefined> = process.env, home?: string) {
  if (!briefingMonitorEnabled(env)) return null
  const projectDir = env.NEX_BRIEFING_MONITOR_PROJECT?.trim()
  if (!projectDir || !path.isAbsolute(projectDir) || !existsSync(projectDir)) {
    console.warn(`${LOG_PREFIX} NEX_BRIEFING_MONITOR=1 needs NEX_BRIEFING_MONITOR_PROJECT set to an existing absolute project path; not started.`)
    return null
  }
  const skillDir = locateMonitorSkill(projectDir, home)
  if (!skillDir) {
    console.warn(`${LOG_PREFIX} the ${BRIEFING_SKILL_NAME} Skill with monitor support (scripts/monitor_scan.py, references/monitor.json) is not installed for ${projectDir}; not started.`)
    return null
  }
  const monitor = new BriefingMonitor({ projectDir, skillDir })
  try {
    await monitor.start()
  } catch (error) {
    console.warn(`${LOG_PREFIX} not started: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
  return monitor
}
