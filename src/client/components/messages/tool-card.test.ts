import { expect, test } from "bun:test"
import { QUOTE_GEOMETRY, TOOL_CARD_CAPTION_CLASS, TOOL_CARD_MARK_SLOT_CLASS, TOOL_QUOTE_CLASS, toolCardClasses } from "./tool-card"

test("a quote's border is the card's at half strength, resting and lit", () => {
  const card = toolCardClasses(false)
  const quote = toolCardClasses(true)

  expect(card.box).toContain("border-border ")
  expect(quote.box).toContain("border-border/50")
  // Lit by the pointer, and held lit while the hover card it opened is up.
  expect(card.lit).toBe("hover:border-muted-foreground/40 data-[hover-card-open]:border-muted-foreground/40")
  expect(quote.lit).toBe("hover:border-muted-foreground/20 data-[hover-card-open]:border-muted-foreground/20")
  // The card where a chat was started keeps its fill. The quote has none.
  expect(card.box).toContain("bg-card")
  expect(quote.box).toContain("bg-transparent")
})

// Tailwind's spacing scale: one unit is 4px.
const spacingPx = (units: number) => units * 4

test("a quote's measurements are the ones its classes draw", () => {
  const classes = TOOL_QUOTE_CLASS.split(" ")
  // A plain `border` is 1px.
  expect(classes).toContain("border")
  expect(QUOTE_GEOMETRY.borderPx).toBe(1)
  // `px-2.5`
  const padding = classes.find((name) => name.startsWith("px-"))
  expect(padding).toBe("px-2.5")
  expect(spacingPx(Number(padding!.slice(3)))).toBe(QUOTE_GEOMETRY.paddingXPx)
  // The mark's slot is `size-4`.
  const slot = TOOL_CARD_MARK_SLOT_CLASS.split(" ").find((name) => name.startsWith("size-"))
  expect(slot).toBe("size-4")
  expect(spacingPx(Number(slot!.slice(5)))).toBe(QUOTE_GEOMETRY.markPx)
  // The caption starts under the title: past the mark and the gap after it.
  expect(TOOL_CARD_CAPTION_CLASS).toContain(`pl-[${QUOTE_GEOMETRY.markPx + QUOTE_GEOMETRY.markGapPx}px]`)
})

test("a mark's slot centres whatever is drawn in it, and does not shrink", () => {
  const classes = TOOL_CARD_MARK_SLOT_CLASS.split(" ")
  for (const name of ["flex", "items-center", "justify-center", "shrink-0"]) expect(classes).toContain(name)
})
