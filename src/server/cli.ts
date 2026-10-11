import { APP_VERSION, LOG_PREFIX } from "../shared/branding"
import { parseArgs, openUrl } from "./cli-runtime"
import { startNexServer } from "./server"
import { claimInstance, requestInstanceStop } from "./instance-socket"
const args = process.argv.slice(2)
if (args.includes("--help") || args.includes("-h")) {
  console.log("Nex web server: --host <address> --port <port> --no-open --strict-port. Optional NEX_PASSWORD environment variable. Updates are managed by deployment.")
} else if (args.includes("--version")) {
  console.log(APP_VERSION)
} else if (args[0] === "stop") {
  if (!(await requestInstanceStop())) process.exitCode = 1
} else {
  const options = parseArgs(args)
  const claim = await claimInstance()
  if (claim.kind === "running") {
    console.log(`${LOG_PREFIX} already running${claim.status?.port ? ` on port ${claim.status.port}` : ""}`)
  } else {
    const started = await startNexServer(options)
    claim.attach({ port: started.port, version: APP_VERSION, state: started.state })
    const url = `http://${options.host === "0.0.0.0" ? "127.0.0.1" : options.host}:${started.port}`
    console.log(`${LOG_PREFIX} listening on ${url}`)
    if (options.openBrowser) openUrl(url)
    let stopping = false
    const stop = async () => {
      if (stopping) return
      stopping = true
      try { await started.stop() } finally { process.exit(0) }
    }
    process.once("SIGTERM", () => void stop())
    process.once("SIGINT", () => void stop())
  }
}
