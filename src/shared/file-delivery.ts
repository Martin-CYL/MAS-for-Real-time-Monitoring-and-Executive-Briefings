/** Browser delivery policy. Executable formats must never render on the app origin. */
export function fileDeliveryKind(name: string): "pdf" | "image" | "text" | "download" {
  const ext = name.split(".").pop()?.toLowerCase() ?? ""
  if (ext === "pdf") return "pdf"
  if (["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"].includes(ext)) return "image"
  if (["html", "htm", "svg", "xhtml", "xml"].includes(ext)) return "download"
  if (["txt", "md", "markdown", "csv", "tsv", "json", "jsonc", "log", "yaml", "yml", "toml", "ini", "cfg", "conf", "js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "kt", "lua", "properties", "sh", "css", "scss", "sql", "c", "h", "cpp", "hpp", "cc", "cs", "go", "rs", "java", "rb", "php", "swift", "vue", "svelte", "diff", "patch", "env", "gitignore", "npmrc", "graphql", "zsh"].includes(ext)
    || ["Dockerfile", "Makefile", "Gemfile", "Procfile"].includes(name.split("/").pop() ?? "")) return "text"
  return "download"
}

export function projectFileUrl(projectId: string, relativePath: string, download = false) {
  return `/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(relativePath)}/content${download ? "?download=1" : ""}`
}

export function fileDownloadUrl(url: string) {
  // Only our file endpoints understand download=1. Leave external/signed URLs intact.
  if (!/^\/api\/(projects|chats)\//.test(url)) return url
  const parsed = new URL(url, "http://nex.invalid")
  parsed.searchParams.set("download", "1")
  return parsed.pathname + parsed.search
}
