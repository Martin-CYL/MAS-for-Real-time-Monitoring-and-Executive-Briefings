import { SHOW_DEVELOPER_UI } from "../../config/productFeatures"
import { t } from "../../i18n/translate"
import { useTranslation } from "../../i18n/useTranslation"
import { useEffect, useState } from "react"
import { DownloadCloud } from "lucide-react"
import { useNavigate } from "react-router-dom"
import type { EditorPreset } from "../../../shared/protocol"
import { DEFAULT_NEW_PROJECTS_DIRECTORY, isNightlyVersion, type PaneVisibilityScope, type SubmitWhileRunning } from "../../../shared/types"
import { EDITOR_OPTIONS, EditorIcon } from "../../components/editor-icons"
import { useInstalledEditors } from "../../components/open-external-menu"
import { Input } from "../../components/ui/input"
import { Switch } from "../../components/ui/switch"
import { SelectItem } from "../../components/ui/select"
import { useTheme, type ThemePreference } from "../../hooks/useTheme"
import { cn } from "../../lib/utils"
import { playChatNotificationSound } from "../../lib/chatSounds"
import {
  DEFAULT_TERMINAL_MIN_COLUMN_WIDTH,
  DEFAULT_TERMINAL_SCROLLBACK,
  MAX_TERMINAL_MIN_COLUMN_WIDTH,
  MAX_TERMINAL_SCROLLBACK,
  MIN_TERMINAL_MIN_COLUMN_WIDTH,
  MIN_TERMINAL_SCROLLBACK,
  getDefaultEditorCommandTemplate,
  useTerminalPreferencesStore,
} from "../../stores/terminalPreferencesStore"
import {
  CHAT_SOUND_OPTIONS,
  useChatSoundPreferencesStore,
  type ChatBrowserNotificationPreference,
  type ChatSoundId,
  type ChatSoundPreference,
} from "../../stores/chatSoundPreferencesStore"
import { requestChatBrowserNotificationPermission } from "../../lib/chatBrowserNotifications"
import {
  DEFAULT_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES,
  MAX_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES,
  MIN_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES,
} from "../../../shared/transcript-window"
import type { NexState } from "../useNexState"
import {
  handleSettingsInputKeyDown,
  resolveChatBrowserNotificationPreferenceAfterPermission,
  SETTINGS_CONTROL_CLASS,
  SETTINGS_INLINE_ACTION_CLASS,
  SETTINGS_NUMBER_INPUT_CLASS,
  SettingsErrorBanner,
  SettingsField,
  SettingsGroup,
  SettingsActionButton,
  SettingsGroups,
  SettingsRow,
  SettingsSelect,
  shouldPreviewChatSoundChange,
} from "./shared"
import { SETTINGS_ROWS } from "./registry"

const themeOptions: { value: ThemePreference; label: string }[] = [
  { value: "light", get label() { return t("Light") } },
  { value: "dark", get label() { return t("Dark") } },
  { value: "system", get label() { return t("System") } },
]

const chatSoundPreferenceOptions: { value: ChatSoundPreference; label: string }[] = [
  { value: "never", get label() { return t("Never") } },
  { value: "unfocused", get label() { return t("When Unfocused") } },
  { value: "always", get label() { return t("Always") } },
]

const paneVisibilityScopeOptions: { value: PaneVisibilityScope; label: string }[] = [
  { value: "chat", get label() { return t("Per Chat") } },
  { value: "project", get label() { return t("Per Project") } },
]

const chatBrowserNotificationPreferenceOptions: { value: ChatBrowserNotificationPreference; label: string }[] = [
  { value: "never", get label() { return t("Never") } },
  { value: "unfocused", get label() { return t("When Unfocused") } },
  { value: "always", get label() { return t("Always") } },
]

export function GeneralSection({
  state,
  appVersion,
}: {
  state: Pick<
    NexState,
    "updateSnapshot" | "appSettings" | "handleWriteAppSettings" | "handleCheckForUpdates" | "handleInstallUpdate"
  >
  appVersion: string
}) {
  const { locale, setLocale } = useTranslation()
  const navigate = useNavigate()
  const { theme, setTheme } = useTheme()
  const appSettings = state.appSettings
  const updateSnapshot = state.updateSnapshot
  const handleWriteAppSettings = state.handleWriteAppSettings

  const scrollbackLines = useTerminalPreferencesStore((store) => store.scrollbackLines)
  const minColumnWidth = useTerminalPreferencesStore((store) => store.minColumnWidth)
  const editorPreset = useTerminalPreferencesStore((store) => store.editorPreset)
  const installedEditors = useInstalledEditors()
  const editorCommandTemplate = useTerminalPreferencesStore((store) => store.editorCommandTemplate)
  const setScrollbackLines = useTerminalPreferencesStore((store) => store.setScrollbackLines)
  const setMinColumnWidth = useTerminalPreferencesStore((store) => store.setMinColumnWidth)
  const setEditorPreset = useTerminalPreferencesStore((store) => store.setEditorPreset)
  const setEditorCommandTemplate = useTerminalPreferencesStore((store) => store.setEditorCommandTemplate)
  const chatSoundPreference = useChatSoundPreferencesStore((store) => store.chatSoundPreference)
  const chatSoundId = useChatSoundPreferencesStore((store) => store.chatSoundId)
  const setChatSoundPreference = useChatSoundPreferencesStore((store) => store.setChatSoundPreference)
  const setChatSoundId = useChatSoundPreferencesStore((store) => store.setChatSoundId)
  const chatBrowserNotificationPreference = useChatSoundPreferencesStore((store) => store.chatBrowserNotificationPreference)
  const setChatBrowserNotificationPreference = useChatSoundPreferencesStore((store) => store.setChatBrowserNotificationPreference)

  const [scrollbackDraft, setScrollbackDraft] = useState(String(scrollbackLines))
  const [minColumnWidthDraft, setMinColumnWidthDraft] = useState(String(minColumnWidth))
  const [editorCommandDraft, setEditorCommandDraft] = useState(editorCommandTemplate)
  const newProjectsDirectory = appSettings?.newProjectsDirectory ?? DEFAULT_NEW_PROJECTS_DIRECTORY
  const [newProjectsDirectoryDraft, setNewProjectsDirectoryDraft] = useState(newProjectsDirectory)
  const submitWhileRunning = appSettings?.submitWhileRunning ?? "queue"
  const paneVisibility = appSettings?.paneVisibility ?? { widgets: "chat", terminal: "chat" }
  const transcriptWindow = appSettings?.transcript?.windowAssistantMessages ?? DEFAULT_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES
  const [transcriptWindowDraft, setTranscriptWindowDraft] = useState(String(transcriptWindow))
  const [appSettingsError, setAppSettingsError] = useState<string | null>(null)

  const updateStatusLabel = updateSnapshot?.status === "checking"
    ? t("Checking for updates…")
    : updateSnapshot?.status === "updating"
      ? t("Installing update…")
      : updateSnapshot?.status === "restart_pending"
        ? t("Restarting Nex…")
        : updateSnapshot?.status === "available"
          ? t("Update available{0}", { 0: updateSnapshot.latestVersion ? `: ${updateSnapshot.latestVersion}` : "" })
          : updateSnapshot?.status === "up_to_date"
            ? isNightlyVersion(updateSnapshot.currentVersion) ? t("No newer stable release") : t("Up to date")
            : updateSnapshot?.status === "error"
              ? t("Update check failed")
              : t("Not checked yet")

  useEffect(() => {
    setScrollbackDraft(String(scrollbackLines))
  }, [scrollbackLines])

  useEffect(() => {
    setMinColumnWidthDraft(String(minColumnWidth))
  }, [minColumnWidth])

  useEffect(() => {
    setEditorCommandDraft(editorCommandTemplate)
  }, [editorCommandTemplate])

  useEffect(() => {
    setNewProjectsDirectoryDraft(newProjectsDirectory)
  }, [newProjectsDirectory])

  useEffect(() => {
    setTranscriptWindowDraft(String(transcriptWindow))
  }, [transcriptWindow])

  function commitTranscriptWindow() {
    const nextValue = Math.round(Number(transcriptWindowDraft))
    if (!Number.isFinite(nextValue)) {
      setTranscriptWindowDraft(String(transcriptWindow))
      return
    }
    void handleWriteAppSettings({ transcript: { windowAssistantMessages: nextValue } }).catch((error) => {
      setAppSettingsError(error instanceof Error ? error.message : "Unable to save transcript settings.")
    })
  }

  function commitScrollback() {
    const nextValue = Number(scrollbackDraft)
    if (!Number.isFinite(nextValue)) {
      setScrollbackDraft(String(scrollbackLines))
      return
    }
    setScrollbackLines(nextValue)
    void handleWriteAppSettings({ terminal: { scrollbackLines: nextValue } }).catch((error) => {
      setAppSettingsError(error instanceof Error ? error.message : "Unable to save terminal settings.")
    })
  }

  function commitMinColumnWidth() {
    const nextValue = Number(minColumnWidthDraft)
    if (!Number.isFinite(nextValue)) {
      setMinColumnWidthDraft(String(minColumnWidth))
      return
    }
    setMinColumnWidth(nextValue)
    void handleWriteAppSettings({ terminal: { minColumnWidth: nextValue } }).catch((error) => {
      setAppSettingsError(error instanceof Error ? error.message : "Unable to save terminal settings.")
    })
  }

  function commitEditorCommand() {
    setEditorCommandTemplate(editorCommandDraft)
    void handleWriteAppSettings({ editor: { commandTemplate: editorCommandDraft } }).catch((error) => {
      setAppSettingsError(error instanceof Error ? error.message : "Unable to save editor settings.")
    })
  }

  function commitNewProjectsDirectory() {
    const trimmed = newProjectsDirectoryDraft.trim()
    if (trimmed === newProjectsDirectory) {
      setNewProjectsDirectoryDraft(newProjectsDirectory)
      return
    }
    // The server normalizes an empty value back to the default; the snapshot
    // round-trips into the draft via the effect above.
    void handleWriteAppSettings({ newProjectsDirectory: trimmed || DEFAULT_NEW_PROJECTS_DIRECTORY }).catch((error) => {
      setAppSettingsError(error instanceof Error ? error.message : "Unable to save the new projects directory.")
    })
  }

  function handleThemeChange(nextTheme: typeof theme) {
    setTheme(nextTheme)
    void handleWriteAppSettings({ theme: nextTheme }).catch((error) => {
      setAppSettingsError(error instanceof Error ? error.message : "Unable to save theme settings.")
    })
  }

  function handleEditorPresetChange(nextPreset: EditorPreset) {
    setEditorPreset(nextPreset)
    const commandTemplate = nextPreset === "custom" ? editorCommandTemplate : getDefaultEditorCommandTemplate(nextPreset)
    void handleWriteAppSettings({
      editor: {
        preset: nextPreset,
        commandTemplate,
      },
    }).catch((error) => {
      setAppSettingsError(error instanceof Error ? error.message : "Unable to save editor settings.")
    })
  }

  function handleChatSoundPreferenceChange(nextValue: ChatSoundPreference) {
    if (!shouldPreviewChatSoundChange(chatSoundPreference, nextValue)) {
      return
    }

    setChatSoundPreference(nextValue)
    void handleWriteAppSettings({ chatSoundPreference: nextValue }).catch((error) => {
      setAppSettingsError(error instanceof Error ? error.message : "Unable to save chat sound settings.")
    })
    void playChatNotificationSound(chatSoundId, 1).catch(() => undefined)
  }

  function handleChatSoundIdChange(nextValue: ChatSoundId) {
    if (!shouldPreviewChatSoundChange(chatSoundId, nextValue)) {
      return
    }

    setChatSoundId(nextValue)
    void handleWriteAppSettings({ chatSoundId: nextValue }).catch((error) => {
      setAppSettingsError(error instanceof Error ? error.message : "Unable to save chat sound settings.")
    })
    void playChatNotificationSound(nextValue, 1).catch(() => undefined)
  }

  function handleChatBrowserNotificationPreferenceChange(nextValue: ChatBrowserNotificationPreference) {
    if (chatBrowserNotificationPreference === nextValue) {
      return
    }

    // The permission prompt is the browser's, and it only appears here, on the
    // user's own click. A denied or unsupported prompt drops the setting back
    // to Never rather than saving an option that would never fire.
    void (async () => {
      try {
        const permission = nextValue === "never" ? "granted" : await requestChatBrowserNotificationPermission()
        const resolvedPreference = resolveChatBrowserNotificationPreferenceAfterPermission(nextValue, permission)
        setChatBrowserNotificationPreference(resolvedPreference)
        await handleWriteAppSettings({ chatBrowserNotificationPreference: resolvedPreference })
        if (nextValue !== "never" && resolvedPreference === "never") {
          setAppSettingsError("Browser notifications are blocked or unsupported in this browser.")
        }
      } catch (error) {
        setAppSettingsError(error instanceof Error ? error.message : "Unable to save chat notification settings.")
      }
    })()
  }

  function handlePaneVisibilityChange(pane: "widgets" | "terminal", scope: PaneVisibilityScope) {
    void handleWriteAppSettings({ paneVisibility: { [pane]: scope } }).catch((error) => {
      setAppSettingsError(error instanceof Error ? error.message : "Unable to save layout settings.")
    })
  }

  async function handleProjectIconsInChatsChange(enabled: boolean) {
    try {
      setAppSettingsError(null)
      await handleWriteAppSettings({ projectIconsInChats: enabled })
    } catch (error) {
      setAppSettingsError(error instanceof Error ? error.message : "Unable to save appearance settings.")
    }
  }

  async function handleChatTabsChange(enabled: boolean) {
    try {
      setAppSettingsError(null)
      await handleWriteAppSettings({ chatTabsEnabled: enabled })
    } catch (error) {
      setAppSettingsError(error instanceof Error ? error.message : "Unable to save appearance settings.")
    }
  }

  async function handleWidgetsPeekChange(enabled: boolean) {
    try {
      setAppSettingsError(null)
      await handleWriteAppSettings({ widgetsPeekEnabled: enabled })
    } catch (error) {
      setAppSettingsError(error instanceof Error ? error.message : "Unable to save appearance settings.")
    }
  }

  const customEditorPreview = editorCommandDraft
    .replaceAll("{path}", "/Users/jake/Projects/nex/src/client/app/App.tsx")
    .replaceAll("{line}", "12")
    .replaceAll("{column}", "1")

  const isCheckingForUpdate = updateSnapshot?.status === "checking"
  const isInstallingUpdate = updateSnapshot?.status === "updating" || updateSnapshot?.status === "restart_pending"
  const currentVersionLabel = updateSnapshot?.currentVersion ?? appVersion

  return (
    <>
      {appSettingsError ? <SettingsErrorBanner message={appSettingsError} /> : null}
      <SettingsGroups>
        <SettingsGroup>
          <SettingsRow def={SETTINGS_ROWS.language}>
            <SettingsSelect
              value={locale}
              onValueChange={(value) => setLocale(value === "en" ? "en" : "zh-CN")}
              aria-label="界面语言 / Language"
            >
              <SelectItem value="zh-CN">简体中文</SelectItem>
              <SelectItem value="en">English</SelectItem>
            </SettingsSelect>
          </SettingsRow>
        </SettingsGroup>
        {SHOW_DEVELOPER_UI && (<SettingsGroup>
          <SettingsRow
            def={SETTINGS_ROWS.applicationUpdate}
            description={(
              <>
                <span>Nex {currentVersionLabel}. {t(updateStatusLabel)}.</span>
                {updateSnapshot?.lastCheckedAt ? (
                  <span>{" " + t("Last checked") + " "}{new Intl.DateTimeFormat(locale, {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  }).format(updateSnapshot.lastCheckedAt)}.</span>
                ) : null}
                {updateSnapshot?.error ? (
                  <span> {updateSnapshot.error}</span>
                ) : null}
                {" "}
                <button
                  type="button"
                  onClick={() => navigate("/settings/changelog")}
                  className={SETTINGS_INLINE_ACTION_CLASS}
                >
                  {t("Changelog")}</button>
              </>
            )}
          >
            {updateSnapshot?.updateAvailable ? (
              <SettingsActionButton
                prominent
                onClick={() => { void state.handleInstallUpdate() }}
                disabled={isInstallingUpdate}
                icon={<DownloadCloud />}
              >
                {isInstallingUpdate ? t("Updating…") : t("Update to {0}", { 0: updateSnapshot.latestVersion ?? "latest" })}
              </SettingsActionButton>
            ) : (
              <SettingsActionButton
                onClick={() => { void state.handleCheckForUpdates({ force: true }) }}
                disabled={isCheckingForUpdate || isInstallingUpdate}
              >
                {isCheckingForUpdate ? t("Checking…") : t("Check for updates")}
              </SettingsActionButton>
            )}
          </SettingsRow>
        </SettingsGroup>)}

        <SettingsGroup title={t("Appearance")}>
          <SettingsRow def={SETTINGS_ROWS.theme}>
            <SettingsSelect value={theme} onValueChange={(value) => handleThemeChange(value as ThemePreference)}>
              {themeOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SettingsSelect>
          </SettingsRow>
          <SettingsRow def={SETTINGS_ROWS.projectIconsInChats}>
            <Switch
              checked={appSettings?.projectIconsInChats !== false}
              onCheckedChange={(checked) => {
                void handleProjectIconsInChatsChange(checked)
              }}
              aria-label={SETTINGS_ROWS.projectIconsInChats.title}
            />
          </SettingsRow>
          <SettingsRow def={SETTINGS_ROWS.chatTabs}>
            <Switch
              checked={appSettings?.chatTabsEnabled === true}
              onCheckedChange={(checked) => {
                void handleChatTabsChange(checked)
              }}
              aria-label={SETTINGS_ROWS.chatTabs.title}
            />
          </SettingsRow>
          <SettingsRow def={SETTINGS_ROWS.widgetsPeek}>
            <Switch
              checked={appSettings?.widgetsPeekEnabled === true}
              onCheckedChange={(checked) => {
                void handleWidgetsPeekChange(checked)
              }}
              aria-label={SETTINGS_ROWS.widgetsPeek.title}
            />
          </SettingsRow>
        </SettingsGroup>

        <SettingsGroup title={t("Notifications")}>
          <SettingsRow def={SETTINGS_ROWS.chatSounds}>
            <SettingsSelect
              value={chatSoundPreference}
              onValueChange={(value) => handleChatSoundPreferenceChange(value as ChatSoundPreference)}
            >
              {chatSoundPreferenceOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SettingsSelect>
          </SettingsRow>

          <SettingsRow def={SETTINGS_ROWS.chatSound}>
            {/* Which sound only matters while sounds can play at all. */}
            <SettingsSelect
              value={chatSoundId}
              onValueChange={(value) => handleChatSoundIdChange(value as ChatSoundId)}
              disabled={chatSoundPreference === "never"}
            >
              {CHAT_SOUND_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SettingsSelect>
          </SettingsRow>

          <SettingsRow def={SETTINGS_ROWS.chatBrowserNotifications}>
            <SettingsSelect
              value={chatBrowserNotificationPreference}
              onValueChange={(value) => handleChatBrowserNotificationPreferenceChange(value as ChatBrowserNotificationPreference)}
            >
              {chatBrowserNotificationPreferenceOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SettingsSelect>
          </SettingsRow>
        </SettingsGroup>

        <SettingsGroup title={t("Chats")}>
          <SettingsRow def={SETTINGS_ROWS.submitWhileRunning}>
            <SettingsSelect
              value={submitWhileRunning}
              onValueChange={(value) => {
                void handleWriteAppSettings({ submitWhileRunning: value as SubmitWhileRunning }).catch((error) => {
                  setAppSettingsError(error instanceof Error ? error.message : "Unable to save composer settings.")
                })
              }}
            >
              <SelectItem value="queue">{t("Queue message")}</SelectItem>
              <SelectItem value="steer">{t("Steer now")}</SelectItem>
            </SettingsSelect>
          </SettingsRow>

          <SettingsRow def={SETTINGS_ROWS.transcriptWindow} wideControl>
            <SettingsField
              hint={t("{0}–{1} messages{2}", { 0: MIN_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES, 1: MAX_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES, 2: transcriptWindow === DEFAULT_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES ? t(" (default)") : "" })}
            >
              <Input
                type="number"
                min={MIN_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES}
                max={MAX_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES}
                step={5}
                value={transcriptWindowDraft}
                onChange={(event) => setTranscriptWindowDraft(event.target.value)}
                onBlur={commitTranscriptWindow}
                onKeyDown={(event) => handleSettingsInputKeyDown(event, commitTranscriptWindow)}
                className={SETTINGS_NUMBER_INPUT_CLASS}
              />
            </SettingsField>
          </SettingsRow>
        </SettingsGroup>

        <SettingsGroup title={t("Layout")}>
          {([
            ["widgets", SETTINGS_ROWS.widgetsVisibility],
            ["terminal", SETTINGS_ROWS.terminalVisibility],
          ] as const).filter(([pane]) => SHOW_DEVELOPER_UI || pane !== "terminal").map(([pane, def]) => (
            <SettingsRow key={pane} def={def}>
              <SettingsSelect
                value={paneVisibility[pane]}
                onValueChange={(value) => handlePaneVisibilityChange(pane, value as PaneVisibilityScope)}
              >
                {paneVisibilityScopeOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SettingsSelect>
            </SettingsRow>
          ))}
        </SettingsGroup>

        {SHOW_DEVELOPER_UI && (<SettingsGroup title={t("Editor & Projects")}>
          <SettingsRow def={SETTINGS_ROWS.defaultEditor}>
            <SettingsSelect
              value={editorPreset}
              onValueChange={(value) => handleEditorPresetChange(value as EditorPreset)}
            >
              {EDITOR_OPTIONS.map((option) => {
                // Listed but not selectable when it isn't on this machine —
                // picking it would only make every "Open in" fail later.
                const installed = !installedEditors || option.value === "custom" || installedEditors.includes(option.value)
                return (
                  <SelectItem key={option.value} value={option.value} disabled={!installed}>
                    <span className="flex items-center gap-2">
                      <EditorIcon preset={option.value} className={`h-4 w-4 shrink-0${installed ? "" : " opacity-40 grayscale"}`} />
                      <span className={installed ? undefined : "text-muted-foreground"}>{option.label}</span>
                      {installed ? null : (
                        <span className="ml-auto shrink-0 rounded-full border border-border/70 px-1.5 py-px text-[10px] leading-4 font-medium text-muted-foreground">
                          {t("Not installed")}</span>
                      )}
                    </span>
                  </SelectItem>
                )
              })}
            </SettingsSelect>
          </SettingsRow>

          {editorPreset === "custom" ? (
            <SettingsRow
              nested
              wideControl
              title={t("Command Template")}
              description={<>{t("Include") + " "}{"{path}"}{" " + t("and optionally") + " "}{"{line}"}{" " + t("and") + " "}{"{column}"}{" " + t("in your command.")}</>}
            >
              <SettingsField hint={<>{t("Preview:") + " "}<span className="font-mono">{customEditorPreview}</span></>}>
                <Input
                  type="text"
                  value={editorCommandDraft}
                  onChange={(event) => setEditorCommandDraft(event.target.value)}
                  onBlur={commitEditorCommand}
                  onKeyDown={(event) => handleSettingsInputKeyDown(event, commitEditorCommand)}
                  spellCheck={false}
                  autoComplete="off"
                  className={cn(SETTINGS_CONTROL_CLASS, "font-mono @2xl:w-80")}
                />
              </SettingsField>
            </SettingsRow>
          ) : null}

          <SettingsRow def={SETTINGS_ROWS.newProjectsDirectory} wideControl>
            <SettingsField
              hint={t("Created on first use{0}", { 0: newProjectsDirectory === DEFAULT_NEW_PROJECTS_DIRECTORY ? t(" (default)") : "" })}
            >
              <Input
                type="text"
                value={newProjectsDirectoryDraft}
                onChange={(event) => setNewProjectsDirectoryDraft(event.target.value)}
                onBlur={commitNewProjectsDirectory}
                onKeyDown={(event) => handleSettingsInputKeyDown(event, commitNewProjectsDirectory)}
                spellCheck={false}
                autoComplete="off"
                className={cn(SETTINGS_CONTROL_CLASS, "font-mono")}
              />
            </SettingsField>
          </SettingsRow>
        </SettingsGroup>)}

        {SHOW_DEVELOPER_UI && (<SettingsGroup title={t("Terminal")}>
          <SettingsRow def={SETTINGS_ROWS.terminalScrollback} wideControl>
            <SettingsField
              hint={t("{0}–{1} lines{2}", { 0: MIN_TERMINAL_SCROLLBACK, 1: MAX_TERMINAL_SCROLLBACK, 2: scrollbackLines === DEFAULT_TERMINAL_SCROLLBACK ? t(" (default)") : "" })}
            >
              <Input
                type="number"
                min={MIN_TERMINAL_SCROLLBACK}
                max={MAX_TERMINAL_SCROLLBACK}
                step={100}
                value={scrollbackDraft}
                onChange={(event) => setScrollbackDraft(event.target.value)}
                onBlur={commitScrollback}
                onKeyDown={(event) => handleSettingsInputKeyDown(event, commitScrollback)}
                className={SETTINGS_NUMBER_INPUT_CLASS}
              />
            </SettingsField>
          </SettingsRow>

          <SettingsRow def={SETTINGS_ROWS.terminalMinColumnWidth} wideControl>
            <SettingsField
              hint={`${MIN_TERMINAL_MIN_COLUMN_WIDTH}–${MAX_TERMINAL_MIN_COLUMN_WIDTH} px${minColumnWidth === DEFAULT_TERMINAL_MIN_COLUMN_WIDTH ? t(" (default)") : ""}`}
            >
              <Input
                type="number"
                min={MIN_TERMINAL_MIN_COLUMN_WIDTH}
                max={MAX_TERMINAL_MIN_COLUMN_WIDTH}
                step={10}
                value={minColumnWidthDraft}
                onChange={(event) => setMinColumnWidthDraft(event.target.value)}
                onBlur={commitMinColumnWidth}
                onKeyDown={(event) => handleSettingsInputKeyDown(event, commitMinColumnWidth)}
                className={SETTINGS_NUMBER_INPUT_CLASS}
              />
            </SettingsField>
          </SettingsRow>
        </SettingsGroup>)}

      </SettingsGroups>
    </>
  )
}
