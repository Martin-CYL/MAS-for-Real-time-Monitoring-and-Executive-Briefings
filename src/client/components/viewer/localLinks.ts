/**
 * A local path as a path inside the project, or null when it's outside it.
 * The viewer reads files through the project's file route, which serves the
 * project's files and nothing else, so only these can open there.
 */
export function projectRelativePath(projectPath: string | null | undefined, localPath: string): string | null {
  if (!projectPath) return null
  const root = projectPath.replace(/\/+$/u, "")
  if (!localPath.startsWith(`${root}/`)) return null
  const relative = localPath.slice(root.length + 1)
  if (!relative || relative.split("/").includes("..")) return null
  return relative
}

// Files a link would hand to the default app (Numbers, Excel) that the viewer
// shows better in place, as a table.
const VIEWER_DEFAULT_EXTENSIONS = new Set([".csv", ".tsv"])

/**
 * Whether a link opened with `action` belongs in the viewer: what would go to
 * the editor, and the table files that would go to the default app.
 */
export function opensInViewer(localPath: string, action: string): boolean {
  if (action === "open_editor") return true
  if (action !== "open_default") return false
  const name = localPath.split("/").pop() ?? ""
  const dot = name.lastIndexOf(".")
  return dot > 0 && VIEWER_DEFAULT_EXTENSIONS.has(name.slice(dot).toLowerCase())
}
