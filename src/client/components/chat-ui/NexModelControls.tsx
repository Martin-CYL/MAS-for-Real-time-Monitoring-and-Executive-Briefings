import { useCallback, useEffect, useRef, useState } from "react"
import { Box, Brain } from "lucide-react"
import type { NexSocket } from "../../app/socket"
import type { ComposerController } from "../../hooks/useComposer"
import { useChatPreferencesStore } from "../../stores/chatPreferencesStore"
import { useLocale } from "../../i18n/useTranslation"
import { t } from "../../i18n/translate"
import { codexReasoningEffortLabel, resolveModelLabel, type ProviderCatalogEntry } from "../../../shared/types"
import { InputPopover, ModelPickerList, PopoverMenuItem } from "./ChatPreferenceControls"

/** The ordinary Nex surface reuses Kanna's pickers without provider/speed controls. */
export function NexModelControls({ socket, composer, chatId, disabled, onSavingChange }: {
  socket: NexSocket
  composer: ComposerController
  chatId: string | null
  disabled: boolean
  onSavingChange: (saving: boolean) => void
}) {
  useLocale()
  const [catalog, setCatalog] = useState<ProviderCatalogEntry | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  const pending = useRef(false)
  const state = composer.effectiveState
  const model = state.model
  const effort = "reasoningEffort" in state.modelOptions ? state.modelOptions.reasoningEffort : "medium"
  const selected = catalog?.models.find((option) => option.id === model)
  const options = selected?.supportedReasoningEfforts ?? []

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await socket.command<ProviderCatalogEntry>({ type: "models.listCodex" })
      if (alive.current) setCatalog(result)
    } catch {
      if (alive.current) {
        setCatalog(null)
        setError("Unable to load models. Please retry.")
      }
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [socket])

  useEffect(() => {
    alive.current = true
    void refresh()
    return () => { alive.current = false }
  }, [refresh])

  // Nex exposes a single harness. Old chats may still carry another harness's preference.
  useEffect(() => {
    if (!disabled && state.provider !== "codex") composer.selectProvider("codex")
  }, [disabled, state.provider, composer.selectProvider])

  useEffect(() => {
    onSavingChange(saving || loading || state.provider !== "codex")
    return () => onSavingChange(false)
  }, [saving, loading, state.provider, onSavingChange])

  async function select(nextModel: string, nextEffort: string) {
    if (disabled || pending.current || !catalog) return
    pending.current = true
    setSaving(true)
    onSavingChange(true)
    setError(null)
    try {
      if (chatId) await socket.command({ type: "chat.setCodexPreferences", chatId, model: nextModel, reasoningEffort: nextEffort })
      if (!alive.current) return
      if (state.provider !== "codex") composer.selectProvider("codex")
      useChatPreferencesStore.getState().setComposerState(composer.composerChatId, {
        provider: "codex", model: nextModel,
        modelOptions: { reasoningEffort: nextEffort, fastMode: false },
        planMode: false, autoPlan: false,
      }, catalog.models)
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      pending.current = false
      if (alive.current) setSaving(false)
    }
  }

  return (
    <div className="min-w-0 flex flex-col items-start md:items-center" data-testid="nex-model-controls">
      <div className="flex max-w-full flex-wrap items-center gap-0.5">
        <InputPopover disabled={disabled || loading || saving || !catalog} trigger={
          <><Box className="h-3.5 w-3.5" /><span>{resolveModelLabel(catalog?.models, model)}</span></>
        }>
          {(close) => <ModelPickerList models={catalog?.models ?? []} selectedModel={model} onSelect={(nextModel) => {
            const next = catalog?.models.find((candidate) => candidate.id === nextModel)
            if (!next) return
            const supported = next.supportedReasoningEfforts ?? []
            const nextEffort = supported.some((option) => option.id === effort)
              ? effort : next.defaultReasoningEffort ?? supported[0]?.id ?? ""
            close()
            void select(nextModel, nextEffort)
          }} />}
        </InputPopover>
        <InputPopover disabled={disabled || loading || saving || !catalog || options.length === 0} trigger={
          <><Brain className="h-3.5 w-3.5" /><span>{t("Reasoning: {0}", { 0: t(codexReasoningEffortLabel(effort)) })}</span></>
        }>
          {(close) => options.map((option) => <PopoverMenuItem key={option.id}
            selected={option.id === effort} icon={<Brain className="h-4 w-4 text-muted-foreground" />}
            label={t(codexReasoningEffortLabel(option.id))}
            onClick={() => { close(); void select(model, option.id) }} />)}
        </InputPopover>
      </div>
      {error && <div role="alert" className="max-w-80 whitespace-normal px-2 text-xs text-destructive">
        {t(error)} <button className="underline" disabled={loading || saving} onClick={() => void refresh()}>{t("Retry")}</button>
      </div>}
    </div>
  )
}
