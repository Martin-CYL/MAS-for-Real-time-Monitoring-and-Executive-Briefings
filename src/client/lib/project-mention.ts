import type { SidebarProjectGroup } from "../../shared/types"

/**
 * Helpers for the composer's "@" project menu. Pure functions so they can be
 * unit-tested; ChatInput owns the state and rendering.
 *
 * Tagging a project puts its absolute path into the prompt. No harness
 * expands an "@" mention on its own, so the path is the part that reaches the
 * agent; the "@" is only how you ask for the menu. Unlike "/" skills, a
 * mention can sit anywhere in the message.
 */

export interface ProjectMentionItem {
  projectId: string
  title: string
  localPath: string
  lastActivityAt: number
}

export interface ActiveProjectMention {
  /** Index of the "@" in the value. */
  start: number
  /** Text typed between the "@" and the caret. */
  query: string
}

/**
 * The "@token" the caret sits in, when the menu should be open. The "@" must
 * open the message or follow whitespace, so an email address or a scoped npm
 * package mid-word never opens it.
 */
export function getActiveProjectMention(value: string, caretPosition: number): ActiveProjectMention | null {
  if (caretPosition < 1 || caretPosition > value.length) return null
  const beforeCaret = value.slice(0, caretPosition)
  const match = beforeCaret.match(/(?:^|\s)@([^\s@]*)$/)
  if (!match) return null
  const query = match[1] ?? ""
  return { start: caretPosition - query.length - 1, query }
}

/** Every project in the sidebar except the one the chat already runs in, most recently active first. */
export function projectMentionCandidates(groups: SidebarProjectGroup[], currentPath: string | null): ProjectMentionItem[] {
  const items: ProjectMentionItem[] = []
  for (const group of groups) {
    if (!group.localPath || group.localPath === currentPath) continue
    let lastActivityAt = 0
    for (const chat of group.chats) {
      lastActivityAt = Math.max(lastActivityAt, chat.lastMessageAt ?? chat._creationTime)
    }
    items.push({ projectId: group.groupKey, title: group.title, localPath: group.localPath, lastActivityAt })
  }
  return items.sort((left, right) => right.lastActivityAt - left.lastActivityAt)
}

function scoreProject(item: ProjectMentionItem, query: string): number {
  if (query.length === 0) return 1
  const lowered = query.toLowerCase()
  const title = item.title.toLowerCase()
  const folder = (item.localPath.split("/").pop() ?? "").toLowerCase()
  if (title === lowered || folder === lowered) return 100
  if (title.startsWith(lowered) || folder.startsWith(lowered)) return 80
  if ([title, folder].some((name) => name.split(/[\s./_-]/).some((part) => part.startsWith(lowered)))) return 60
  if (title.includes(lowered) || folder.includes(lowered)) return 40
  if (item.localPath.toLowerCase().includes(lowered)) return 20
  return 0
}

/**
 * Filter + rank for the menu. Rendered top-to-bottom in ASCENDING match
 * quality, like the skill menu: the best match sits at the BOTTOM, next to
 * the input. Among equals the most recently active project wins.
 */
export function filterProjectMentionItems(items: ProjectMentionItem[], query: string): ProjectMentionItem[] {
  return items
    .map((item, index) => ({ item, index, score: scoreProject(item, query) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => left.score - right.score || right.index - left.index)
    .map((entry) => entry.item)
}

/** Swap the "@token" under the caret for the project's path and a space. */
export function applyProjectMention(
  value: string,
  mention: ActiveProjectMention,
  localPath: string
): { value: string; caret: number } {
  const tokenEnd = mention.start + 1 + (value.slice(mention.start + 1).match(/^[^\s]*/)?.[0].length ?? 0)
  const rest = value.slice(tokenEnd)
  const inserted = rest.startsWith(" ") || rest.startsWith("\n") ? localPath : `${localPath} `
  return {
    value: `${value.slice(0, mention.start)}${inserted}${rest}`,
    caret: mention.start + localPath.length + 1,
  }
}
