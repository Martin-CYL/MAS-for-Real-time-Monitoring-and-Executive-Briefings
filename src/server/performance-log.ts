import { CLIENT_PERFORMANCE_METRICS } from "../shared/performance"
import { appendFile, mkdir, readdir, rm, stat } from "node:fs/promises"
import { execFile } from "node:child_process"
import path from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const DAY_MS = 86_400_000
const MAX_DAILY_BYTES = 8 * 1024 * 1024
const RETENTION_DAYS = 14
const MAX_METRICS = 64

interface Metric {
  count: number
  total: number
  max: number
}

/** Local summaries have fixed limits so diagnostics cannot become another leak. */
export class PerformanceLog {
  readonly directory: string
  private metrics = new Map<string, Metric>()
  private clients = new Map<string, { lastSeen: string; metrics: Record<string, Metric> }>()
  private droppedSamples = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private lagTimer: ReturnType<typeof setInterval> | null = null
  private writing: Promise<void> | null = null
  private sampleResources: () => Record<string, number> = () => ({})
  private previousCpu = process.cpuUsage()
  private previousTime = performance.now()
  private lastPruneDay = ""
  private warned = false
  private stopped = false

  constructor(dataDir: string, private readonly dailyLimit = MAX_DAILY_BYTES, private readonly version = "development") {
    this.directory = path.join(dataDir, "diagnostics")
  }

  record(name: string, value = 1) {
    if (!Number.isFinite(value) || value < 0 || name.length > 80) return
    let metric = this.metrics.get(name)
    if (!metric) {
      if (this.metrics.size >= MAX_METRICS) return
      metric = { count: 0, total: 0, max: 0 }
      this.metrics.set(name, metric)
    }
    metric.count += 1
    metric.total += value
    metric.max = Math.max(metric.max, value)
  }

  mergeClientSummary(input: unknown, clientId?: string) {
    const sanitized: Record<string, Metric> = {}
    if (!input || typeof input !== "object" || Array.isArray(input)) return
    for (const name of CLIENT_PERFORMANCE_METRICS) {
      const value = (input as Record<string, unknown>)[name]
      if (!value || typeof value !== "object") continue
      const { count, total, max } = value as Metric
      if (![count, total, max].every(number => Number.isFinite(number) && number >= 0 && number <= 1e12)) continue
      if (!Number.isInteger(count) || count < 1 || count > 1e6 || max > total) continue
      sanitized[name] = { count, total, max }
      const key = `client_${name}`
      const previous = this.metrics.get(key) ?? { count: 0, total: 0, max: 0 }
      this.metrics.set(key, { count: previous.count + count, total: previous.total + total, max: Math.max(previous.max, max) })
    }
    if (clientId && /^[a-f0-9-]{36}$/.test(clientId)) {
      this.clients.delete(clientId)
      this.clients.set(clientId, { lastSeen: new Date().toISOString(), metrics: sanitized })
      while (this.clients.size > 32) this.clients.delete(this.clients.keys().next().value!)
    }
  }

  start(sampleResources: () => Record<string, number>) {
    if (this.timer || this.stopped) return
    this.sampleResources = sampleResources
    let expected = performance.now() + 1000
    this.lagTimer = setInterval(() => {
      const now = performance.now()
      this.record("event_loop_lag_ms", Math.max(0, now - expected))
      expected = now + 1000
    }, 1000)
    this.lagTimer.unref?.()
    this.timer = setInterval(() => { void this.flush() }, 60_000)
    this.timer.unref?.()
    void this.flush()
  }

  flush(): Promise<void> {
    if (this.writing) return this.writing
    this.writing = this.writeSample().catch((error) => {
      // One warning avoids an error loop when the disk is full.
      if (!this.warned) {
        this.warned = true
        console.warn("[performance-log] Cannot write diagnostics:", error instanceof Error ? error.message : String(error))
      }
    }).finally(() => { this.writing = null })
    return this.writing
  }

  private async writeSample() {
    const now = Date.now()
    const day = new Date(now).toISOString().slice(0, 10)
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    if (this.lastPruneDay !== day) {
      for (const name of await readdir(this.directory)) {
        const match = /^performance-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name)
        if (match && Date.parse(match[1]!) <= now - RETENTION_DAYS * DAY_MS) {
          await rm(path.join(this.directory, name), { force: true })
        }
      }
      this.lastPruneDay = day
    }
    const cpu = process.cpuUsage()
    const time = performance.now()
    const elapsed = Math.max(1, time - this.previousTime)
    const metrics = Object.fromEntries(this.metrics)
    this.metrics.clear()
    for (const [id, client] of this.clients) {
      if (Date.parse(client.lastSeen) < now - 300_000) this.clients.delete(id)
    }
    const sample = {
      v: 1,
      version: this.version,
      bunVersion: process.versions.bun,
      time: new Date(now).toISOString(),
      pid: process.pid,
      uptimeSeconds: process.uptime(),
      intervalMs: elapsed,
      memory: process.memoryUsage(),
      cpuPercent: ((cpu.user - this.previousCpu.user + cpu.system - this.previousCpu.system) / 1000 / elapsed) * 100,
      resources: this.sampleResources(),
      clients: Object.fromEntries(this.clients),
      droppedSamples: this.droppedSamples,
      metrics,
      children: await readChildProcessMemory(),
    }
    this.previousCpu = cpu
    this.previousTime = time
    const file = path.join(this.directory, `performance-${day}.jsonl`)
    const size = await stat(file).then(value => value.size).catch(() => 0)
    const line = `${JSON.stringify(sample)}\n`
    if (size + Buffer.byteLength(line) > this.dailyLimit) { this.droppedSamples += 1; return }
    await appendFile(file, line, { encoding: "utf8", mode: 0o600 })
    this.droppedSamples = 0
  }

  async stop() {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    if (this.lagTimer) clearInterval(this.lagTimer)
    this.timer = null
    this.lagTimer = null
    await this.writing
    await this.flush()
  }
}

/** Executable names and numeric process data only. Never collect command arguments. */
async function readChildProcessMemory() {
  if (process.platform === "win32") return null
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,rss=,pcpu=,comm="], {
      timeout: 3000,
      maxBuffer: 1024 * 1024,
    })
    const processes = stdout.trim().split("\n").flatMap(line => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.+)$/.exec(line)
      return match ? [{ pid: Number(match[1]), parent: Number(match[2]), rssBytes: Number(match[3]) * 1024, cpuPercent: Number(match[4]), executable: path.basename(match[5]!) }] : []
    })
    const ids = new Set([process.pid])
    for (let pass = 0; pass < 32; pass++) {
      const before = ids.size
      for (const child of processes) if (ids.has(child.parent)) ids.add(child.pid)
      if (ids.size === before) break
    }
    const children = processes.filter(child => child.pid !== process.pid && ids.has(child.pid) && child.executable !== "ps")
    return {
      count: children.length,
      rssBytes: children.reduce((sum, child) => sum + child.rssBytes, 0),
      largest: children.sort((a, b) => b.rssBytes - a.rssBytes).slice(0, 12),
    }
  } catch {
    return null
  }
}
