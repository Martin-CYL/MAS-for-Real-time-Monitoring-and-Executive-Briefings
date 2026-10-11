import { useLocale } from "../../i18n/useTranslation"
import type { CSSProperties } from "react"
import { cn } from "../../lib/utils"

/**
 * A placeholder shaped like the content on its way. Loaders that know what
 * they will show use these instead of a spinner: the layout is already there
 * when the data lands, so nothing jumps, and the wait reads as shorter.
 *
 * Pulses, except under reduced motion, where it holds still.
 */
export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  useLocale()
  return <div aria-hidden className={cn("animate-pulse rounded-md bg-foreground/[0.07] motion-reduce:animate-none dark:bg-foreground/10", className)} style={style} />
}
