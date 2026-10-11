import type { UpdateSnapshot } from "../../shared/types"
import type { useAppDialog } from "../components/ui/app-dialog"
import type { NexSocket, SocketStatus } from "./socket"

export function getUiUpdateRestartReconnectAction(
  phase: string | null,
  connectionStatus: SocketStatus
): "none" | "awaiting_server_ready" {
  if (phase === "awaiting_disconnect" && connectionStatus === "disconnected") {
    return "awaiting_server_ready"
  }

  return "none"
}

export function shouldHandleUiUpdateReloadRequest(
  reloadRequestedAt: number | null | undefined,
  lastHandledReloadRequest: string | null
) {
  if (!reloadRequestedAt) return false
  return String(reloadRequestedAt) !== lastHandledReloadRequest
}

export function getUiUpdateReadinessPath() {
  return "/auth/status"
}

// Nex is updated through deployment. Keep the state interface while the hidden
// legacy settings panels are retired; never poll or invoke the old updater.
export function useUpdateRestart(_params: {
  socket: NexSocket
  connectionStatus: SocketStatus
  dialog: ReturnType<typeof useAppDialog>
  setCommandError: (message: string | null) => void
}) {
  return {
    updateSnapshot: null as UpdateSnapshot | null,
    handleCheckForUpdates: async (_options?: { force?: boolean }) => {},
    handleInstallUpdate: async () => {},
    handleInstallNightly: async () => {},
    handleInstallStable: async () => {},
  }
}
