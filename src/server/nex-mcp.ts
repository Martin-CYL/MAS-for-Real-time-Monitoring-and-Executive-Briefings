import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { nexToolSpecs, type NexToolHost } from "./nex-tools"

export function createNexMcpServer(host: NexToolHost) {
  const token = crypto.randomUUID()
  const abortController = new AbortController()
  const connections = new Set<Server>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${token}` || new URL(request.url).pathname !== "/mcp") {
        return new Response("Unauthorized", { status: 401 })
      }
      if (request.headers.has("origin")) return new Response("Forbidden", { status: 403 })
      const mcp = new Server({ name: "nex", version: "1.0.0" }, { capabilities: { tools: {} } })
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      connections.add(mcp)
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: nexToolSpecs() }))
      mcp.setRequestHandler(CallToolRequestSchema, async (call, extra) => {
        const signal = AbortSignal.any([extra.signal, request.signal, abortController.signal])
        const progressToken = extra._meta?.progressToken
        let progress = 0
        const heartbeat = progressToken === undefined ? undefined : setInterval(() => {
          void extra.sendNotification({
            method: "notifications/progress",
            params: { progressToken, progress: ++progress },
          }).catch(() => {})
        }, 10_000)
        try {
          return await host.execute(call.params.name, call.params.arguments ?? {}, signal)
        } finally {
          if (heartbeat) clearInterval(heartbeat)
        }
      })
      await mcp.connect(transport)
      const response = await transport.handleRequest(request)
      if (!response.body) {
        connections.delete(mcp)
        await mcp.close()
        return response
      }
      const reader = response.body.getReader()
      const cleanup = async () => {
        connections.delete(mcp)
        await mcp.close()
      }
      return new Response(new ReadableStream({
        async pull(controller) {
          try {
            const chunk = await reader.read()
            if (chunk.done) {
              controller.close()
              await cleanup()
            } else {
              controller.enqueue(chunk.value)
            }
          } catch (error) {
            controller.error(error)
            await cleanup()
          }
        },
        async cancel() {
          await reader.cancel()
          await cleanup()
        },
      }), { status: response.status, headers: response.headers })
    },
  })

  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    abortController.abort()
    server.stop(true)
    for (const mcp of connections) void mcp.close().catch(() => {})
    connections.clear()
  }
  return { url: `http://127.0.0.1:${server.port}/mcp`, headers: { Authorization: `Bearer ${token}` }, close }
}
