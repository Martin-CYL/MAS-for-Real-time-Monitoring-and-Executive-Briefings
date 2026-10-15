import { Database } from "bun:sqlite"
import { betterAuth } from "better-auth"
import { getMigrations } from "better-auth/db/migration"
import { randomUUID } from "node:crypto"

export async function createAccounts(options: {
  databasePath: string; origin: string; secret: string
  rateLimit?: boolean
  onResetLink?: (email: string, url: string) => Promise<void>
}) {
  if (options.secret.length < 32) throw new Error("A random authentication secret of at least 32 characters is required")
  const database = new Database(options.databasePath)
  database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;")
  const auth = betterAuth({
    appName: "Nex", baseURL: options.origin, secret: options.secret, database,
    trustedOrigins: [options.origin],
    emailAndPassword: {
      enabled: true, minPasswordLength: 12, maxPasswordLength: 128,
      autoSignIn: false, revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 3600,
      // Signup is callable by the host administrator only. The gateway never
      // exposes sign-up/email, and no user has access to this database.
      sendResetPassword: async ({ user, url }) => { await options.onResetLink?.(user.email, url) },
    },
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24, cookieCache: { enabled: false } },
    advanced: {
      ipAddress: { ipAddressHeaders: ["x-nex-client-ip"] },
      useSecureCookies: options.origin.startsWith("https:"), cookiePrefix: "nex-account",
      database: { generateId: () => randomUUID() },
      defaultCookieAttributes: { httpOnly: true, sameSite: "strict", path: "/" },
    },
    rateLimit: { enabled: options.rateLimit ?? true, window: 60, max: 30 },
  })
  const { runMigrations } = await getMigrations(auth.options)
  await runMigrations()
  return { auth, database }
}
export type Accounts = Awaited<ReturnType<typeof createAccounts>>
