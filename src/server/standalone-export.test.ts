import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { TranscriptEntry } from "../shared/types"
import { publicTranscriptMessages, writeStandaloneTranscriptExport } from "./standalone-export"
import { handleSharedTranscript } from "./share-http"

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
const messages: TranscriptEntry[] = [
  { _id: "u", createdAt: 1, kind: "user_prompt", content: "Summarise the news", debugRaw: "secret session" },
  { _id: "a", createdAt: 2, kind: "assistant_text", text: "Nex briefing: [source](https://example.com)", debugRaw: "provider secret" },
  { _id: "s", createdAt: 3, kind: "status", status: "private internal status" },
  { _id: "hidden", createdAt: 4, kind: "assistant_text", text: "hidden", hidden: true },
  { _id: "child", createdAt: 5, kind: "assistant_text", text: "subagent", parentToolUseId: "t" },
]
async function fixture(mode: "bundle" | "metadata" = "metadata") {
  const dataDir = await mkdtemp(path.join(tmpdir(), "nex-share-")); dirs.push(dataDir)
  const viewerDistDir = path.join(dataDir, "viewer")
  await mkdir(path.join(viewerDistDir, "assets"), { recursive: true })
  await writeFile(path.join(viewerDistDir, "index.html"), "<title>Nex</title>")
  await writeFile(path.join(viewerDistDir, "assets", "viewer.js"), "// Nex")
  const attachmentPath = path.join(dataDir, "private.txt")
  await writeFile(attachmentPath, "private file contents")
  const input = structuredClone(messages)
  const user = input[0]!
  if (user.kind === "user_prompt") user.attachments = [{ id: "file", kind: "file", displayName: "note.txt", absolutePath: attachmentPath, relativePath: "private.txt", contentUrl: "/api/private", mimeType: "text/plain", size: 21 }]
  const result = await writeStandaloneTranscriptExport({ dataDir, sourceOrigin: "http://user:password@private.example", localPath: dataDir, chatId: "private-chat-id", title: "Private title", theme: "light", attachmentMode: mode, messages: input }, { viewerDistDir })
  if (!result.ok) throw new Error(result.error)
  return { dataDir, result, input }
}
describe("Nex self-hosted sharing", () => {
  test("allows only visible conversation text; strips debug/provider records without changing originals", () => {
    const safe = publicTranscriptMessages(messages)
    expect(safe.map(m => m.kind)).toEqual(["user_prompt", "assistant_text"])
    expect(JSON.stringify(safe)).not.toContain("secret")
    expect(messages[0]!.debugRaw).toBe("secret session")
  })
  test("publishes an opaque local link and removes private origins, IDs and attachment paths", async () => {
    const { result, dataDir, input } = await fixture()
    expect(result.shareUrl).toMatch(/^\/share\/[a-f0-9]{48}\/$/)
    expect(result.uploadedFileCount).toBe(0)
    expect(result.bundledAttachmentCount).toBe(0)
    const json = await readFile(result.transcriptJsonPath, "utf8")
    for (const secret of ["secret", "private.example", "private-chat-id", dataDir, "/api/private"]) expect(json).not.toContain(secret)
    expect(input[0]!.debugRaw).toBe("secret session")
  })
  test("snapshot is immutable when a second share is made", async () => {
    const a = await fixture(); const before = await readFile(a.result.transcriptJsonPath, "utf8")
    const b = await fixture()
    expect(a.result.shareSlug).not.toBe(b.result.shareSlug)
    expect(await readFile(a.result.transcriptJsonPath, "utf8")).toBe(before)
  })
  test("serves viewer, JSON and assets with no-store; HEAD is bodyless", async () => {
    const { result, dataDir } = await fixture()
    for (const suffix of ["", "transcript.json", "assets/viewer.js"]) {
      const res = await handleSharedTranscript(new Request(`http://localhost${result.shareUrl}${suffix}`), dataDir)
      expect(res?.status).toBe(200); expect(res?.headers.get("cache-control")).toBe("no-store")
    }
    const res = await handleSharedTranscript(new Request(`http://localhost${result.shareUrl}`, { method: "HEAD" }), dataDir)
    expect(await res?.text()).toBe("")
  })
  test("redirects missing trailing slash to keep relative assets working", async () => {
    const { result, dataDir } = await fixture()
    const res = await handleSharedTranscript(new Request(`http://localhost${result.shareUrl.slice(0, -1)}`), dataDir)
    expect(res?.status).toBe(308); expect(res?.headers.get("location")).toBe(result.shareUrl)
  })
  test("rejects invalid tokens, writes, encoded traversal and symlink escapes", async () => {
    const { result, dataDir } = await fixture()
    await symlink(path.join(dataDir, "private.txt"), path.join(result.outputDir, "assets", "escape.txt"))
    for (const url of ["/share/invalid/", `${result.shareUrl}assets/%2e%2e%2f%2e%2e%2fprivate.txt`, `${result.shareUrl}assets/escape.txt`, `${result.shareUrl}missing.json`]) {
      expect((await handleSharedTranscript(new Request(`http://localhost${url}`), dataDir))?.status).toBe(404)
    }
    expect((await handleSharedTranscript(new Request(`http://localhost${result.shareUrl}`, { method: "POST" }), dataDir))?.status).toBe(405)
    expect(await handleSharedTranscript(new Request("http://localhost/api/private"), dataDir)).toBeNull()
  })
  test("explicit bundled attachments are downloads, never executable app-origin pages", async () => {
    const { result, dataDir } = await fixture("bundle")
    expect(result.bundledAttachmentCount).toBe(1)
    const res = await handleSharedTranscript(new Request(`http://localhost${result.shareUrl}attachments/file-note.txt`), dataDir)
    expect(res?.status).toBe(200)
    expect(res?.headers.get("content-disposition")).toBe("attachment")
    expect(await res?.text()).toBe("private file contents")
  })
})
