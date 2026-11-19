/**
 * Classifies the provider error that ended a briefing agent's turn, so the
 * workflow can stop instead of retrying into the same failure.
 *
 * The provider rarely says why it refused. A 403 in particular may be an
 * authorization block, a regional or routing block in front of the API, or
 * an exhausted plan, and the error text alone does not tell them apart. It is
 * reported as `forbidden` unless the account's own usage figures show a full
 * window, and never assumed to be quota.
 */

export type ProviderErrorClass = "auth" | "forbidden" | "quota" | "rate_limit" | "transient" | "unknown"

export interface ProviderError {
  class: ProviderErrorClass
  status?: number
  /** First line of the provider's message, without HTML. */
  detail: string
}

const PATTERNS: Array<[ProviderErrorClass, RegExp]> = [
  ["auth", /\b401\b|unauthori[sz]ed|invalid[ _-]?(api[ _-]?key|token|grant)|token (has )?expired|refresh token|not (logged|signed) in|log ?in (again|required)|authentication/i],
  ["quota", /usage limit|quota|insufficient[_ ]quota|exceeded your (current )?(plan|quota|limit)|plan limit|credits? (exhausted|depleted)/i],
  ["rate_limit", /\b429\b|rate[ -]?limit|too many requests/i],
  ["forbidden", /\b403\b|forbidden|access denied/i],
  ["transient", /\b50[0-4]\b|overloaded|timed? ?out|timeout|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|stream (disconnected|error|closed)|connection (reset|closed|refused|error)|routing discovery|service unavailable|temporar/i],
]

function plain(message: string) {
  return message.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()
}

/**
 * `usedPercent` is the account's fullest usage window as Nex last saw it
 * (Codex rate-limit pushes), or null when unknown.
 */
export function classifyProviderError(message: string, usedPercent: number | null = null): ProviderError | null {
  if (!message.trim()) return null
  const status = Number(message.match(/\bstatus:? (4\d\d|5\d\d)\b|\b(401|403|429|50[0-4])\b/)?.slice(1).find(Boolean)) || undefined
  // The status code decides before any word in the message: an HTML error page can contain anything.
  const byStatus: ProviderErrorClass | undefined = status === 401 ? "auth" : status === 403 ? "forbidden" : status === 429 ? "rate_limit"
    : status && status >= 500 ? "transient" : undefined
  const quota = PATTERNS.find(([name]) => name === "quota")![1].test(plain(message))
  let errorClass = quota ? "quota" : byStatus ?? PATTERNS.find(([, pattern]) => pattern.test(plain(message)))?.[0]
  if (!errorClass) return null
  // A refusal while the account's window is full is most likely the plan limit.
  if ((errorClass === "forbidden" || errorClass === "rate_limit") && usedPercent !== null && usedPercent >= 100) errorClass = "quota"
  return { class: errorClass, ...(status ? { status } : {}), detail: plain(message).slice(0, 160) }
}

/** What the run does next. Halting classes will fail again on retry, so nothing new starts. */
export function providerAction(errorClass: ProviderErrorClass): "halt" | "backoff" | "none" {
  if (errorClass === "auth" || errorClass === "forbidden" || errorClass === "quota") return "halt"
  if (errorClass === "rate_limit" || errorClass === "transient") return "backoff"
  return "none"
}

/** Exponential backoff for repeated rate limits or transient failures, capped at 15 minutes. */
export function backoffMs(consecutive: number) {
  return Math.min(15 * 60_000, 60_000 * 2 ** Math.max(0, consecutive - 1))
}
