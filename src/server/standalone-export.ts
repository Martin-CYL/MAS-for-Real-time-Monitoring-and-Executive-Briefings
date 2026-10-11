import { randomBytes } from "node:crypto"
import path from "node:path"
import { cp, copyFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises"
import type { StandaloneTranscriptAttachmentMode, StandaloneTranscriptBundle, StandaloneTranscriptExportCommandResult, StandaloneTranscriptTheme, TranscriptEntry } from "../shared/types"
import { APP_VERSION } from "../shared/branding"

const STANDALONE_SHARE_WORKSPACE_PATH = "/workspace"
export interface WriteStandaloneTranscriptExportArgs {
  dataDir: string
  sourceOrigin?: string
  chatId: string
  title: string
  localPath: string
  theme: StandaloneTranscriptTheme
  attachmentMode: StandaloneTranscriptAttachmentMode
  messages: TranscriptEntry[]
  resolveMediaPath?: (url: string) => string | null
}
export interface StandaloneExportDeps {
  viewerDistDir?: string
  now?: Date
}
export function getStandaloneViewerDistDir() {
  return path.join(import.meta.dir, "..", "..", "dist", "export-viewer")
}
/** Explicitly allow only visible conversation text and user attachments into a share.
 * Never serialize provider sessions, tool arguments/results, reasoning or debug data.
 */
export function publicTranscriptMessages(messages: TranscriptEntry[]): TranscriptEntry[] {
  return messages.flatMap((entry): TranscriptEntry[] => {
    if (entry.hidden || entry.parentToolUseId) return []
    const base = { _id: entry._id, createdAt: entry.createdAt, messageId: entry.messageId }
    if (entry.kind === "assistant_text") return [{ ...base, kind: entry.kind, text: entry.text }]
    if (entry.kind === "user_prompt") return [{ ...base, kind: entry.kind, content: entry.content,
      attachments: entry.attachments?.map(a => ({ id: a.id, kind: a.kind, displayName: a.displayName,
        absolutePath: a.absolutePath, relativePath: a.relativePath, contentUrl: a.contentUrl, mimeType: a.mimeType, size: a.size })) }]
    return []
  })
}
export async function writeStandaloneTranscriptExport(args: WriteStandaloneTranscriptExportArgs, deps: StandaloneExportDeps = {}): Promise<StandaloneTranscriptExportCommandResult> {
  const viewerDistDir = deps.viewerDistDir ?? getStandaloneViewerDistDir()
  if (!(await defaultPathExists(viewerDistDir))) throw new Error("Standalone viewer bundle not found. Run `bun run build`.")
  const shareSlug = randomBytes(24).toString("hex")
  const root = path.join(args.dataDir, "shares")
  const outputDir = path.join(root, shareSlug)
  const stagingDir = path.join(root, `.pending-${shareSlug}`)
  await mkdir(root, { recursive: true })
  try {
    await cp(viewerDistDir, stagingDir, { recursive: true })
    const prepared = await prepareStandaloneMessages(publicTranscriptMessages(args.messages), {
      attachmentMode: args.attachmentMode, localPath: args.localPath,
      attachmentsDir: path.join(stagingDir, "attachments"), copyFile, mkdir,
      pathExists: defaultPathExists, resolveMediaPath: args.resolveMediaPath ?? (() => null),
    })
    const bundle: StandaloneTranscriptBundle = {
      version: 1, chatId: shareSlug, title: args.title, localPath: STANDALONE_SHARE_WORKSPACE_PATH,
      exportedAt: (deps.now ?? new Date()).toISOString(), viewerVersion: APP_VERSION,
      theme: args.theme, attachmentMode: args.attachmentMode, messages: prepared.messages,
    }
    await writeFile(path.join(stagingDir, "transcript.json"), JSON.stringify(bundle, null, 2), "utf8")
    // Publish only complete snapshots. No upload to an external sharing service.
    await rename(stagingDir, outputDir)
    return { ok: true, outputDir, indexHtmlPath: path.join(outputDir, "index.html"),
      transcriptJsonPath: path.join(outputDir, "transcript.json"), attachmentMode: args.attachmentMode,
      totalAttachmentCount: prepared.totalAttachmentCount, bundledAttachmentCount: prepared.bundledAttachmentCount,
      shareSlug, shareUrl: `/share/${shareSlug}/`, uploadedFileCount: 0 }
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true })
    throw error
  }
}

interface PreparedMessagesResult { messages: TranscriptEntry[]; totalAttachmentCount: number; bundledAttachmentCount: number }

async function prepareStandaloneMessages(
  messages: TranscriptEntry[],
  args: {
    attachmentMode: StandaloneTranscriptAttachmentMode
    localPath: string
    attachmentsDir: string
    copyFile: typeof copyFile
    mkdir: typeof mkdir
    pathExists: (targetPath: string) => Promise<boolean>
    resolveMediaPath: (url: string) => string | null
  },
): Promise<PreparedMessagesResult> {
  const preparedMessages = structuredClone(messages)
  let totalAttachmentCount = 0
  let bundledAttachmentCount = 0
  let attachmentsDirCreated = false

  for (const message of preparedMessages) {
    // Tool result images are files beside the transcript; bundle them like
    // attachments, or blank the URL so the viewer draws nothing rather than
    // a request against a server that is not there.
    if (message.kind === "tool_result" && Array.isArray(message.content)) {
      for (const block of message.content as Array<{ type?: unknown; url?: unknown }>) {
        if (!block || typeof block !== "object" || (block.type !== "image" && block.type !== "attachment" && block.type !== "visualization") || typeof block.url !== "string" || !block.url) {
          continue
        }
        if (/^https?:\/\//.test(block.url)) continue
        totalAttachmentCount += 1
        const sourcePath = args.attachmentMode === "metadata" ? null : args.resolveMediaPath(block.url)
        if (!sourcePath || !(await args.pathExists(sourcePath))) {
          block.url = ""
          continue
        }
        if (!attachmentsDirCreated) {
          await args.mkdir(args.attachmentsDir, { recursive: true })
          attachmentsDirCreated = true
        }
        const exportedFileName = sanitizeFileNameSegment(path.basename(sourcePath))
        await args.copyFile(sourcePath, path.join(args.attachmentsDir, exportedFileName))
        bundledAttachmentCount += 1
        block.url = `./attachments/${exportedFileName}`
      }
      continue
    }

    if (message.kind !== "user_prompt" || !message.attachments?.length) {
      continue
    }

    totalAttachmentCount += message.attachments.length

    for (const attachment of message.attachments) {
      if (args.attachmentMode === "metadata") {
        rewriteAttachmentAsMetadata(attachment)
        continue
      }

      if (!attachment.absolutePath || !(await args.pathExists(attachment.absolutePath))) {
        rewriteAttachmentAsMetadata(attachment)
        continue
      }

      if (!attachmentsDirCreated) {
        await args.mkdir(args.attachmentsDir, { recursive: true })
        attachmentsDirCreated = true
      }

      const exportedFileName = `${sanitizeFileNameSegment(attachment.id)}-${sanitizeFileNameSegment(path.basename(attachment.displayName || attachment.absolutePath))}`
      const destinationPath = path.join(args.attachmentsDir, exportedFileName)
      await args.copyFile(attachment.absolutePath, destinationPath)
      bundledAttachmentCount += 1

      const relativeDestinationPath = `./attachments/${exportedFileName}`
      attachment.absolutePath = relativeDestinationPath
      attachment.relativePath = relativeDestinationPath
      attachment.contentUrl = relativeDestinationPath
    }
  }

  rewriteLocalPathsForShare(preparedMessages, args.localPath)

  return {
    messages: preparedMessages,
    totalAttachmentCount,
    bundledAttachmentCount,
  }
}

function rewriteAttachmentAsMetadata(attachment: {
  absolutePath: string
  relativePath: string
  contentUrl: string
}) {
  attachment.absolutePath = ""
  attachment.relativePath = ""
  attachment.contentUrl = ""
}

function sanitizeFileNameSegment(value: string) {
  return value
    .trim()
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

async function defaultPathExists(targetPath: string) {
  try {
    await stat(targetPath)
    return true
  } catch {
    return false
  }
}

function rewriteLocalPathsForShare(value: unknown, localPath: string) {
  if (!localPath) {
    return
  }

  if (typeof value === "string") {
    return value.replaceAll(localPath, STANDALONE_SHARE_WORKSPACE_PATH)
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      value[index] = rewriteLocalPathsForShare(value[index], localPath)
    }
    return value
  }

  if (!value || typeof value !== "object") {
    return value
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    ;(value as Record<string, unknown>)[key] = rewriteLocalPathsForShare(nestedValue, localPath)
  }

  return value
}
