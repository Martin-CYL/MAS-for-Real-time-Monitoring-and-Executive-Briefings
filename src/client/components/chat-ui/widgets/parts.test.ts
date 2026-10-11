import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { WidgetMoreRow } from "./parts"

describe("WidgetMoreRow", () => {
  test("reveals in place with a verb and a count, then offers to fold back", () => {
    const more = renderToStaticMarkup(createElement(WidgetMoreRow, { count: 4 }))
    expect(more).toContain("Show 4 more")
    expect(more).toContain('aria-expanded="false"')
    const less = renderToStaticMarkup(createElement(WidgetMoreRow, { count: 4, shown: true }))
    expect(less).toContain("Show less")
    expect(less).toContain('aria-expanded="true"')
  })

  test("says when a click only shows a page, and how much remains", () => {
    const markup = renderToStaticMarkup(createElement(WidgetMoreRow, { count: 200, detail: "1,240 left" }))
    expect(markup).toContain("Show 200 more")
    expect(markup).toContain("1,240 left")
  })

  test("says it leaves for GitHub, with the page's full count", () => {
    const markup = renderToStaticMarkup(createElement(WidgetMoreRow, { count: 33, total: 38, href: "https://github.com/acme/repo/pulls" }))
    expect(markup).toContain("All 38 on GitHub")
    expect(markup).not.toContain("aria-expanded")
  })

  test("is not a row: no icon column, text only", () => {
    const markup = renderToStaticMarkup(createElement(WidgetMoreRow, { count: 4 }))
    expect(markup).not.toContain("h-5 w-4")
  })
})
