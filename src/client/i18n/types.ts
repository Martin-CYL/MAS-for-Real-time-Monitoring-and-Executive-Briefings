import type { en } from "./en"

export type Locale = "zh-CN" | "en"
export type MessageKey = keyof typeof en
export type TranslationParams = Record<string, string | number>
