import { realpath, stat } from "node:fs/promises"
import path from "node:path"
import { fileDeliveryKind } from "../shared/file-delivery"

/** Both lexical paths and symlink targets must remain inside the registered root. */
export async function confinedFile(root: string, candidate: string): Promise<string | null> {
  try {
    const [realRoot, realFile] = await Promise.all([realpath(root), realpath(candidate)])
    if (!realFile.startsWith(realRoot + path.sep) || !(await stat(realFile)).isFile()) return null
    return realFile
  } catch { return null }
}

export function fileDeliveryHeaders(name: string, mime: string, download: boolean): Record<string, string> {
  const kind = fileDeliveryKind(name)
  const attachment = download || kind === "download"
  const filename = path.basename(name).replace(/[\x00-\x1f\x7f]/g, "_")
  const fallback = filename.replace(/[^a-zA-Z0-9._-]/g, "_") || "download"
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return {
    "Content-Type": kind === "pdf" ? "application/pdf" : kind === "text" ? "text/plain; charset=utf-8" : mime,
    "Content-Disposition": `${attachment ? "attachment" : "inline"}; filename="${fallback}"; filename*=UTF-8''${encoded}`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
    // No scripts from generated documents may execute with Nex's cookies.
    ...(kind === "pdf" || kind === "image" ? {} : { "Content-Security-Policy": "sandbox; default-src 'none'" }),
  }
}
