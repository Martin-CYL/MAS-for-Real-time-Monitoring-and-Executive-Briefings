import { SHOW_DEVELOPER_UI } from "../../config/productFeatures"
import { t } from "../../i18n/translate"
import { useLocale } from "../../i18n/useTranslation"
import type { AgentProvider } from "../../../shared/types"
import { authServiceForProvider } from "../../../shared/types"
import { useProviderAuthStore, selectAuthService } from "../../stores/providerAuthStore"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog"
import { AuthCard } from "./AuthCard"

/**
 * Shown when the user picks a harness that isn't signed in. The switch is
 * blocked until sign-in completes — the caller watches the auth store and
 * applies the pending switch (closing this dialog) once the service flips to
 * signed_in.
 */
export function SignInDialogDeveloper({
  provider,
  onOpenChange,
}: {
  /** The harness the user tried to switch to, or null when closed. */
  provider: AgentProvider | null
  onOpenChange: (open: boolean) => void
}) {
  useLocale()
  const snapshot = useProviderAuthStore((store) => store.snapshot)
  const socket = useProviderAuthStore((store) => store.socket)
  const serviceId = provider ? authServiceForProvider(provider) : null
  const service = serviceId ? selectAuthService(snapshot, serviceId) : null

  return (
    <Dialog open={Boolean(provider && service && socket)} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{t("Sign in to") + " "}{service?.label ?? ""}</DialogTitle>
          <DialogDescription>
            {service && !service.installed
              ? t("Install and sign in to {0} to use it for this chat.", { 0: service.label })
              : t("Sign in to {0} to use it for this chat. The switch applies automatically once you're signed in.", { 0: service?.label ?? "this provider" })}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {service && socket ? <AuthCard service={service} socket={socket} /> : null}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

/** Developer surface retained for internal maintenance only. */
export function SignInDialog(...args: Parameters<typeof SignInDialogDeveloper>) {
  return SHOW_DEVELOPER_UI ? <SignInDialogDeveloper {...args[0]} /> : null
}
