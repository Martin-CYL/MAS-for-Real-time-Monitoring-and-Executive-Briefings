import { describe, expect, test } from "bun:test"
import {
  NEX_AGENT_TRAILER_KEY,
  NEX_COMMIT_FOOTER,
  NEX_COMMIT_TRAILER,
  appendNexAttribution,
  buildNexAgentCorrection,
  buildNexAgentId,
  buildNexAgentTrailer,
  buildNexAttributionInstructions,
  buildNexCommitAttribution,
  buildNexPrFooter,
  hasNexFooter,
  hasNexTrailer,
} from "./attribution"

const AGENT_ID = buildNexAgentId("claude", "claude-opus-5")

describe("hasNexTrailer", () => {
  test("detects the trailer on its own line", () => {
    expect(hasNexTrailer(`fix: thing\n\n${NEX_COMMIT_TRAILER}`)).toBe(true)
  })

  test("is case-insensitive on the trailer token", () => {
    expect(hasNexTrailer("fix: thing\n\nco-authored-by: Nex <noreply@example.invalid>")).toBe(true)
  })

  test("ignores a mention inside prose", () => {
    expect(hasNexTrailer("document the Co-Authored-By: Nex <noreply@example.invalid> trailer")).toBe(false)
  })

  test("does not match another tool's trailer", () => {
    expect(hasNexTrailer("fix\n\nCo-Authored-By: Claude <noreply@anthropic.com>")).toBe(false)
  })
})

describe("hasNexFooter", () => {
  test("detects the footer line", () => {
    expect(hasNexFooter(`fix: thing\n\n${NEX_COMMIT_FOOTER}`)).toBe(true)
  })

  test("detects it without the emoji", () => {
    expect(hasNexFooter("fix: thing\n\nShipped with Nex — https://github.com/Martin-CYL/MAS-for-Real-time-Monitoring-and-Executive-Briefings")).toBe(true)
  })

  test("ignores a mention inside prose", () => {
    expect(hasNexFooter("this release was shipped with Nex and other tools")).toBe(false)
  })
})

describe("buildNexCommitAttribution", () => {
  test("returns both parts for a bare message", () => {
    expect(buildNexCommitAttribution("fix: thing")).toBe(`${NEX_COMMIT_FOOTER}\n\n${NEX_COMMIT_TRAILER}`)
  })

  test("returns only the missing part", () => {
    expect(buildNexCommitAttribution(`fix\n\n${NEX_COMMIT_FOOTER}`)).toBe(NEX_COMMIT_TRAILER)
    expect(buildNexCommitAttribution(`fix\n\n${NEX_COMMIT_TRAILER}`)).toBe(NEX_COMMIT_FOOTER)
  })

  test("returns null when fully attributed", () => {
    expect(buildNexCommitAttribution(`fix\n\n${NEX_COMMIT_FOOTER}\n\n${NEX_COMMIT_TRAILER}`)).toBeNull()
  })
})

describe("appendNexAttribution", () => {
  test("appends footer then trailer, trailer last", () => {
    expect(appendNexAttribution("fix: thing")).toBe(
      `fix: thing\n\n${NEX_COMMIT_FOOTER}\n\n${NEX_COMMIT_TRAILER}`
    )
  })

  test("is idempotent", () => {
    const once = appendNexAttribution("fix: thing")
    expect(appendNexAttribution(once)).toBe(once)
  })

  test("handles an empty message", () => {
    expect(appendNexAttribution("   ")).toBe(`${NEX_COMMIT_FOOTER}\n\n${NEX_COMMIT_TRAILER}`)
  })
})

describe("buildNexAgentId", () => {
  test("joins provider and model", () => {
    expect(buildNexAgentId("claude", "claude-opus-5")).toBe("claude/claude-opus-5")
  })

  test("leaves the harness recoverable when the model id contains a slash", () => {
    const id = buildNexAgentId("opencode", "anthropic/claude-opus-5")
    expect(id.slice(0, id.indexOf("/"))).toBe("opencode")
  })
})

describe("buildNexAttributionInstructions", () => {
  const instructions = buildNexAttributionInstructions(AGENT_ID)

  test("carries every attribution surface verbatim", () => {
    expect(instructions).toContain(NEX_COMMIT_TRAILER)
    expect(instructions).toContain(NEX_COMMIT_FOOTER)
    expect(instructions).toContain(buildNexAgentTrailer(AGENT_ID))
    expect(instructions).toContain(buildNexPrFooter(AGENT_ID))
  })

  test("keeps the commit link bare and the PR link markdown", () => {
    expect(NEX_COMMIT_FOOTER).not.toContain("](")
    expect(buildNexPrFooter(AGENT_ID)).toContain("](https://github.com/Martin-CYL/MAS-for-Real-time-Monitoring-and-Executive-Briefings)")
  })

  test("keeps the pitch out of the commit footer", () => {
    // Commit messages are permanent and squash-merges repeat them per commit,
    // so the tagline belongs to the PR body alone.
    expect(NEX_COMMIT_FOOTER).not.toContain("open-source workspace")
    expect(buildNexPrFooter(AGENT_ID)).toContain("open-source workspace")
  })

  test("puts the two trailers last, as one adjacent block", () => {
    const lines = instructions.split("\n")
    const trailerIndex = lines.indexOf(NEX_COMMIT_TRAILER)
    expect(trailerIndex).toBeGreaterThan(-1)
    // Adjacent, not blank-separated: git only parses a trailing paragraph in
    // which every line is `key: value`.
    expect(lines[trailerIndex + 1]).toBe(buildNexAgentTrailer(AGENT_ID))
  })

  test("the footer it dictates still satisfies the dedupe matchers", () => {
    const commit = [
      "fix: thing",
      "",
      NEX_COMMIT_FOOTER,
      "",
      NEX_COMMIT_TRAILER,
      buildNexAgentTrailer(AGENT_ID),
    ].join("\n")
    expect(hasNexFooter(commit)).toBe(true)
    expect(hasNexTrailer(commit)).toBe(true)
    expect(buildNexCommitAttribution(commit)).toBeNull()
  })
})

describe("buildNexAgentCorrection", () => {
  test("carries the new id and names the trailer", () => {
    const correction = buildNexAgentCorrection("claude/claude-sonnet-5")
    expect(correction).toContain("claude/claude-sonnet-5")
    expect(correction).toContain(NEX_AGENT_TRAILER_KEY)
  })

  test("stays far shorter than the full instructions", () => {
    // It rides every turn after a mid-session model swap, so it must be the
    // value alone — the rule is already in the (cached) system prompt.
    expect(buildNexAgentCorrection(AGENT_ID).length).toBeLessThan(
      buildNexAttributionInstructions(AGENT_ID).length / 3
    )
  })
})
