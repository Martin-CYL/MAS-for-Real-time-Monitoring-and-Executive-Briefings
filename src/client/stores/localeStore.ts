import { create } from "zustand"
import type { Locale } from "../i18n/types"

export const LOCALE_STORAGE_KEY = "nex.locale"
export const DEFAULT_LOCALE: Locale = "zh-CN"
export function normalizeLocale(value: unknown): Locale {
  return value === "en" ? "en" : DEFAULT_LOCALE
}
function readLocale(): Locale {
  try {
    return normalizeLocale(typeof window === "undefined" ? null : window.localStorage.getItem(LOCALE_STORAGE_KEY))
  } catch {
    return DEFAULT_LOCALE
  }
}
function syncDocument(locale: Locale) {
  if (typeof document !== "undefined") document.documentElement.lang = locale
}
export const useLocaleStore = create<{ locale: Locale; setLocale: (locale: Locale) => void }>((set) => ({
  locale: readLocale(),
  setLocale: (value) => {
    const locale = normalizeLocale(value)
    try {
      if (typeof window !== "undefined") window.localStorage.setItem(LOCALE_STORAGE_KEY, locale)
    } catch { /* Storage can be disabled; in-memory switching still works. */ }
    syncDocument(locale)
    set({ locale })
  },
}))
// Apply before first React render; language changes never remount the app.
syncDocument(useLocaleStore.getState().locale)
export function handleLocaleStorage(event: Pick<StorageEvent, "key" | "newValue">) {
  if (event.key !== LOCALE_STORAGE_KEY && event.key !== null) return
  const locale = normalizeLocale(event.newValue)
  useLocaleStore.setState({ locale })
  syncDocument(locale)
}
if (typeof window !== "undefined") {
  window.addEventListener("storage", handleLocaleStorage)
  if (import.meta.hot) import.meta.hot.dispose(() => window.removeEventListener("storage", handleLocaleStorage))
}
