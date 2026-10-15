import { afterEach, describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { en } from "./en"
import { zhCN } from "./zh-CN"
import { translate } from "./translate"
import { DEFAULT_LOCALE, LOCALE_STORAGE_KEY, handleLocaleStorage, normalizeLocale, useLocaleStore } from "../stores/localeStore"
import { ProcessingMessage } from "../components/messages/ProcessingMessage"
import { createChatBrowserNotificationPayload } from "../lib/chatBrowserNotifications"
import { formatSidebarAgeLabel } from "../lib/formatters"
import { SETTINGS_ROWS, SETTINGS_SECTIONS } from "../app/settings/registry"

afterEach(() => useLocaleStore.setState({ locale: "en" }))

describe("Nex locale", () => {
  test("English default preserves valid saved preferences", () => {
    expect(DEFAULT_LOCALE).toBe("en")
    expect(normalizeLocale(null)).toBe("en")
    expect(normalizeLocale("unsupported")).toBe("en")
    expect(normalizeLocale("en")).toBe("en")
    expect(normalizeLocale("zh-CN")).toBe("zh-CN")
  })
  test("catalogues have matching keys and translated placeholders reference valid arguments", () => {
    expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort())
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      const params = new Set(en[key].match(/\{\w+\}/g) ?? [])
      for (const token of zhCN[key].match(/\{\w+\}/g) ?? []) expect(params.has(token)).toBe(true)
      expect(zhCN[key].length).toBeGreaterThan(0)
    }
  })
  test("interpolation preserves user-provided names and raw values", () => {
    expect(translate('Delete "{0}"? This cannot be undone.', "zh-CN", { 0: "Search" })).toBe('删除“Search”？此操作无法撤销。')
    expect(translate("{0} message{1}", "en", {0: 1, 1: ""})).toBe("1 message")
    expect(translate("{0} message{1}", "en", {0: 2, 1: "s"})).toBe("2 messages")
    expect(translate("{0} message{1}", "zh-CN", {0: 2, 1: "s"})).toBe("2 条消息")
    expect(translate("unrecognised diagnostic", "zh-CN")).toBe("unrecognised diagnostic")
  })
  test("language changes update static registry entries and live status labels", () => {
    useLocaleStore.getState().setLocale("zh-CN")
    expect(SETTINGS_ROWS.language.title).toBe("界面语言")
    expect(SETTINGS_SECTIONS[0].label).toBe("通用")
    expect(renderToStaticMarkup(<ProcessingMessage status="running" />)).toContain("正在运行")
    useLocaleStore.getState().setLocale("en")
    expect(SETTINGS_ROWS.language.title).toBe("Language")
    expect(SETTINGS_SECTIONS[0].label).toBe("General")
    expect(renderToStaticMarkup(<ProcessingMessage status="running" />)).toContain("Running...")
  })
  test("notifications translate the fallback but do not translate message content or titles", () => {
    useLocaleStore.getState().setLocale("zh-CN")
    expect(createChatBrowserNotificationPayload({ projectTitle: "Search", chatTitle: "Settings", message: "Cancel" })).toEqual({title: "Search - Settings", body: "Cancel"})
    expect(createChatBrowserNotificationPayload({ projectTitle: "P", chatTitle: "C", message: "" }).body).toBe("对话有新动态。")
    expect(formatSidebarAgeLabel(0, 300_000)).toBe("5分钟前")
  })
  test("storage events sync preferences without overwriting unrelated settings", () => {
    useLocaleStore.setState({ locale: "en" })
    handleLocaleStorage({key:"other",newValue:"zh-CN"})
    expect(useLocaleStore.getState().locale).toBe("en")
    handleLocaleStorage({key:LOCALE_STORAGE_KEY,newValue:"zh-CN"})
    expect(useLocaleStore.getState().locale).toBe("zh-CN")
    handleLocaleStorage({key:LOCALE_STORAGE_KEY,newValue:"en"})
    expect(useLocaleStore.getState().locale).toBe("en")
    handleLocaleStorage({key:null,newValue:null})
    expect(useLocaleStore.getState().locale).toBe("en")
  })
})
