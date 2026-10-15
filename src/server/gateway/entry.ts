import { mkdir, readFile, writeFile, chmod } from "node:fs/promises"
import path from "node:path"
import { hashPassword } from "better-auth/crypto"
import { randomBytes } from "node:crypto"
import { createAccounts } from "./accounts"
import { startGateway, type Tenant } from "./server"

process.umask(0o077)
const directory = process.env.NEX_ACCOUNTS_DIR ?? "/data"
const origin = process.env.NEX_PUBLIC_ORIGIN
const secret = process.env.NEX_AUTH_SECRET
if (!origin || !secret) throw new Error("NEX_PUBLIC_ORIGIN and NEX_AUTH_SECRET required")
await mkdir(directory, { recursive: true, mode: 0o700 })
let resetLink: string | undefined
const accounts = await createAccounts({ databasePath: path.join(directory, "accounts.sqlite"), origin, secret,
  onResetLink: async (_email, url) => { resetLink = url },
})
await chmod(path.join(directory, "accounts.sqlite"), 0o600)
const action = process.argv[2]
if (action === "invite" || action === "reset") {
  const email = process.argv[3]?.trim().toLowerCase()
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Valid email required")
  let user = accounts.database.query<{ id: string }, [string]>('SELECT id FROM user WHERE email = ?').get(email)
  if (action === "invite") {
    if (user) throw new Error("Account already exists; use reset")
    const result = await accounts.auth.api.signUpEmail({ body: { name: process.argv[4] ?? email, email, password: randomBytes(48).toString("base64url") } })
    user = { id: result.user.id }
  }
  if (!user) throw new Error("Account not found")
  await accounts.auth.api.requestPasswordReset({ body: { email, redirectTo: origin + "/reset-password" } })
  if (!resetLink) throw new Error("No reset link generated")
  await mkdir(path.join(directory, "invitations"), { recursive: true, mode: 0o700 })
  await writeFile(path.join(directory, "invitations", user.id + ".txt"), resetLink + "\n", { mode: 0o600 })
  console.log(JSON.stringify({ userId: user.id, linkFile: path.join(directory, "invitations", user.id + ".txt"), expiresIn: "1 hour" }))
  accounts.database.close()
} else if (action === "disable") {
  const id = process.argv[3]
  accounts.database.query('DELETE FROM session WHERE userId = ?').run(id)
  accounts.database.query('UPDATE account SET password = ? WHERE userId = ?').run(await hashPassword(randomBytes(48).toString("base64url")), id)
  // Also remove this id from tenants.json and restart the gateway when retiring a workspace.
  accounts.database.close()
} else {
  const tenants = JSON.parse(await readFile(path.join(directory, "tenants.json"), "utf8")) as Tenant[]
  const gateway = startGateway({ accounts, tenants, origin, port: Number(process.env.PORT ?? 3220), hostname: process.env.HOST ?? "0.0.0.0" })
  console.log("Nex account gateway ready")
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { gateway.stop(); accounts.database.close(); process.exit(0) })
}
