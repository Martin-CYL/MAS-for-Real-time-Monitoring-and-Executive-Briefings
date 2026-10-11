import { spawn } from "node:child_process"
export interface CliOptions { host: string; port: number; strictPort: boolean; openBrowser: boolean; password: string | null }
export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { host: "127.0.0.1", port: 3210, strictPort: true, openBrowser: true, password: process.env.NEX_PASSWORD || null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--no-open") options.openBrowser = false
    else if (arg === "--strict-port" || arg === "--no-cloud") continue
    else if (arg === "--host" || arg === "--port") {
      const value = argv[++i]
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`)
      if (arg === "--host") options.host = value
      else {
        if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error("Invalid port")
        options.port = Number(value)
      }
    } else throw new Error(`Unsupported option: ${arg}`)
  }
  return options
}
export function openUrl(url: string) {
  const command = process.platform === "darwin" ? "open" : "xdg-open"
  const child = spawn(command, [url], { stdio: "ignore" })
  child.on("error", () => {})
}
/** Used only to inspect installed provider CLI versions, never to update Nex. */
export async function fetchLatestPackageVersion(packageName: string) {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`, { signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error(`Registry returned ${response.status}`)
  const result = await response.json() as { version?: string }
  if (!result.version) throw new Error("Missing package version")
  return result.version
}
export function compareVersions(currentVersion: string, latestVersion: string) {
  const currentParts = normalizeVersion(currentVersion)
  const latestParts = normalizeVersion(latestVersion)
  const length = Math.max(currentParts.length, latestParts.length)

  for (let index = 0; index < length; index += 1) {
    const current = currentParts[index] ?? 0
    const latest = latestParts[index] ?? 0
    if (current === latest) continue
    return current < latest ? -1 : 1
  }

  return 0
}

function normalizeVersion(version: string) {
  return version
    .trim()
    .replace(/^v/i, "")
    .split("-")[0]
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part))
}
