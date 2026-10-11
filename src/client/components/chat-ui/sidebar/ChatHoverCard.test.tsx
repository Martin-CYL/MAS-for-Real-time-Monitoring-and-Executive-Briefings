import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { ChatTouchedFilesResult, SidebarChatRow } from "../../../../shared/types"
import type { ChatJumpRole } from "../../../lib/chat-navigation"
import type { SidebarThread } from "../../../lib/thread-sections"
import { HOVER_CARD_SURFACE_CLASSNAME } from "../../ui/list-hover-card"
import { ChatHoverCardContent } from "./ChatHoverCard"

const NOW = Date.now()

function thread(
  overrides: Partial<SidebarChatRow> = {},
  label?: SidebarThread["projectLabel"],
): SidebarThread {
  const row: SidebarChatRow = {
    _id: "chat-1",
    _creationTime: NOW - 60 * 60 * 1000,
    chatId: "chat-1",
    title: "Refactor the ws router",
    status: "idle",
    unread: false,
    localPath: "/repo",
    provider: "claude",
    hasAutomation: false,
    // An answered turn: the prompt, then the reply to it a minute later.
    lastMessageAt: NOW - 2 * 60_000,
    lastUserMessagePreview: "make the sidebar labels shorter",
    lastAgentMessagePreview: "Done — the branch moved into the hover card.",
    lastAgentMessagePreviewAt: NOW - 60_000,
    ...overrides,
  }
  return {
    chatId: row.chatId,
    title: row.title,
    projectId: "project-1",
    projectTitle: "nex",
    projectLabel: label ?? {
      name: "nex",
      branchName: "feat/hover-card",
      currentBranch: "feat/hover-card",
      repoPath: "jakemor/nex",
      hasOwner: true,
      text: "nex/feat/hover-card",
    },
    archived: false,
    lastActivityAt: NOW,
    row,
  }
}

function render(
  overrides: Partial<SidebarChatRow> = {},
  label?: SidebarThread["projectLabel"],
  draft?: string,
  onSelectMessage?: (role: ChatJumpRole) => void,
) {
  return renderToStaticMarkup(
    <ChatHoverCardContent
      thread={thread(overrides, label)}
      draft={draft}
      onSelectMessage={onSelectMessage}
    />
  )
}

const JUMPS = () => undefined

describe("HOVER_CARD_SURFACE_CLASSNAME", () => {
  test("a closed card is gone, not fading", () => {
    // The card follows a pointer down a list of rows. An exit animation keeps
    // the closed one on screen — over the row the pointer has already reached.
    expect(HOVER_CARD_SURFACE_CLASSNAME).toContain("data-[state=closed]:hidden")
    expect(HOVER_CARD_SURFACE_CLASSNAME).not.toContain("animate-out")
  })

  test("carries the surface it used to inherit from the primitive", () => {
    // It is anchored by hand now, so no base class comes with it: layering,
    // the border and the padding all have to be spelled out here.
    expect(HOVER_CARD_SURFACE_CLASSNAME).toContain("z-50")
    expect(HOVER_CARD_SURFACE_CLASSNAME).toContain("border-border")
    expect(HOVER_CARD_SURFACE_CLASSNAME).toContain("px-1.5")
  })
})

describe("ChatHoverCardContent", () => {
  test("retains the prompt and reply without repository metadata", () => {
    const html = render()

    expect(html).not.toContain("jakemor/nex")
    expect(html).toContain("make the sidebar labels shorter")
    expect(html).toContain("Done — the branch moved into the hover card.")
    // The project heads the card; the exchange follows it.
    expect(html).toContain("Nex")
  })

  test("hides branch and repository headers", () => {
    // Down a list of chats the branch is what differs; the repo is the same
    // one over and over. The varying fact reads down the left edge.
    const html = render()

    expect(html).toContain("Nex")
  })

  test("hides the branch even for main", () => {
    // The row can only afford the glyph, so it shows one just for a surprising
    // branch; the card has the room to always say which branch you're on.
    const onMain = render({}, {
      name: "nex",
      currentBranch: "main",
      repoPath: "jakemor/nex",
      hasOwner: true,
      text: "nex",
    })

    expect(onMain).not.toContain("main")
    expect(onMain).not.toContain("lucide-git-branch")
  })

  test("a detached HEAD has no branch to name", () => {
    const detached = render({}, {
      name: "nex",
      repoPath: "jakemor/nex",
      hasOwner: true,
      text: "nex",
    })

    expect(detached).not.toContain("lucide-git-branch")
  })

  test("does not offer Setup Git for a workspace without a repo", () => {
    const html = renderToStaticMarkup(
      <ChatHoverCardContent
        thread={thread({}, { name: "scratch", hasGitRepo: false, text: "scratch" })}
        onSetupGit={JUMPS}
      />
    )

    expect(html).not.toContain("Setup Git")
    // Where the branch would have been — ahead of the project name opposite it.
    expect(html).toContain("Nex")
  })

  test("says nothing about git until the server has actually looked", () => {
    // An unresolved project reads the same as one with no repo if you go by
    // the missing branch alone, and every repo in the sidebar is unresolved
    // for the first probe pass after boot.
    const html = renderToStaticMarkup(
      <ChatHoverCardContent
        thread={thread({}, { name: "scratch", text: "scratch" })}
        onSetupGit={JUMPS}
      />
    )

    expect(html).not.toContain("Setup Git")
  })

  test("hides Git setup and branch controls for repositories", () => {
    const html = renderToStaticMarkup(
      <ChatHoverCardContent thread={thread()} onSetupGit={JUMPS} />
    )

    expect(html).not.toContain("feat/hover-card")
    expect(html).not.toContain("Setup Git")
  })

  test("drops a reply the current prompt hasn't earned", () => {
    // Sent again and still waiting: pairing the new question with the old
    // answer would read as though it had already come back.
    const html = render({ status: "running", lastMessageAt: NOW - 10_000 })

    expect(html).toContain("make the sidebar labels shorter")
    expect(html).not.toContain("Done — the branch moved into the hover card.")
  })

  test("an undated reply falls back to the agent's last activity", () => {
    // Chats whose last text predates the preview timestamp still pair up.
    const html = render({
      lastAgentMessagePreviewAt: undefined,
      lastAgentMessageAt: NOW - 60_000,
    })

    expect(html).toContain("Done — the branch moved into the hover card.")
  })

  test("sizes the whole chat rather than timing its last turn", () => {
    // How far a conversation has gone is what a row can't show and what you'd
    // want before opening it; the last turn's duration says nothing about that,
    // and the minimap already reports it per turn.
    expect(render({ turnCount: 24 })).toContain("24 turns")
    expect(render({ turnCount: 1 })).toContain("1 turn")
  })

  test("anchors the turn count and landing time together at the right edge", () => {
    const endedAt = NOW - 60_000
    const time = new Date(endedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    const html = render({ turnCount: 8, lastTurnEndedAt: endedAt })

    const anchored = html.slice(html.indexOf("ml-auto"))
    expect(anchored).toContain("8 turns")
    expect(anchored).toContain(time)
    expect(anchored.indexOf("8 turns")).toBeLessThan(anchored.indexOf(time))
  })

  test("a live turn shows no end time — the only one on hand is the previous turn's", () => {
    const endedAt = NOW - 30 * 60_000
    const time = new Date(endedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    const html = render({
      status: "running",
      turnCount: 3,
      lastTurnEndedAt: endedAt,
      lastTurnStartedAt: NOW - 60_000,
    })

    expect(html).toContain("3 turns")
    expect(html).not.toContain(time)
  })

  test("a chat waiting on a subagent says so where the landing time would go", () => {
    // Its last turn did end, but stamping the card with that time would read
    // as the chat having finished then.
    const endedAt = NOW - 30 * 60_000
    const time = new Date(endedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    const html = render({
      status: "waiting_on_subagent",
      turnCount: 3,
      lastTurnStartedAt: endedAt - 60_000,
      lastTurnEndedAt: endedAt,
    })

    const anchored = html.slice(html.indexOf("ml-auto"))
    expect(anchored).toContain("3 turns")
    expect(anchored).toContain("Waiting on a subagent")
    expect(html).not.toContain(time)
  })

  test("uses Nex identity regardless of the executing provider", () => {
    const html = render({ provider: "codex", turnCount: 2, lastTurnEndedAt: NOW })

    expect(html).toContain("data-nex-icon")
    expect(html).toContain("Nex")
    expect(html).not.toContain("Codex")
    // The turn's numbers are right-anchored (the footer's `ml-auto`, the last
    // one in the card), so the glyph and name sit alone on the left with no
    // separator of any kind between them.
    expect(html.indexOf("Nex")).toBeLessThan(html.lastIndexOf("ml-auto"))
  })

  test("a project with nothing to qualify it shows no separators at all", () => {
    const html = render(
      { provider: null, lastTurnStartedAt: undefined, lastTurnEndedAt: undefined },
      { name: "nex", currentBranch: "main", repoPath: "jakemor/nex", hasOwner: true, text: "nex" },
    )

    expect(html).not.toContain("•")
  })

  test("a chat whose turns predate the counter says nothing rather than zero", () => {
    // The landing time still stands alone; only the count is dropped.
    const endedAt = NOW - 1000
    const time = new Date(endedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    const html = render({ turnCount: undefined, lastTurnEndedAt: endedAt })

    expect(html).not.toContain("0 turns")
    expect(html).toContain(time)
  })

  test("an unsent draft ends the card and takes the sent prompt's place", () => {
    const html = render({}, undefined, "also drop the last user message")

    expect(html).toContain("also drop the last user message")
    // The prompt is already answered by the reply; the draft is what's next.
    expect(html).not.toContain("make the sidebar labels shorter")
    expect(html).toContain("Done — the branch moved into the hover card.")
    expect(html.indexOf("Done — the branch")).toBeLessThan(html.indexOf("also drop"))
  })

  test("a draft reads as unsent: pencilled and italic", () => {
    const html = render({}, undefined, "half a thought")

    expect(html).toContain("lucide-pencil-line")
    expect(html).toContain("italic")
    // The glyph is inline, so a wrapped second line runs the full width rather
    // than indenting to clear it.
    expect(html).toContain("inline")
  })

  test("a draft cuts the reply above it to one line", () => {
    // What you were about to say outranks how the last answer began.
    expect(render({}, undefined, "half a thought")).toContain("line-clamp-1")
    expect(render()).toContain("line-clamp-3")
  })

  test("no draft leaves the sent prompt in place", () => {
    // `useChatDraft` trims, so whitespace never reaches here as a draft.
    const html = render({}, undefined, "")

    expect(html).toContain("make the sidebar labels shorter")
    expect(html).not.toContain("lucide-pencil-line")
  })

  test("both messages are targets wherever the card can navigate", () => {
    // No per-chat condition: the card shows a chat's latest prompt and latest
    // reply by definition, and the transcript resolves those itself.
    const html = render({}, undefined, undefined, JUMPS)

    expect(html).toContain("Jump to this prompt")
    expect(html).toContain("Jump to this reply")
    expect(html).toContain("<button")
  })

  test("stays plain text on a card with nowhere to send you", () => {
    // Archived rows pass no handler — the card is a read-only peek there, and
    // a hover fill on text that does nothing would lie.
    expect(render()).not.toContain("<button")
  })

  test("a reply carried over from the previous turn is neither shown nor clickable", () => {
    // The prompt is newer than the reply, so the answer on hand isn't to it.
    const html = render(
      { lastMessageAt: NOW, lastAgentMessagePreviewAt: NOW - 60_000 },
      undefined,
      undefined,
      JUMPS,
    )

    expect(html).not.toContain("Done — the branch moved into the hover card.")
    expect(html).not.toContain("Jump to this reply")
    expect(html).toContain("Jump to this prompt")
  })

  test("a draft leaves only the reply to click, since it replaced the prompt", () => {
    const html = render({}, undefined, "half a thought", JUMPS)

    expect(html).not.toContain("Jump to this prompt")
    expect(html).toContain("Jump to this reply")
  })

  test("a draft opens the chat rather than aiming at a message", () => {
    // It was never sent, so there is no message to land on — the composer is
    // already holding it.
    const html = renderToStaticMarkup(
      <ChatHoverCardContent
        thread={thread()}
        draft="half a thought"
        onSelectChat={() => undefined}
      />
    )

    expect(html).toContain("Open this chat")
    expect(html).toContain("half a thought")
  })

  test("hides repository links even when a remote exists", () => {
    const html = renderToStaticMarkup(
      <ChatHoverCardContent
        thread={thread({}, {
          name: "nex",
          repoPath: "jakemor/nex",
          hasOwner: true,
          repoUrl: "https://github.com/jakemor/nex",
          text: "nex",
        })}
        onOpenRepo={() => undefined}
      />
    )

    expect(html).not.toContain("Open on GitHub")
    expect(html).not.toContain("jakemor/nex")
  })

  test("hides repository details without a remote", () => {
    // No origin, or a remote that resolves to no page — nothing should suggest
    // a click that goes nowhere.
    const html = renderToStaticMarkup(
      <ChatHoverCardContent thread={thread()} onOpenRepo={() => undefined} />
    )

    expect(html).not.toContain("Open on")
    expect(html).not.toContain("jakemor/nex")
  })

  test("falls back to the chat title when there is no prompt yet", () => {
    const html = render({ lastUserMessagePreview: undefined, lastAgentMessagePreview: undefined })

    expect(html).toContain("Refactor the ws router")
  })

  describe("the file list", () => {
    const FILES: ChatTouchedFilesResult = {
      files: [
        { path: "src/embed/widget.ts", additions: 60, deletions: 1 },
        { path: "poems/moon.md", additions: 6 },
      ],
      // Every row is a live claim carrying a count: the server sends only files
      // still uncommitted (`isTouchLive`) that can say how much changed
      // (`hasLineCounts`).
      totalCount: 2,
    }

    function renderWithFiles(result: ChatTouchedFilesResult, onOpenFile?: (path: string) => void) {
      return renderToStaticMarkup(
        <ChatHoverCardContent thread={thread()} touchedFiles={result} onOpenFile={onOpenFile} />
      )
    }

    test("hides changed-file paths while preserving Nex identity", () => {
      const html = renderWithFiles(FILES)

      expect(html).not.toContain("src/embed/widget.ts")
      expect(html).not.toContain("poems/moon.md")
      // An appendix to the summary, not a replacement for it.
      expect(html).toContain("Nex")
    })

    test("hides diff statistics", () => {
      const html = renderWithFiles(FILES)

      expect(html).not.toContain("+60")
      expect(html).not.toContain(">-1<")
      expect(html).not.toContain("+6")
    })

    test("hides editor actions even when callbacks are available", () => {
      const opened: string[] = []
      const html = renderWithFiles(FILES, (filePath) => opened.push(filePath))

      // Labelled by path: down a list of eight, it is the only thing telling
      // one control from the next.
      expect(html).not.toContain("Open src/embed/widget.ts")
      expect(html).not.toContain("disabled")
    })

    test("does not leave disabled file controls behind", () => {
      const html = renderWithFiles(FILES)

      expect(html).not.toContain("disabled")
    })

    test("hides the changed-file overflow count", () => {
      const html = renderWithFiles({ files: FILES.files, totalCount: 290 })

      expect(html).not.toContain("288 more files")
    })

    test("hides a single overflow file too", () => {
      const html = renderWithFiles({ files: FILES.files, totalCount: 3 })

      expect(html).not.toContain("1 more file")
      expect(html).not.toContain("1 more files")
    })

    test("adds nothing to a card whose chat has changed nothing", () => {
      const withFiles = renderWithFiles({ files: [], totalCount: 0 })
      const without = renderToStaticMarkup(<ChatHoverCardContent thread={thread()} />)

      expect(withFiles).toBe(without)
    })
  })
})
