import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { NexIcon } from "../client/components/NexIcon"
import { useTranslation } from "../client/i18n/useTranslation"
import "@fontsource-variable/bricolage-grotesque"
import { ChatTranscriptViewport, type TranscriptScrollHandle } from "../client/app/ChatPage/ChatTranscriptViewport"
import { getLatestToolIds } from "../client/app/derived"
import { TranscriptRenderOptionsProvider } from "../client/components/messages/render-context"
import { TooltipProvider } from "../client/components/ui/tooltip"
import { ViewerLayer } from "../client/components/viewer/ViewerLayer"
import { processTranscriptMessages } from "../client/lib/parseTranscript"
import { syncThemeMetadata } from "../client/hooks/useTheme"
import type { AskUserQuestionItem } from "../client/components/messages/types"
import { APP_NAME } from "../shared/branding"
import type { AskUserQuestionAnswerMap, StandaloneTranscriptBundle } from "../shared/types"
import "../index.css"

type ViewerState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; bundle: StandaloneTranscriptBundle }

function StandaloneTranscriptApp() {
  const { t, locale, setLocale } = useTranslation()
  const [state, setState] = useState<ViewerState>({ status: "loading" })
  const [isAtEnd, setIsAtEnd] = useState(true)
  const listRef = useRef<TranscriptScrollHandle | null>(null)

  useEffect(() => {
    let cancelled = false

    void fetch(new URL("./transcript.json", document.baseURI).toString(), {
      headers: {
        Accept: "application/json",
      },
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Transcript request failed with status ${response.status}`)
        }

        return await response.json() as StandaloneTranscriptBundle
      })
      .then((bundle) => {
        if (cancelled) return
        setState({ status: "ready", bundle })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "Unable to load transcript.",
        })
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (state.status !== "ready") {
      return
    }

    document.title = `${state.bundle.title} | ${APP_NAME}`
    document.documentElement.classList.toggle("dark", state.bundle.theme === "dark")
    document.documentElement.style.colorScheme = state.bundle.theme

    const frameId = window.requestAnimationFrame(() => {
      syncThemeMetadata(state.bundle.theme)
    })

    return () => {
      window.cancelAnimationFrame(frameId)
    }
  }, [state])

  const messages = useMemo(
    () => state.status === "ready" ? processTranscriptMessages(state.bundle.messages) : [],
    [state],
  )
  const latestToolIds = useMemo(() => getLatestToolIds(messages), [messages])

  const noop = useCallback(() => undefined, [])
  const noopPromise = useCallback(() => Promise.resolve(), [])
  const handleAskUserQuestion = useCallback((
    _toolUseId: string,
    _questions: AskUserQuestionItem[],
    _answers: AskUserQuestionAnswerMap,
  ) => Promise.resolve(), [])
  const handleExitPlanMode = useCallback((
    _toolUseId: string,
    _confirmed: boolean,
    _clearContext?: boolean,
    _message?: string,
  ) => Promise.resolve(), [])
  const handleOpenLocalLink = useCallback(() => Promise.resolve(), [])
  const scrollToBottom = useCallback(() => {
    listRef.current?.scrollToEnd()
  }, [])

  if (state.status === "loading") {
    return (
      <div className="flex h-full items-center justify-center bg-background text-sm text-muted-foreground">
        {t("Loading shared conversation…")}
      </div>
    )
  }

  if (state.status === "error") {
    return (
      <div className="flex h-full items-center justify-center bg-background px-6">
        <div className="max-w-md rounded-2xl border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-foreground">
          {t("Unable to load this shared conversation. The link may no longer be available.")}
        </div>
      </div>
    )
  }

  return (
    <TranscriptRenderOptionsProvider
      value={{
        readonly: true,
        localLinkMode: "text",
        sourceOrigin: state.bundle.sourceOrigin ?? null,
        attachmentMode: state.bundle.attachmentMode,
      }}
    >
      <TooltipProvider>
      <div className="relative h-full bg-background">
        {/* The same viewer the app has, for the attachments and charts in the
            transcript, over the whole page since there's no chat column here. */}
        <ViewerLayer className="fixed" />
        <div className="flex h-full min-h-0 flex-col overflow-hidden">
          <header className="flex-shrink-0 border-b border-border px-4">
            <div className="mx-auto flex h-16 w-full items-center gap-2 min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <div className="flex flex-shrink-0 items-center gap-2">
                  <NexIcon className="h-6 w-6" />
                  <span className="font-logo text-lg">{APP_NAME}</span>
                </div>
                <span className="hidden text-sm text-muted-foreground sm:inline">/</span>
                <span className="truncate text-sm text-muted-foreground">{state.bundle.title}</span>
              </div>
              <div className="flex-1" />
              <select aria-label={t("Language")} value={locale} onChange={e => setLocale(e.target.value === "en" ? "en" : "zh-CN")} className="rounded-lg border border-border bg-background p-2 text-sm">
                <option value="zh-CN">中文</option><option value="en">English</option>
              </select>
            </div>
          </header>

          <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
          <ChatTranscriptViewport
            activeChatId={state.bundle.chatId}
            listRef={listRef}
            messages={messages}
            queuedMessages={[]}
            transcriptPaddingBottom={32}
            localPath={state.bundle.localPath}
            latestToolIds={latestToolIds}
            isProcessing={false}
            runtimeStatus={null}
            isDraining={false}
            commandError={null}
            onStopDraining={noop}
            onSteerQueuedMessage={noopPromise}
            onRemoveQueuedMessage={noopPromise}
            onOpenLocalLink={handleOpenLocalLink}
            onAskUserQuestionSubmit={handleAskUserQuestion}
            onExitPlanModeConfirm={handleExitPlanMode}
            showScrollButton={!isAtEnd && messages.length > 0}
            onIsAtEndChange={setIsAtEnd}
            scrollToBottom={scrollToBottom}
            typedEmptyStateText=""
            isEmptyStateTypingComplete
            isPageFileDragActive={false}
            showEmptyState={false}
            headerOffsetPx={20}
          />

          </div>
        </div>
      </div>
      </TooltipProvider>
    </TranscriptRenderOptionsProvider>
  )
}

const container = document.getElementById("root")

if (!container) {
  throw new Error("Missing #root")
}

createRoot(container).render(
  <StrictMode>
    <StandaloneTranscriptApp />
  </StrictMode>,
)
