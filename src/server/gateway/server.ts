import type { Accounts } from "./accounts"
import { loginPage } from "./login-page"
import type { ServerWebSocket } from "bun"
const BunWebSocket = WebSocket as unknown as { new(url: string, options: { headers: Record<string, string> }): WebSocket }

export interface Tenant { userId: string; upstream: string; password: string }
interface Connection { upstream: WebSocket; sessionId: string; headers: Headers; ready: boolean; pending: string[]; pendingBytes: number; queue: Promise<void>; timer?: ReturnType<typeof setInterval> }
const forbidden = () => Response.json({ error: "Unauthorized" }, { status: 401 })
const publicAuth = new Set(["/api/auth/sign-in/email", "/api/auth/sign-out", "/api/auth/reset-password", "/api/auth/get-session"])

export function startGateway(options: { accounts: Accounts; tenants: Tenant[]; origin: string; port: number; hostname?: string }) {
  const origin = new URL(options.origin).origin
  const tenants = new Map(options.tenants.map(t => {
    const url = new URL(t.upstream)
    if (!/^[a-zA-Z0-9-]+$/.test(t.userId) || url.protocol !== "http:" || url.pathname !== "/" || url.search || url.username || t.password.length < 32) throw new Error("Invalid tenant configuration")
    return [t.userId, { ...t, upstream: url.origin }] as const
  }))
  const cookies = new Map<string, Promise<string>>()
  const connections = new Set<ServerWebSocket<Connection>>()
  const session = (headers: Headers) => options.accounts.auth.api.getSession({ headers })
  function closeSession(id: string) { for (const ws of connections) if (ws.data.sessionId === id) ws.close(1008, "Session ended") }
  async function upstreamCookie(tenant: Tenant): Promise<string> {
    let pending = cookies.get(tenant.userId)
    if (!pending) {
      pending = (async () => {
        const r = await fetch(new URL("/auth/login", tenant.upstream), { method: "POST", headers: { "Content-Type": "application/json", Origin: tenant.upstream }, body: JSON.stringify({ password: tenant.password }), redirect: "manual", signal: AbortSignal.timeout(10000) })
        const cookie = r.headers.getSetCookie().find(c => c.startsWith("nex_session="))?.split(";")[0]
        if (!r.ok || !cookie) throw new Error("Workspace authentication unavailable")
        return cookie
      })()
      cookies.set(tenant.userId, pending)
      pending.catch(() => cookies.delete(tenant.userId))
    }
    return pending
  }
  async function proxy(req: Request, tenant: Tenant, authenticated: boolean): Promise<Response> {
    const url = new URL(req.url)
    // Assign pathname rather than resolve it: //evil.example must never change host.
    const target = new URL(tenant.upstream); target.pathname = url.pathname; target.search = url.search
    const headers = new Headers(req.headers)
    for (const key of [...headers.keys()]) if (/^(host|cookie|authorization|connection|upgrade|x-forwarded-.*|forwarded|x-nex-.*|sec-websocket-.*)$/i.test(key)) headers.delete(key)
    headers.set("Origin", tenant.upstream)
    headers.set("Accept-Encoding", "identity")
    if (authenticated) headers.set("Cookie", await upstreamCookie(tenant))
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer()
    let response = await fetch(target, { method: req.method, headers, body, redirect: "manual", signal: AbortSignal.timeout(60000) })
    if (authenticated && response.status === 401) {
      await response.body?.cancel(); cookies.delete(tenant.userId)
      headers.set("Cookie", await upstreamCookie(tenant))
      response = await fetch(target, { method: req.method, headers, body, redirect: "manual", signal: AbortSignal.timeout(60000) })
    }
    const resultHeaders = new Headers(response.headers)
    resultHeaders.delete("set-cookie"); resultHeaders.delete("content-length"); resultHeaders.delete("content-encoding")
    resultHeaders.set("Cache-Control", "no-store")
    const location = resultHeaders.get("location")
    if (location) { const resolved = new URL(location, tenant.upstream); if (resolved.origin === new URL(tenant.upstream).origin) resultHeaders.set("location", resolved.pathname + resolved.search) }
    return new Response(response.body, { status: response.status, headers: resultHeaders })
  }
  const server = Bun.serve<Connection>({
    hostname: options.hostname ?? "127.0.0.1", port: options.port, maxRequestBodySize: 100 * 1024 * 1024,
    async fetch(req, server) {
      const url = new URL(req.url)
      if (url.pathname === "/health") return Response.json({ ok: true })
      // Caddy preserves Host. Never use arbitrary client-forwarded host/proto.
      if (url.host !== new URL(origin).host) return new Response("Invalid host", { status: 400 })
      if (req.headers.get("Origin") && req.headers.get("Origin") !== origin) return new Response("Invalid origin", { status: 403 })
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.headers.get("Origin") !== origin) return new Response("Invalid origin", { status: 403 })
      if (url.pathname === "/login" || url.pathname === "/auth/login") return loginPage()
      if (url.pathname === "/reset-password") return loginPage(true)
      if (url.pathname.startsWith("/api/auth/")) {
        if (!publicAuth.has(url.pathname) && !/^\/api\/auth\/reset-password\/[^/]+$/.test(url.pathname)) return new Response("Not found", { status: 404 })
        const before = url.pathname === "/api/auth/sign-out" ? await session(req.headers) : null
        const authRequest = new Request(origin + url.pathname + url.search, req)
        // Only trust the socket peer for rate limits, never client-supplied proxy headers.
        // Behind Caddy this intentionally shares a conservative login limit.
        authRequest.headers.set("x-nex-client-ip", server.requestIP(req)?.address ?? "127.0.0.1")
        const response = await options.accounts.auth.handler(authRequest)
        if (before && response.ok) closeSession(before.session.id)
        return response
      }
      if (url.pathname.startsWith("/share/")) {
        // A 192-bit explicitly-created capability is the only anonymous data route.
        if (!/^\/share\/[a-f0-9]{48}(\/|$)/.test(url.pathname) || !["GET", "HEAD"].includes(req.method)) return new Response("Not found", { status: 404 })
        for (const tenant of tenants.values()) {
          const response = await proxy(req, tenant, false)
          if (response.status !== 404) return response
          await response.body?.cancel()
        }
        return new Response("Not found", { status: 404 })
      }
      const identity = await session(req.headers)
      if (url.pathname === "/auth/status") return Response.json({ enabled: true, authenticated: Boolean(identity), managedAccounts: true })
      if (url.pathname === "/auth/logout") {
        if (req.method !== "POST") return new Response(null, { status: 405 })
        const response = await options.accounts.auth.handler(new Request(origin + "/api/auth/sign-out", { method: "POST", headers: req.headers }))
        if (identity) closeSession(identity.session.id)
        return response
      }
      if (!identity) return url.pathname.startsWith("/api/") || req.headers.get("upgrade") ? forbidden() : Response.redirect(origin + "/login", 302)
      const tenant = tenants.get(identity.user.id)
      if (!tenant) return new Response("工作区尚未开通，请联系管理员。 Workspace not provisioned.", { status: 503 })
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        if (url.pathname !== "/ws" || req.headers.get("Origin") !== origin) return new Response(null, { status: 403 })
        const upstream = new BunWebSocket(tenant.upstream.replace(/^http:/, "ws:") + "/ws", { headers: { Cookie: await upstreamCookie(tenant), Origin: tenant.upstream } })
        const data: Connection = { upstream, sessionId: identity.session.id, headers: new Headers(req.headers), ready: false, pending: [], pendingBytes: 0, queue: Promise.resolve() }
        upstream.onmessage = e => { if (data.ready) socket?.send(e.data); else { const frame = String(e.data); data.pendingBytes += Buffer.byteLength(frame); if (data.pendingBytes <= 16 * 1024 * 1024) data.pending.push(frame); else upstream.close() } }
        let socket: ServerWebSocket<Connection> | undefined
        // Attach the browser socket through open without letting pre-open frames vanish.
        ;(data as Connection & { attach?: (ws: ServerWebSocket<Connection>) => void }).attach = ws => { socket = ws }
        try {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { upstream.close(); reject(new Error("Workspace timeout")) }, 10000)
            upstream.onopen = () => { clearTimeout(timer); resolve() }
            upstream.onerror = () => { clearTimeout(timer); reject(new Error("Workspace unavailable")) }
          })
        } catch { return new Response("Workspace unavailable", { status: 503 }) }
        if (server.upgrade(req, { data })) return
        upstream.close(); return new Response(null, { status: 400 })
      }
      return proxy(req, tenant, true)
    },
    websocket: {
      maxPayloadLength: 16 * 1024 * 1024, backpressureLimit: 16 * 1024 * 1024, closeOnBackpressureLimit: true,
      open(ws) {
        const data = ws.data
        ;(data as Connection & { attach?: (ws: ServerWebSocket<Connection>) => void }).attach?.(ws)
        connections.add(ws); data.ready = true
        for (const frame of data.pending) ws.send(frame)
        data.pending = []
        data.upstream.onclose = () => ws.close(1012, "Workspace disconnected")
        data.upstream.onerror = () => ws.close(1011, "Workspace unavailable")
        data.timer = setInterval(async () => { try { const current = await session(data.headers); if (!current || current.session.id !== data.sessionId) ws.close(1008, "Session ended") } catch { ws.close(1011) } }, 15000)
      },
      message(ws, message) {
        ws.data.queue = ws.data.queue.then(async () => {
        // Check every command, so revoked sessions cannot keep using a live socket.
        const identity = await session(ws.data.headers).catch(() => null)
        if (!identity || identity.session.id !== ws.data.sessionId) { ws.close(1008); return }
        if (ws.data.upstream.readyState === WebSocket.OPEN) ws.data.upstream.send(message)
        else ws.close(1013, "Workspace connecting; retry")
        }).catch(() => { ws.close(1011) })
      },
      close(ws) { clearInterval(ws.data.timer); connections.delete(ws); ws.data.upstream.close() },
    },
    error() { return new Response("服务暂时不可用 / Service unavailable", { status: 503 }) },
  })
  return { server, stop: () => { for (const ws of connections) ws.close(); server.stop(true) } }
}
