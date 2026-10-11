import { useEffect, useState, type RefObject } from "react"

/** How far past the panel's inner edge the mouse may stray before the panel leaves. */
const PEEK_SLOP_PX = 16

/**
 * How long the mouse may be out of the window before a peek gives up on it.
 *
 * Inside the window the peek leaves the moment the mouse is off it, with no
 * delay: the page sees every move, so it knows. Outside it sees nothing, and
 * the one thing it can tell apart is an overshoot from a departure, by time.
 * The edge is aimed at with a flick, and on a window that is not against the
 * screen's edge the flick carries past it; coming back takes a reaction and a
 * move, some 300 to 500ms. This is that with margin, and still short enough
 * that a mouse gone to another screen takes the panel down before it is in
 * the way.
 */
export const PEEK_AWAY_CLOSE_MS = 600

/** How often a held peek (see `checkPeekAway`) is looked at again. The focus watch's beat. */
const PEEK_AWAY_HELD_RECHECK_MS = 200

/**
 * A menu, select or dialog that is up. They portal out of the panel, so the
 * pointer is over one of these while it is no longer over the panel. A hover
 * card is one of them too: it is a popover, and a popover is a dialog.
 */
export const OPEN_LAYER_SELECTOR = "[role='menu'][data-state='open'], [role='listbox'][data-state='open'], [role='dialog'][data-state='open'], [role='alertdialog'][data-state='open']"

/** Since when the mouse has been out of the window, or null while it is in it. */
export interface PeekAway {
  since: number | null
}

export const PEEK_POINTER_INSIDE: PeekAway = { since: null }

export function peekPointerLeft(now: number): PeekAway {
  return { since: now }
}

/**
 * Whether a peek whose mouse is out of the window should close now, and if
 * not, when to ask again.
 *
 * Held (a button down, a menu up, a field in the panel being typed in), it
 * does not close, and the time out does not count either: the clock starts
 * over each time it is found held, so the wait runs from the last of those.
 * A hold ending is not an event, so that is up to one recheck before it
 * really ended; a button let go is one, and the hook restarts the clock on
 * it, so a drag released off the window gets the whole wait.
 */
export function checkPeekAway(away: PeekAway, now: number, held: boolean): {
  away: PeekAway
  close: boolean
  recheckInMs: number | null
} {
  if (away.since === null) return { away, close: false, recheckInMs: null }
  if (held) return { away: { since: now }, close: false, recheckInMs: PEEK_AWAY_HELD_RECHECK_MS }
  const remaining = PEEK_AWAY_CLOSE_MS - (now - away.since)
  if (remaining <= 0) return { away, close: true, recheckInMs: null }
  return { away, close: false, recheckInMs: remaining }
}

/** The panel where it rests once shown: how far in from its edge of the window it reaches, and its vertical extent. */
interface PeekPanelFootprint {
  reachPx: number
  top: number
  bottom: number
}

/** Whether a point is on the shown panel, give or take `slopPx`. `fromEdgePx` is measured from the panel's side of the window. */
export function isOnPeekPanel(fromEdgePx: number, y: number, panel: PeekPanelFootprint, slopPx: number) {
  return fromEdgePx <= panel.reachPx + slopPx && y >= panel.top - slopPx && y <= panel.bottom + slopPx
}

interface EdgePeekOptions {
  side: "left" | "right"
  /** The panel is closed, so there is something to peek at. */
  enabled: boolean
  /** The panel as it is laid out: its width and its vertical extent are read from it. */
  panelRef: RefObject<HTMLElement | null>
  /** How close to the window's edge the mouse opens the peek. */
  edgePx: number
  /** The gap between the window's edge and the panel once it is shown. */
  insetPx?: number
}

/**
 * The peek: a closed side panel comes back as an overlay while the mouse is
 * at its edge of the window, and leaves as soon as the mouse has left it.
 * Nothing is opened: this only says when to show the panel over the chat.
 *
 * Listened for on the document rather than on a strip along the edge. A
 * strip would take the clicks that land on it, and a fast mouse crosses a few
 * pixels between two events; the move that leaves the window by that side is
 * caught instead, which is also what makes the edge easy to hit when the
 * window is not against the screen's.
 */
export function useEdgePeek({ side, enabled, panelRef, edgePx, insetPx = 0 }: EdgePeekOptions) {
  const [requested, setRequested] = useState(false)
  if (!enabled && requested) setRequested(false)

  useEffect(() => {
    if (!enabled) return
    let open = false
    // Kept from the last mouse event, for the checks no event comes with.
    let buttons = 0
    // A finger lifting is followed by mouse events the browser makes up for
    // it, a leave among them. Only a real mouse can be out of the window.
    let lastPointerWasMouse = false
    let away = PEEK_POINTER_INSIDE
    let awayTimer: number | undefined

    function show() {
      open = true
      setRequested(true)
    }

    // The one way out: the mouse moved off the panel, the window lost focus,
    // or the mouse stayed out of the window too long.
    function hide() {
      stopAwayWatch()
      open = false
      setRequested(false)
    }

    // The distance from the panel's side of the window, so both sides read alike.
    function fromEdge(clientX: number) {
      return side === "left" ? clientX : window.innerWidth - clientX
    }

    // The panel may not run the window's whole height (the terminal sits
    // under the right one): its edge is only the part it stands beside.
    function besidePanel(clientY: number) {
      const rect = panelRef.current?.getBoundingClientRect()
      return rect !== undefined && clientY >= rect.top && clientY <= rect.bottom
    }

    // Where the panel rests, not where it is: a mouse that outruns the panel
    // on its way in is still headed for it.
    function onPanel(clientX: number, clientY: number) {
      const panel = panelRef.current
      if (!panel) return false
      const rect = panel.getBoundingClientRect()
      return isOnPeekPanel(
        fromEdge(clientX),
        clientY,
        { reachPx: insetPx + panel.offsetWidth, top: rect.top, bottom: rect.bottom },
        PEEK_SLOP_PX,
      )
    }

    function inWindow(event: MouseEvent) {
      return event.clientX >= 0 && event.clientX < window.innerWidth
        && event.clientY >= 0 && event.clientY < window.innerHeight
    }

    // Whether something the panel started is still going on: a drag (resize,
    // reorder), a menu or dialog opened from a row, a rename being typed.
    // Closing under any of them would take away what the user is using.
    function isBusy() {
      if (buttons !== 0) return true
      if (document.querySelector(OPEN_LAYER_SELECTOR)) return true
      const focused = document.activeElement
      return focused instanceof HTMLElement
        && (focused.tagName === "INPUT" || focused.tagName === "TEXTAREA" || focused.isContentEditable)
        && Boolean(panelRef.current?.contains(focused))
    }

    // The peek belongs to the window you are working in. Once another app
    // (or another window) is in front, a panel left hanging over the chat is
    // in the way of reading what is behind it, and a mouse crossing this
    // window's edge on its way somewhere else is not asking for it. So it
    // leaves when the window loses focus, whatever was going on in it, and
    // stays away until the window has focus again.
    function handleWindowBlur() {
      hide()
    }

    // The blur event is not the whole story: a window can stop being the one
    // in front without the page being told (focus was in another part of the
    // app's window, or already gone when the peek came up). So while the
    // peek is up, the question is also asked outright, a few times a second.
    const focusWatch = window.setInterval(() => {
      if (open && !document.hasFocus()) hide()
    }, 200)

    function handleVisibilityChange() {
      if (document.visibilityState !== "visible") hide()
    }

    // Focus is not the whole story either: the window is often still the one
    // in front while the mouse is off it, on another screen or over the
    // window beside it. No move reaches the page from out there, so nothing
    // above would ever close the peek. It is given `PEEK_AWAY_CLOSE_MS` to
    // come back (`checkPeekAway`), counted from here.
    function startAwayWatch() {
      away = peekPointerLeft(performance.now())
      scheduleAwayCheck(PEEK_AWAY_CLOSE_MS)
    }

    function stopAwayWatch() {
      window.clearTimeout(awayTimer)
      awayTimer = undefined
      away = PEEK_POINTER_INSIDE
    }

    function scheduleAwayCheck(delayMs: number) {
      window.clearTimeout(awayTimer)
      awayTimer = window.setTimeout(() => {
        awayTimer = undefined
        if (!open) return
        const result = checkPeekAway(away, performance.now(), isBusy())
        away = result.away
        if (result.close) hide()
        else if (result.recheckInMs !== null) scheduleAwayCheck(result.recheckInMs)
      }, delayMs)
    }

    function handlePointerDown(event: PointerEvent) {
      lastPointerWasMouse = event.pointerType === "mouse"
      if (lastPointerWasMouse) buttons = event.buttons
    }

    // A button let go off the window ends a drag that was holding the peek.
    // The wait starts from here, whether or not the leave was ever reported:
    // browsers differ on sending it while a button is down.
    function handlePointerUp(event: PointerEvent) {
      if (event.pointerType !== "mouse") return
      buttons = event.buttons
      if (open && !inWindow(event)) startAwayWatch()
    }

    function handlePointerMove(event: PointerEvent) {
      lastPointerWasMouse = event.pointerType === "mouse"
      if (!lastPointerWasMouse) return
      buttons = event.buttons
      if (!inWindow(event)) {
        // Only a drag is still heard from out here. It holds the peek, and
        // the watch is what picks it up if the mouse is let go there.
        if (open && away.since === null) startAwayWatch()
        return
      }
      stopAwayWatch()
      if (fromEdge(event.clientX) <= edgePx && besidePanel(event.clientY)) {
        if (!open && buttons === 0 && document.hasFocus()) show()
        return
      }
      if (open && !onPanel(event.clientX, event.clientY) && !isBusy()) hide()
    }

    function handleMouseLeave(event: MouseEvent) {
      if (!lastPointerWasMouse) return
      buttons = event.buttons
      // Already known to be out: a drag that left earlier, reported now that
      // its button is up. The watch has it.
      if (away.since !== null) return
      if (!open && fromEdge(event.clientX) <= 0 && besidePanel(event.clientY)
        && buttons === 0 && document.hasFocus()) show()
      if (!open) return
      // A mouse that goes out across the panel (through the edge it hangs
      // from, or over the top of it into the title bar) may be an overshoot,
      // and gets the wait. So does one that leaves mid-drag or under a menu.
      // Anywhere else it has moved off the panel as surely as it would have
      // inside the window, and the panel leaves at once. The point is pulled
      // back to the window's edge first: it is reported from a little outside.
      const exitX = Math.min(Math.max(event.clientX, 0), window.innerWidth)
      const exitY = Math.min(Math.max(event.clientY, 0), window.innerHeight)
      if (onPanel(exitX, exitY) || isBusy()) startAwayWatch()
      else hide()
    }

    function handleMouseEnter() {
      if (lastPointerWasMouse) stopAwayWatch()
    }

    window.addEventListener("pointerdown", handlePointerDown, true)
    window.addEventListener("pointerup", handlePointerUp, true)
    window.addEventListener("pointercancel", handlePointerUp, true)
    window.addEventListener("pointermove", handlePointerMove)
    window.addEventListener("blur", handleWindowBlur)
    document.addEventListener("visibilitychange", handleVisibilityChange)
    document.documentElement.addEventListener("mouseleave", handleMouseLeave)
    document.documentElement.addEventListener("mouseenter", handleMouseEnter)
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true)
      window.removeEventListener("pointerup", handlePointerUp, true)
      window.removeEventListener("pointercancel", handlePointerUp, true)
      window.removeEventListener("pointermove", handlePointerMove)
      window.removeEventListener("blur", handleWindowBlur)
      document.removeEventListener("visibilitychange", handleVisibilityChange)
      window.clearInterval(focusWatch)
      window.clearTimeout(awayTimer)
      document.documentElement.removeEventListener("mouseleave", handleMouseLeave)
      document.documentElement.removeEventListener("mouseenter", handleMouseEnter)
    }
  }, [edgePx, enabled, insetPx, panelRef, side])

  return enabled && requested
}
