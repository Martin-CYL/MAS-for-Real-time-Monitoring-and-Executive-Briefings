import { t } from "../../../i18n/translate"
import { useLocale } from "../../../i18n/useTranslation"
import { GitBranch, GitPullRequest, Search } from "lucide-react"
import type { KeyboardEvent, ReactNode, Ref } from "react"
import type { ChatBranchListEntry } from "../../../../shared/types"
import { formatRelativeTime } from "../../../lib/formatters"
import { cn } from "../../../lib/utils"
import { Input } from "../../ui/input"
import { Skeleton } from "../../ui/skeleton"
import { WIDGET_ROW_REVEAL_CLASS, WIDGET_STRIP_INPUT_CLASS, WidgetIconColumn, WidgetListLabel, WidgetRow, WidgetStrip } from "../widgets/parts"

/** A boxed search field, for the merge dialog. The widget card uses BranchSearchRow. */
export function BranchSearchInput({
  value,
  onChange,
  placeholder,
  disabled,
  trailingAction,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  disabled?: boolean
  trailingAction?: ReactNode
}) {
  useLocale()
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className={cn("h-9 pl-7 text-sm", trailingAction ? "pr-14" : undefined)}
        disabled={disabled}
      />
      {trailingAction ? <div className="absolute right-1 top-1/2 -translate-y-1/2">{trailingAction}</div> : null}
    </div>
  )
}

/**
 * The Branch card's search: a Strip over the list, and a combobox over it.
 * The arrow keys move the list's active option; the input keeps focus.
 */
export function BranchSearchRow({
  inputRef,
  value,
  onChange,
  placeholder,
  listId,
  activeOptionId,
  onKeyDown,
}: {
  inputRef?: Ref<HTMLInputElement>
  value: string
  onChange: (value: string) => void
  placeholder: string
  listId: string
  activeOptionId?: string
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void
}) {
  useLocale()
  return (
    <WidgetStrip leading={<Search />}>
      <input
        ref={inputRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        role="combobox"
        aria-expanded
        aria-controls={listId}
        aria-activedescendant={activeOptionId}
        aria-autocomplete="list"
        autoComplete="off"
        spellCheck={false}
        data-1p-ignore
        className={WIDGET_STRIP_INPUT_CLASS}
      />
    </WidgetStrip>
  )
}

/**
 * What a branch row shows. A PR row is laid out like a History commit row:
 * its title, then "#number · author" under it, its age on the right (and its
 * checks under that, from the picker). A branch row is its name and age.
 */
export function branchRowContent(entry: ChatBranchListEntry) {
  if (entry.kind === "pull_request") {
    return {
      icon: <GitPullRequest />,
      title: entry.prTitle ?? entry.displayName,
      // The author's full name, as History's commit rows show theirs; the
      // login when GitHub has no name for them.
      subtitle: [entry.prNumber ? `#${entry.prNumber}` : null, entry.authorName ?? entry.authorLogin].filter(Boolean).join(" · ") || undefined,
      meta: entry.updatedAt ? formatRelativeTime(entry.updatedAt) : undefined,
    }
  }
  return {
    icon: <GitBranch />,
    title: entry.displayName,
    subtitle: entry.headLabel ?? undefined,
    meta: entry.updatedAt ? formatRelativeTime(entry.updatedAt) : undefined,
  }
}

export function BranchListSection({
  title,
  count,
  entries,
  emptyLabel,
  selectedName,
  activeOptionId,
  optionId,
  optionClassName,
  disabled,
  footer,
  expanded = true,
  onToggle,
  revealFrom,
  subMetaFor,
  iconFor,
  onSelect,
}: {
  title: string
  /** Muted after the title, e.g. how many open PRs there are in all. */
  count?: number
  entries: ChatBranchListEntry[]
  emptyLabel?: string
  selectedName?: string | null
  /**
   * For a list driven by a combobox: the option the arrow keys are on, each
   * row's option id, and the row's highlight classes, which the combobox
   * owns (it knows whether the pointer or the keys are driving).
   */
  activeOptionId?: string | null
  optionId?: (entry: ChatBranchListEntry) => string
  optionClassName?: (isActive: boolean) => string | undefined
  disabled?: boolean
  /** A last row after the entries, e.g. "N more". */
  footer?: ReactNode
  /** Folded, the section is just its header. */
  expanded?: boolean
  /** Makes the header fold the section, like the left sidebar's sections. */
  onToggle?: () => void
  /** Rows from this index on came from a "Show more", and fade in. */
  revealFrom?: number
  /** State under a row's age, on its second line (a PR's checks). */
  subMetaFor?: (entry: ChatBranchListEntry) => ReactNode
  /** Replaces a row's main icon (a PR's merge state), when there's one to show. */
  iconFor?: (entry: ChatBranchListEntry) => ReactNode
  onSelect: (entry: ChatBranchListEntry) => void
}) {
  useLocale()
  if (entries.length === 0 && !emptyLabel) {
    return null
  }

  // A fragment, not a wrapper: the label and rows sit directly in the List,
  // touching the rows of the sections around them.
  return (
    <>
      <WidgetListLabel count={count} expanded={expanded} onToggle={onToggle}>{title}</WidgetListLabel>
      {!expanded ? null : entries.length === 0 ? (
        <div className="px-1.5 pb-1 text-xs text-muted-foreground">{emptyLabel}</div>
      ) : (
        entries.map((entry, index) => {
          const id = optionId?.(entry)
          const isActive = id !== undefined && id === activeOptionId
          return (
            <WidgetRow
              key={entry.id}
              {...branchRowContent(entry)}
              {...(iconFor?.(entry) ? { icon: iconFor(entry) } : {})}
              id={id}
              // For the picker's hover card, which finds the row by it.
              rowKey={entry.id}
              subMeta={subMetaFor?.(entry)}
              role={id ? "option" : undefined}
              aria-selected={id ? isActive : undefined}
              // Keeps focus in the search field when the list is a combobox's.
              tabIndex={id ? -1 : undefined}
              active={selectedName === entry.name}
              highlightClassName={optionClassName?.(isActive)}
              disabled={disabled}
              className={revealFrom !== undefined && index >= revealFrom ? WIDGET_ROW_REVEAL_CLASS : undefined}
              onActivate={() => onSelect(entry)}
            />
          )
        })
      )}
      {expanded ? footer : null}
    </>
  )
}

// Fixed, uneven widths: branch names vary in length, and identical bars read
// as a table waiting for data rather than a list of names.
const SKELETON_NAME_WIDTHS = ["58%", "42%", "70%", "36%", "52%"]

/**
 * The branch list while it loads: a label and rows in WidgetRow's geometry
 * (icon column, name, trailing age), so the list lands in place.
 */
export function BranchListSkeleton({ rows = 5 }: { rows?: number }) {
  useLocale()
  return (
    <div aria-busy aria-label={t("Loading branches")} className="flex flex-col gap-px">
      {/* The header's text-sm line, not a label bar: it lands where the real
          "Recent" header will. */}
      <div className="flex h-5 items-center px-1.5 pb-1 pt-1 box-content">
        <Skeleton className="h-3 w-14" />
      </div>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-2 rounded-lg border border-transparent px-[5px] py-1.5">
          <WidgetIconColumn>
            <Skeleton className="size-3.5 rounded-full" />
          </WidgetIconColumn>
          <Skeleton className="h-3 flex-none" style={{ width: SKELETON_NAME_WIDTHS[index % SKELETON_NAME_WIDTHS.length] }} />
          <Skeleton className="ml-auto h-2.5 w-7" />
        </div>
      ))}
    </div>
  )
}
