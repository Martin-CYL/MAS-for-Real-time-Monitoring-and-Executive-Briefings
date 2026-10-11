import type { ReactNode } from "react"
import type { SocketStatus } from "../app/socket"
import { useLocale } from "../i18n/useTranslation"
import { t } from "../i18n/translate"
export function LocalDev({ connectionStatus, ready, children }: { connectionStatus: SocketStatus; ready: boolean; children: ReactNode }) {
  useLocale()
  return <div className="flex-1 flex flex-col min-w-0 bg-background overflow-y-auto">{
    connectionStatus === "connected" && ready ? children :
    <p role="status" className="p-8 text-center text-muted-foreground">{t(connectionStatus === "connecting" ? "Connecting…" : "Unable to connect to Nex. Please try again later or contact your administrator.")}</p>
  }</div>
}
