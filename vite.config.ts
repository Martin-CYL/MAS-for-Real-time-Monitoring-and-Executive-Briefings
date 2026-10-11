import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { getDefaultDevServerPort } from "./src/shared/dev-ports"
import { DEV_CLIENT_PORT } from "./src/shared/ports"
import { messageScrollerPatch } from "./vite-plugin-message-scroller"

function getBackendTargetHost() {
  return process.env.NEX_DEV_BACKEND_TARGET_HOST || "127.0.0.1"
}

function getBackendPort() {
  const configured = Number(process.env.NEX_DEV_BACKEND_PORT)
  return Number.isFinite(configured) && configured > 0 ? configured : getDefaultDevServerPort(DEV_CLIENT_PORT)
}

const backendTargetHost = getBackendTargetHost()
const backendPort = getBackendPort()

export default defineConfig({
  plugins: [messageScrollerPatch(), react()],
  server: {
    host: "0.0.0.0",
    port: DEV_CLIENT_PORT,
    strictPort: true,
    proxy: {
      "/ws": {
        target: `ws://${backendTargetHost}:${backendPort}`,
        ws: true,
      },
      "/api": {
        target: `http://${backendTargetHost}:${backendPort}`,
      },
      "/health": {
        target: `http://${backendTargetHost}:${backendPort}`,
      },
      "/auth": {
        target: `http://${backendTargetHost}:${backendPort}`,
      },
    },
    allowedHosts: true,
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
})
