import { describe, expect, test } from "bun:test"
import { classifyAttachmentPreview } from "../messages/attachmentPreview"
import { sortTableRows } from "./AttachmentViewer"

describe("sortTableRows", () => {
  const rows = [
    ["beta", "1,204", "item 10"],
    ["alpha", "$3.50", "item 2"],
    ["", "42%", ""],
    ["gamma", "-7", "item 1"],
  ]

  test("sorts numbers as numbers, currency and percent included", () => {
    expect(sortTableRows(rows, { column: 1, direction: "asc" }).map((row) => row[1])).toEqual(["-7", "$3.50", "42%", "1,204"])
    expect(sortTableRows(rows, { column: 1, direction: "desc" }).map((row) => row[1])).toEqual(["1,204", "42%", "$3.50", "-7"])
  })

  test("sorts text with digits in order, and empty cells always last", () => {
    expect(sortTableRows(rows, { column: 2, direction: "asc" }).map((row) => row[2])).toEqual(["item 1", "item 2", "item 10", ""])
    expect(sortTableRows(rows, { column: 0, direction: "desc" }).map((row) => row[0])).toEqual(["gamma", "beta", "alpha", ""])
  })

  test("sorts row indices, leaving the rows where they are", async () => {
    const { sortedRowOrder } = await import("./AttachmentViewer")
    const big = Array.from({ length: 1_000 }, (_, index) => [`row ${index}`, String((index * 7919) % 1_000)])
    const order = sortedRowOrder(big, { column: 1, direction: "desc" })
    expect(big[order[0]!]![1]).toBe("999")
    expect(big[order[999]!]![1]).toBe("0")
  })

  test("no sort keeps the file's order", () => {
    expect(sortTableRows(rows, null)).toEqual(rows)
  })
})

describe("classifyAttachmentPreview", () => {
  test("knows tables by extension, video by type, and previews JSON of unknown size", () => {
    expect(classifyAttachmentPreview({ mimeType: "application/octet-stream", displayName: "data.csv", size: 10 }).kind).toBe("table")
    expect(classifyAttachmentPreview({ mimeType: "video/mp4", displayName: "clip.mp4", size: 10 }).kind).toBe("video")
    expect(classifyAttachmentPreview({ mimeType: "application/json", displayName: "x.json", size: null }).kind).toBe("json")
    expect(classifyAttachmentPreview({ mimeType: "text/markdown", displayName: "README.md", size: 10 }).kind).toBe("markdown")
  })
})

describe("CellText", () => {
  test("links web addresses in a cell to a new tab, leaving the text and trailing punctuation plain", async () => {
    const { createElement } = await import("react")
    const { renderToStaticMarkup } = await import("react-dom/server")
    const { CellText } = await import("./AttachmentViewer")
    const markup = renderToStaticMarkup(createElement(CellText, { text: "See https://example.com/a?b=1, then done." }))
    expect(markup).toContain('<a href="https://example.com/a?b=1" target="_blank" rel="noreferrer noopener"')
    expect(markup).toContain("See ")
    expect(markup).toContain(", then done.")
  })
})

describe("truncationNotes", () => {
  test("says briefly what a preview left out, for the header's subtitle", async () => {
    const { truncationNotes } = await import("./AttachmentViewer")
    expect(truncationNotes({ truncated: false })).toEqual([])
    expect(truncationNotes({
      truncated: true,
      table: { rows: Array.from({ length: 1_000 }, () => ["a"]), rowCount: 1_001, columnCount: 80, truncatedRows: true, truncatedColumns: true },
    })).toEqual(["first 1 MB", "first 1,000 of 1,001 rows", "first 50 of 80 columns"])
  })
})
