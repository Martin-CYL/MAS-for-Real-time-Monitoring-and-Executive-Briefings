import { describe, expect, test } from "bun:test"
import {
  PEEK_AWAY_CLOSE_MS,
  PEEK_POINTER_INSIDE,
  checkPeekAway,
  isOnPeekPanel,
  peekPointerLeft,
  type PeekAway,
} from "./useEdgePeek"

/**
 * The hook's away watch on a clock the test owns: it starts when the mouse
 * leaves, asks `checkPeekAway` whenever the last answer said to, and stops
 * when the mouse is back. Returns when the peek closed, or null if it never did.
 */
function runAwayWatch({ leaveAt, enterAt = Infinity, heldUntil = -Infinity, until = 60_000 }: {
  leaveAt: number
  /** When the mouse comes back into the window. */
  enterAt?: number
  /** A button, a menu or a field holds the peek up to (not including) this time. */
  heldUntil?: number
  until?: number
}) {
  let away: PeekAway = peekPointerLeft(leaveAt)
  let nextCheckAt: number | null = leaveAt + PEEK_AWAY_CLOSE_MS
  while (nextCheckAt !== null && nextCheckAt <= until) {
    const now: number = nextCheckAt
    if (now >= enterAt) return null
    const result = checkPeekAway(away, now, now < heldUntil)
    if (result.close) return now
    away = result.away
    nextCheckAt = result.recheckInMs === null ? null : now + result.recheckInMs
  }
  return null
}

describe("checkPeekAway", () => {
  test("a mouse in the window never closes the peek, and asks for no recheck", () => {
    expect(checkPeekAway(PEEK_POINTER_INSIDE, 10_000, false)).toEqual({
      away: PEEK_POINTER_INSIDE,
      close: false,
      recheckInMs: null,
    })
  })

  test("closes once the mouse has been out for the threshold, and not a millisecond before", () => {
    const away = peekPointerLeft(1_000)
    expect(checkPeekAway(away, 1_000 + PEEK_AWAY_CLOSE_MS - 1, false)).toEqual({ away, close: false, recheckInMs: 1 })
    expect(checkPeekAway(away, 1_000 + PEEK_AWAY_CLOSE_MS, false).close).toBe(true)
  })

  test("asks to be checked again exactly when the threshold falls", () => {
    const away = peekPointerLeft(0)
    expect(checkPeekAway(away, 250, false).recheckInMs).toBe(PEEK_AWAY_CLOSE_MS - 250)
  })

  test("held, it does not close however long the mouse has been out", () => {
    const result = checkPeekAway(peekPointerLeft(0), 30_000, true)
    expect(result.close).toBe(false)
    expect(result.recheckInMs).toBeGreaterThan(0)
  })

  test("a hold restarts the clock, so the wait runs from when the hold ends", () => {
    const held = checkPeekAway(peekPointerLeft(0), 5_000, true)
    expect(held.away).toEqual({ since: 5_000 })
    expect(checkPeekAway(held.away, 5_000 + PEEK_AWAY_CLOSE_MS - 1, false).close).toBe(false)
    expect(checkPeekAway(held.away, 5_000 + PEEK_AWAY_CLOSE_MS, false).close).toBe(true)
  })
})

describe("the away watch, run on a fake clock", () => {
  test("a mouse that leaves and stays out closes the peek at the threshold", () => {
    expect(runAwayWatch({ leaveAt: 2_000 })).toBe(2_000 + PEEK_AWAY_CLOSE_MS)
  })

  test("an overshoot that comes back inside the threshold leaves the peek up", () => {
    expect(runAwayWatch({ leaveAt: 2_000, enterAt: 2_000 + PEEK_AWAY_CLOSE_MS - 50 })).toBeNull()
  })

  test("a drag held off the window keeps the peek up for as long as it lasts", () => {
    expect(runAwayWatch({ leaveAt: 0, heldUntil: Infinity, until: 120_000 })).toBeNull()
  })

  test("after the hold ends the peek waits the whole threshold again before closing", () => {
    const closedAt = runAwayWatch({ leaveAt: 0, heldUntil: 10_000 })
    expect(closedAt).not.toBeNull()
    // The hold's end is noticed at the next recheck, and the wait runs from the last held one.
    expect(closedAt!).toBeGreaterThanOrEqual(10_000 + PEEK_AWAY_CLOSE_MS - 200)
    expect(closedAt!).toBeLessThanOrEqual(10_000 + PEEK_AWAY_CLOSE_MS + 200)
  })

  test("coming back during a hold cancels it like any other return", () => {
    expect(runAwayWatch({ leaveAt: 0, heldUntil: 10_000, enterAt: 4_000 })).toBeNull()
  })
})

describe("isOnPeekPanel", () => {
  // A 280px card 8px in from its edge, 8px down from the top of an 800px window.
  const panel = { reachPx: 288, top: 8, bottom: 792 }

  test("covers the panel and the slop past its inner edge, and no further", () => {
    expect(isOnPeekPanel(100, 400, panel, 16)).toBe(true)
    expect(isOnPeekPanel(304, 400, panel, 16)).toBe(true)
    expect(isOnPeekPanel(305, 400, panel, 16)).toBe(false)
  })

  test("a point past the window's own edge, on the panel's side, is on it", () => {
    expect(isOnPeekPanel(-40, 400, panel, 16)).toBe(true)
  })

  test("the window's top edge above the panel is on it, within the slop", () => {
    expect(isOnPeekPanel(100, 0, panel, 16)).toBe(true)
  })

  test("beside a panel that stops short of the window's bottom, below it is off", () => {
    const column = { reachPx: 370, top: 0, bottom: 500 }
    expect(isOnPeekPanel(100, 516, column, 16)).toBe(true)
    expect(isOnPeekPanel(100, 517, column, 16)).toBe(false)
  })
})
