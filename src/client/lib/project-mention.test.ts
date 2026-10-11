import { describe, expect, test } from "bun:test"
import type { SidebarChatRow, SidebarProjectGroup } from "../../shared/types"
import {
  applyProjectMention,
  filterProjectMentionItems,
  getActiveProjectMention,
  projectMentionCandidates,
  type ProjectMentionItem,
} from "./project-mention"

function item(title: string, localPath: string): ProjectMentionItem {
  return { projectId: title, title, localPath, lastActivityAt: 0 }
}

function group(groupKey: string, localPath: string, lastMessageAt?: number): SidebarProjectGroup {
  const chats = lastMessageAt === undefined ? [] : [{ chatId: `${groupKey}-chat`, lastMessageAt, _creationTime: 0 } as SidebarChatRow]
  return {
    groupKey,
    title: groupKey,
    realTitle: groupKey,
    localPath,
    chats,
    previewChats: [],
    olderChats: [],
    defaultCollapsed: false,
  }
}

describe("getActiveProjectMention", () => {
  test("active at the start of the message and after whitespace", () => {
    expect(getActiveProjectMention("@", 1)).toEqual({ start: 0, query: "" })
    expect(getActiveProjectMention("@nov", 4)).toEqual({ start: 0, query: "nov" })
    expect(getActiveProjectMention("look at @nov", 12)).toEqual({ start: 8, query: "nov" })
    expect(getActiveProjectMention("first\n@nov", 10)).toEqual({ start: 6, query: "nov" })
  })

  test("query stops at the caret", () => {
    expect(getActiveProjectMention("@novax rest", 3)).toEqual({ start: 0, query: "no" })
  })

  test("inactive mid-word, past whitespace, and before the @", () => {
    expect(getActiveProjectMention("me@example.com", 14)).toBeNull()
    expect(getActiveProjectMention("@novax ", 7)).toBeNull()
    expect(getActiveProjectMention("@novax", 0)).toBeNull()
    expect(getActiveProjectMention("hello", 5)).toBeNull()
  })
})

describe("projectMentionCandidates", () => {
  test("drops the current project and sorts by recent activity", () => {
    const items = projectMentionCandidates(
      [group("old", "/p/old", 1), group("here", "/p/here", 9), group("new", "/p/new", 5), group("empty", "/p/empty")],
      "/p/here"
    )
    expect(items.map((entry) => entry.projectId)).toEqual(["new", "old", "empty"])
  })
})

describe("filterProjectMentionItems", () => {
  const items = [item("novax", "/p/novax"), item("site", "/p/novax-site"), item("notes", "/p/notes")]

  test("empty query keeps recency order, reversed so the latest sits at the bottom", () => {
    expect(filterProjectMentionItems(items, "").map((entry) => entry.title)).toEqual(["notes", "site", "novax"])
  })

  test("best match renders last", () => {
    expect(filterProjectMentionItems(items, "novax").map((entry) => entry.title)).toEqual(["site", "novax"])
    expect(filterProjectMentionItems(items, "site").map((entry) => entry.title)).toEqual(["site"])
  })

  test("drops projects that don't match", () => {
    expect(filterProjectMentionItems(items, "zzz")).toEqual([])
  })
})

describe("applyProjectMention", () => {
  test("replaces the token with the path and a trailing space", () => {
    const value = "look at @nov"
    const mention = getActiveProjectMention(value, value.length)!
    expect(applyProjectMention(value, mention, "/p/novax")).toEqual({ value: "look at /p/novax ", caret: 17 })
  })

  test("replaces the whole token when the caret is inside it, and reuses the following space", () => {
    const value = "@novxx and more"
    const mention = getActiveProjectMention(value, 3)!
    expect(applyProjectMention(value, mention, "/p/novax")).toEqual({ value: "/p/novax and more", caret: 9 })
  })
})
