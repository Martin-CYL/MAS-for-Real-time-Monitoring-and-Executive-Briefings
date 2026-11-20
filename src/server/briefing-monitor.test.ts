import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  BriefingMonitor,
  briefingMonitorEnabled,
  describeSummary,
  locateMonitorSkill,
  type MonitorSummary,
  parseMonitorLine,
  readMonitorConfig,
  startBriefingMonitor,
} from "./briefing-monitor"
import { type PythonRunner, runPython } from "./briefing-workflow"

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "nex-monitor-"))
  temps.push(dir)
  return dir
}

/** A project with an installed stand-in Skill that has the monitor files. */
function project(monitorJson: Record<string, unknown> = { tick_minutes: 15, scan_timeout_minutes: 10 }) {
  const root = tempDir()
  const skill = path.join(root, ".agents", "skills", "us-china-ai-chip-briefing")
  mkdirSync(path.join(skill, "scripts"), { recursive: true })
  mkdirSync(path.join(skill, "references"), { recursive: true })
  writeFileSync(path.join(skill, "SKILL.md"), "---\nname: us-china-ai-chip-briefing\ndescription: stand-in\n---\n")
  writeFileSync(path.join(skill, "scripts", "monitor_scan.py"), "")
  writeFileSync(path.join(skill, "references", "monitor.json"), JSON.stringify(monitorJson))
  return { root, skill }
}

function summary(overrides: Partial<MonitorSummary> = {}): MonitorSummary {
  return {
    at: "2026-11-20T01:00:00+00:00",
    tiers: ["official"],
    boosted: [],
    sources: 13,
    failed: ["cac"],
    new: 2,
    new_relevant: 1,
    baseline: 0,
    page_changes: 0,
    alerts: [],
    batch: "/p/monitor/batches/20261120T090000",
    digest: null,
    ...overrides,
  }
}

/** A manual clock and timer queue. */
function clock() {
  let now = 0
  const timers: Array<{ at: number; fn: () => void; id: number }> = []
  let ids = 0
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => { const id = ++ids; timers.push({ at: now + ms, fn, id }); return id },
    clearTimer: (id: unknown) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1) },
    pending: () => timers.map((t) => t.at - now),
    advance(ms: number) {
      now += ms
      for (const due of timers.filter((t) => t.at <= now)) {
        timers.splice(timers.indexOf(due), 1)
        due.fn()
      }
    },
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("parseMonitorLine", () => {
  test("reads the last MONITOR line and ignores what comes before", () => {
    const out = `tiers official; 13 sources\nMONITOR {"tiers":["feeds"]}\nnoise\nMONITOR ${JSON.stringify(summary())}\n`
    expect(parseMonitorLine(out)).toEqual(summary())
  })

  test("passes the scan's own error through and rejects anything else", () => {
    expect(parseMonitorLine('MONITOR {"error":"another monitor call holds .lock"}')).toEqual({ error: "another monitor call holds .lock" })
    expect(parseMonitorLine("Traceback (most recent call last):")).toBeNull()
    expect(parseMonitorLine("MONITOR {not json")).toBeNull()
  })
})

describe("describeSummary", () => {
  test("one line per tick, then one per alert and the digest", () => {
    const lines = describeSummary(summary({
      boosted: ["mofcom"],
      alerts: [{ kind: "deadline_passed_no_notice", level: "flash", message: "As of 2026-11-11 00:05 HKT, a search listed no official item" }],
      digest: { path: "/p/monitor/digests/2026-11-20.md", scans: 40, items: 9, official: 3, alerts: 1 },
    }))
    expect(lines[0]).toBe("tiers=official boosted=mofcom sources=13 unavailable=cac new=1/2 baseline=0 page_changes=0 alerts=1")
    expect(lines[1]).toBe("alert flash deadline_passed_no_notice: As of 2026-11-11 00:05 HKT, a search listed no official item")
    expect(lines[2]).toContain("digest /p/monitor/digests/2026-11-20.md: 3 official of 9 new items")
  })
})

describe("BriefingMonitor", () => {
  test("a tick runs the Skill's scan in the project's monitor directory and logs the result", async () => {
    const { root, skill } = project()
    const calls: Array<{ args: string[]; cwd: string; timeoutMs: number }> = []
    const python: PythonRunner = async (args, options) => {
      calls.push({ args, cwd: options.cwd, timeoutMs: options.timeoutMs })
      return { exitCode: 0, stdout: `MONITOR ${JSON.stringify(summary({ alerts: [{ kind: "source_down", level: "warning", message: "cac unavailable" }] }))}`, stderr: "" }
    }
    const log: string[] = []
    const monitor = new BriefingMonitor({ projectDir: root, skillDir: skill, python, log: (l) => log.push(l), warn: (l) => log.push(`WARN ${l}`) })
    const result = await monitor.tick()
    expect(result.outcome).toBe("scanned")
    expect(calls).toEqual([{ args: [path.join(skill, "scripts", "discover.py"), "--monitor", "--dir", path.join(root, "monitor")], cwd: skill, timeoutMs: 600_000 }])
    expect(log).toEqual([
      "tiers=official sources=13 unavailable=cac new=1/2 baseline=0 page_changes=0 alerts=1",
      "alert warning source_down: cac unavailable",
    ])
  })

  test("a tick while the last one runs does nothing", async () => {
    const { root, skill } = project()
    let release: () => void = () => {}
    let runs = 0
    const python: PythonRunner = () => {
      runs += 1
      return new Promise((resolve) => { release = () => resolve({ exitCode: 0, stdout: `MONITOR ${JSON.stringify(summary())}`, stderr: "" }) })
    }
    const monitor = new BriefingMonitor({ projectDir: root, skillDir: skill, python, log: () => {} })
    const first = monitor.tick()
    await flush()
    expect(await monitor.tick()).toEqual({ outcome: "skipped" })
    release()
    expect((await first).outcome).toBe("scanned")
    expect(runs).toBe(1)
  })

  test("a failed scan is reported with its reason and does not stop the monitor", async () => {
    const { root, skill } = project()
    const outputs = [
      { exitCode: 1, stdout: "", stderr: "Traceback\nKeyError: 'tiers'" },
      { exitCode: 2, stdout: 'MONITOR {"error":"another monitor call holds /p/monitor/.lock"}', stderr: "" },
    ]
    const warnings: string[] = []
    const monitor = new BriefingMonitor({ projectDir: root, skillDir: skill, python: async () => outputs.shift()!, log: () => {}, warn: (l) => warnings.push(l) })
    expect(await monitor.tick()).toEqual({ outcome: "failed", reason: "exit 1: Traceback | KeyError: 'tiers'" })
    expect(await monitor.tick()).toEqual({ outcome: "failed", reason: "another monitor call holds /p/monitor/.lock" })
    expect(warnings).toHaveLength(2)
  })

  test("ticks are spaced from each tick's start, and stop ends them and the scan in flight", async () => {
    const { root, skill } = project({ tick_minutes: 15 })
    const c = clock()
    let signal: AbortSignal | undefined
    let release: () => void = () => {}
    const python: PythonRunner = (_args, options) => {
      signal = options.signal
      return new Promise((resolve) => { release = () => resolve({ exitCode: 0, stdout: `MONITOR ${JSON.stringify(summary())}`, stderr: "" }) })
    }
    const monitor = new BriefingMonitor({ projectDir: root, skillDir: skill, python, log: () => {}, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, firstDelayMs: 5_000 })
    await monitor.start()
    expect(c.pending()).toEqual([5_000])
    c.advance(5_000)
    await flush()
    c.advance(2 * 60_000) // the scan takes two minutes
    release()
    await flush()
    await flush()
    expect(c.pending()).toEqual([13 * 60_000])
    c.advance(13 * 60_000)
    await flush()
    expect(signal?.aborted).toBe(false)
    monitor.stop()
    expect(signal?.aborted).toBe(true)
    release()
    await flush()
    await flush()
    expect(c.pending()).toEqual([])
  })

  test("the tick interval comes from the Skill and is never under a minute", async () => {
    expect((await readMonitorConfig(project({ tick_minutes: 0.01 }).skill)).tickMs).toBe(60_000)
    expect((await readMonitorConfig(project({ tick_minutes: 30, scan_timeout_minutes: 5 }).skill))).toEqual({ tickMs: 30 * 60_000, timeoutMs: 5 * 60_000 })
    expect((await readMonitorConfig(project({}).skill))).toEqual({ tickMs: 15 * 60_000, timeoutMs: 10 * 60_000 })
  })
})

describe("enabling", () => {
  test("off unless NEX_BRIEFING_MONITOR=1", async () => {
    expect(briefingMonitorEnabled({})).toBe(false)
    expect(briefingMonitorEnabled({ NEX_BRIEFING_MONITOR: "1" })).toBe(true)
    expect(await startBriefingMonitor({})).toBeNull()
  })

  test("needs a project path and a Skill with the monitor", async () => {
    const home = tempDir()
    expect(await startBriefingMonitor({ NEX_BRIEFING_MONITOR: "1" }, home)).toBeNull()
    expect(await startBriefingMonitor({ NEX_BRIEFING_MONITOR: "1", NEX_BRIEFING_MONITOR_PROJECT: "relative/path" }, home)).toBeNull()
    const bare = tempDir()
    expect(await startBriefingMonitor({ NEX_BRIEFING_MONITOR: "1", NEX_BRIEFING_MONITOR_PROJECT: bare }, home)).toBeNull()
  })

  test("finds the Skill in the project only when it has the monitor files", () => {
    const home = tempDir()
    const { root, skill } = project()
    expect(locateMonitorSkill(root, home)).toBe(skill)
    rmSync(path.join(skill, "scripts", "monitor_scan.py"))
    expect(locateMonitorSkill(root, home)).toBeNull()
  })
})

/**
 * Against the real Skill: point BRIEFING_SKILL_DIR at a Skill with
 * `scripts/monitor_scan.py`. Uses an empty source list, so nothing is fetched.
 */
const SKILL_DIR = process.env.BRIEFING_SKILL_DIR
describe.skipIf(!SKILL_DIR)("with the real Skill", () => {
  test("one tick through discover.py --monitor writes state and log and returns a summary", async () => {
    const root = tempDir()
    const sources = JSON.parse(await Bun.file(path.join(SKILL_DIR!, "references", "discovery_sources.json")).text()) as Record<string, unknown>
    const emptySources = path.join(root, "sources.json")
    writeFileSync(emptySources, JSON.stringify({
      ...sources,
      official_api: [],
      official_listing: [],
      rss: [],
      news_search: { themes_en: [], themes_zh: [], outlets: [], outlet_query: "", open_en: [], open_zh: [], official_domains_zh: {}, official_domains_en: {} },
    }))
    const monitor = new BriefingMonitor({
      projectDir: root,
      skillDir: SKILL_DIR!,
      python: runPython,
      log: () => {},
      extraArgs: ["--sources", emptySources, "--now", "2026-11-20T01:00:00+00:00"],
    })
    const result = await monitor.tick()
    expect(result.outcome).toBe("scanned")
    if (result.outcome !== "scanned") return
    expect(result.summary.tiers).toEqual(["official", "feeds", "news"])
    expect(await Bun.file(path.join(root, "monitor", "state.json")).exists()).toBe(true)
    expect((await Bun.file(path.join(root, "monitor", "log.jsonl")).text()).trim().split("\n")).toHaveLength(1)
  })
})
