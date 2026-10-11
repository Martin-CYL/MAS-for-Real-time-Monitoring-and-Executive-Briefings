import path from "node:path"
import { realpath } from "node:fs/promises"

/** Public, capability-link snapshots only. Never fall back to the app or expose its APIs. */
export async function handleSharedTranscript(req: Request, dataDir: string): Promise<Response | null> {
  const url = new URL(req.url)
  if (!url.pathname.startsWith("/share/")) return null
  const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" }
  if (req.method !== "GET" && req.method !== "HEAD") return new Response(null, { status: 405, headers: { ...headers, Allow: "GET, HEAD" } })
  const missing = () => new Response("Shared conversation not found", { status: 404, headers })
  let segments: string[]
  try { segments = decodeURIComponent(url.pathname).slice(7).split("/") } catch { return missing() }
  const token = segments.shift() ?? ""
  if (!/^[a-f0-9]{48}$/.test(token) || segments.some(s => s === "." || s === ".." || s.includes("\\") || s.includes("\0"))) return missing()
  const root = path.join(dataDir, "shares", token)
  try {
    const rootReal = await realpath(root)
    const sharesReal = await realpath(path.join(dataDir, "shares"))
    if (rootReal !== path.join(sharesReal, token)) return missing()
    if (segments.length === 0) return new Response(null, { status: 308, headers: { ...headers, Location: `${url.pathname}/` } })
    const relative = segments.join("/") || "index.html"
    // Attachments can contain active HTML/SVG. Downloads must not execute in the app origin.
    const attachment = relative.startsWith("attachments/")
    if (!attachment && relative !== "index.html" && relative !== "transcript.json" && relative !== "nex-app-icon.svg" && !relative.startsWith("assets/")) return missing()
    const filePath = await realpath(path.join(rootReal, relative))
    if (!filePath.startsWith(rootReal + path.sep)) return missing()
    const file = Bun.file(filePath)
    if (!(await file.exists())) return missing()
    return new Response(req.method === "HEAD" ? null : file, { headers: { ...headers,
      "Content-Type": attachment ? "application/octet-stream" : file.type,
      ...(attachment ? { "Content-Disposition": "attachment" } : {}),
    } })
  } catch { return missing() }
}
