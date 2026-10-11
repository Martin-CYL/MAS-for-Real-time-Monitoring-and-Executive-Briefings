import { SHOW_DEVELOPER_UI } from "../../config/productFeatures"
import { getLocale } from "../../i18n/translate"
import { useLocale } from "../../i18n/useTranslation"
import { useEffect, useMemo, useState } from "react"
import type { UsageLimitsSnapshot } from "../../../shared/types"
import { NEW_CHAT_COMPOSER_ID, useChatPreferencesStore } from "../../stores/chatPreferencesStore"
import type { NexSocket } from "../socket"
import { ProviderCard } from "../settings/UsageSection"

let lastUsageSnapshot: UsageLimitsSnapshot | null = null

/**
 * Compact harness usage meters shown on the empty (new chat) page. Renders
 * only providers with live limit data (Claude/Codex when signed in with a
 * subscription). Cards start collapsed — each header carries its first window's
 * meter — with the composer's current provider listed first. Display-only —
 * refresh lives on the Settings → Usage page.
 */
export function EmptyStateUsageCardsDeveloper({
  socket,
  activeChatId,
}: {
  socket: NexSocket
  activeChatId: string | null
}) {
  useLocale()
  // Starts from the last push: each new chat remounts this, and waiting on a
  // fresh subscription made the cards drop out and pop back in.
  const [snapshot, setSnapshot] = useState<UsageLimitsSnapshot | null>(() => lastUsageSnapshot)

  useEffect(() => {
    return socket.subscribe<UsageLimitsSnapshot>({ type: "usage-limits" }, (next) => {
      lastUsageSnapshot = next
      setSnapshot(next)
    })
  }, [socket])

  // The composer provider currently chosen for this (new/empty) chat.
  const composerChatId = activeChatId ?? NEW_CHAT_COMPOSER_ID
  const selectedProvider = useChatPreferencesStore(
    (store) => store.getComposerState(composerChatId).provider,
  )

  const cards = useMemo(() => {
    const withData = (snapshot?.providers ?? []).filter(
      (provider) => provider.status === "ok" && provider.windows.length > 0,
    )
    // Selected provider first, then the rest in their natural order.
    return [...withData].sort((a, b) => {
      const aSel = a.provider === selectedProvider ? 0 : 1
      const bSel = b.provider === selectedProvider ? 0 : 1
      return aSel - bSel
    })
  }, [snapshot, selectedProvider, getLocale()])

  if (cards.length === 0) return null

  return (
    <div className="w-full space-y-3 text-left">
      {cards.map((provider) => (
        <ProviderCard key={provider.provider} snapshot={provider} collapsible />
      ))}
    </div>
  )
}

/** Developer surface retained for internal maintenance only. */
export function EmptyStateUsageCards(...args: Parameters<typeof EmptyStateUsageCardsDeveloper>) {
  return SHOW_DEVELOPER_UI ? <EmptyStateUsageCardsDeveloper {...args[0]} /> : null
}
