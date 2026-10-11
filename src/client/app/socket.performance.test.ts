import { expect, test } from "bun:test"
import { NexSocket } from "./socket"

class FakeSocket extends EventTarget {
  static OPEN = 1
  static CONNECTING = 0
  static CLOSED = 3
  static CLOSING = 2
  static current: FakeSocket
  readyState = 0
  sent: any[] = []
  constructor(_url: string) { super(); FakeSocket.current = this }
  send(text: string) { this.sent.push(JSON.parse(text)) }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")) }
  close() { this.readyState = 3; this.dispatchEvent(new Event("close")) }
}

test("hidden tabs stop chat updates and resume from the held span", () => {
  const previous = { window: globalThis.window, document: globalThis.document, WebSocket: globalThis.WebSocket }
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" })
  const window = Object.assign(new EventTarget(), { setTimeout, clearTimeout, setInterval, clearInterval })
  Object.assign(globalThis, { window, document, WebSocket: FakeSocket })
  const socket = new NexSocket("ws://test")
  try {
    let received = 0
    socket.start()
    socket.subscribe({ type: "chat", chatId: "one" }, () => { received++ }, undefined, {
      topicOnReconnect: () => ({ type: "chat", chatId: "one", cachedSpan: { start: 0, end: 1, endEntryId: "entry" } }),
    })
    socket.subscribe({ type: "sidebar" }, () => {})
    FakeSocket.current.open()
    expect(FakeSocket.current.sent.filter(message => message.type === "subscribe")).toHaveLength(2)
    const chat = FakeSocket.current.sent.find(message => message.topic?.type === "chat")
    document.visibilityState = "hidden"
    document.dispatchEvent(new Event("visibilitychange"))
    expect(FakeSocket.current.sent.at(-1)).toMatchObject({ type: "unsubscribe", id: chat.id })
    FakeSocket.current.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "snapshot", id: chat.id, snapshot: { data: {} } }) }))
    expect(received).toBe(0)
    document.visibilityState = "visible"
    document.dispatchEvent(new Event("visibilitychange"))
    expect(FakeSocket.current.sent.at(-1)).toMatchObject({ type: "subscribe", id: chat.id, topic: { cachedSpan: { end: 1 } } })
  } finally {
    socket.dispose()
    Object.assign(globalThis, previous)
  }
})
