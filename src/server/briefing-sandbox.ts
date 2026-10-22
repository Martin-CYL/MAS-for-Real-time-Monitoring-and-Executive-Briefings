import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import type { BriefingRole } from "./briefing-contracts"

/**
 * Least-privilege execution for briefing agents.
 *
 * Every other Nex chat runs Codex with `danger-full-access`. A briefing agent
 * instead gets a Codex permission profile built here and enforced by Codex's
 * OS sandbox (Seatbelt on macOS): it may write only its own task directory,
 * may not read the other agents' directories, the workflow state, Nex's data
 * or the usual credential stores, and keeps network access for research.
 * Codex features that reach outside the sandbox (desktop and browser control,
 * connectors, plugins, native sub-agents) are switched off for the thread.
 *
 * Profiles are passed as thread config overrides, so nothing is written to
 * the user's Codex configuration. `verifySandbox` runs the same profile
 * through `codex sandbox` before a run starts: a host where the denials do not
 * hold refuses to run the workflow rather than running it unconfined.
 *
 * Reads outside the denied paths stay allowed (system tools, Python, the
 * Skill, the rest of the user's files). That is a deliberate limit: a
 * deny-everything home breaks shells and interpreters across hosts.
 */

export type FileAccess = "read" | "write" | "deny"

/**
 * The Nex tools each role may call. Everything else is refused, including the
 * chat tools (messaging the user's chats, schedules, new chats), attachments
 * and image generation: an agent reading untrusted pages gets no channel out
 * of its task except its own submission. Enforced in `NexToolRuntime`; the
 * same list is all the agent's Codex session is offered.
 */
export const ROLE_TOOLS: Record<BriefingRole, readonly string[]> = {
  chief: ["briefing_status", "briefing_delegate", "briefing_wait", "briefing_submit", "briefing_cross_border"],
  lead: ["briefing_status", "briefing_delegate", "briefing_wait", "briefing_submit"],
  cross_border: ["briefing_status", "briefing_delegate", "briefing_wait", "briefing_submit"],
  scout: ["briefing_status", "briefing_submit"],
  reviewer: ["briefing_status", "briefing_submit"],
}

export interface CodexRestriction {
  /** Permission profile name, unique per role. */
  profile: string
  /** Working directory for the agent's session. */
  cwd: string
  /** Path → access, most specific path wins. Built on Codex's `:read-only` profile. */
  filesystem: Record<string, FileAccess>
  network: boolean
  disabledFeatures: string[]
  env: { set: Record<string, string>; exclude: string[] }
  /** The Nex MCP tools the session is offered; Codex runs them without asking (see `nexMcpApproval`). */
  nexTools: readonly string[]
}

/** Codex features that act outside the shell sandbox or outside Nex's accounting. */
export const DISABLED_CODEX_FEATURES = [
  "computer_use",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "in_app_browser",
  "apps",
  "plugins",
  "multi_agent",
  "multi_agent_v2",
]

/** Credential and private-data locations under the user's home, denied to every briefing agent. */
export const HOME_DENY = [
  ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".config", ".netrc", ".git-credentials", ".gitconfig",
  ".npmrc", ".pypirc", ".codex", ".claude", ".nex", ".nex-dev", ".agents", ".zsh_history", ".bash_history",
  "Library/Keychains", "Library/Application Support", "Library/Cookies", "Library/Mail", "Library/Messages",
]

export interface RestrictionInput {
  role: BriefingRole
  taskDir: string
  runDir: string
  projectDir: string
  skillDir: string
  home: string
  /** CODEX_HOME and Nex's data directory when they live elsewhere. */
  extraDeny?: string[]
}

/**
 * The profile for one role. Scouts see only their own directory of the run;
 * leads, the chief and the reviewer may read the run (they consolidate and
 * review it) and write only their own directory. Workflow state, logs and
 * discovery output belong to the controller and are never writable.
 */
export function buildRestriction(input: RestrictionInput): CodexRestriction {
  const fs: Record<string, FileAccess> = {}
  for (const rel of HOME_DENY) fs[path.join(input.home, rel)] = "deny"
  for (const dir of input.extraDeny ?? []) fs[dir] = "deny"
  // The project holds other runs and the user's files; only the Skill and this run are needed.
  fs[input.projectDir] = "deny"
  fs[input.skillDir] = "read"
  if (input.role === "scout") {
    fs[path.join(input.runDir, "discovery")] = "read"
  } else {
    fs[input.runDir] = "read"
  }
  fs[input.taskDir] = "write"
  // Controller-owned files, also inside a chief's writable run root.
  for (const name of ["workflow.json", "workflow.log.jsonl", "assignment.json", "submission.json"]) {
    fs[path.join(input.runDir, name)] = "deny"
  }
  if (input.role === "chief") fs[path.join(input.runDir, "tasks")] = "read"
  fs[path.join(input.runDir, "discovery")] = "read"
  fs[path.join(input.taskDir, "assignment.json")] = "read"
  fs[path.join(input.taskDir, "submission.json")] = "read"
  // The run's dates and window, written once by the controller (found live: a chief rewrote its report date).
  fs[path.join(input.taskDir, "run_config.json")] = "read"
  return {
    nexTools: ROLE_TOOLS[input.role],
    profile: `nex-briefing-${input.role === "cross_border" ? "lead" : input.role}`,
    cwd: input.taskDir,
    filesystem: fs,
    network: true,
    disabledFeatures: DISABLED_CODEX_FEATURES,
    env: {
      set: {
        PYTHONDONTWRITEBYTECODE: "1",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GH_PROMPT_DISABLED: "1",
      },
      exclude: ["*TOKEN*", "*SECRET*", "*KEY*", "*PASSWORD*", "*CREDENTIAL*", "GH_*", "GITHUB_*", "NEX_*", "SSH_AUTH_SOCK"],
    },
  }
}

/** Thread config overrides for `thread/start`, `thread/resume` and `thread/fork`. */
export function restrictionConfig(restriction: CodexRestriction): Record<string, unknown> {
  const prefix = `permissions.${restriction.profile}`
  return {
    default_permissions: restriction.profile,
    [`${prefix}.extends`]: ":read-only",
    [`${prefix}.network.enabled`]: restriction.network,
    [`${prefix}.filesystem`]: restriction.filesystem,
    ...Object.fromEntries(restriction.disabledFeatures.map((feature) => [`features.${feature}`, false])),
    "shell_environment_policy.inherit": "all",
    "shell_environment_policy.exclude": restriction.env.exclude,
    "shell_environment_policy.set": restriction.env.set,
  }
}

/**
 * Settings for the Nex MCP server in a confined session. Codex asks before
 * running an MCP tool once the shell is sandboxed, and with approval policy
 * "never" that question is a refusal: the agent could not even submit. The
 * Nex server alone is approved (its tools are checked per role by Nex), and
 * only the role's tools are listed.
 */
export function nexMcpApproval(restriction: CodexRestriction) {
  return { default_tools_approval_mode: "approve", enabled_tools: [...restriction.nexTools] }
}

/** A stable key: a session started under one restriction is never reused under another. */
export function restrictionKey(restriction: CodexRestriction | undefined) {
  return restriction ? JSON.stringify(restrictionConfig(restriction)) : ""
}

function toml(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "boolean" || typeof value === "number") return String(value)
  if (Array.isArray(value)) return `[${value.map(toml).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value).map(([key, entry]) => `${JSON.stringify(key)}=${toml(entry)}`).join(",")}}`
  }
  throw new Error(`cannot express ${String(value)} in TOML`)
}

/** The same overrides as `-c key=value` arguments, for `codex sandbox`. */
export function restrictionCliArgs(restriction: CodexRestriction): string[] {
  return Object.entries(restrictionConfig(restriction)).flatMap(([key, value]) => ["-c", `${key}=${toml(value)}`])
}

export interface SandboxCheck {
  ok: boolean
  results: Record<string, "allowed" | "denied">
  problems: string[]
}

export type SandboxRunner = (args: string[], cwd: string, timeoutMs: number) => Promise<{ exitCode: number; stdout: string; stderr: string }>

export const runCodexSandbox: SandboxRunner = (args, cwd, timeoutMs) => new Promise((resolve) => {
  const child = spawn("codex", ["sandbox", ...args], { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env })
  let stdout = ""
  let stderr = ""
  const timer = setTimeout(() => child.kill(), timeoutMs)
  child.stdout.on("data", (chunk) => { stdout += chunk })
  child.stderr.on("data", (chunk) => { stderr += chunk })
  child.on("error", (error) => { clearTimeout(timer); resolve({ exitCode: 127, stdout, stderr: String(error) }) })
  child.on("close", (code) => { clearTimeout(timer); resolve({ exitCode: code ?? 1, stdout, stderr }) })
})

/**
 * Runs a scout's profile through `codex sandbox` against canaries in the run:
 * its own directory must be writable; a sibling task directory, the workflow
 * state and a denied canary must not be. Codex's own credentials are checked
 * too when the file exists. Any other outcome means the host does not enforce
 * the profile, and the run must not start.
 */
export async function verifySandbox(input: Omit<RestrictionInput, "role" | "taskDir">, run: SandboxRunner = runCodexSandbox): Promise<SandboxCheck> {
  const own = path.join(input.runDir, "tasks", "_sandbox-check")
  const sibling = path.join(input.runDir, "tasks", "_sandbox-sibling")
  await mkdir(own, { recursive: true })
  await mkdir(sibling, { recursive: true })
  await writeFile(path.join(sibling, "canary.txt"), "canary\n")
  const restriction = buildRestriction({ ...input, role: "scout", taskDir: own })
  const probes: Array<[string, string, "allowed" | "denied"]> = [
    ["write own task directory", `echo ok > ${JSON.stringify(path.join(own, "probe.txt"))}`, "allowed"],
    ["write another task directory", `echo x > ${JSON.stringify(path.join(sibling, "probe.txt"))}`, "denied"],
    ["read another task directory", `cat ${JSON.stringify(path.join(sibling, "canary.txt"))}`, "denied"],
    ["write workflow state", `echo x > ${JSON.stringify(path.join(input.runDir, "workflow.json"))}`, "denied"],
    ["read workflow state", `cat ${JSON.stringify(path.join(input.runDir, "workflow.json"))}`, "denied"],
    ["read Codex credentials", `test ! -e ${JSON.stringify(path.join(input.home, ".codex", "auth.json"))} && exit 1; cat ${JSON.stringify(path.join(input.home, ".codex", "auth.json"))}`, "denied"],
  ]
  const script = probes.map(([name, command]) => `if (${command}) >/dev/null 2>&1; then echo "${name}=allowed"; else echo "${name}=denied"; fi`).join("\n")
  const result = await run(["-P", restriction.profile, "-C", own, ...restrictionCliArgs(restriction), "--", "/bin/sh", "-c", script], own, 30_000)
  const results: SandboxCheck["results"] = {}
  for (const line of result.stdout.split("\n")) {
    const [name, outcome] = line.split("=")
    if (name && (outcome === "allowed" || outcome === "denied")) results[name] = outcome
  }
  const problems = probes
    .filter(([name, , expected]) => results[name] !== expected)
    .map(([name, , expected]) => `${name}: expected ${expected}, got ${results[name] ?? "no result"}`)
  if (result.exitCode !== 0 && Object.keys(results).length === 0) {
    problems.unshift(`codex sandbox could not run (exit ${result.exitCode}): ${result.stderr.trim().split("\n").slice(-2).join(" ").slice(0, 300)}`)
  }
  return { ok: problems.length === 0, results, problems }
}
