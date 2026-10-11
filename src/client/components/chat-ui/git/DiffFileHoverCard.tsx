import { t } from "../../../i18n/translate"
import { useLocale } from "../../../i18n/useTranslation"
import type { RefObject } from "react"
import { FileText } from "lucide-react"
import { cn } from "../../../lib/utils"
import { TURN_CARD_ROW_INSET, TurnCardMetaRow, TurnCardMetaSeparator } from "../../ui/turn-card"
import { useCardDetails, WidgetHoverCard } from "../widgets/WidgetHoverCard"
import { diffHold, diffStatus, getDiffPreviewAttachment, type DiffFile } from "./shared"

// Keyed by path and patch digest: an edit to the file reads it again.
const patchCache = new Map<string, string>()

/** Lines the peek shows: enough to recognise the change, not to review it. */
const PEEK_LINE_LIMIT = 12

export interface PatchPeek {
  /** The first hunk's header, e.g. "@@ -12,6 +12,9 @@ function load()". */
  header: string
  lines: Array<{ kind: "add" | "remove" | "context"; text: string }>
  /** Changed lines past the peek, across the whole patch. */
  moreChanges: number
}

/**
 * The first hunk of a unified patch, cut to a few lines, plus how many
 * changed lines the rest holds. Null when there's no hunk (binary, empty).
 */
export function peekPatch(patch: string, limit = PEEK_LINE_LIMIT): PatchPeek | null {
  const lines = patch.split("\n")
  const start = lines.findIndex((line) => line.startsWith("@@"))
  if (start === -1) return null
  const peek: PatchPeek = { header: lines[start]!, lines: [], moreChanges: 0 }
  for (const line of lines.slice(start + 1)) {
    const kind = line.startsWith("+") ? "add" : line.startsWith("-") ? "remove" : line.startsWith(" ") ? "context" : null
    if (!kind) continue
    if (peek.lines.length < limit) {
      peek.lines.push({ kind, text: line.slice(1) })
    } else if (kind !== "context") {
      peek.moreChanges += 1
    }
  }
  return peek
}

/** A changed file's card: its whole path, what happened to it, and a peek at the change. */
export function DiffFileCardContent({
  file,
  patch,
  previewUrl,
  note,
}: {
  file: DiffFile
  /** Absent until the read lands (or if it fails). */
  patch: string | null
  /** An image's own URL, shown instead of a patch. */
  previewUrl?: string
  /** Why there's no peek (a binary, a lockfile, a huge diff), said instead of one. */
  note?: string
}) {
  useLocale()
  const status = diffStatus(file)
  const peek = patch ? peekPatch(patch) : null
  const kind = file.size !== undefined && file.mimeType && !file.mimeType.startsWith("text/") ? file.mimeType : undefined
  return (
    <>
      {/* The status letter and +/- are on the row. What the letter doesn't
          say is spelled out: that "A" is a file git doesn't track yet, and
          what kind of file a binary is. */}
      {file.isUntracked || kind ? (
        <TurnCardMetaRow>
          <span className="shrink-0">{file.isUntracked ? t("Untracked") : status.label}</span>
          {kind ? (
            <>
              <TurnCardMetaSeparator />
              <span className="truncate">{kind}</span>
            </>
          ) : null}
        </TurnCardMetaRow>
      ) : null}
      {/* The whole path, which the row has to cut: wrapped, never truncated. */}
      <div className={cn("break-all text-sm font-medium text-popover-foreground", TURN_CARD_ROW_INSET, (file.isUntracked || kind) && "mt-1")}>{file.path}</div>
      {previewUrl ? (
        <div className="mx-1.5 mt-1.5">
          <img src={previewUrl} alt={file.path} className="max-h-40 rounded-md border border-border/60 object-contain" />
        </div>
      ) : peek ? (
        <>
          {/* The start of the change, in the diff's own colors: enough to
              tell which edit this is without opening the viewer. A code
              box whose edge sits on the card's text line (6px card + 6px row
              inset), so it lines up under the path; the colored bands run to
              the box's edges rather than stopping short of them. */}
          <div className="mx-1.5 mt-1.5 overflow-hidden rounded-md border border-border/60 bg-muted/30 py-1 font-mono text-[11px] leading-4">
            <div className="truncate px-2 text-muted-foreground/70">{peek.header}</div>
            {peek.lines.map((line, index) => (
              <div
                key={index}
                className={cn(
                  "truncate whitespace-pre px-2",
                  line.kind === "add" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                  line.kind === "remove" && "bg-red-500/10 text-red-700 dark:text-red-300",
                  line.kind === "context" && "text-muted-foreground",
                )}
              >
                {line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}{line.text || " "}
              </div>
            ))}
          </div>
          {peek.moreChanges > 0 ? (
            <div className={cn("mt-1 text-[12px] text-muted-foreground/70", TURN_CARD_ROW_INSET)}>
              {t("{0} more changed line{1}", { 0: peek.moreChanges, 1: peek.moreChanges === 1 ? "" : "s" })}
            </div>
          ) : null}
        </>
      ) : note ? (
        <TurnCardMetaRow className="mt-1">
          <FileText className="size-2.5 shrink-0" strokeWidth={2.5} />
          <span>{note}</span>
        </TurnCardMetaRow>
      ) : patch !== null ? (
        <TurnCardMetaRow className="mt-1">
          <FileText className="size-2.5 shrink-0" strokeWidth={2.5} />
          <span>{t("No text changes to show")}</span>
        </TurnCardMetaRow>
      ) : null}
      {/* The card's footer, in the footer's slot and spacing (mt-1), like
          every other card's who-and-when line. */}
      <TurnCardMetaRow className="mt-1">
        <span>{t("Click to review")}</span>
      </TurnCardMetaRow>
    </>
  )
}

function DiffFileHoverCardBody({
  file,
  projectId,
  onLoadPatch,
}: {
  file: DiffFile
  projectId: string | null
  onLoadPatch?: (path: string) => Promise<string>
}) {
  useLocale()
  const preview = getDiffPreviewAttachment(projectId, file)
  const imageUrl = preview?.kind === "image" ? preview.contentUrl : undefined
  // An image shows as itself, and a PDF as its name: neither has a patch to
  // peek. Nor does a file the viewer holds back (a binary, a lockfile, a huge
  // diff): the card says why rather than reading all of it for twelve lines.
  const hold = preview ? null : diffHold(file)
  const patch = useCardDetails(
    patchCache,
    `${file.path}\u0000${file.patchDigest}`,
    onLoadPatch && !preview && !hold ? () => onLoadPatch(file.path) : null,
    50,
  )
  return <DiffFileCardContent file={file} patch={preview || hold ? null : patch} previewUrl={imageUrl} note={hold?.message} />
}

/** The Changes list's hover card: a file's card on the row under the pointer. */
export function DiffFileHoverCard({
  containerRef,
  files,
  projectId,
  onLoadPatch,
}: {
  containerRef: RefObject<HTMLDivElement | null>
  files: ReadonlyMap<string, DiffFile>
  projectId: string | null
  onLoadPatch?: (path: string) => Promise<string>
}) {
  useLocale()
  return (
    <WidgetHoverCard containerRef={containerRef}>
      {(path) => {
        const file = files.get(path)
        if (!file) return null
        return <DiffFileHoverCardBody key={`${path}\u0000${file.patchDigest}`} file={file} projectId={projectId} onLoadPatch={onLoadPatch} />
      }}
    </WidgetHoverCard>
  )
}
