import { SHOW_DEVELOPER_UI, isProductSettingsRowVisible } from "../../config/productFeatures"
import { t } from "../../i18n/translate"
import { BookText, History, Command, FlaskConical, Gauge, MessageSquareQuote, Settings2, type LucideIcon } from "lucide-react"

/**
 * Single source of truth for settings navigation targets.
 *
 * Every settings row is declared here and referenced by the section components
 * (`<SettingsRow def={SETTINGS_ROWS.theme}>`), so the command palette derives
 * its "Settings" entries automatically: add a def + use it in JSX and the row
 * is searchable and jumpable (`/settings/:sectionId#rowId`) with no palette
 * changes.
 */

export const SETTINGS_SECTIONS = [
  {
    id: "general",
    get label() { return t("General") },
    icon: Settings2 as LucideIcon,
    get subtitle() { return t("Appearance, notifications, chats, and layout.") },
  },
  {
    id: "changelog",
    get label() { return t("Changelog") },
    icon: History as LucideIcon,
    get subtitle() { return t("Features and improvements in each Nex release.") },
  },
  {
    id: "providers",
    get label() { return t("Providers") },
    icon: MessageSquareQuote as LucideIcon,
    get subtitle() { return t("Sign-ins, the default provider, and model defaults for each harness.") },
  },
  {
    id: "skills",
    get label() { return t("Skills") },
    icon: BookText as LucideIcon,
    get subtitle() { return t("Global agent skills from the active skill lock file.") },
  },
  {
    id: "keybindings",
    get label() { return t("Keybindings") },
    icon: Command as LucideIcon,
    get subtitle() { return t("Edit global app shortcuts stored in the active keybindings file.") },
  },
  {
    id: "usage",
    get label() { return t("Usage") },
    icon: Gauge as LucideIcon,
    get subtitle() { return t("Subscription rate limits for each harness, with reset times.") },
  },
  {
    id: "labs",
    get label() { return t("Labs") },
    icon: FlaskConical as LucideIcon,
    get subtitle() { return t("Experimental features that are still in progress.") },
  },
] as const

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]
export type SettingsSectionId = SettingsSection["id"]

/** Product settings exposed to ordinary users. */
export function isSettingsSectionVisible(id: SettingsSectionId) {
  return (SHOW_DEVELOPER_UI || id === "general" || id === "changelog")
}

export function visibleSettingsSections(): SettingsSection[] {
  return SETTINGS_SECTIONS.filter((section) => isSettingsSectionVisible(section.id))
}

export interface SettingsRowDef {
  /** Stable anchor id; the palette navigates to `/settings/:sectionId#id`. */
  id: string
  sectionId: SettingsSectionId
  title: string
  /** Plain-text description used for palette search + display. Sections may render richer JSX in place of it. */
  description: string
  /** Extra search terms that don't appear in the title/description. */
  keywords?: string[]
}

function defineRows<TIds extends string>(
  rows: { [TId in TIds]: Omit<SettingsRowDef, "id"> }
): { [TId in TIds]: SettingsRowDef } {
  return Object.fromEntries(
    Object.entries<Omit<SettingsRowDef, "id">>(rows).map(([id, row]) => [id, Object.defineProperties({ id }, Object.getOwnPropertyDescriptors(row))])
  ) as { [TId in TIds]: SettingsRowDef }
}

export const SETTINGS_ROWS = defineRows({
  // General
  language: {
    sectionId: "general",
    get title() { return t("Language") },
    get description() { return t("Choose the language used for buttons, menus and notifications. Conversation content is unchanged.") },
    keywords: ["language", "locale", "English", "中文", "语言"],
  },
  applicationUpdate: {
    sectionId: "general",
    get title() { return t("Application Update") },
    get description() { return t("Current version and update status.") },
    keywords: ["version", "upgrade", "latest", "check for updates"],
  },
  theme: {
    sectionId: "general",
    get title() { return t("Theme") },
    get description() { return t("Light, dark, or match the system appearance.") },
    keywords: ["appearance", "dark mode", "light mode"],
  },
  projectIconsInChats: {
    sectionId: "general",
    get title() { return t("Project Icons in Chats") },
    get description() { return t("Lead each chat in the sidebar's Chats view with its project's icon, in place of the agent's.") },
    keywords: ["sidebar", "icon", "favicon", "app icon", "project", "chats", "monogram", "initials"],
  },
  chatTabs: {
    sectionId: "general",
    get title() { return t("Chat Tabs") },
    get description() { return t("Keep the chats you open as tabs in the title bar, to switch between, rearrange and close.") },
    keywords: ["tabs", "tab bar", "title bar", "navbar", "open chats", "switch"],
  },
  widgetsPeek: {
    sectionId: "general",
    get title() { return t("Peek at Widgets") },
    get description() { return t("Show the closed widget column over the chat while the mouse is at the window's right edge.") },
    keywords: ["widgets", "right sidebar", "hover", "edge", "popout", "overlay", "slideover", "peek"],
  },
  chatSounds: {
    sectionId: "general",
    get title() { return t("Chat Sounds") },
    get description() { return t("Play a sound when a chat starts waiting on you or the unread count goes up.") },
    keywords: ["notifications", "audio", "mute"],
  },
  chatSound: {
    sectionId: "general",
    get title() { return t("Sound Effect") },
    get description() { return t("The sound chat notifications play. Picking one plays a preview.") },
    keywords: ["notifications", "audio", "chat sound"],
  },
  chatBrowserNotifications: {
    sectionId: "general",
    get title() { return t("System Notifications") },
    get description() { return t("Show a system notification when a chat starts waiting on you or turns unread.") },
    keywords: ["notifications", "browser", "desktop", "system", "popup", "permission", "chat notifications"],
  },
  submitWhileRunning: {
    sectionId: "general",
    get title() { return t("Enter While Running") },
    get description() { return t("What Enter does while an agent is working. ⌘Enter always does the other one.") },
    keywords: ["queue", "steer", "interrupt", "enter", "send", "composer"],
  },
  widgetsVisibility: {
    sectionId: "general",
    get title() { return t("Widgets Visibility") },
    get description() { return t("Show and hide the widget column for each chat on its own, or once for every chat in the project.") },
    keywords: ["right sidebar", "panel", "widgets", "per chat", "per project", "remember", "layout"],
  },
  terminalVisibility: {
    sectionId: "general",
    get title() { return t("Terminal Visibility") },
    get description() { return t("Show and hide the terminal for each chat on its own, or once for every chat in the project. The terminals themselves belong to the project either way.") },
    keywords: ["terminal", "shell", "panel", "per chat", "per project", "remember", "layout"],
  },
  defaultEditor: {
    sectionId: "general",
    get title() { return t("Default Editor") },
    get description() { return t("Opens transcript links and files from the git diff menu.") },
    keywords: ["cursor", "xcode", "windsurf", "vscode", "command template"],
  },
  newProjectsDirectory: {
    sectionId: "general",
    get title() { return t("New Projects Directory") },
    get description() { return t("Where cloned and newly created projects go.") },
    keywords: ["clone", "create", "folder", "destination", "add project", "path"],
  },
  terminalScrollback: {
    sectionId: "general",
    get title() { return t("Terminal Scrollback") },
    get description() { return t("Lines of history each embedded terminal keeps.") },
  },
  terminalMinColumnWidth: {
    sectionId: "general",
    get title() { return t("Terminal Min Column Width") },
    get description() { return t("Minimum width of each terminal pane.") },
  },
  transcriptWindow: {
    sectionId: "general",
    get title() { return t("Transcript Window") },
    get description() { return t("Assistant messages a chat opens with, and how many each \"load earlier\" adds.") },
    keywords: ["chat", "history", "load earlier", "messages", "performance", "window"],
  },


  // Providers
  defaultProvider: {
    sectionId: "providers",
    get title() { return t("Default Provider") },
    get description() { return t("The harness new chats start with. A chat keeps its provider once a session exists.") },
    keywords: ["harness", "agent"],
  },
  claudeDefaults: {
    sectionId: "providers",
    get title() { return t("Claude Code Defaults") },
    get description() { return t("Defaults for new Claude Code chats.") },
    keywords: ["anthropic", "model"],
  },
  codexDefaults: {
    sectionId: "providers",
    get title() { return t("Codex Defaults") },
    get description() { return t("Defaults for new Codex chats.") },
    keywords: ["openai", "model"],
  },
  cursorDefaults: {
    sectionId: "providers",
    get title() { return t("Cursor Defaults") },
    get description() { return t("Defaults for new Cursor chats.") },
    keywords: ["model"],
  },
  grokDefaults: {
    sectionId: "providers",
    get title() { return t("Grok Build Defaults") },
    get description() { return t("Defaults for new Grok Build chats.") },
    keywords: ["grok", "xai", "model"],
  },
  piDefaults: {
    sectionId: "providers",
    get title() { return t("Pi Defaults") },
    get description() { return t("Defaults for new Pi chats. Pi connects through the Model Registry.") },
    keywords: ["model"],
  },
  modelRegistry: {
    sectionId: "providers",
    get title() { return t("Model Registry") },
    get description() { return t("Model Registry endpoint and API key used by Pi and quick responses.") },
    keywords: ["api key", "base url", "llm provider"],
  },
  defaultModels: {
    sectionId: "providers",
    get title() { return t("Default Models") },
    get description() { return t("Models shown in Pi's model picker, with a display label and the model id sent to the Model Registry endpoint.") },
    keywords: ["fave models", "pi"],
  },

  // Labs
  recentChatsInSidebar: {
    sectionId: "labs",
    get title() { return t("New Sidebar") },
    get description() { return t("Replace the sidebar with a tabbed Chats / Projects view — In Progress, Review, and Recents up top, full projects one tap away.") },
    keywords: ["sidebar", "recents", "chats", "projects", "review", "in progress", "experimental"],
  },
  terminalWebglRenderer: {
    sectionId: "labs",
    get title() { return t("Terminal GPU Rendering") },
    get description() { return t("Draw the embedded terminal with xterm's WebGL renderer instead of the DOM one. Faster with heavy output; falls back to the DOM renderer if the GPU context is unavailable or lost. Reopens open terminals.") },
    keywords: ["terminal", "webgl", "gpu", "renderer", "performance", "acceleration", "experimental"],
  },
})

export function listAllSettingsRowDefs(): SettingsRowDef[] {
  return Object.values<SettingsRowDef>(SETTINGS_ROWS).filter((row) => isSettingsSectionVisible(row.sectionId) && isProductSettingsRowVisible(row.id))
}
