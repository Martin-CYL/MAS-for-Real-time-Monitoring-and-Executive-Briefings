import { expect, test } from "bun:test"
import { isImeKey } from "./ime-composition"

test("composition state protects IME keys even when native flags lag", () => {
  expect(isImeKey({ isComposing: false, keyCode: 13 }, true)).toBe(true)
  expect(isImeKey({ isComposing: true, keyCode: 13 }, false)).toBe(true)
})
test("Safari commit key is protected after compositionend; subsequent Enter is not swallowed", () => {
  expect(isImeKey({ isComposing: false, keyCode: 229 }, false)).toBe(true)
  expect(isImeKey({ isComposing: false, keyCode: 13 }, false)).toBe(false)
})
