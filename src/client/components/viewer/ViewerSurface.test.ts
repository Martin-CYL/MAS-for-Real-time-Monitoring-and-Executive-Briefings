import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { TooltipProvider } from "../ui/tooltip"
import { ChartFullView } from "../messages/ChartTool"

describe("ChartFullView", () => {
  test("a full-size chart sits in the viewer's chrome, with its title, close and the data table", () => {
    const markup = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(ChartFullView, {
      payload: { title: "Signups", description: "By week", type: "bar", data: [{ week: "W1", signups: 3 }, { week: "W2", signups: 5 }] },
      onClose: () => {},
    })))
    expect(markup).toContain('aria-label="Chart: Signups"')
    expect(markup).toContain("By week")
    expect(markup).toContain('aria-label="Close (Esc)"')
    expect(markup).toContain('aria-label="Download table as CSV"')
    expect(markup).toContain("W2")
  })
})
