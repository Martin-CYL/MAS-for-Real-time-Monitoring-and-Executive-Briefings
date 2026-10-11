import { t, getLocale } from "../../i18n/translate"
import { useLocale } from "../../i18n/useTranslation"
import { UserRound, X } from "lucide-react"
import type { NormalizedToolCall } from "../../../shared/types"
import type { ProcessedToolCall } from "./types"
import { MetaRow, MetaLabel, ExpandableRow, getToolIcon } from "./shared"
import { useMemo } from "react"
import { stripWorkspacePath } from "../../lib/pathUtils"
import { AnimatedShinyText } from "../ui/animated-shiny-text"
import { formatBashCommandTitle, toTitleCase } from "../../lib/formatters"
import { ToolCallExpandedContent } from "./ToolCallExpandedContent"
import { ChatToolMessage, isChatToolCall } from "./ChatToolMessage"
import { isScheduleToolCall, ScheduleToolMessage } from "./ScheduleToolMessage"
import { DisplayToolMessage } from "./DisplayToolMessage"
import { useToolPayloadPrefetch } from "./tool-payload-context"

interface Props {
  message: ProcessedToolCall
  isLoading?: boolean
  localPath?: string | null
}

/** A tool call as the transcript names it: the tool and the thing it acts on. */
type ToolTitleSource = NormalizedToolCall extends infer T
  ? T extends NormalizedToolCall ? Pick<T, "toolKind" | "toolName" | "input"> : never
  : never

/**
 * A tool call's one-line name, as its transcript row shows it ("Read
 * src/app.ts", "Find `x` in files"). Shared so anywhere else that names a
 * call (the Agents card's latest step) says it the same way.
 */
export function formatToolCallTitle(message: ToolTitleSource, localPath?: string | null): string {
  if (message.toolKind === "skill") {
    return message.input.skill ? t("Read Skill – {0}", { 0: message.input.skill }) : t("Read Skill")
  }
  if (message.toolKind === "glob") {
    return t("Search files {0}", { 0: message.input.pattern === "**/*" ? "in all directories" : `matching ${message.input.pattern}` })
  }
  if (message.toolKind === "grep") {
    const pattern = message.input.pattern
    const outputMode = message.input.outputMode
    if (outputMode === "count") {
      return t("Count `{0}` occurrences", { 0: pattern })
    }
    if (outputMode === "content") {
      return t("Find `{0}` in text", { 0: pattern })
    }
    return t("Find `{0}` in files", { 0: pattern })
  }
  if (message.toolKind === "bash") {
    return message.input.description || (message.input.command ? formatBashCommandTitle(message.input.command) : "Bash")
  }
  if (message.toolKind === "web_search") {
    return message.input.query || t("Web Search")
  }
  if (message.toolKind === "read_file") {
    return t("Read {0}", { 0: stripWorkspacePath(message.input.filePath, localPath) })
  }
  if (message.toolKind === "write_file") {
    return t("Write {0}", { 0: stripWorkspacePath(message.input.filePath, localPath) })
  }
  if (message.toolKind === "edit_file") {
    return t("Edit {0}", { 0: stripWorkspacePath(message.input.filePath, localPath) })
  }
  if (message.toolKind === "delete_file") {
    return t("Delete {0}", { 0: stripWorkspacePath(message.input.filePath, localPath) })
  }
  if (message.toolKind === "mcp_generic") {
    return `${toTitleCase(message.input.tool)} from ${toTitleCase(message.input.server)}`
  }
  if (message.toolKind === "subagent_task") {
    const agent = message.input.subagentType || message.toolName
    return message.input.description ? `${agent}: ${message.input.description}` : agent
  }
  return message.toolName
}

export function ToolCallMessage({ message, isLoading = false, localPath }: Props) {
  useLocale()
  // Presence is the *existence* of a result entry, not its payload: a result
  // may arrive with its body left on the server, to be fetched only if the row
  // is opened.
  const hasResult = message.resultEntryId !== undefined
  const showLoadingState = !hasResult && isLoading

  const name = useMemo(() => formatToolCallTitle(message, localPath), [message, localPath, getLocale()])

  const isAgent = message.toolKind === "subagent_task"

  // Warm the payload on hover so the body is usually already there by the time
  // the row is clicked. Pointer-only by nature; touch falls through to the
  // fetch the expanded view issues on mount.
  const prefetchPayloads = useToolPayloadPrefetch()
  const prefetchOwnPayloads = () => {
    if (!message.inputTrimmed && !message.resultTrimmed) return
    prefetchPayloads([
      message.inputTrimmed ? message.id : undefined,
      message.resultTrimmed ? message.resultEntryId : undefined,
    ])
  }

  if (message.toolKind === "display") return <DisplayToolMessage message={message} />
  if (isChatToolCall(message)) return <ChatToolMessage message={message} />
  if (isScheduleToolCall(message)) return <ScheduleToolMessage message={message} />

  return (
    <MetaRow className="w-full" onPointerEnter={prefetchOwnPayloads}>
      {/* Creating the element is free; `ExpandableRow` only mounts it — and so
          only runs the work inside it — once the row is opened. */}
      <ExpandableRow expandedContent={<ToolCallExpandedContent message={message} isLoading={isLoading} localPath={localPath} />}>
        <div className="w-5 h-5 relative flex items-center justify-center">
          {(() => {
            if (message.isError) {
              return <X className="size-4 text-destructive" />
            }
            if (isAgent) {
              return <UserRound className="size-4 text-muted-icon" />
            }
            const Icon = getToolIcon(message.toolName)

            return <Icon className="size-4 text-muted-icon" />
          })()}
        </div>
        <MetaLabel className="h-5 text-left transition-opacity duration-200 truncate">
          <AnimatedShinyText
            animate={showLoadingState}
            shimmerWidth={Math.max(20, (name?.length ?? 33) * 3)}
          >
            {name}
          </AnimatedShinyText>
        </MetaLabel>
      </ExpandableRow>
    </MetaRow>
  )
}
