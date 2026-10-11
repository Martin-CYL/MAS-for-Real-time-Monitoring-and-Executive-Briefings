import { t } from "../../../i18n/translate"
import { useLocale } from "../../../i18n/useTranslation"
import { Check, GitPullRequest, GitPullRequestArrow, GitPullRequestDraft, X } from "lucide-react"
import type { ChatCommitChecks, ChatPullRequestDetails } from "../../../../shared/types"

/*
 * State as row glyphs, shared by the two rows that describe a change: a PR in
 * the branch picker and a commit in History. Both lay out the same way (main
 * icon, title, author under it, age on the right, checks under the age); only
 * the main icon differs, and for a PR the main icon is its merge state.
 */

function describeChecks(checks: ChatCommitChecks) {
  return checks.state === "pending"
    ? t("Checks running: {0} of {1} finished", { 0: checks.passed, 1: checks.total })
    : t("{0} of {1} checks passed", { 0: checks.passed, 1: checks.total })
}

/**
 * A check rollup under a row's age: "12/16" then ✓, ✕, or the amber pending
 * dot. The count leads so the glyphs line up down the list's right edge; the
 * glyph sits in a fixed 12px box so that edge doesn't move between states.
 * Opens the CI run when GitHub gave a link.
 */
export function ChecksIcon({ checks }: { checks: ChatCommitChecks }) {
  useLocale()
  const label = describeChecks(checks)
  const glyph = checks.state === "success"
    ? <Check className="size-3 text-success" strokeWidth={2.5} />
    : checks.state === "failure"
      ? <X className="size-3 text-destructive" strokeWidth={2.5} />
      : <span className="size-1.5 rounded-full bg-amber-500" />
  const content = (
    <>
      <span className="tabular-nums">{checks.passed}/{checks.total}</span>
      <span className="flex size-3 shrink-0 items-center justify-center">{glyph}</span>
    </>
  )
  const className = "flex shrink-0 items-center gap-1"
  if (!checks.url) return <span title={label} aria-label={label} className={className}>{content}</span>
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      // The row opens the commit or checks out the PR; this glyph opens the run.
      onClick={(event) => {
        event.stopPropagation()
        window.open(checks.url, "_blank", "noopener,noreferrer")
      }}
      className={`${className} cursor-pointer rounded-sm hover:text-foreground`}
    >
      {content}
    </button>
  )
}

/**
 * GitHub's merge state as the PR row's main icon: a shape and a color, named
 * by its tooltip. Ready is a green arrow PR, conflicts red, blocked or behind
 * or failing amber, and a draft its own dashed glyph. Unknown (GitHub still
 * working it out, or not read yet) is the plain muted PR glyph.
 */
export function pullRequestStateIcon(pr: ChatPullRequestDetails | undefined): { icon: React.ReactNode; label: string } {
  if (pr?.isDraft) return { icon: <GitPullRequestDraft className="text-muted-foreground" />, get label() { return t("Draft") } }
  switch (pr?.mergeableState) {
    case "clean":
    case "has_hooks":
      return { icon: <GitPullRequestArrow className="text-success" />, get label() { return t("Ready to merge") } }
    case "dirty":
      return { icon: <GitPullRequest className="text-destructive" />, get label() { return t("Has conflicts") } }
    case "unstable":
      return { icon: <GitPullRequest className="text-amber-500" />, get label() { return t("Mergeable, but checks are failing") } }
    case "blocked":
      return { icon: <GitPullRequest className="text-amber-500" />, get label() { return t("Blocked: needs reviews or checks") } }
    case "behind":
      return { icon: <GitPullRequest className="text-amber-500" />, get label() { return t("Behind its base branch") } }
    default:
      return { icon: <GitPullRequest />, get label() { return t("Pull request") } }
  }
}
