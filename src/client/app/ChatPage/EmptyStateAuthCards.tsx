import { SHOW_DEVELOPER_UI } from "../../config/productFeatures"
import { useLocale } from "../../i18n/useTranslation"
import { SetupCard } from "../../components/auth/SetupCard"

/**
 * New-chat empty state onboarding entry: a single Setup card (opens the
 * full-screen setup wizard) shown until the wizard has been completed.
 * Signed-in claude/codex usage renders separately via EmptyStateUsageCards.
 */
export function EmptyStateAuthCardsDeveloper() {
  useLocale()
  return <SetupCard />
}

/** Developer surface retained for internal maintenance only. */
export function EmptyStateAuthCards() {
  return SHOW_DEVELOPER_UI ? <EmptyStateAuthCardsDeveloper /> : null
}
