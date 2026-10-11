import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { RefreshCw } from "lucide-react"
import { getKeybindingsSubtitle, resolveChatBrowserNotificationPreferenceAfterPermission, resolveSettingsSectionId, shouldPreviewChatSoundChange, SkillsSection } from "./SettingsPage"
import { SettingsActionButton } from "./settings/shared"
describe("resolveSettingsSectionId", () => {
  test("accepts General and rejects developer settings links", () => {
    expect(resolveSettingsSectionId("general")).toBe("general")
    expect(resolveSettingsSectionId("providers")).toBeNull()
    expect(resolveSettingsSectionId("changelog")).toBe("changelog")
    expect(resolveSettingsSectionId("keybindings")).toBeNull()
    expect(resolveSettingsSectionId("skills")).toBeNull()
  })

  test("rejects unknown settings sections", () => {
    expect(resolveSettingsSectionId("page-1")).toBeNull()
    expect(resolveSettingsSectionId("page-2")).toBeNull()
    expect(resolveSettingsSectionId("page-3")).toBeNull()
    expect(resolveSettingsSectionId("nope")).toBeNull()
    expect(resolveSettingsSectionId(undefined)).toBeNull()
  })

  test("This Mac exists only in Nex for Mac", () => {
    expect(resolveSettingsSectionId("mac")).toBeNull()
  })
})

describe("SkillsSection", () => {
  test("renders the skills.sh search box and installed section", () => {
    const html = renderToStaticMarkup(
      <SkillsSection
        state={{
          connectionStatus: "connected",
          socket: {
            command: async () => ({ skills: [] }),
          } as never,
        }}
      />
    )

    expect(html).toContain("No global skills installed yet")
    expect(html).toContain("Add skills from skills.sh")
    expect(html).toContain("searchbox")
  })
})

describe("getKeybindingsSubtitle", () => {
  test("renders the active keybindings path", () => {
    expect(getKeybindingsSubtitle("~/.nex-dev/keybindings.json")).toBe(
      "Edit global app shortcuts stored in ~/.nex-dev/keybindings.json."
    )
  })
})

describe("shouldPreviewChatSoundChange", () => {
  test("previews only when the selected value actually changes", () => {
    expect(shouldPreviewChatSoundChange("always", "always")).toBe(false)
    expect(shouldPreviewChatSoundChange("always", "never")).toBe(true)
    expect(shouldPreviewChatSoundChange("never", "unfocused")).toBe(true)
    expect(shouldPreviewChatSoundChange("funk", "glass")).toBe(true)
  })
})

describe("resolveChatBrowserNotificationPreferenceAfterPermission", () => {
  test("keeps enabled browser notification preferences only after permission is granted", () => {
    expect(resolveChatBrowserNotificationPreferenceAfterPermission("always", "granted")).toBe("always")
    expect(resolveChatBrowserNotificationPreferenceAfterPermission("unfocused", "granted")).toBe("unfocused")
  })

  test("falls back to never when browser notifications cannot be used", () => {
    expect(resolveChatBrowserNotificationPreferenceAfterPermission("always", "denied")).toBe("never")
    expect(resolveChatBrowserNotificationPreferenceAfterPermission("unfocused", "unsupported")).toBe("never")
    expect(resolveChatBrowserNotificationPreferenceAfterPermission("always", "default")).toBe("never")
  })

  test("keeps never without requiring browser permission", () => {
    expect(resolveChatBrowserNotificationPreferenceAfterPermission("never", "denied")).toBe("never")
  })
})

describe("SettingsActionButton", () => {
  test("renders the label and icon as plain text, with no box", () => {
    const html = renderToStaticMarkup(
      <SettingsActionButton icon={<RefreshCw />}>
        Check for updates
      </SettingsActionButton>
    )

    expect(html).toContain("Check for updates")
    expect(html).toContain("lucide-refresh-cw")
    expect(html).toContain("text-foreground")
    expect(html).not.toContain("border")
    expect(html).not.toContain("bg-")
  })

  test("tints the prominent action with the brand colour", () => {
    const html = renderToStaticMarkup(
      <SettingsActionButton prominent>
        Update
      </SettingsActionButton>
    )

    expect(html).toContain("Update")
    expect(html).toContain("text-logo")
  })
})
