import { useLocale } from "../../i18n/useTranslation"
import { useState } from "react"
import { Switch } from "../../components/ui/switch"
import type { NexState } from "../useNexState"
import { SETTINGS_ROWS } from "./registry"
import { SettingsErrorBanner, SettingsGroup, SettingsRow } from "./shared"

export function LabsSection({
  state,
  appVersion,
}: {
  state: Pick<
    NexState,
    | "appSettings"
    | "handleWriteAppSettings"
    | "updateSnapshot"
    | "handleInstallNightly"
    | "handleInstallStable"
    | "handleCheckForUpdates"
  >
  appVersion: string
}) {
  useLocale()
  const { appSettings, handleWriteAppSettings } = state
  const [error, setError] = useState<string | null>(null)

  async function handleRecentChatsChange(enabled: boolean) {
    try {
      setError(null)
      await handleWriteAppSettings({ newSidebarEnabled: enabled })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to save Labs settings.")
    }
  }

  async function handleWebglRendererChange(enabled: boolean) {
    try {
      setError(null)
      await handleWriteAppSettings({ terminal: { webglRenderer: enabled } })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to save Labs settings.")
    }
  }

  const newSidebarEnabled = appSettings?.newSidebarEnabled !== false
  const webglRendererEnabled = appSettings?.terminal.webglRenderer === true

  return (
    <>
      {error ? <SettingsErrorBanner message={error} /> : null}
      <SettingsGroup>

        <SettingsRow def={SETTINGS_ROWS.recentChatsInSidebar}>
          <Switch
            checked={newSidebarEnabled}
            onCheckedChange={(checked) => {
              void handleRecentChatsChange(checked)
            }}
            aria-label={SETTINGS_ROWS.recentChatsInSidebar.title}
          />
        </SettingsRow>
        <SettingsRow def={SETTINGS_ROWS.terminalWebglRenderer}>
          <Switch
            checked={webglRendererEnabled}
            onCheckedChange={(checked) => {
              void handleWebglRendererChange(checked)
            }}
            aria-label={SETTINGS_ROWS.terminalWebglRenderer.title}
          />
        </SettingsRow>
      </SettingsGroup>
    </>
  )
}
