import { t } from "../../../i18n/translate"
import { useLocale } from "../../../i18n/useTranslation"
import { Check, Minus, X } from "lucide-react"
import type { ReactNode } from "react"
import type { ChatAttachment, ChatCommitChecks, ChatDiffSnapshot } from "../../../../shared/types"
import { cn } from "../../../lib/utils"
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip"

export type DiffRenderMode = "unified" | "split"
export type DiffFile = ChatDiffSnapshot["files"][number]

export function IconButton(props: {
  label: string
  active?: boolean
  onClick: () => void
  children: ReactNode
}) {
  useLocale()
  return (
    <Tooltip delayDuration={0}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={props.label}
          title={props.label}
          onClick={props.onClick}
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
            props.active && "bg-accent text-foreground"
          )}
        >
          {props.children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{props.label}</TooltipContent>
    </Tooltip>
  )
}

export function StageCheckbox({
  checked,
  mixed = false,
  label,
  className,
  onClick,
}: {
  checked: boolean
  mixed?: boolean
  label?: string
  className?: string
  onClick: () => void
}) {
  useLocale()
  return (
    <button
      type="button"
      aria-label={label ?? (checked ? t("Exclude file from commit") : t("Include file in commit"))}
      aria-checked={mixed ? "mixed" : checked}
      aria-pressed={mixed ? "mixed" : checked}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      className={cn(
        "flex size-4.5 shrink-0 items-center justify-center rounded border transition-colors",
        checked || mixed
          ? "border-foreground bg-foreground text-background"
          : "border-border bg-background text-transparent",
        className
      )}
    >
      {mixed
        ? <Minus className="h-3 w-3" strokeWidth={3} />
        : checked
          ? <Check className="h-3 w-3" strokeWidth={3} />
          : null}
    </button>
  )
}

/**
 * A file's line changes — `+6`, `-2`, or both — in the git panel's colours.
 *
 * Shared with the sidebar hover card's list of what a chat changed, so the two
 * places you read "how big was this edit" read identically. Each side keeps its
 * own meaning for the numbers (the panel's are the file's current diff against
 * HEAD; the card's are what one chat wrote there), but a count is a count and
 * two typographies for it would only invite comparing them wrongly.
 *
 * Renders nothing when both counts are zero or unknown, so a binary file — or
 * anything recorded before counts existed — leaves an empty slot rather than
 * claiming `+0`.
 */
export function DiffFileStat({
  additions,
  deletions,
  className,
}: {
  additions?: number
  deletions?: number
  className?: string
}) {
  useLocale()
  const hasAdditions = (additions ?? 0) > 0
  const hasDeletions = (deletions ?? 0) > 0
  if (!hasAdditions && !hasDeletions) return null

  return (
    <span className={cn("whitespace-nowrap text-xs font-mono", className)}>
      {hasAdditions ? <span className="text-emerald-600 dark:text-emerald-400">+{additions}</span> : null}
      {hasDeletions ? (
        <span className={cn("text-red-600 dark:text-red-400", hasAdditions && "ml-2")}>-{deletions}</span>
      ) : null}
    </span>
  )
}

/**
 * The letter git would print, in the column's status colors. An untracked
 * file is a new one as far as a commit is concerned, so it reads "A" too.
 */
export function diffStatus(file: DiffFile): { letter: string; label: string; className: string } {
  if (file.isUntracked || file.changeType === "added") return { letter: "A", get label() { return t("Added") }, className: "text-success" }
  if (file.changeType === "deleted") return { letter: "D", get label() { return t("Deleted") }, className: "text-destructive" }
  if (file.changeType === "renamed") return { letter: "R", get label() { return t("Renamed") }, className: "text-info" }
  return { letter: "M", get label() { return t("Modified") }, className: "text-muted-foreground" }
}

/**
 * Files GitHub (through linguist) treats as generated and doesn't render by
 * default: lockfiles, minified bundles, source maps, Xcode project files,
 * protobuf output. Nobody reads them line by line, and they're often long
 * enough to stall the diffs around them.
 */
const GENERATED_FILE_NAMES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb", "deno.lock",
  "Cargo.lock", "Gemfile.lock", "composer.lock", "poetry.lock", "Pipfile.lock", "uv.lock", "go.sum", "go.work.sum",
  "Podfile.lock", "Package.resolved", "flake.lock", "pubspec.lock", "mix.lock", "gradle.lockfile", "project.pbxproj",
])
const GENERATED_FILE_PATTERN = /(?:[.-]min\.(?:js|mjs|css)|\.(?:js|mjs|css)\.map|\.pb\.(?:go|swift|cc|h)|_pb2(?:_grpc)?\.pyi?|\.xcworkspacedata)$/iu

export function isGeneratedPath(path: string) {
  const name = path.slice(path.lastIndexOf("/") + 1)
  return GENERATED_FILE_NAMES.has(name) || GENERATED_FILE_PATTERN.test(name)
}

/** Changed lines past which a diff waits for a click: one huge file shouldn't stall the rest. */
export const LARGE_DIFF_LINES = 1_000

/**
 * Why a file's diff isn't drawn straight away, GitHub's precautions: what
 * the file says instead, and whether "Load diff" can still show it. Null
 * when it's drawn as usual. An image or PDF never lands here; it shows as
 * itself.
 */
export function diffHold(file: DiffFile): { message: string; loadable: boolean } | null {
  const lines = file.additions + file.deletions
  if (file.binary) return { message: "Binary file not shown.", loadable: false }
  if (file.changeType === "renamed" && lines === 0) return { message: "File renamed without changes.", loadable: false }
  if (file.changeType !== "deleted" && file.size === 0) return { message: "Empty file.", loadable: false }
  if (file.changeType === "deleted") return { message: "This file was deleted.", loadable: true }
  if (isGeneratedPath(file.path)) return { message: "Generated files are not rendered by default.", loadable: true }
  if (lines > LARGE_DIFF_LINES) return { message: "Large diffs are not rendered by default.", loadable: true }
  return null
}

const PATH_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })

/**
 * Tree order, as GitHub's and VS Code's file lists: folder by folder, a
 * folder's subfolders before its files, names in natural order ("item2"
 * before "item10", case aside). A file sits with its neighbours, so a
 * component and its test read one after the other.
 */
export function compareFilePaths(left: string, right: string) {
  const leftParts = left.split("/")
  const rightParts = right.split("/")
  const shared = Math.min(leftParts.length, rightParts.length)
  for (let index = 0; index < shared; index += 1) {
    const leftPart = leftParts[index]!
    const rightPart = rightParts[index]!
    if (leftPart === rightPart) continue
    const leftIsFolder = index < leftParts.length - 1
    const rightIsFolder = index < rightParts.length - 1
    if (leftIsFolder !== rightIsFolder) return leftIsFolder ? -1 : 1
    return PATH_COLLATOR.compare(leftPart, rightPart) || (leftPart < rightPart ? -1 : 1)
  }
  return leftParts.length - rightParts.length
}

export function sortByPath<T extends { path: string }>(files: readonly T[]): T[] {
  return [...files].sort((left, right) => compareFilePaths(left.path, right.path))
}

/** "src/app/Page.tsx" → name "Page.tsx", folder "src/app". */
export function splitDiffPath(path: string) {
  const slash = path.lastIndexOf("/")
  return slash === -1 ? { name: path, folder: "" } : { name: path.slice(slash + 1), folder: path.slice(0, slash) }
}

/** An image or PDF shows as itself rather than as a binary diff. */
export function getDiffPreviewAttachment(projectId: string | null, file: DiffFile): ChatAttachment | null {
  if (!projectId || !file.mimeType || typeof file.size !== "number" || file.changeType === "deleted") {
    return null
  }

  if (!file.mimeType.startsWith("image/") && file.mimeType !== "application/pdf") {
    return null
  }

  return {
    id: `diff:${file.path}`,
    kind: file.mimeType.startsWith("image/") ? "image" : "file",
    displayName: file.path.split("/").pop() ?? file.path,
    absolutePath: file.path,
    relativePath: file.path,
    contentUrl: `/api/projects/${projectId}/files/${encodeURIComponent(file.path)}/content`,
    mimeType: file.mimeType,
    size: file.size,
  }
}

/**
 * A tag or label inside a hover card's small-print row. 16px tall, the row's
 * own line box (14px leading and a 1px border each side), so a row with a
 * pill is exactly as tall as one without and the card doesn't shift between
 * commits.
 */
export const CARD_PILL_CLASS = "shrink-0 rounded-full border border-border px-1.5 text-[11px] leading-[14px]"

/**
 * A check rollup in a hover card: glyph, then "2 of 3 checks passed". The
 * glyph sits in a fixed 10px box, so the text starts in the same place
 * whether it follows a check, a cross or the smaller pending dot.
 */
export function CheckRollupLabel({ checks }: { checks: ChatCommitChecks }) {
  useLocale()
  return (
    <>
      <span className="flex size-2.5 shrink-0 items-center justify-center" aria-hidden>
        {checks.state === "success"
          ? <Check className="size-2.5 text-success" strokeWidth={2.5} />
          : checks.state === "failure"
            ? <X className="size-2.5 text-destructive" strokeWidth={2.5} />
            : <span className="size-1.5 rounded-full bg-amber-500" />}
      </span>
      <span className="truncate">
        {checks.state === "pending"
          ? t("Checks running · {0} of {1} finished", { 0: checks.passed, 1: checks.total })
          : t("{0} of {1} checks passed", { 0: checks.passed, 1: checks.total })}
      </span>
    </>
  )
}

/**
 * Who a hover card is about, leading the card: the one fact a row never has
 * room for, so it gets the card's first line at full contrast. A GitHub
 * avatar when there's a login; otherwise the name's initial in a disc, so
 * every card's first line has the same shape.
 */
export function CardPerson({ name, avatarUrl, detail, title }: {
  name: string
  avatarUrl?: string
  /** Muted after the name, e.g. "committed by GitHub". */
  detail?: string
  title?: string
}) {
  useLocale()
  return (
    <span className="flex min-w-0 items-center gap-1.5" title={title}>
      {avatarUrl ? (
        <img src={avatarUrl} alt="" className="size-4 shrink-0 rounded-full bg-muted" />
      ) : (
        <span aria-hidden className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[9px] font-semibold uppercase text-foreground">
          {name.trim().charAt(0)}
        </span>
      )}
      <span className="truncate text-[13px] font-medium tracking-normal text-popover-foreground">{name}</span>
      {detail ? <span className="shrink-0 truncate">{detail}</span> : null}
    </span>
  )
}
