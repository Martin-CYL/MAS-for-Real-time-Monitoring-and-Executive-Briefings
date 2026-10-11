import { t } from "../../../i18n/translate"
import { useLocale } from "../../../i18n/useTranslation"
import { ArrowUp, GitCommitHorizontal } from "lucide-react"
import type { ChatBranchHistoryEntry } from "../../../../shared/types"
import { formatRelativeTime } from "../../../lib/formatters"
import { WidgetRow } from "../widgets/parts"
import { ChecksIcon } from "./PullRequestState"
import { CARD_PILL_CLASS } from "./shared"

function openInNewTab(url: string) {
  if (typeof window === "undefined") return
  window.open(url, "_blank", "noopener,noreferrer")
}

/**
 * A commit in the History card, laid out like a PR row in the branch picker:
 * its message, the author (and any tags) under it, its age on the right and
 * its checks under that. A commit not on the remote yet shows ↑ as its main
 * icon. Opens on GitHub when the repo is there.
 */
export function CommitHistoryRow({ entry, isPendingPush = false, className }: {
  entry: ChatBranchHistoryEntry
  isPendingPush?: boolean
  className?: string
}) {
  useLocale()
  const relativeTime = formatRelativeTime(entry.authoredAt)
  return (
    <WidgetRow
      icon={isPendingPush
        ? <span title={t("Not pushed yet")} aria-label={t("Not pushed yet")} className="flex"><ArrowUp className="text-foreground" /></span>
        : <GitCommitHorizontal />}
      title={entry.summary}
      subtitle={entry.authorName || entry.tags.length > 0 ? (
        <span className="flex min-w-0 items-center gap-1">
          {entry.authorName ? <span className="truncate">{entry.authorName}</span> : null}
          {entry.tags.map((tag) => (
            <span key={tag} className={CARD_PILL_CLASS}>{tag}</span>
          ))}
        </span>
      ) : undefined}
      meta={relativeTime || undefined}
      subMeta={entry.checks ? <ChecksIcon checks={entry.checks} /> : undefined}
      // No native tooltip: the list's CommitHoverCard shows the whole commit.
      rowKey={entry.sha}
      className={className}
      onActivate={entry.githubUrl ? () => openInNewTab(entry.githubUrl!) : undefined}
      aria-label={entry.githubUrl ? t("Open commit {0} on GitHub", { 0: entry.sha.slice(0, 7) }) : undefined}
    />
  )
}
