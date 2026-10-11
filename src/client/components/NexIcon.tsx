import type { SVGProps } from "react"
import { NEX_ICON_PATHS } from "../../shared/nex-icon"

/** Nex identity, legible in either theme without changing status colors. */
export function NexIcon({ className, style, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 64 64" fill="currentColor" stroke="none"
      width="24" height="24" aria-hidden="true" data-nex-icon=""
      className={`shrink-0 ${className ?? ""}`}
      style={{ color: "var(--nex-icon-ink, #142e4d)", ...style }}>
      {NEX_ICON_PATHS.map((d) => <path key={d} d={d} />)}
    </svg>
  )
}
