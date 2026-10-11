import { t } from "../../../i18n/translate"
import { useLocale } from "../../../i18n/useTranslation"
import { Ban, Code, Copy, Eye, FolderOpen, Trash2 } from "lucide-react"
import { memo } from "react"
import { cn } from "../../../lib/utils"
import { ContextMenuItem, ContextMenuSeparator } from "../../ui/context-menu"
import { WidgetRow } from "../widgets/parts"
import { DiffFileStat, diffStatus, splitDiffPath, StageCheckbox, type DiffFile } from "./shared"

export interface DiffFileActions {
  onOpenFile: (path: string) => void
  onOpenInFinder: (path: string) => void
  onDiscardFile: (path: string) => void
  onIgnoreFile: (path: string) => void
  onIgnoreFolder: (path: string) => void
  onCopyFilePath: (path: string) => void
  onCopyRelativePath: (path: string) => void
}

export function canIgnoreDiffFile(file: DiffFile) {
  // New files are ignorable whether they are untracked or already staged (the
  // server unstages staged new files before adding the .gitignore entry).
  // Tracked files stay disabled: .gitignore has no effect on tracked files.
  return file.isUntracked || file.changeType === "added"
}

export function canIgnoreDiffFolder(file: DiffFile) {
  if (!canIgnoreDiffFile(file)) {
    return false
  }
  return file.path.includes("/")
}

/**
 * A changed file in the Changes card: the commit checkbox, then the status
 * letter, the file's name and its folder, the +/- counts and the kebab.
 * Pressing it opens the file in the viewer; the card itself never shows
 * a diff.
 *
 * The name is what you scan for, so it stays whole while the folder gives way,
 * losing its start rather than its end ("…/chat-ui/widgets").
 */
export const DiffFileRow = memo(function DiffFileRow({
  file,
  isChecked,
  isReviewing,
  editorLabel,
  fileActions,
  onToggleChecked,
  onReview,
  className,
}: {
  file: DiffFile
  isChecked: boolean
  /** The file open in the viewer: lit like a keyboard cursor. */
  isReviewing: boolean
  editorLabel: string
  fileActions: DiffFileActions
  onToggleChecked: () => void
  onReview: () => void
  className?: string
}) {
  useLocale()
  const status = diffStatus(file)
  const { name, folder } = splitDiffPath(file.path)
  const canIgnore = canIgnoreDiffFile(file)
  const canIgnoreFolder = canIgnoreDiffFolder(file)
  return (
    <WidgetRow
      icon={<StageCheckbox checked={isChecked} onClick={onToggleChecked} className="size-4" />}
      title={(
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="min-w-0 max-w-[75%] shrink-0 truncate">{name}</span>
          {folder ? (
            // RTL so the ellipsis eats the folder's start; the <bdi> keeps
            // the path itself reading left to right.
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground [direction:rtl] text-left"><bdi>{folder}</bdi></span>
          ) : null}
        </span>
      )}
      // No native tooltip: the list's DiffFileHoverCard shows the whole path.
      rowKey={file.path}
      meta={<DiffFileStat additions={file.additions} deletions={file.deletions} />}
      active={isReviewing}
      className={className}
      onActivate={onReview}
      // The status sits in the kebab's slot at rest and gives way to it on
      // hover: the row's last glyph is what happened to the file, until you
      // reach for what you can do with it.
      menuIdle={(
        <span className={cn("font-mono text-[11px] font-semibold leading-none", status.className)} title={status.label}>{status.letter}</span>
      )}
      menuLabel={t("Actions for {0}", { 0: file.path })}
      menu={(
        <>
          <ContextMenuItem onSelect={onReview}>
            <Eye className="h-3.5 w-3.5" />
            <span className="text-xs font-medium">{t("Review")}</span>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => fileActions.onOpenFile(file.path)}>
            <Code className="h-3.5 w-3.5" />
            <span className="text-xs font-medium">{t("Open in") + " "}{editorLabel}</span>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => fileActions.onOpenInFinder(file.path)}>
            <FolderOpen className="h-3.5 w-3.5" />
            <span className="text-xs font-medium">{t("Open in Finder")}</span>
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => fileActions.onDiscardFile(file.path)}
            className="text-destructive dark:text-red-400 hover:bg-destructive/10 focus:bg-destructive/10 dark:hover:bg-red-500/20 dark:focus:bg-red-500/20"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span className="text-xs font-medium">{t("Discard Changes")}</span>
          </ContextMenuItem>
          <ContextMenuItem disabled={!canIgnore} onSelect={() => { if (canIgnore) fileActions.onIgnoreFile(file.path) }}>
            <Ban className="h-3.5 w-3.5" />
            <span className="text-xs font-medium">{t("Ignore File")}</span>
          </ContextMenuItem>
          <ContextMenuItem disabled={!canIgnoreFolder} onSelect={() => { if (canIgnoreFolder) fileActions.onIgnoreFolder(file.path) }}>
            <Ban className="h-3.5 w-3.5" />
            <span className="text-xs font-medium">{t("Ignore folder...")}</span>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => fileActions.onCopyFilePath(file.path)}>
            <Copy className="h-3.5 w-3.5" />
            <span className="text-xs font-medium">{t("Copy File Path")}</span>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => fileActions.onCopyRelativePath(file.path)}>
            <Copy className="h-3.5 w-3.5" />
            <span className="text-xs font-medium">{t("Copy Relative Path")}</span>
          </ContextMenuItem>
        </>
      )}
    />
  )
})
