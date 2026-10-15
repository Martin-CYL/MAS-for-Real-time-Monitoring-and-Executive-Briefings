import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAccounts } from "./accounts"
import { startGateway } from "./server"
import { createAuthManager } from "../auth"

let accounts: Awaited<ReturnType<typeof createAccounts>>, gateway: ReturnType<typeof startGateway>, directory: string
const origin = "http://localhost:32891"
const password = "Test-only-password-2026!"
const links = new Map<string,string>()
const upstreams: ReturnType<typeof Bun.serve>[] = []
let aliceCookie = "", bobCookie = "", aliceId = "", bobId = ""
const call = (path: string, body?: unknown, cookie = "", extra: Record<string,string> = {}) => fetch(origin + path, { method: body ? "POST" : "GET", redirect: "manual", headers: { Origin: origin, "Content-Type": "application/json", Cookie: cookie, ...extra }, body: body ? JSON.stringify(body) : undefined })
async function login(email: string) { const r = await call("/api/auth/sign-in/email", { email, password }); expect(r.status).toBe(200); return r.headers.getSetCookie().map(c=>c.split(";")[0]).join("; ") }
function workspace(name: string) {
  const auth = createAuthManager("x".repeat(48))
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req, server) {
    const p = new URL(req.url).pathname
    if (p === "/auth/login") return auth.handleLogin(req, "/")
    if (p.startsWith("/share/")) return new Response("Not found", {status:404})
    if (!auth.isAuthenticated(req)) return new Response(null,{status:401})
    if (req.headers.get("upgrade")) { if (server.upgrade(req)) return; return new Response(null,{status:400}) }
    return Response.json({ workspace:name, path:p, cookie:req.headers.get("cookie"), injected:req.headers.get("x-nex-user") })
  }, websocket:{ open(ws){ ws.send(name) },message(ws,m){ ws.send(name+":"+m) } } })
  upstreams.push(server); return `http://127.0.0.1:${server.port}`
}
beforeAll(async()=>{
  directory=await mkdtemp(join(tmpdir(),"nex-accounts-test-"))
  accounts=await createAccounts({databasePath:join(directory,"db.sqlite"),origin,rateLimit:false,secret:"test-secret-".repeat(5),onResetLink:async(email,url)=>{links.set(email,url)}})
  aliceId=(await accounts.auth.api.signUpEmail({body:{email:"alice@example.test",name:"Alice",password}})).user.id
  bobId=(await accounts.auth.api.signUpEmail({body:{email:"bob@example.test",name:"Bob",password}})).user.id
  gateway=startGateway({accounts,origin,port:32891,hostname:"127.0.0.1",tenants:[{userId:aliceId,upstream:workspace("alice"),password:"x".repeat(48)},{userId:bobId,upstream:workspace("bob"),password:"x".repeat(48)}]})
  aliceCookie=await login("alice@example.test");bobCookie=await login("bob@example.test")
})
afterAll(async()=>{gateway?.stop(); for(const s of upstreams)s.stop(true);accounts?.database.close();if(directory)await rm(directory,{recursive:true,force:true})})
test("anonymous data access and public signup denied",async()=>{
  expect((await call("/api/projects/private/content")).status).toBe(401)
  expect((await call("/",undefined)).status).toBe(302)
  expect((await call("/api/auth/sign-up/email",{email:"intruder@example.test",password,name:"Bad"})).status).toBe(404)
  expect((await call("/api/auth/request-password-reset",{email:"alice@example.test"})).status).toBe(404)
})
test("HTTP/files route by authenticated identity, ignore forged identity and credentials",async()=>{
  const a=await call("/api/projects/alice/file.pdf",undefined,aliceCookie,{"x-nex-user":bobId,Authorization:"Bearer evil"})
  expect(a.headers.get("set-cookie")).toBeNull()
  const data=await a.json();expect(data.workspace).toBe("alice");expect(data.injected).toBeNull();expect(data.cookie).toStartWith("nex_session=")
  expect((await (await call("/api/projects/alice/file.pdf",undefined,bobCookie)).json()).workspace).toBe("bob")
})
test("cross-origin mutations and forged host rejected",async()=>{
  expect((await call("/api/task",{},aliceCookie,{Origin:"https://evil.test"})).status).toBe(403)
  expect((await fetch(origin+"/api/task",{method:"POST",headers:{Cookie:aliceCookie}})).status).toBe(403)
  expect((await call("/api/task",undefined,aliceCookie,{Host:"evil.test"})).status).toBe(400)
  expect((await call("/share/not-a-capability")).status).toBe(404)
})
test("wrong password fails and cookies are HTTP-only host-only",async()=>{
  expect((await call("/api/auth/sign-in/email",{email:"alice@example.test",password:"incorrect-password"})).status).toBe(401)
  const r=await call("/api/auth/sign-in/email",{email:"bob@example.test",password})
  const cookie=r.headers.get("set-cookie")!;expect(cookie).toContain("HttpOnly");expect(cookie.toLowerCase()).toContain("samesite=strict");expect(cookie.toLowerCase()).not.toContain("domain=")
})
test("one-time reset link revokes existing sessions and cannot be reused",async()=>{
  await accounts.auth.api.requestPasswordReset({body:{email:"alice@example.test",redirectTo:origin+"/reset-password"}})
  const r=await fetch(links.get("alice@example.test")!,{redirect:"manual"})
  const token=new URL(r.headers.get("location")!).searchParams.get("token")
  expect(token).toBeTruthy()
  expect((await call("/api/auth/reset-password",{token,newPassword:password})).status).toBe(200)
  expect((await call("/api/private",undefined,aliceCookie)).status).toBe(401)
  expect((await call("/api/auth/reset-password",{token,newPassword:password})).status).not.toBe(200)
  aliceCookie=await login("alice@example.test")
})
test("WebSocket connects only to own workspace and logout closes it",async()=>{
  const WS=WebSocket as unknown as {new(url:string,options:{headers:Record<string,string>}):WebSocket}
  const ws=new WS(origin.replace("http:","ws:")+"/ws",{headers:{Origin:origin,Cookie:aliceCookie}})
  const frames:string[]=[]
  await new Promise<void>((resolve,reject)=>{const t=setTimeout(()=>reject(new Error("ws timeout")),5000);ws.onerror=()=>reject(new Error("ws error"));ws.onmessage=e=>{frames.push(String(e.data));if(frames.length===1)ws.send("hello");if(frames.length===2){clearTimeout(t);resolve()}}})
  expect(frames).toEqual(["alice","alice:hello"])
  const closed=new Promise<void>((resolve,reject)=>{const t=setTimeout(()=>reject(new Error("logout did not close ws")),3000);ws.onclose=()=>{clearTimeout(t);resolve()}})
  expect((await call("/auth/logout",{},aliceCookie)).status).toBe(200);await closed
  expect((await call("/api/private",undefined,aliceCookie)).status).toBe(401)
})
test("expired setup tokens are rejected",async()=>{
  await accounts.auth.api.requestPasswordReset({body:{email:"bob@example.test",redirectTo:origin+"/reset-password"}})
  const r=await fetch(links.get("bob@example.test")!,{redirect:"manual"})
  const token=new URL(r.headers.get("location")!).searchParams.get("token")
  accounts.database.query('UPDATE verification SET expiresAt = ? WHERE identifier = ?').run(Date.now()-60000,'reset-password:'+token)
  expect((await call("/api/auth/reset-password",{token,newPassword:password})).status).not.toBe(200)
})
test("anonymous and cross-origin WebSockets cannot connect",async()=>{
  const WS=WebSocket as unknown as {new(url:string,options:{headers:Record<string,string>}):WebSocket}
  for(const headers of [{Origin:origin,Cookie:""},{Origin:"https://evil.test",Cookie:bobCookie}]) {
    const socket=new WS(origin.replace("http:","ws:")+"/ws",{headers})
    await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("socket not rejected")),2000);socket.onopen=()=>{clearTimeout(timer);socket.close();reject(new Error("unauthorized socket opened"))};socket.onerror=()=>{clearTimeout(timer);resolve()}})
  }
})
test("forged proxy headers cannot bypass login rate limits",async()=>{
  const limitedOrigin="http://localhost:32892"
  const limited=await createAccounts({databasePath:join(directory,"limited.sqlite"),origin:limitedOrigin,secret:"limited-test-secret-".repeat(4)})
  const instance=startGateway({accounts:limited,tenants:[],origin:limitedOrigin,port:32892,hostname:"127.0.0.1"})
  try {
    let blocked=false
    for(let i=0;i<8;i++){
      const r=await fetch(limitedOrigin+"/api/auth/sign-in/email",{method:"POST",headers:{Origin:limitedOrigin,"Content-Type":"application/json","x-forwarded-for":`10.0.0.${i+1}`,"x-nex-client-ip":`10.1.0.${i+1}`},body:JSON.stringify({email:"missing@example.test",password:"wrong-password-test"})})
      if(r.status===429){blocked=true;break}
    }
    expect(blocked).toBe(true)
  } finally {instance.stop();limited.database.close()}
})
