import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { startNexServer } from "./server"

test("independent instances reject each other's password, session and project files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nex-isolation-"))
  const a = await startNexServer({ dataDir: path.join(root, "a"), port: 54331, password: "dev-password", strictPort: true })
  let b: Awaited<ReturnType<typeof startNexServer>> | undefined
  try {
    b = await startNexServer({ dataDir: path.join(root, "b"), port: 54332, password: "production-password", strictPort: true })
    const project = await a.store.openProject(root, "Development only")
    await writeFile(path.join(root, "private.txt"), "development-only evidence")
    const login = async (port: number, password: string) => fetch(`http://127.0.0.1:${port}/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }),
    })
    const devLogin = await login(a.port, "dev-password")
    expect(devLogin.status).toBe(200)
    expect(devLogin.headers.get("set-cookie")).not.toContain("Domain=")
    expect((await login(b.port, "dev-password")).status).toBe(401)
    const cookieA = devLogin.headers.get("set-cookie")!.split(";")[0]!
    const status = await fetch(`http://127.0.0.1:${b.port}/auth/status`, { headers: { Cookie: cookieA } })
    expect((await status.json()).authenticated).toBe(false)
    const route = `/api/projects/${project.id}/files/private.txt/content`
    expect((await fetch(`http://127.0.0.1:${a.port}${route}`, { headers: { Cookie: cookieA } })).status).toBe(200)
    const productionLogin = await login(b.port, "production-password")
    const cookieB = productionLogin.headers.get("set-cookie")!.split(";")[0]!
    expect((await fetch(`http://127.0.0.1:${b.port}${route}`, { headers: { Cookie: cookieB } })).status).toBe(404)
  } finally {
    await a.stop()
    await b?.stop()
    await rm(root, { recursive: true, force: true })
  }
}, 15000)
