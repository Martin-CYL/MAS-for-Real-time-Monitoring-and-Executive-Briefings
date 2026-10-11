export interface ChartToolPayload {
  title: string
  description?: string
  type: "bar" | "line" | "area" | "pie"
  data: Array<Record<string, string | number | null>>
  xKey?: string
  yKeys?: string[]
  xAxisKey?: string
  dataKeys?: string[]
  config?: Record<string, { label?: string; color?: string }>
  stacked?: boolean
}

export const CHART_COLORS = ["#00a6f5", "#615fff", "#f6339a", "#fe9900", "#00bd7c"] as const

// Both clients accept Tressa's key aliases. Category columns must not become series.
export function resolveChartKeys(payload: ChartToolPayload): { xKey: string; keys: string[] } {
  const data = payload.data
  const first = data[0] ?? {}
  const xKey = payload.xAxisKey ?? payload.xKey ?? Object.keys(first)[0] ?? "name"
  const candidates = payload.dataKeys?.length ? payload.dataKeys : payload.yKeys?.length ? payload.yKeys : Object.keys(first)
  const keys = [...new Set(candidates)].filter(key => key !== xKey && data.some(row => typeof row[key] === "number" && Number.isFinite(row[key])))
  return { xKey, keys }
}

export interface DisplayAttachment {
  type: "attachment"
  url: string
  name: string
  kind: "image" | "video" | "file"
  mimeType: string
  size: number | null
}

export function displayAttachments(value: unknown): DisplayAttachment[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is DisplayAttachment => Boolean(item && item.type === "attachment"
    && typeof item.url === "string" && isDisplayUrl(item.url) && typeof item.name === "string"
    && ["image", "video", "file"].includes(item.kind)))
}

export function isDisplayUrl(value: string): boolean {
  if (/^\/api\/chats\/[^/]+\/media\/[^/]+$/.test(value) || /^\.\/attachments\/[^/]+$/.test(value)) return true
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password } catch { return false }
}

/** Tools whose result is a list of attachments. They all render through the same attachment card. */
export const ATTACHMENT_TOOL_NAMES: readonly string[] = ["send_attachments", "generate_images"]
