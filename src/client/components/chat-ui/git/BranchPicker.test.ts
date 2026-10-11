import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { ChatBranchListEntry, ChatBranchListResult } from "../../../../shared/types"
import { BranchPicker, branchCreateOptions, branchPickerSections, mostRecentBranches, UNSEARCHED_BRANCH_LIMIT } from "./BranchPicker"

const branch = (name: string, updatedAt?: string): ChatBranchListEntry =>
  ({ id: name, kind: "local", name, displayName: name, updatedAt })

describe("mostRecentBranches", () => {
  test("keeps the newest by commit date, newest first", () => {
    const entries = Array.from({ length: 15 }, (_, index) =>
      branch(`b${index}`, `2026-09-${String(index + 1).padStart(2, "0")}T00:00:00Z`))
    const picked = mostRecentBranches(entries)
    expect(picked).toHaveLength(UNSEARCHED_BRANCH_LIMIT)
    expect(picked[0]?.name).toBe("b14")
    expect(picked.at(-1)?.name).toBe(`b${15 - UNSEARCHED_BRANCH_LIMIT}`)
  })

  test("undated branches sort after dated ones", () => {
    const entries = [branch("old", "2020-01-01T00:00:00Z"), branch("undated"), branch("new", "2026-01-01T00:00:00Z")]
    expect(mostRecentBranches(entries, 2).map((entry) => entry.name)).toEqual(["new", "old"])
  })

  test("a list within the limit comes back untouched, in its own order", () => {
    const entries = [branch("b", "2020-01-01T00:00:00Z"), branch("a", "2026-01-01T00:00:00Z")]
    expect(mostRecentBranches(entries)).toBe(entries)
  })
})

const list = (overrides: Partial<ChatBranchListResult> = {}): ChatBranchListResult => ({
  currentBranchName: "feature/widgets",
  defaultBranchName: "main",
  recent: [],
  local: [branch("main"), branch("feature/widgets"), branch("spike/minimap")],
  remote: [],
  pullRequests: [],
  pullRequestsStatus: "available",
  ...overrides,
})

describe("branchCreateOptions", () => {
  test("offers nothing for an empty search or one naming an existing branch", () => {
    expect(branchCreateOptions("  ", list(), "feature/widgets")).toEqual([])
    expect(branchCreateOptions("spike/minimap", list(), "feature/widgets")).toEqual([])
    expect(branchCreateOptions("feature/widgets", list(), "feature/widgets")).toEqual([])
  })

  test("off the default branch first, then off the current one when HEAD is elsewhere", () => {
    expect(branchCreateOptions("fix/login", list(), "feature/widgets")).toEqual([
      { name: "fix/login", baseBranchName: "main" },
      { name: "fix/login", baseBranchName: "feature/widgets" },
    ])
    expect(branchCreateOptions("fix/login", list(), "main")).toEqual([{ name: "fix/login", baseBranchName: "main" }])
  })

  test("turns whitespace into dashes, since git refuses spaces", () => {
    expect(branchCreateOptions(" fix  the login ", list(), "main")[0]?.name).toBe("fix-the-login")
  })

  test("waits for the list, which is what says the name is free", () => {
    expect(branchCreateOptions("fix/login", null, "main")).toEqual([])
  })
})

describe("branchPickerSections", () => {
  const pr: ChatBranchListEntry = {
    id: "pr:142", kind: "pull_request", name: "fix-auth", displayName: "Fix auth redirect", prNumber: 142, headRefName: "fix-auth",
  }
  const remote = (name: string): ChatBranchListEntry => ({ id: `remote:${name}`, kind: "remote", name, displayName: name })

  test("one search covers every section, PR titles and numbers included", () => {
    const branchList = list({ pullRequests: [pr], remote: [remote("release")] })
    const byTitle = branchPickerSections({ branchList, query: "auth", currentBranchName: "feature/widgets", showAllLocal: false, showAllRemote: false, showAllPullRequests: false })
    expect(byTitle.pullRequests).toEqual([pr])
    expect(byTitle.local).toEqual([])
    const byNumber = branchPickerSections({ branchList, query: "#142", currentBranchName: "feature/widgets", showAllLocal: false, showAllRemote: false, showAllPullRequests: false })
    expect(byNumber.pullRequests).toEqual([pr])
  })

  test("pull requests stop at the limit like the other sections, until searched or shown", () => {
    const pullRequests = Array.from({ length: 8 }, (_, index): ChatBranchListEntry => ({
      id: `pr:${index}`, kind: "pull_request", name: `pr-${index}`, displayName: `PR ${index}`, prNumber: index,
    }))
    const base = { branchList: list({ pullRequests }), currentBranchName: "feature/widgets", showAllLocal: false, showAllRemote: false }
    const limited = branchPickerSections({ ...base, query: "", showAllPullRequests: false })
    expect(limited.pullRequests).toHaveLength(UNSEARCHED_BRANCH_LIMIT)
    expect(limited.allPullRequestCount).toBe(8)
    expect(branchPickerSections({ ...base, query: "", showAllPullRequests: true }).pullRequests).toHaveLength(8)
    expect(branchPickerSections({ ...base, query: "PR", showAllPullRequests: false }).pullRequests).toHaveLength(8)
  })

  test("leaves out the current branch, and remote branches that show as their PR", () => {
    const branchList = list({ pullRequests: [pr], remote: [remote("fix-auth"), remote("release")] })
    const sections = branchPickerSections({ branchList, query: "", currentBranchName: "feature/widgets", showAllLocal: false, showAllRemote: false, showAllPullRequests: false })
    expect(sections.local.map((entry) => entry.name)).toEqual(["main", "spike/minimap"])
    expect(sections.remote.map((entry) => entry.name)).toEqual(["release"])
  })
})

describe("BranchPicker", () => {
  test("opens on search over a skeleton, with no Branches / PRs split", () => {
    const markup = renderToStaticMarkup(createElement(BranchPicker, {
      onListBranches: () => new Promise<ChatBranchListResult>(() => {}),
      onCheckoutBranch: async () => {},
      onCreateBranch: async () => {},
      onDone: () => {},
    }))
    expect(markup).toContain("Find or create a branch")
    expect(markup).toContain('aria-label="Loading branches"')
    expect(markup).not.toContain("Open PRs")
  })
})
