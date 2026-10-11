import { t } from "../i18n/translate"
import { create } from "zustand"
import type { ChatBrowserNotificationPreference, ChatSoundId, ChatSoundPreference } from "../../shared/types"

export type { ChatBrowserNotificationPreference, ChatSoundId, ChatSoundPreference }

export const DEFAULT_CHAT_SOUND_PREFERENCE: ChatSoundPreference = "always"
export const DEFAULT_CHAT_SOUND_ID: ChatSoundId = "funk"
export const DEFAULT_CHAT_BROWSER_NOTIFICATION_PREFERENCE: ChatBrowserNotificationPreference = "never"

export const CHAT_SOUND_OPTIONS: Array<{ value: ChatSoundId; label: string }> = [
  { value: "blow", get label() { return t("Blow") } },
  { value: "bottle", get label() { return t("Bottle") } },
  { value: "frog", get label() { return t("Frog") } },
  { value: "funk", get label() { return t("Funk") } },
  { value: "glass", get label() { return t("Glass") } },
  { value: "ping", get label() { return t("Ping") } },
  { value: "pop", get label() { return t("Pop") } },
  { value: "purr", get label() { return t("Purr") } },
  { value: "tink", get label() { return t("Tink") } },
]

export function normalizeChatSoundPreference(value?: string): ChatSoundPreference {
  switch (value) {
    case "never":
    case "unfocused":
    case "always":
      return value
    default:
      return DEFAULT_CHAT_SOUND_PREFERENCE
  }
}

export function normalizeChatBrowserNotificationPreference(value?: string): ChatBrowserNotificationPreference {
  switch (value) {
    case "never":
    case "unfocused":
    case "always":
      return value
    default:
      return DEFAULT_CHAT_BROWSER_NOTIFICATION_PREFERENCE
  }
}

export function normalizeChatSoundId(value?: string): ChatSoundId {
  switch (value) {
    case "blow":
    case "bottle":
    case "frog":
    case "funk":
    case "glass":
    case "ping":
    case "pop":
    case "purr":
    case "tink":
      return value
    default:
      return DEFAULT_CHAT_SOUND_ID
  }
}

export interface ChatSoundPreferencesState {
  chatSoundPreference: ChatSoundPreference
  chatSoundId: ChatSoundId
  chatBrowserNotificationPreference: ChatBrowserNotificationPreference
  setChatSoundPreference: (value: ChatSoundPreference) => void
  setChatSoundId: (value: ChatSoundId) => void
  setChatBrowserNotificationPreference: (value: ChatBrowserNotificationPreference) => void
}

export const useChatSoundPreferencesStore = create<ChatSoundPreferencesState>()(
  (set) => ({
    chatSoundPreference: DEFAULT_CHAT_SOUND_PREFERENCE,
    chatSoundId: DEFAULT_CHAT_SOUND_ID,
    chatBrowserNotificationPreference: DEFAULT_CHAT_BROWSER_NOTIFICATION_PREFERENCE,
    setChatSoundPreference: (value) => set({ chatSoundPreference: normalizeChatSoundPreference(value) }),
    setChatSoundId: (value) => set({ chatSoundId: normalizeChatSoundId(value) }),
    setChatBrowserNotificationPreference: (value) => set({ chatBrowserNotificationPreference: normalizeChatBrowserNotificationPreference(value) }),
  })
)
