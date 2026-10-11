import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { ChatBranchListEntry } from "../../../../shared/types"
import { PullRequestCardContent } from "./BranchHoverCard"
import { DiffFileCardContent, peekPatch } from "./DiffFileHoverCard"

const PATCH = [
  "diff --git a/app.ts b/app.ts",
  "--- a/app.ts",
  "+++ b/app.ts",
  "@@ -1,4 +1,5 @@ function load()",
  " const a = 1",
  "-const b = 2",
  "+const b = 3",
  "+const c = 4",
  " export { a }",
  "@@ -20,2 +21,3 @@",
  " x",
  "+y",
  "-z",
].join("\n")

describe("peekPatch", () => {
  test("takes the first hunk, and counts the changes it leaves out", () => {
    const peek = peekPatch(PATCH, 4)!
    expect(peek.header).toBe("@@ -1,4 +1,5 @@ function load()")
    expect(peek.lines.map((line) => line.kind)).toEqual(["context", "remove", "add", "add"])
    // One context line of the first hunk and two changes of the second are past the cut.
    expect(peek.moreChanges).toBe(2)
  })

  test("is null without a hunk (a binary or empty patch)", () => {
    expect(peekPatch("Binary files a/x.png and b/x.png differ")).toBeNull()
  })
})

describe("DiffFileCardContent", () => {
  test("shows the whole path and a peek of the change, not the row's status and counts", () => {
    const markup = renderToStaticMarkup(createElement(DiffFileCardContent, {
      file: { path: "src/client/components/chat-ui/widgets/app.ts", changeType: "modified", isUntracked: false, additions: 2, deletions: 1, patchDigest: "d" },
      patch: PATCH,
    }))
    expect(markup).toContain("src/client/components/chat-ui/widgets/app.ts")
    expect(markup).not.toContain("Modified")
    expect(markup).not.toContain(">+2<")
    expect(markup).toContain("const c = 4")
    expect(markup).toContain("Click to review")
  })
})

describe("PullRequestCardContent", () => {
  const entry: ChatBranchListEntry = {
    id: "pr:126", kind: "pull_request", name: "grok", displayName: "PR #126", prNumber: 126, prTitle: "Add Grok", headRefName: "grok", headLabel: "chroxify:grok",
  }

  test("shows the title and head before the read lands", () => {
    const markup = renderToStaticMarkup(createElement(PullRequestCardContent, { entry, pr: undefined }))
    expect(markup).toContain("Add Grok")
    expect(markup).toContain("chroxify:grok")
  })

  test("then adds the base, when it opened, a cleaned description and its size; not the row's number, author or state", () => {
    const markup = renderToStaticMarkup(createElement(PullRequestCardContent, {
      entry,
      pr: {
        number: 126, title: "Add Grok Build", url: "https://github.com/a/b/pull/126", authorLogin: "chroxify", isDraft: true,
        baseRefName: "main", additions: 2248, deletions: 36, changedFiles: 34, commits: 6, comments: 1,
        mergeableState: "dirty", checks: { state: "failure", passed: 2, total: 3 }, labels: ["provider"],
        createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        body: "### What does this change?\n\nSpawn the grok CLI per turn.",
      },
    }))
    expect(markup).toContain("chroxify:grok<span class=\"opacity-60\"> → </span>main")
    expect(markup).toContain("opened 2d")
    expect(markup).toContain("Spawn the grok CLI per turn.")
    expect(markup).not.toContain("What does this change?")
    expect(markup).toContain('title="34 files changed"')
    expect(markup).toContain("provider")
    expect(markup).not.toContain("#126")
    expect(markup).not.toContain("Has conflicts")
    expect(markup).not.toContain("checks passed")
  })
})
