import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { PROVIDERS } from "../../shared/types"
import { isProductActionVisible, isProductPalettePageVisible } from "./productFeatures"
import { listAllSettingsRowDefs, visibleSettingsSections } from "../app/settings/registry"
import { ChatPreferenceControls } from "../components/chat-ui/ChatPreferenceControls"
import { useLocaleStore } from "../stores/localeStore"

describe("Nex ordinary-user surface", () => {
  test("hides developer preferences for every configured harness without invoking callbacks", () => {
    for (const provider of PROVIDERS) {
      let changed = false
      const html = renderToStaticMarkup(<ChatPreferenceControls
        availableProviders={PROVIDERS} selectedProvider={provider.id}
        model={provider.models[0]?.id ?? "default"}
        onProviderChange={() => { changed = true }} onModelChange={() => { changed = true }}
        onModelOptionChange={() => { changed = true }}
      />)
      expect(html).toBe("")
      expect(changed).toBe(false)
    }
  })

  test("settings navigation and search agree in both languages", () => {
    for (const locale of ["en", "zh-CN"] as const) {
      useLocaleStore.getState().setLocale(locale)
      expect(visibleSettingsSections().map(section => section.id)).toEqual(["general", "changelog"])
      const ids = listAllSettingsRowDefs().map(row => row.id)
      expect(ids).toContain("language")
      expect(ids).toContain("theme")
      for (const id of ["anonymousAnalytics", "applicationUpdate", "defaultEditor", "newProjectsDirectory", "terminalVisibility", "terminalScrollback", "terminalMinColumnWidth"]) expect(ids).not.toContain(id)
    }
  })

  test("blocks palette deep links and developer actions but keeps conversation actions", () => {
    for (const page of ["usage", "models", "harness", "open-in", "add-project", "browse", "clone-github", "create-new"]) expect(isProductPalettePageVisible(page)).toBe(false)
    for (const action of ["toggle-terminal", "change-model", "change-harness", "copy-project-path", "set-model-gpt-5.5", "set-harness-codex", "mode-plan", "set-reasoning-high", "set-context-1m", "add-project-create-new"]) expect(isProductActionVisible(action)).toBe(false)
    for (const action of ["attach-files", "share-chat", "archive-chat", "new-thread-current", "toggle-widgets", "settings", "set-theme-dark"]) expect(isProductActionVisible(action)).toBe(true)
    for (const page of ["root", "settings", "new-thread", "project-chats"]) expect(isProductPalettePageVisible(page)).toBe(true)
  })
})
