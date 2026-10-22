import { z } from "zod"
import type { BriefingWorkflow } from "./briefing-workflow"
import type { NexToolDefinition, NexToolResult } from "./nex-tools"

/**
 * The multi-agent briefing tools. The rules are in `briefing-workflow.ts`;
 * these are the schemas and the words the agents read. Registered only when
 * NEX_BRIEFING_WORKFLOW=1 (see `nex-tools.ts`), so the single-agent briefing
 * and every other chat see no change unless the mode is switched on.
 */

function reply(value: unknown): NexToolResult & { transcriptContent: unknown } {
  return { content: [{ type: "text", text: JSON.stringify(value) }], transcriptContent: value }
}

function workflow(context: { briefing?: BriefingWorkflow }) {
  if (!context.briefing) throw new Error("The multi-agent briefing workflow is not enabled on this Nex server.")
  return context.briefing
}

const start = z.strictObject({
  request: z.string().min(1).describe("The user's monitoring request, in full: the Chief Editor sees nothing else of this conversation."),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Last day of the reporting window. Defaults to today."),
  days: z.number().int().min(1).max(31).optional().describe("Window length in days. Defaults to the Skill's setting (7)."),
  timezone: z.string().optional().describe("Default Asia/Hong_Kong."),
  discovery: z.boolean().optional().describe("Run the Skill's scripted discovery sweep first (about a minute). Default from the Skill."),
  model: z.string().optional().describe("Model for every agent in the run. Defaults to this chat's."),
  effort: z.string().optional(),
})

const delegate = z.strictObject({
  role: z.enum(["lead", "scout"]).describe("lead: Chief Editor only, one per country. scout: country leads only."),
  country: z.enum(["us", "cn"]).optional().describe("For a lead."),
  topic: z.string().optional().describe("For a scout: one narrow research topic."),
  category: z.string().optional().describe("For a scout: a category id from references/roles/categories.json."),
  questions: z.array(z.string()).optional().describe("Concrete questions the scout must answer."),
  cases: z.array(z.string()).optional().describe("Active case IDs (A001…) the scout must recheck."),
  leads: z.array(z.string()).optional().describe("Discovery candidate IDs (D001…) worth opening."),
  brief: z.string().optional().describe("Anything else the agent needs to know."),
  retryOf: z.string().optional().describe("Task ID of a failed task to retry once, with the same assignment."),
  reworkOf: z.string().optional().describe("Chief Editor, after a review asks for rework: the accepted lead task to reopen."),
  findings: z.array(z.string()).optional().describe("With reworkOf: the review finding IDs (R001…) to fix."),
  forTaskId: z.string().optional().describe("Only when this chat holds several open tasks."),
})

const submit = z.strictObject({
  kind: z.enum(["result", "plan", "draft", "review"]).optional().describe("Chief Editor: plan, then draft. Others: leave unset."),
  taskId: z.string().optional().describe("Only when this chat holds several open tasks (a lead answering a cross-border request)."),
  partialReason: z.string().optional().describe("Chief Editor's draft only, when a country lead failed: why the run continues without it."),
})

const wait = z.strictObject({
  taskIds: z.array(z.string()).optional().describe("Defaults to every task you delegated whose result you have not received."),
  timeoutSeconds: z.number().int().min(1).max(3600).optional().describe("Default 1800. A timeout stops nothing."),
  forTaskId: z.string().optional(),
})

const crossBorder = z.strictObject({
  fromTaskId: z.string().describe("The lead task that raised the question, or chief for your own."),
  toCountry: z.enum(["us", "cn"]).describe("The lead that should answer."),
  question: z.string().min(1),
  eventIds: z.array(z.string()).min(1).describe("Event IDs in fromTaskId's records that the question rests on."),
  scope: z.string().min(1),
  evidenceRequired: z.string().min(1).describe("What evidence would answer it."),
})

const status = z.strictObject({
  runId: z.string().optional().describe("Defaults to the run this chat belongs to or started."),
})

export const BRIEFING_TOOLS: readonly NexToolDefinition[] = [
  {
    name: "briefing_start",
    description: "Start a multi-agent US-China AI and semiconductor briefing run (us-china-ai-chip-briefing Skill). Use only when the user explicitly asks for the multi-agent briefing. Creates the run directory and the Chief Editor sub-chat, which reports back here when the run ends. Returns at once.",
    schema: start,
    async execute(input, context) {
      return reply(await workflow(context).start(context.chatId, context.cwd, start.parse(input)))
    },
  },
  {
    name: "briefing_delegate",
    description: "In a briefing run: hand a research task to a new agent. The Chief Editor delegates country leads (after its plan is accepted); a country lead delegates topic scouts. Nex checks roles and budgets, prepares the task directory and starts the agent, or queues it when the concurrency budget is full. Also retries a failed task (retryOf) and sends review rework to a lead (reworkOf).",
    schema: delegate,
    async execute(input, context) {
      return reply(await workflow(context).delegate(context.chatId, context.cwd, delegate.parse(input)))
    },
  },
  {
    name: "briefing_wait",
    description: "In a briefing run: wait until the tasks you delegated have ended, then return each one's accepted result (output, check findings, record summary) or its explicit failure. Accepted research records are merged into your task directory before this returns. Queued tasks are started as slots free.",
    schema: wait,
    async execute(input, context) {
      return reply(await workflow(context).wait(context.chatId, context.cwd, wait.parse(input), context.signal))
    },
  },
  {
    name: "briefing_submit",
    description: "In a briefing run: hand in your task's result. Nex validates output.json (findings.json for the reviewer, plan.json or the draft for the Chief Editor) and runs the Skill's checks on your records. A refusal lists what to fix; submit again after fixing. Your task counts as done only when a submission is accepted.",
    schema: submit,
    async execute(input, context) {
      return reply(await workflow(context).submit(context.chatId, context.cwd, submit.parse(input)))
    },
  },
  {
    name: "briefing_cross_border",
    description: "Chief Editor in a briefing run: send an evidence-backed question from one country's research to the other country's lead. The request names the events it rests on, its scope and the evidence required; the answer comes back as a task (briefing_wait) with its own records.",
    schema: crossBorder,
    async execute(input, context) {
      return reply(await workflow(context).crossBorder(context.chatId, context.cwd, crossBorder.parse(input)))
    },
  },
  {
    name: "briefing_status",
    description: "Read a briefing run's stage, status, budgets and every task with its chat and state.",
    schema: status,
    async execute(input, context) {
      return reply(await workflow(context).status(context.chatId, context.cwd, status.parse(input)))
    },
  },
]
