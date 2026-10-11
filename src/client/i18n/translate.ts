import { en } from "./en"
import { zhCN } from "./zh-CN"
import type { Locale, MessageKey, TranslationParams } from "./types"
import { useLocaleStore } from "../stores/localeStore"

/** Only call at application-owned UI boundaries, never on conversation/file content. */
export function translate(key: string, locale: Locale, params: TranslationParams = {}): string {
  const dictionary = locale === "zh-CN" ? zhCN : en
  const message = Object.prototype.hasOwnProperty.call(dictionary, key) ? dictionary[key as MessageKey] : key
  return message.replace(/\{(\w+)\}/g, (original, name: string) => String(params[name] ?? original))
}
/** Source-text message IDs also allow unrecognised diagnostic details to pass through. */
export function t(key: string, params?: TranslationParams): string {
  return translate(key, useLocaleStore.getState().locale, params)
}
export function getLocale(): Locale { return useLocaleStore.getState().locale }
