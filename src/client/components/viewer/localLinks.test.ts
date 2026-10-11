import { describe, expect, test } from "bun:test"
import { opensInViewer, projectRelativePath } from "./localLinks"

describe("opensInViewer", () => {
  test("takes editor links, and tables that would open in the default app", () => {
    expect(opensInViewer("/Users/me/app/src/a.ts", "open_editor")).toBe(true)
    expect(opensInViewer("/Users/me/app/data/numbers.csv", "open_default")).toBe(true)
    expect(opensInViewer("/Users/me/app/data/people.TSV", "open_default")).toBe(true)
  })

  test("leaves other default-app files and other actions alone", () => {
    expect(opensInViewer("/Users/me/app/shot.png", "open_default")).toBe(false)
    expect(opensInViewer("/Users/me/app/data/numbers.csv", "open_finder")).toBe(false)
  })
})

describe("projectRelativePath", () => {
  test("names a file inside the project by its path there", () => {
    expect(projectRelativePath("/Users/me/app", "/Users/me/app/src/a.ts")).toBe("src/a.ts")
    expect(projectRelativePath("/Users/me/app/", "/Users/me/app/README.md")).toBe("README.md")
  })

  test("leaves out anything the project's file route wouldn't serve", () => {
    expect(projectRelativePath("/Users/me/app", "/Users/me/app-two/a.ts")).toBeNull()
    expect(projectRelativePath("/Users/me/app", "/Users/me/app")).toBeNull()
    expect(projectRelativePath("/Users/me/app", "/Users/me/app/../secret")).toBeNull()
    expect(projectRelativePath(null, "/Users/me/app/a.ts")).toBeNull()
  })
})
