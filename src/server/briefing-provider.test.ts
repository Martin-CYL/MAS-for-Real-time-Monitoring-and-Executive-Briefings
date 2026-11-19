import { describe, expect, test } from "bun:test"
import { backoffMs, classifyProviderError, providerAction } from "./briefing-provider"

describe("provider error classification", () => {
  test("the live run's 403 page is forbidden, not quota, unless the account's window is full", () => {
    const page = "unexpected status 403 Forbidden: <html><head><style>body{}</style></head><body>Please log in again to continue</body></html>"
    expect(classifyProviderError(page)).toMatchObject({ class: "forbidden", status: 403 })
    expect(classifyProviderError(page, 79)).toMatchObject({ class: "forbidden" })
    expect(classifyProviderError(page, 100)).toMatchObject({ class: "quota" })
    expect(classifyProviderError(page)!.detail).not.toContain("<")
  })

  test("status codes and messages map to distinct classes", () => {
    expect(classifyProviderError("unexpected status 401 Unauthorized")!.class).toBe("auth")
    expect(classifyProviderError("Your refresh token has expired; log in again")!.class).toBe("auth")
    expect(classifyProviderError("unexpected status 429 Too Many Requests")!.class).toBe("rate_limit")
    expect(classifyProviderError("You've hit your usage limit. Try again later.")!.class).toBe("quota")
    expect(classifyProviderError("unexpected status 429: usage limit reached for this plan")!.class).toBe("quota")
    expect(classifyProviderError("unexpected status 503 Service Unavailable")!.class).toBe("transient")
    expect(classifyProviderError("stream disconnected before completion")!.class).toBe("transient")
    expect(classifyProviderError("workspace routing discovery failed: other")!.class).toBe("transient")
    expect(classifyProviderError("The model wrote an invalid patch")).toBeNull()
    expect(classifyProviderError("")).toBeNull()
  })

  test("halting classes stop the run; rate limits and transient errors back off exponentially to 15 minutes", () => {
    expect(["auth", "forbidden", "quota"].map((name) => providerAction(name as never))).toEqual(["halt", "halt", "halt"])
    expect(providerAction("rate_limit")).toBe("backoff")
    expect(providerAction("unknown")).toBe("none")
    expect([1, 2, 3, 10].map(backoffMs)).toEqual([60_000, 120_000, 240_000, 900_000])
  })
})
