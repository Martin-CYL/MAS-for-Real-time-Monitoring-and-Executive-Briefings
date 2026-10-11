/** Nex's ordinary-user surface. This is presentation policy, not access control.
 * Provider configuration, agent tools and runtime data stay on the server.
 * Keep this a build-time constant: no hidden user toggle enables developer UI.
 */
export const SHOW_DEVELOPER_UI = false

const hiddenSettingsRows = new Set([
  "applicationUpdate", "defaultEditor", "newProjectsDirectory", "terminalVisibility",
  "terminalScrollback", "terminalMinColumnWidth",
])
export function isProductSettingsRowVisible(id: string): boolean {
  return SHOW_DEVELOPER_UI || !hiddenSettingsRows.has(id)
}

const hiddenPalettePages = new Set([
  "usage", "models", "harness", "open-in", "add-project", "clone-github", "create-new", "browse",
])
export function isProductPalettePageVisible(page: string): boolean {
  return SHOW_DEVELOPER_UI || !hiddenPalettePages.has(page)
}

const hiddenActions = new Set([
  "usage", "new-project", "toggle-recent-chats-sidebar", "toggle-terminal", "open-in",
  "copy-project-path", "change-model", "change-harness", "standard-mode", "fast-mode",
])
const hiddenActionPrefixes = ["add-project-", "open-", "mode-", "set-reasoning-", "set-context-", "set-model-", "set-harness-"]
export function isProductActionVisible(id: string): boolean {
  return SHOW_DEVELOPER_UI || (!hiddenActions.has(id) && !hiddenActionPrefixes.some((prefix) => id.startsWith(prefix)))
}
