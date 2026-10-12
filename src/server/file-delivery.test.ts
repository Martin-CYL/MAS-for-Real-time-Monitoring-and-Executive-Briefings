import { test, expect } from "bun:test"
import { mkdtemp, rm, writeFile, symlink, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { startNexServer } from "./server"
import { storeLocalAttachment } from "./nex-display-tools"
import { projectFileUrl } from "../shared/file-delivery"

test("authenticated file delivery handles Unicode, downloads, missing files and escaped paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nex-delivery-"))
  const projectDir = path.join(root, "workspace")
  await mkdir(projectDir)
  const server = await startNexServer({ dataDir: path.join(root, "data"), port: 56381, strictPort: false, password: "file-test" })
  try {
    const project = await server.store.openProject(projectDir, "Delivery test")
    const base = `http://127.0.0.1:${server.port}`
    const login = await fetch(base + "/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "file-test" }) })
    const headers = { Cookie: login.headers.get("set-cookie")!.split(";")[0]! }
    for (const name of ["今日 新闻 100% #1.pdf", "literal%20name.pdf", "english.pdf", "简报.docx", "slides.pptx", "sheet.xlsx", "bundle.zip", "report.html", "image.svg", "notes.txt", "data.csv", "script.ts", "photo.png"]) {
      const contents = name.endsWith(".pdf") ? "%PDF-1.4\nfixture" : "file body"
      await writeFile(path.join(projectDir, name), contents)
      const url = base + projectFileUrl(project.id, name)
      expect((await fetch(url)).status).toBe(401)
      const res = await fetch(url, { headers })
      expect(res.status).toBe(200)
      expect(await res.text()).toBe(contents)
      expect(res.headers.get("content-disposition")).toContain(`filename*=UTF-8''${encodeURIComponent(name)}`)
      const preview = /\.(pdf|png|csv|txt|ts)$/.test(name)
      expect(res.headers.get("content-disposition")?.startsWith(preview ? "inline;" : "attachment;")).toBe(true)
      if (name.endsWith(".pdf")) expect(res.headers.get("content-type")).toBe("application/pdf")
      const download = await fetch(url + "?download=1", { headers })
      expect(download.headers.get("content-disposition")).toStartWith("attachment;")
      await download.arrayBuffer()
    }
    await writeFile(path.join(root, "outside.txt"), "secret")
    await symlink(path.join(root, "outside.txt"), path.join(projectDir, "escape.txt"))
    for (const name of ["missing.pdf", "escape.txt"]) {
      expect((await fetch(base + projectFileUrl(project.id, name), { headers })).status).toBe(404)
    }
    for (const name of ["../outside.txt", "a/../../outside.txt", "/etc/passwd", "a\0b"]) {
      expect((await fetch(base + projectFileUrl(project.id, name), { headers })).status).toBe(400)
    }
    expect((await fetch(base + `/api/projects/${project.id}/files/%ZZ/content`, { headers })).status).toBe(400)
    expect((await fetch(base + projectFileUrl(project.id, "english.pdf"), { method: "POST", headers })).status).toBe(405)

    const chat = await server.store.createChat(project.id)
    const name = "附件 100% #报告.pdf"
    const source = path.join(projectDir, name)
    await writeFile(source, "%PDF-1.4\nsnapshot")
    const stored = await storeLocalAttachment(source, { chatId: chat.id, dataDir: path.join(root, "data") })
    await rm(source)
    const media = await fetch(base + stored.attachment.url, { headers })
    expect(media.status).toBe(200)
    expect(media.headers.get("content-type")).toBe("application/pdf")
    expect(media.headers.get("content-disposition")).toContain(`filename*=UTF-8''${encodeURIComponent(name)}`)
    expect(await media.text()).toContain("snapshot")
    expect((await fetch(base + stored.attachment.url)).status).toBe(401)
    expect((await fetch(base + stored.attachment.url + "?download=1", { headers })).headers.get("content-disposition")).toStartWith("attachment;")
  } finally {
    await server.stop()
    await rm(root, { recursive: true, force: true })
  }
}, 15000)
