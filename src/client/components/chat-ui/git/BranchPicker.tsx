import { t } from "../../../i18n/translate"
import { useLocale } from "../../../i18n/useTranslation"
import { GitBranchPlus } from "lucide-react"
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react"
import type {
  ChatBranchDetails,
  ChatBranchListEntry,
  ChatBranchListResult,
} from "../../../../shared/types"
import { cn } from "../../../lib/utils"
import { ROW_HIGHLIGHT_CLASS, ROW_HOVER_CLASS, WidgetError, WidgetList, WidgetMoreRow, WidgetRow } from "../widgets/parts"
import { BranchHoverCard, useBranchDetails } from "./BranchHoverCard"
import { ChecksIcon, pullRequestStateIcon } from "./PullRequestState"
import { BranchListSection, BranchListSkeleton, BranchSearchRow } from "./BranchList"

/**
 * Unsearched, Local and Remote show only this many, newest commit first: the
 * picker sits inline in the widget column, and a repo's full remote list
 * would bury everything under it. A search still covers every branch, and
 * each section's "N more" row reaches the rest.
 */
export const UNSEARCHED_BRANCH_LIMIT = 5

export function mostRecentBranches(entries: ChatBranchListEntry[], limit = UNSEARCHED_BRANCH_LIMIT) {
  if (entries.length <= limit) return entries
  // ISO timestamps compare correctly as strings; undated entries sort last.
  return [...entries]
    .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""))
    .slice(0, limit)
}

export interface BranchCreateOption {
  name: string
  /** Unset when the list named neither a default nor a current branch. */
  baseBranchName?: string
}

/**
 * What "Create branch" offers for a search: nothing while the search is empty
 * or names a branch that already exists (checking that one out is the
 * answer), otherwise the name off the default branch and, when HEAD is
 * elsewhere, off the current one too. Default first: it is the usual base,
 * and the previous dialog defaulted to it as well.
 *
 * Whitespace becomes "-": git refuses spaces, and the row shows the name it
 * will actually create.
 */
export function branchCreateOptions(
  query: string,
  branchList: ChatBranchListResult | null,
  currentBranchName?: string,
): BranchCreateOption[] {
  const name = query.trim().replace(/\s+/g, "-")
  if (!name || !branchList) return []
  const existing = [...branchList.recent, ...branchList.local, ...branchList.remote, ...branchList.pullRequests]
  if (name === currentBranchName || existing.some((entry) => entry.name === name || entry.displayName === name)) return []
  const bases = [...new Set([branchList.defaultBranchName, currentBranchName].filter((base): base is string => Boolean(base)))]
  return bases.length === 0 ? [{ name }] : bases.map((baseBranchName) => ({ name, baseBranchName }))
}

/**
 * The picker's sections for a search. One search covers all of them: a
 * branch you want may be a local branch, a remote one or someone's PR, and
 * you shouldn't have to know which before you type.
 */
export function branchPickerSections(args: {
  branchList: ChatBranchListResult | null
  query: string
  currentBranchName?: string
  showAllLocal: boolean
  showAllRemote: boolean
  showAllPullRequests: boolean
}) {
  const { branchList, currentBranchName, showAllLocal, showAllRemote, showAllPullRequests } = args
  const normalizedQuery = args.query.trim().toLowerCase()
  const matches = (entry: ChatBranchListEntry) => entry.name !== currentBranchName && (
    !normalizedQuery
    || [entry.displayName, entry.name, entry.description, entry.prTitle, entry.headLabel, entry.prNumber ? `#${entry.prNumber}` : undefined]
      .some((value) => value?.toLowerCase().includes(normalizedQuery))
  )
  const pullRequestHeadNames = new Set((branchList?.pullRequests ?? []).map((entry) => entry.headRefName ?? entry.name))
  const allLocal = (branchList?.local ?? []).filter(matches)
  // A remote branch with an open PR shows once, as the PR.
  const allRemote = (branchList?.remote ?? []).filter((entry) => matches(entry) && !pullRequestHeadNames.has(entry.name))
  const allPullRequests = (branchList?.pullRequests ?? []).filter(matches)
  return {
    recent: (branchList?.recent ?? []).filter(matches),
    pullRequests: normalizedQuery || showAllPullRequests ? allPullRequests : mostRecentBranches(allPullRequests),
    local: normalizedQuery || showAllLocal ? allLocal : mostRecentBranches(allLocal),
    remote: normalizedQuery || showAllRemote ? allRemote : mostRecentBranches(allRemote),
    allPullRequestCount: allPullRequests.length,
    allLocalCount: allLocal.length,
    allRemoteCount: allRemote.length,
  }
}

/** PRs whose state the picker reads before any hover. */
const PREFETCHED_PULL_REQUEST_LIMIT = 10

type PickerSection = "recent" | "pullRequests" | "local" | "remote"

type PickerOption =
  | { id: string; kind: "branch"; entry: ChatBranchListEntry }
  | { id: string; kind: "create"; option: BranchCreateOption }

/**
 * Find or create a branch. One search over one list, with no Branches / PRs
 * split: Recent, Pull requests, Local, Remote. Empty sections drop out. A
 * name that matches nothing offers to create that branch.
 *
 * Rendered inline in the Branch widget. It loads the list on mount, i.e.
 * when the widget opens, and focuses the search then (where there is a
 * keyboard). ↑/↓ move, Enter checks out or creates, Esc closes.
 */
export function BranchPicker({
  currentBranchName,
  onListBranches,
  onCheckoutBranch,
  onCreateBranch,
  onDone,
  repoSlug,
  onReadBranch,
}: {
  currentBranchName?: string
  /** "owner/repo" when origin is on GitHub: Remote's and Pull requests' "N more" open their GitHub pages. */
  repoSlug?: string
  onListBranches: () => Promise<ChatBranchListResult>
  onCheckoutBranch: (branch: ChatBranchListEntry) => Promise<void>
  onCreateBranch: (option: BranchCreateOption) => Promise<void>
  /** After a checkout or create, or on Esc: the widget collapses. */
  onDone: () => void
  /** A branch's tip and standing, or a PR as GitHub has it, for the rows' hover card. */
  onReadBranch?: (entry: ChatBranchListEntry) => Promise<ChatBranchDetails>
}) {
  useLocale()
  const [isLoading, setIsLoading] = useState(true)
  const [isMutating, setIsMutating] = useState(false)
  const [query, setQuery] = useState("")
  const [showAllLocal, setShowAllLocal] = useState(false)
  const [showAllRemote, setShowAllRemote] = useState(false)
  const [showAllPullRequests, setShowAllPullRequests] = useState(false)
  // Folded sections, like the left sidebar's. A search unfolds all of them
  // (and hides the chevrons): a match nobody can see is worse than none.
  const [collapsedSections, setCollapsedSections] = useState<ReadonlySet<PickerSection>>(() => new Set())
  const [branchList, setBranchList] = useState<ChatBranchListResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  /*
   * Two ways to drive the list, and only one highlights at a time.
   *
   * Pointer (the default): rows light with CSS :hover. That is instant and
   * never out of step with the pointer. Tracking hover in React state instead
   * re-rendered the picker for every row crossed, lagged behind the pointer,
   * and left a row lit over gaps and section labels.
   *
   * Keyboard: the arrow keys move a cursor held in state, and :hover is off,
   * so a pointer resting over the list doesn't light a second row. Real
   * pointer movement hands control back. Movement is checked because
   * scrolling the cursor into view slides rows under a still pointer, and
   * some browsers report that as a mouse move.
   */
  const [mode, setMode] = useState<"pointer" | "keyboard">("pointer")
  const [keyboardActiveId, setKeyboardActiveId] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listId = useId()

  useEffect(() => {
    setIsLoading(true)
    setError(null)
    void onListBranches()
      .then((result) => setBranchList(result))
      .catch((loadError) => {
        setError(loadError instanceof Error ? loadError.message : String(loadError))
      })
      .finally(() => {
        setIsLoading(false)
      })
  }, [onListBranches])

  // Only with a real keyboard: on a phone, focusing would throw up the
  // on-screen keyboard over the list you opened this to tap.
  useEffect(() => {
    if (window.matchMedia?.("(hover: hover) and (pointer: fine)").matches) inputRef.current?.focus({ preventScroll: true })
  }, [])

  const currentName = branchList?.currentBranchName ?? currentBranchName
  const sections = branchPickerSections({ branchList, query, currentBranchName: currentName, showAllLocal, showAllRemote, showAllPullRequests })
  const createOptions = branchCreateOptions(query, branchList, currentName)
  const optionIdFor = (entry: ChatBranchListEntry) => `${listId}-${entry.id}`

  // The PRs on screen read their state up front, for the icons under each
  // one's age. At most ten: each is a network read, and a search can show 50.
  const pullRequestDetails = useBranchDetails(sections.pullRequests.slice(0, PREFETCHED_PULL_REQUEST_LIMIT), onReadBranch)
  const pullRequestChecks = (entry: ChatBranchListEntry) => {
    const checks = pullRequestDetails.get(entry.id)?.pullRequest?.checks
    return checks ? <ChecksIcon checks={checks} /> : undefined
  }
  // The main icon says whether it can merge, once that's been read.
  const pullRequestIcon = (entry: ChatBranchListEntry) => {
    const pr = pullRequestDetails.get(entry.id)?.pullRequest
    if (!pr) return undefined
    const { icon, label } = pullRequestStateIcon(pr)
    return <span title={label} aria-label={label} className="flex">{icon}</span>
  }
  const shownEntries = new Map(
    [...sections.recent, ...sections.pullRequests, ...sections.local, ...sections.remote].map((entry) => [entry.id, entry]),
  )
  const searching = query.trim().length > 0
  const isExpanded = (section: PickerSection) => searching || !collapsedSections.has(section)
  const sectionFold = (section: PickerSection) => ({
    expanded: isExpanded(section),
    onToggle: searching ? undefined : () => setCollapsedSections((current) => {
      const next = new Set(current)
      if (next.has(section)) next.delete(section)
      else next.add(section)
      return next
    }),
  })

  // Every row the keys can reach, top to bottom. A folded section's rows
  // aren't on screen, so the keys skip them.
  const options: PickerOption[] = [
    ...(["recent", "pullRequests", "local", "remote"] as const)
      .flatMap((section) => (isExpanded(section) ? sections[section] : []))
      .map((entry): PickerOption => ({ id: optionIdFor(entry), kind: "branch", entry })),
    ...createOptions.map((option): PickerOption => ({ id: `${listId}-create-${option.baseBranchName ?? ""}`, kind: "create", option })),
  ]

  // Enter's target. The keyboard cursor when there is one; while searching,
  // otherwise, the best match. With no search and no cursor, nothing, so a
  // stray Enter on opening doesn't switch branches.
  useEffect(() => {
    setKeyboardActiveId(null)
  }, [query])
  const resolvedActiveId = keyboardActiveId && options.some((option) => option.id === keyboardActiveId)
    ? keyboardActiveId
    : query.trim() ? options[0]?.id ?? null : null

  function moveActive(step: 1 | -1) {
    if (options.length === 0) return
    // From the row under the pointer, if the keys take over from a hover.
    const fromId = mode === "keyboard"
      ? resolvedActiveId
      : listRef.current?.querySelector<HTMLElement>('[role="option"]:hover')?.id ?? resolvedActiveId
    const index = options.findIndex((option) => option.id === fromId)
    const nextIndex = index === -1
      ? (step === 1 ? 0 : options.length - 1)
      : (index + step + options.length) % options.length
    const next = options[nextIndex]!
    setMode("keyboard")
    setKeyboardActiveId(next.id)
    document.getElementById(next.id)?.scrollIntoView({ block: "nearest" })
  }

  /**
   * A row's highlight. Keyboard mode: only the cursor. Pointer mode: :hover,
   * plus Enter's target (the best match while searching) whenever the
   * pointer isn't over the list, so there is never more than one lit row.
   */
  function optionClassName(isActive: boolean) {
    // "" rather than undefined: a row given no highlight falls back to hover.
    if (mode === "keyboard") return isActive ? ROW_HIGHLIGHT_CLASS : ""
    return isActive
      ? cn(ROW_HIGHLIGHT_CLASS, "group-hover/list:border-transparent group-hover/list:bg-transparent hover:!border-border hover:!bg-muted")
      : ROW_HOVER_CLASS
  }

  async function runMutation(action: () => Promise<void>) {
    if (isMutating) return
    setIsMutating(true)
    try {
      await action()
      onDone()
    } finally {
      setIsMutating(false)
    }
  }

  function choose(option: PickerOption) {
    void runMutation(() => option.kind === "branch" ? onCheckoutBranch(option.entry) : onCreateBranch(option.option))
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      moveActive(event.key === "ArrowDown" ? 1 : -1)
    } else if (event.key === "Enter") {
      event.preventDefault()
      const option = options.find((candidate) => candidate.id === resolvedActiveId)
      if (option) choose(option)
    } else if (event.key === "Escape") {
      event.preventDefault()
      // Kept here: the page listens for Esc on window (to stop a turn, close
      // panels), and this one means only "leave the picker".
      event.stopPropagation()
      // First Esc clears a search, the next closes the picker.
      if (query) setQuery("")
      else onDone()
    }
  }

  // Every header counts its section, what a search matched while searching.
  // The count is what says a section holds more than its first few rows.
  const countOf = (total: number) => (total > 0 ? total : undefined)
  // Rows a "Show more" added fade in; a search's results just appear.
  const revealFrom = (showAll: boolean) => (showAll && !searching ? UNSEARCHED_BRANCH_LIMIT : undefined)
  // A section's end, when it shows only its newest few: the rest in place,
  // or on GitHub where the list lives there. Nothing while searching, which
  // shows every match. Out of the tab order and quiet while the keys drive,
  // like everything else in a combobox's list.
  const sectionMore = (total: number, showAll: boolean, setShowAll: (showAll: boolean) => void, githubHref?: string) => {
    if (searching || total <= UNSEARCHED_BRANCH_LIMIT) return null
    return githubHref ? (
      <WidgetMoreRow count={total - UNSEARCHED_BRANCH_LIMIT} total={total} href={githubHref} tabIndex={-1} suppressHover={mode === "keyboard"} />
    ) : (
      <WidgetMoreRow
        count={total - UNSEARCHED_BRANCH_LIMIT}
        shown={showAll}
        onShow={() => setShowAll(true)}
        onHide={() => setShowAll(false)}
        tabIndex={-1}
        suppressHover={mode === "keyboard"}
      />
    )
  }
  const sectionProps = {
    disabled: isMutating,
    activeOptionId: resolvedActiveId,
    optionId: optionIdFor,
    optionClassName,
    onSelect: (entry: ChatBranchListEntry) => choose({ id: optionIdFor(entry), kind: "branch", entry }),
  }
  const hasBranchRows = sections.recent.length + sections.pullRequests.length + sections.local.length + sections.remote.length > 0

  return (
    <>
      <BranchSearchRow
        inputRef={inputRef}
        value={query}
        onChange={setQuery}
        placeholder={t("Find or create a branch…")}
        listId={listId}
        activeOptionId={resolvedActiveId ?? undefined}
        onKeyDown={handleKeyDown}
      />
      <WidgetList
        listRef={listRef}
        id={listId}
        role="listbox"
        aria-label={t("Branches")}
        aria-busy={isLoading}
        data-mode={mode}
        onPointerMove={(event) => {
          if (mode !== "keyboard" || (event.movementX === 0 && event.movementY === 0)) return
          setMode("pointer")
          setKeyboardActiveId(null)
        }}
        className="group/list"
      >
        {isLoading ? (
          <BranchListSkeleton />
        ) : error ? (
          <WidgetError>{error}</WidgetError>
        ) : (
          <>
            {!hasBranchRows && createOptions.length === 0 ? (
              <div className="px-1.5 py-1 text-xs text-muted-foreground">
                {query.trim() ? t("No matching branches.") : t("No other branches.")}
              </div>
            ) : null}
            <BranchListSection title={t("Recent")} count={countOf(sections.recent.length)} entries={sections.recent} {...sectionFold("recent")} {...sectionProps} />
            <BranchListSection
              title={t("Pull requests")}
              {...sectionFold("pullRequests")}
              count={countOf(sections.allPullRequestCount)}
              entries={sections.pullRequests}
              subMetaFor={pullRequestChecks}
              iconFor={pullRequestIcon}
              // Said only when PRs could not be read. "None open" is the
              // section being absent, like every other empty section.
              emptyLabel={branchList?.pullRequestsStatus === "error" && !searching
                ? branchList.pullRequestsError ?? t("Could not load pull requests.")
                : undefined}
              revealFrom={revealFrom(showAllPullRequests)}
              footer={sectionMore(sections.allPullRequestCount, showAllPullRequests, setShowAllPullRequests, repoSlug ? `https://github.com/${repoSlug}/pulls` : undefined)}
              {...sectionProps}
            />
            <BranchListSection
              title={t("Local")}
              {...sectionFold("local")}
              count={countOf(sections.allLocalCount)}
              entries={sections.local}
              revealFrom={revealFrom(showAllLocal)}
              // Local branches have no page on GitHub, so the rest open here.
              footer={sectionMore(sections.allLocalCount, showAllLocal, setShowAllLocal)}
              {...sectionProps}
            />
            <BranchListSection
              title={t("Remote")}
              {...sectionFold("remote")}
              count={countOf(sections.allRemoteCount)}
              entries={sections.remote}
              revealFrom={revealFrom(showAllRemote)}
              footer={sectionMore(sections.allRemoteCount, showAllRemote, setShowAllRemote, repoSlug ? `https://github.com/${repoSlug}/branches/all` : undefined)}
              {...sectionProps}
            />
            {createOptions.length > 0 ? (
              // Directly under the last section's rows, touching them.
              <div role="group" aria-label={t("Create branch")} className="flex flex-col gap-px">
                {createOptions.map((option) => {
                  const id = `${listId}-create-${option.baseBranchName ?? ""}`
                  const isActive = id === resolvedActiveId
                  return (
                    <WidgetRow
                      key={id}
                      id={id}
                      role="option"
                      aria-selected={isActive}
                      tabIndex={-1}
                      icon={<GitBranchPlus />}
                      title={(
                        <>
                          {t("Create") + " "}<span className="font-mono text-[13px]">{option.name}</span>
                          {option.baseBranchName ? <span className="text-muted-foreground"> from {option.baseBranchName}</span> : null}
                        </>
                      )}
                      disabled={isMutating}
                      highlightClassName={optionClassName(isActive)}
                      onActivate={() => choose({ id, kind: "create", option })}
                    />
                  )
                })}
              </div>
            ) : null}
          </>
        )}
      </WidgetList>
      <BranchHoverCard containerRef={listRef} entries={shownEntries} onReadBranch={onReadBranch} repoSlug={repoSlug} />
    </>
  )
}
