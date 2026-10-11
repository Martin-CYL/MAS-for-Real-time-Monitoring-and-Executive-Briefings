type LocalizedText = Readonly<Record<"zh-CN" | "en", string>>

export interface ChangelogEntry {
  readonly version: string
  /** Release date, YYYY-MM-DD. Keep historical entries unchanged on later releases. */
  readonly date: string
  readonly title: LocalizedText
  readonly changes: readonly {
    readonly title: LocalizedText
    readonly description: LocalizedText
  }[]
}

/** Newest release first. Add a bilingual entry when updating package.json. */
export const CHANGELOG: readonly ChangelogEntry[] = [
  {
    version: "0.1.0",
    date: "2026-10-11",
    title: { "zh-CN": "初始版本", en: "Initial release" },
    changes: [
      {
        title: { "zh-CN": "Agent 对话", en: "Agent conversations" },
        description: {
          "zh-CN": "通过自然语言提出需求，查看任务执行过程与结果。",
          en: "Describe tasks in natural language and follow their progress and results.",
        },
      },
      {
        title: { "zh-CN": "会话管理", en: "Conversation history" },
        description: {
          "zh-CN": "保存历史对话，继续已有任务。",
          en: "Save conversation history and continue existing tasks.",
        },
      },
    ],
  },
]
