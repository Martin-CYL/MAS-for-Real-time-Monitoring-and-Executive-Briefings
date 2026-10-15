import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { ResultMessage } from "./ResultMessage"

for (const durationMs of [0, -1, NaN, Infinity]) {
  test(`does not present unknown legacy duration ${durationMs} as elapsed time`, () => {
    const html = renderToStaticMarkup(<ResultMessage message={{ id: "r", kind: "result", success: true, result: "", durationMs, timestamp: "2026-10-15T00:34:00Z" }} />)
    expect(html).not.toContain("Worked for")
    expect(html).not.toContain("0ms")
  })
}
test("renders recorded elapsed time", () => {
  const html = renderToStaticMarkup(<ResultMessage message={{ id: "r", kind: "result", success: true, result: "", durationMs: 65000, timestamp: "2026-10-15T00:34:00Z" }} />)
  expect(html).toContain("1m 5s")
})
