import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { TooltipProvider } from "../../ui/tooltip"
import { DIFF_VIEWER_PAGE_SIZE, DiffViewer, pageLimit, reviewFiles } from "./DiffViewer"
import { compareFilePaths, diffHold, diffStatus, isGeneratedPath, splitDiffPath, type DiffFile } from "./shared"

const file = (path: string, overrides: Partial<DiffFile> = {}): DiffFile => ({
  path, changeType: "modified", isUntracked: false, additions: 3, deletions: 1, patchDigest: `d-${path}`, ...overrides,
})

describe("diffStatus", () => {
  test("reads like git, with untracked files counting as added", () => {
    expect(diffStatus(file("a.ts")).letter).toBe("M")
    expect(diffStatus(file("a.ts", { changeType: "added" })).letter).toBe("A")
    expect(diffStatus(file("a.ts", { isUntracked: true })).letter).toBe("A")
    expect(diffStatus(file("a.ts", { changeType: "deleted" })).letter).toBe("D")
    expect(diffStatus(file("a.ts", { changeType: "renamed" })).letter).toBe("R")
  })
})

describe("splitDiffPath", () => {
  test("splits the name from its folder", () => {
    expect(splitDiffPath("src/app/Page.tsx")).toEqual({ name: "Page.tsx", folder: "src/app" })
    expect(splitDiffPath("README.md")).toEqual({ name: "README.md", folder: "" })
  })
})

describe("reviewFiles", () => {
  test("lists the checked files in order, plus the opened one when it isn't checked", () => {
    const files = [file("a.ts"), file("b.ts"), file("c.ts"), file("d.ts")]
    const checked = new Set(["a.ts", "d.ts"])
    expect(reviewFiles(files, (path) => checked.has(path), "a.ts").map((entry) => entry.path)).toEqual(["a.ts", "d.ts"])
    expect(reviewFiles(files, (path) => checked.has(path), "c.ts").map((entry) => entry.path)).toEqual(["a.ts", "c.ts", "d.ts"])
  })
})

describe("pageLimit", () => {
  test("holds whole pages, enough to reach the file asked for", () => {
    expect(pageLimit(DIFF_VIEWER_PAGE_SIZE, 3)).toBe(25)
    expect(pageLimit(DIFF_VIEWER_PAGE_SIZE, 25)).toBe(50)
    expect(pageLimit(DIFF_VIEWER_PAGE_SIZE, 60)).toBe(75)
    expect(pageLimit(50, 10)).toBe(50)
  })
})

describe("DiffViewer", () => {
  test("lists every file with its own header, counts the opened one, and pages past 25", () => {
    const files = Array.from({ length: 30 }, (_, index) => file(`src/f${index}.ts`))
    const markup = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(DiffViewer, {
      projectId: "p1",
      path: "src/f1.ts",
      context: {
        projectId: "p1",
        files,
        editorLabel: "Cursor",
        diffRenderMode: "unified",
        wrapLines: false,
        onDiffRenderModeChange: () => {},
        onWrapLinesChange: () => {},
        onLoadPatch: () => new Promise<string>(() => {}),
        onOpenFile: () => {},
        isMac: true,
      },
      onClose: () => {},
    })))
    expect(markup).toContain(">f0.ts<")
    expect(markup).toContain(">f24.ts<")
    expect(markup).not.toContain(">f25.ts<")
    expect(markup).toContain("2 of 30")
    expect(markup).toContain("Load 5 more")
    expect(markup).toContain('aria-label="Side-by-side diff"')
  })
})

describe("diffHold", () => {
  test("holds back what GitHub does, and says why", () => {
    expect(diffHold(file("fonts/Inter.woff2", { binary: true, additions: 0, deletions: 0 }))).toEqual({ message: "Binary file not shown.", loadable: false })
    expect(diffHold(file("a.ts", { changeType: "renamed", additions: 0, deletions: 0 }))?.message).toBe("File renamed without changes.")
    expect(diffHold(file("a.ts", { changeType: "added", additions: 0, deletions: 0, size: 0 }))?.message).toBe("Empty file.")
    expect(diffHold(file("a.ts", { changeType: "deleted" }))).toEqual({ message: "This file was deleted.", loadable: true })
    expect(diffHold(file("bun.lock"))?.loadable).toBe(true)
    expect(diffHold(file("a.ts", { additions: 900, deletions: 200 }))?.message).toBe("Large diffs are not rendered by default.")
    expect(diffHold(file("src/a.ts"))).toBeNull()
  })

  test("knows generated files by name, wherever they sit", () => {
    for (const path of ["package-lock.json", "web/yarn.lock", "go.sum", "App.xcodeproj/project.pbxproj", "dist/app.min.js", "dist/app.js.map", "api/user.pb.go", "api/user_pb2.py"]) {
      expect(isGeneratedPath(path)).toBe(true)
    }
    for (const path of ["src/lock.ts", "minimal.js", "src/map.ts", "README.md"]) {
      expect(isGeneratedPath(path)).toBe(false)
    }
  })
})

describe("compareFilePaths", () => {
  test("orders like a file tree: folders before files, names naturally", () => {
    const paths = ["src/b.ts", "README.md", "src/lib/z.ts", "src/a.test.ts", "src/a.ts", "src/item10.ts", "src/item2.ts", "docs/guide.md", "Src2/x.ts"]
    expect([...paths].sort(compareFilePaths)).toEqual([
      "docs/guide.md", "src/lib/z.ts", "src/a.test.ts", "src/a.ts", "src/b.ts", "src/item2.ts", "src/item10.ts", "Src2/x.ts", "README.md",
    ])
  })
})
