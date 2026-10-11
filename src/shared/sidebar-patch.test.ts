import { describe, expect, test } from "bun:test"
import { applySidebarPatch, diffSidebarIndex, indexSidebarData } from "./sidebar-patch"
import type { SidebarChatRow, SidebarData, SidebarProjectGroup } from "./types"

function row(chatId: string, overrides: Partial<SidebarChatRow> = {}): SidebarChatRow {
  return {
    _id: chatId,
    _creationTime: 1,
    chatId,
    title: `Chat ${chatId}`,
    status: "idle",
    unread: false,
    localPath: "/repo",
    provider: "claude",
    hasAutomation: false,
    ...overrides,
  }
}

function group(groupKey: string, chats: SidebarChatRow[], overrides: Partial<SidebarProjectGroup> = {}): SidebarProjectGroup {
  return {
    groupKey,
    title: groupKey,
    realTitle: groupKey,
    localPath: `/${groupKey}`,
    chats,
    previewChats: chats.slice(0, 1),
    olderChats: chats.slice(1),
    defaultCollapsed: false,
    ...overrides,
  }
}

function patch(previous: SidebarData | null, next: SidebarData, from: number | null, to: number) {
  return diffSidebarIndex(previous ? indexSidebarData(previous)! : null, indexSidebarData(next)!, from, to)
}

// Compared as JSON: the rebuilt group lists its row arrays after the header
// fields, so key order differs from the derive while every value matches.
const normalize = (data: SidebarData) => JSON.parse(JSON.stringify({
  projectGroups: data.projectGroups.map(({ chats, previewChats, olderChats, archivedChats, ...header }) => ({
    header, chats, previewChats, olderChats, archivedChats,
  })),
}))

describe("sidebar patches", () => {
  const a1 = row("a1")
  const a2 = row("a2")
  const b1 = row("b1")
  const base: SidebarData = { projectGroups: [group("a", [a1, a2]), group("b", [b1])] }

  test("a reset rebuilds the snapshot from nothing", () => {
    const reset = patch(null, base, null, 1)
    expect(reset.from).toBeNull()
    expect(normalize(applySidebarPatch(null, reset))).toEqual(normalize(base))
  })

  test("one changed row sends that row and nothing else", () => {
    const next: SidebarData = {
      projectGroups: [group("a", [a1, row("a2", { status: "running" })]), group("b", [b1])],
    }
    const change = patch(base, next, 1, 2)
    expect(change.rows?.map((r) => r.chatId)).toEqual(["a2"])
    expect(change.headers).toBeUndefined()
    expect(change.lists).toBeUndefined()
    expect(normalize(applySidebarPatch(base, change))).toEqual(normalize(next))
  })

  test("reordering, adding and removing chats and groups round-trips", () => {
    const next: SidebarData = {
      projectGroups: [
        group("c", [row("c1")]),
        group("a", [a2, a1, row("a3")], { title: "renamed", archivedChats: [row("a0", { archivedAt: 5 })] }),
      ],
    }
    const change = patch(base, next, 1, 2)
    expect(change.order).toEqual(["c", "a"])
    expect(normalize(applySidebarPatch(base, change))).toEqual(normalize(next))
  })

  test("a patch applied to the wrong base throws", () => {
    const next: SidebarData = { projectGroups: [group("a", [a1, a2, row("a3")]), group("b", [b1])] }
    const change = patch(base, next, 1, 2)
    // Group a's header is unchanged, so the patch leaves it to the base.
    expect(() => applySidebarPatch({ projectGroups: [group("b", [b1])] }, change)).toThrow(/unknown group a/)
    // Group a is there but a1 isn't: its list names a row the patch doesn't carry.
    expect(() => applySidebarPatch({ projectGroups: [group("a", [a2]), group("b", [b1])] }, change)).toThrow(/unknown chat a1/)
  })

  test("one chat id carrying two different rows can't be indexed", () => {
    const clash: SidebarData = { projectGroups: [group("a", [a1]), group("b", [row("a1", { title: "other" })])] }
    expect(indexSidebarData(clash)).toBeNull()
  })
})
