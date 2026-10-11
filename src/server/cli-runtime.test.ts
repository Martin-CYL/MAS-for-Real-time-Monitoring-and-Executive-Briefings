import { describe, expect, test } from "bun:test"
import { parseArgs } from "./cli-runtime"

describe("Nex web CLI", () => {
  test("binds loopback with strict port by default", () => {
    expect(parseArgs([])).toMatchObject({ host: "127.0.0.1", port: 3210, strictPort: true })
  })
  test("supports headless server startup", () => {
    expect(parseArgs(["--host", "0.0.0.0", "--port", "3211", "--no-open"])).toMatchObject({host: "0.0.0.0", port: 3211, openBrowser: false})
  })
  test("rejects invalid ports, missing values and retired commands", () => {
    for (const args of [["--port", "0"], ["--port", "65536"], ["--port", "abc"], ["--host"], ["pair"], ["--update"]]) {
      expect(() => parseArgs(args)).toThrow()
    }
  })
})
