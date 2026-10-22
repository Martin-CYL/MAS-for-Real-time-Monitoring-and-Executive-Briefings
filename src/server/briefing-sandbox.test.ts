import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { PassThrough } from "node:stream"
import {
  buildRestriction,
  DISABLED_CODEX_FEATURES,
  restrictionCliArgs,
  restrictionConfig,
  type SandboxRunner,
  verifySandbox,
} from "./briefing-sandbox"
import { CodexAppServerManager } from "./codex-app-server"

const BASE = {
  runDir: "/work/project/runs/mas-1",
  projectDir: "/work/project",
  skillDir: "/work/project/.agents/skills/us-china-ai-chip-briefing",
  home: "/home/user",
  extraDeny: ["/home/user/.nex/data"],
}

/** The access the profile gives a path: the most specific matching entry wins, as Codex resolves it. */
function access(fs: Record<string, string>, target: string) {
  const match = Object.keys(fs)
    .filter((entry) => target === entry || target.startsWith(`${entry}/`))
    .sort((a, b) => b.length - a.length)[0]
  return match ? fs[match] : "read (base profile)"
}

describe("briefing agent profiles", () => {
  test("a scout writes only its own directory and cannot read the rest of the run or credentials", () => {
    const scout = buildRestriction({ ...BASE, role: "scout", taskDir: `${BASE.runDir}/tasks/us-s01` })
    const fs = scout.filesystem
    expect(scout.cwd).toBe(`${BASE.runDir}/tasks/us-s01`)
    expect(access(fs, `${BASE.runDir}/tasks/us-s01/sources/S001.txt`)).toBe("write")
    expect(access(fs, `${BASE.runDir}/tasks/us-s01/assignment.json`)).toBe("read")
    expect(access(fs, `${BASE.runDir}/tasks/us-s01/run_config.json`)).toBe("read")
    expect(access(fs, `${BASE.runDir}/tasks/us-s02/events.json`)).toBe("deny")
    expect(access(fs, `${BASE.runDir}/tasks/us-lead/narrative.md`)).toBe("deny")
    expect(access(fs, `${BASE.runDir}/workflow.json`)).toBe("deny")
    expect(access(fs, `${BASE.runDir}/discovery/candidates.md`)).toBe("read")
    expect(access(fs, `${BASE.skillDir}/scripts/brief.py`)).toBe("read")
    expect(access(fs, `${BASE.projectDir}/.git/config`)).toBe("deny")
    expect(access(fs, `${BASE.projectDir}/runs/other-run/report.html`)).toBe("deny")
    for (const secret of [".codex/auth.json", ".ssh/id_ed25519", ".config/gh/hosts.yml", "Library/Keychains/login.keychain-db", ".gitconfig", ".nex/data/chats.jsonl"]) {
      expect(access(fs, `${BASE.home}/${secret}`)).toBe("deny")
    }
    expect(scout.network).toBe(true)
  })

  test("leads and the reviewer read the run and write only their own directory; the chief cannot touch other tasks or workflow state", () => {
    const lead = buildRestriction({ ...BASE, role: "lead", taskDir: `${BASE.runDir}/tasks/us-lead` }).filesystem
    expect(access(lead, `${BASE.runDir}/tasks/us-s01/narrative.md`)).toBe("read")
    expect(access(lead, `${BASE.runDir}/tasks/us-s01/events.json`)).toBe("read")
    expect(access(lead, `${BASE.runDir}/tasks/us-lead/xb-01/narrative.md`)).toBe("write") // cross-border replies live inside the lead's directory
    expect(access(lead, `${BASE.runDir}/tasks/cn-lead/events.json`)).toBe("read")
    expect(access(lead, `${BASE.runDir}/workflow.json`)).toBe("deny")
    const chief = buildRestriction({ ...BASE, role: "chief", taskDir: BASE.runDir }).filesystem
    expect(access(chief, `${BASE.runDir}/report.json`)).toBe("write")
    expect(access(chief, `${BASE.runDir}/tasks/us-lead/events.json`)).toBe("read")
    expect(access(chief, `${BASE.runDir}/workflow.json`)).toBe("deny")
    expect(access(chief, `${BASE.runDir}/workflow.log.jsonl`)).toBe("deny")
    expect(access(chief, `${BASE.runDir}/assignment.json`)).toBe("read")
    expect(access(chief, `${BASE.runDir}/run_config.json`)).toBe("read")
    expect(access(chief, `${BASE.runDir}/discovery/events.json`)).toBe("read")
    const reviewer = buildRestriction({ ...BASE, role: "reviewer", taskDir: `${BASE.runDir}/tasks/review-1` }).filesystem
    expect(access(reviewer, `${BASE.runDir}/report.html`)).toBe("read")
    expect(access(reviewer, `${BASE.runDir}/tasks/review-1/findings.json`)).toBe("write")
  })

  test("the thread config switches off tools that act outside the sandbox and scrubs the shell environment", () => {
    const config = restrictionConfig(buildRestriction({ ...BASE, role: "scout", taskDir: `${BASE.runDir}/tasks/us-s01` }))
    expect(config.default_permissions).toBe("nex-briefing-scout")
    expect(config["permissions.nex-briefing-scout.extends"]).toBe(":read-only")
    expect(config["permissions.nex-briefing-scout.network.enabled"]).toBe(true)
    for (const feature of ["computer_use", "browser_use", "apps", "plugins", "multi_agent"]) {
      expect(config[`features.${feature}`]).toBe(false)
    }
    expect(config["shell_environment_policy.set"]).toMatchObject({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", PYTHONDONTWRITEBYTECODE: "1" })
    expect(config["shell_environment_policy.exclude"]).toEqual(expect.arrayContaining(["*TOKEN*", "GH_*", "NEX_*"]))
    expect(JSON.stringify(config)).not.toContain("danger-full-access")
    expect(DISABLED_CODEX_FEATURES).not.toContain("web_search")
  })

  test("the CLI form carries the same profile as TOML values", () => {
    const args = restrictionCliArgs(buildRestriction({ ...BASE, role: "scout", taskDir: `${BASE.runDir}/tasks/us-s01` }))
    const filesystem = args[args.indexOf("-c") + 1 + args.slice(1).findIndex((arg) => arg.startsWith("permissions.nex-briefing-scout.filesystem="))]
    expect(args).toContain('default_permissions="nex-briefing-scout"')
    expect(args.find((arg) => arg.startsWith("permissions.nex-briefing-scout.filesystem="))).toContain(`"${BASE.runDir}/tasks/us-s01"="write"`)
    expect(filesystem ?? "").not.toBe("")
  })
})

class FakeCodexProcess extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly messages: any[] = []
  killed = false
  constructor() {
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
        if (message.method === "initialize") this.stdout.write(`${JSON.stringify({ id: message.id, result: { userAgent: "codex-test" } })}\n`)
        if (message.method === "thread/start") this.stdout.write(`${JSON.stringify({ id: message.id, result: { thread: { id: `thread-${this.messages.length}` }, model: "m" } })}\n`)
      }
    })
  }
  kill() {
    this.killed = true
    this.emit("close", 0)
  }
}

describe("Codex sessions", () => {
  const restriction = buildRestriction({ ...BASE, role: "scout", taskDir: `${BASE.runDir}/tasks/us-s01` })

  test("a restricted session starts under its profile in its task directory, never with danger-full-access", async () => {
    const processes: Array<{ process: FakeCodexProcess; cwd: string }> = []
    const manager = new CodexAppServerManager({ spawnProcess: (cwd) => {
      const process = new FakeCodexProcess()
      processes.push({ process, cwd })
      return process as never
    } })
    const customTools = { execute: async () => ({ content: [] }) }
    await manager.startSession({ chatId: "scout", cwd: BASE.projectDir, model: "m", sessionToken: null, restriction, customTools })
    const start = processes[0]!.process.messages.find((message) => message.method === "thread/start")
    expect(processes[0]!.cwd).toBe(restriction.cwd)
    expect(start.params.cwd).toBe(restriction.cwd)
    expect(start.params.sandbox).toBeUndefined()
    expect(start.params.approvalPolicy).toBe("never")
    expect(start.params.config.default_permissions).toBe("nex-briefing-scout")
    expect(start.params.config["features.computer_use"]).toBe(false)
    // Found live: a sandboxed Codex asks before any MCP tool, and "never" turns that into a refusal. Only Nex's own
    // server is approved, offering only the role's tools.
    expect(start.params.config["mcp_servers.nex"]).toMatchObject({ default_tools_approval_mode: "approve", enabled_tools: ["briefing_status", "briefing_submit"] })
    manager.stopAll()
  })

  test("an ordinary chat keeps today's parameters", async () => {
    const process = new FakeCodexProcess()
    const manager = new CodexAppServerManager({ spawnProcess: () => process as never })
    await manager.startSession({ chatId: "user", cwd: BASE.projectDir, model: "m", sessionToken: null })
    const start = process.messages.find((message) => message.method === "thread/start")
    expect(start.params.sandbox).toBe("danger-full-access")
    expect(start.params.cwd).toBe(BASE.projectDir)
    expect(start.params.config).toBeUndefined()
  })

  test("a session started without the profile is not reused for a confined turn", async () => {
    const processes: FakeCodexProcess[] = []
    const manager = new CodexAppServerManager({ spawnProcess: () => {
      const process = new FakeCodexProcess()
      processes.push(process)
      return process as never
    } })
    await manager.startSession({ chatId: "chat", cwd: restriction.cwd, model: "m", sessionToken: null })
    await manager.startSession({ chatId: "chat", cwd: restriction.cwd, model: "m", sessionToken: null, restriction })
    expect(processes).toHaveLength(2)
    expect(processes[0]!.killed).toBe(true)
    await manager.startSession({ chatId: "chat", cwd: restriction.cwd, model: "m", sessionToken: null, restriction })
    expect(processes).toHaveLength(2) // same profile: the warm session is reused
  })
})

describe("pre-run sandbox check", () => {
  async function runDir() {
    const root = await mkdtemp(path.join(tmpdir(), "nex-sandbox-check-"))
    const run = path.join(root, "project", "runs", "mas-1")
    await mkdir(run, { recursive: true })
    await writeFile(path.join(run, "workflow.json"), "{}")
    return { root, input: { runDir: run, projectDir: path.join(root, "project"), skillDir: path.join(root, "project", ".agents", "skills", "s"), home: path.join(root, "home") } }
  }

  const answering = (outcomes: Record<string, string>): SandboxRunner => async () => ({
    exitCode: 0,
    stdout: Object.entries(outcomes).map(([name, outcome]) => `${name}=${outcome}`).join("\n"),
    stderr: "",
  })

  const ENFORCED = {
    "write own task directory": "allowed",
    "write another task directory": "denied",
    "read another task directory": "denied",
    "write workflow state": "denied",
    "read workflow state": "denied",
    "read Codex credentials": "denied",
  }

  test("passes only when every probe comes out as the profile says", async () => {
    const { root, input } = await runDir()
    try {
      expect(await verifySandbox(input, answering(ENFORCED))).toMatchObject({ ok: true, problems: [] })
      const leaky = await verifySandbox(input, answering({ ...ENFORCED, "write another task directory": "allowed" }))
      expect(leaky.ok).toBe(false)
      expect(leaky.problems).toEqual(["write another task directory: expected denied, got allowed"])
      const missing = await verifySandbox(input, async () => ({ exitCode: 127, stdout: "", stderr: "spawn codex ENOENT" }))
      expect(missing.ok).toBe(false)
      expect(missing.problems[0]).toContain("codex sandbox could not run")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // The real OS boundary. Needs `codex` (0.163 or later) on PATH; the check itself reads nothing it prints.
  const real = process.env.NEX_CODEX_SANDBOX_TEST === "1" ? test : test.skip
  real("the installed Codex enforces the profile on this host", async () => {
    const { root, input } = await runDir()
    try {
      const check = await verifySandbox({ ...input, home: homedir() })
      expect(check.problems).toEqual([])
      expect(check.results).toMatchObject(ENFORCED)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})
