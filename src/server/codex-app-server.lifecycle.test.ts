import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { CodexAppServerManager } from "./codex-app-server"
import { buildRestriction } from "./briefing-sandbox"

/**
 * Process lifecycle regressions from briefing run mas-20261122-145830-bfe9: idle app-servers piled up until the
 * container OOM-killed processes mid-run; restarted agents came up without their briefing_* tools; the kill was
 * reported as an unrelated stderr warning.
 */
class FakeCodexProcess extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly messages: any[] = []
  killed = false

  constructor(private readonly onMessage: (message: any, process: FakeCodexProcess) => void) {
    super()
    let buffer = ""
    this.stdin.on("data", (chunk) => {
      buffer += chunk.toString()
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.trim()) continue
        const message = JSON.parse(line)
        this.messages.push(message)
        this.onMessage(message, this)
      }
    })
  }

  kill() {
    this.killed = true
    this.emit("close", null, "SIGKILL")
  }

  reply(message: any, result: unknown) {
    this.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`)
  }

  fail(message: any, error: string) {
    this.stdout.write(`${JSON.stringify({ id: message.id, error: { message: error } })}\n`)
  }
}

const ROLE = buildRestriction({ role: "chief", taskDir: "/w/runs/r1", runDir: "/w/runs/r1", projectDir: "/w", skillDir: "/s", home: "/h" })
const TOOLS = { execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }) }

/** A Codex that answers the handshake, starts or resumes thread-1, and reports the Nex server as `nexStatus` gives. */
function codex(nexStatus: () => { runtimeStatus?: string; tools?: string[] } | "unsupported" | null) {
  return new FakeCodexProcess((message, child) => {
    if (message.method === "initialize") child.reply(message, { userAgent: "codex-test" })
    else if (message.method === "thread/start" || message.method === "thread/resume") child.reply(message, { thread: { id: "thread-1" } })
    else if (message.method === "turn/start") child.reply(message, { turn: { id: "turn-1", status: "inProgress", error: null } })
    else if (message.method === "mcpServerStatus/list") {
      const status = nexStatus()
      if (status === "unsupported") return child.fail(message, "unknown method: mcpServerStatus/list")
      child.reply(message, {
        data: status ? [{ name: "nex", runtimeStatus: status.runtimeStatus, tools: Object.fromEntries((status.tools ?? []).map((name) => [name, {}])) }] : [],
      })
    }
  })
}

const connected = () => ({ runtimeStatus: "connected", tools: [...ROLE.nexTools] })

describe("Codex app-server lifecycle", () => {
  test("an idle session is stopped, and the next start resumes its thread with the Nex tools", async () => {
    let clock = 0
    const processes = [codex(connected), codex(connected)]
    const spawned: FakeCodexProcess[] = []
    const manager = new CodexAppServerManager({
      spawnProcess: () => { const next = processes.shift()!; spawned.push(next); return next as never },
      now: () => clock,
      idleStopMs: 120_000,
      sweepIntervalMs: 3_600_000,
    })
    const start = (sessionToken: string | null) =>
      manager.startSession({ chatId: "chief", cwd: "/w", model: "m", sessionToken, customTools: TOOLS, restriction: ROLE })

    await start(null)
    expect(manager.reapIdleSessions()).toEqual([])          // first sweep only notes it idle
    clock += 119_000
    expect(manager.reapIdleSessions()).toEqual([])
    clock += 1_000
    expect(manager.reapIdleSessions()).toEqual(["chief"])   // two minutes with nothing in flight
    expect(spawned[0]!.killed).toBe(true)
    expect(manager.getResourceCounts().codexSessions).toBe(0)

    await start("thread-1")
    const resume = spawned[1]!.messages.find((message) => message.method === "thread/resume")
    expect(resume.params.threadId).toBe("thread-1")
    expect(resume.params.config["mcp_servers.nex"].enabled_tools).toEqual([...ROLE.nexTools])
    manager.stopAll()
  })

  test("a session with a turn in flight is never reaped", async () => {
    let clock = 0
    const process = codex(connected)
    const manager = new CodexAppServerManager({ spawnProcess: () => process as never, now: () => clock, idleStopMs: 1_000, sweepIntervalMs: 3_600_000 })
    await manager.startSession({ chatId: "lead", cwd: "/w", model: "m", sessionToken: null })
    await manager.startTurn({ chatId: "lead", model: "m", content: "work", planMode: false, onToolRequest: async () => ({}) })
    manager.reapIdleSessions()
    clock += 60_000
    expect(manager.reapIdleSessions()).toEqual([])
    expect(process.killed).toBe(false)
    manager.stopAll()
  })

  test("idleStopMs 0 keeps sessions forever", async () => {
    let clock = 0
    const process = codex(connected)
    const manager = new CodexAppServerManager({ spawnProcess: () => process as never, now: () => clock, idleStopMs: 0 })
    await manager.startSession({ chatId: "chat", cwd: "/w", model: "m", sessionToken: null })
    clock += 10 * 3_600_000
    expect(manager.reapIdleSessions()).toEqual([])
    manager.stopAll()
  })

  test("a briefing session that comes up without its Nex tools is restarted once", async () => {
    const processes = [codex(() => ({ runtimeStatus: "failed" })), codex(connected)]
    const spawned: FakeCodexProcess[] = []
    const manager = new CodexAppServerManager({ spawnProcess: () => { const next = processes.shift()!; spawned.push(next); return next as never }, nexToolsReadyMs: 1_000 })
    const started = await manager.startSession({ chatId: "chief", cwd: "/w", model: "m", sessionToken: "thread-1", customTools: TOOLS, restriction: ROLE })
    expect(started?.sessionToken).toBe("thread-1")
    expect(spawned).toHaveLength(2)
    expect(spawned[0]!.killed).toBe(true)
    expect(spawned[1]!.messages.map((message) => message.method)).toContain("thread/resume")
    manager.stopAll()
  })

  test("a session missing some of its tools fails clearly after the one retry", async () => {
    const partial = () => ({ runtimeStatus: "connected", tools: ["briefing_status"] })
    const processes = [codex(partial), codex(partial)]
    const manager = new CodexAppServerManager({ spawnProcess: () => processes.shift()! as never, nexToolsReadyMs: 300 })
    await expect(manager.startSession({ chatId: "chief", cwd: "/w", model: "m", sessionToken: null, customTools: TOOLS, restriction: ROLE }))
      .rejects.toThrow(/Nex tools unavailable in this Codex session: connected, missing briefing_delegate/)
    expect(manager.getResourceCounts().codexSessions).toBe(0)
  })

  test("a Codex that cannot report MCP status is not blocked", async () => {
    const process = codex(() => "unsupported")
    const manager = new CodexAppServerManager({ spawnProcess: () => process as never })
    const started = await manager.startSession({ chatId: "chief", cwd: "/w", model: "m", sessionToken: null, customTools: TOOLS, restriction: ROLE })
    expect(started?.sessionToken).toBe("thread-1")
    manager.stopAll()
  })

  test("a Codex that never answers the status query is not blocked, and the request does not linger", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") child.reply(message, { userAgent: "codex-test" })
      else if (message.method === "thread/start") child.reply(message, { thread: { id: "thread-1" } })
    })
    const manager = new CodexAppServerManager({ spawnProcess: () => process as never, nexToolsReadyMs: 200 })
    const started = await manager.startSession({ chatId: "chief", cwd: "/w", model: "m", sessionToken: null, customTools: TOOLS, restriction: ROLE })
    expect(started?.sessionToken).toBe("thread-1")
    expect(manager.getResourceCounts().codexPendingRequests).toBe(0)
    manager.stopAll()
  })

  test("ordinary chats are not checked", async () => {
    const process = codex(() => ({ runtimeStatus: "failed" }))
    const manager = new CodexAppServerManager({ spawnProcess: () => process as never })
    await manager.startSession({ chatId: "chat", cwd: "/w", model: "m", sessionToken: null, customTools: TOOLS })
    expect(process.messages.map((message) => message.method)).not.toContain("mcpServerStatus/list")
    manager.stopAll()
  })

  test("a killed process is reported as killed, not as its last stderr line", async () => {
    const process = codex(connected)
    const manager = new CodexAppServerManager({ spawnProcess: () => process as never })
    await manager.startSession({ chatId: "scout", cwd: "/w", model: "m", sessionToken: null })
    const turn = await manager.startTurn({ chatId: "scout", model: "m", content: "work", planMode: false, onToolRequest: async () => ({}) })
    process.stderr.write("ERROR codex_app_server: Codex could not find bubblewrap on PATH.\n")
    await new Promise((resolve) => setTimeout(resolve, 10))
    process.emit("close", null, "SIGKILL")
    const events: any[] = []
    for await (const event of turn.stream) events.push(event)
    const result = events.find((event) => event.type === "transcript" && event.entry.kind === "result")
    expect(result.entry.result).toStartWith("Codex app-server was killed (SIGKILL, possibly out of memory)")
    expect(result.entry.result).toContain("last stderr: ERROR codex_app_server: Codex could not find bubblewrap")
  })
})
