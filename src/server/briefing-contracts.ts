import { z } from "zod"

/**
 * The files agents hand to the briefing workflow (`briefing-workflow.ts`).
 *
 * These are envelopes only. The facts travel in the Skill's run records
 * (sources.json, events.json, evidence_ledger.json), which the Skill's own
 * `check_handoff.py` validates; these schemas check that each agent said
 * what its parent needs to act on: status, gaps, questions, verdicts.
 */

export const BRIEFING_ROLES = ["chief", "lead", "scout", "cross_border", "reviewer"] as const
export type BriefingRole = (typeof BRIEFING_ROLES)[number]
export const BRIEFING_COUNTRIES = ["us", "cn"] as const
export type BriefingCountry = (typeof BRIEFING_COUNTRIES)[number]

const text = z.string().trim().min(1)
const eventId = z.string().regex(/^E\d{3,}$/, "event IDs look like E001")
const claimId = z.string().regex(/^C\d{3,}$/, "claim IDs look like C001")

const research = {
  task_id: text,
  status: z.enum(["complete", "partial"]),
  summary: text,
  partial_reason: z.string().optional(),
  source_issues: z.array(z.object({ url: z.string(), problem: text })).default([]),
  open_questions: z.array(z.string()).default([]),
}

function partialNeedsReason(value: { status: string; partial_reason?: string }, ctx: z.RefinementCtx) {
  if (value.status === "partial" && !value.partial_reason?.trim()) {
    ctx.addIssue({ code: "custom", path: ["partial_reason"], message: "a partial result needs partial_reason" })
  }
}

export const scoutOutputSchema = z.object(research).superRefine(partialNeedsReason)

export const crossBorderRequestSchema = z.object({
  question: text,
  event_ids: z.array(eventId).min(1),
  scope: text,
  evidence_required: text,
})

export const leadOutputSchema = z.object({
  ...research,
  gaps: z.array(z.object({ task_id: z.string().optional(), topic: z.string().optional(), reason: text })).default([]),
  cross_border_requests: z.array(crossBorderRequestSchema).default([]),
}).superRefine(partialNeedsReason)

export const crossBorderOutputSchema = z.object({
  ...research,
  answer: text,
  remaining_uncertainty: text,
}).superRefine(partialNeedsReason)

const countryPlan = z.object({
  brief: text,
  categories: z.array(text).min(1),
  cases: z.array(z.string().regex(/^A\d{3,}$/)).default([]),
})

export const planSchema = z.object({
  focus: text,
  countries: z.object({ us: countryPlan, cn: countryPlan }),
  cross_border_watch: z.array(z.string()).default([]),
})

export const reviewFindingSchema = z.object({
  id: z.string().regex(/^R\d{3,}$/, "finding IDs look like R001"),
  severity: z.enum(["blocker", "major", "minor"]),
  category: z.enum(["omission", "unsupported_claim", "causal_overreach", "inconsistency", "fact_status", "narrative", "other"]),
  target: z.object({
    claim_id: claimId.optional(),
    event_id: eventId.optional(),
    section: z.string().optional(),
    source_url: z.string().optional(),
  }).refine((target) => Object.values(target).some((value) => typeof value === "string" && value.trim()), "give at least one target field"),
  problem: text,
  evidence: text,
  suggested_fix: z.string().optional(),
})

export const reviewSchema = z.object({
  verdict: z.enum(["pass", "rework"]),
  summary: text,
  findings: z.array(reviewFindingSchema).default([]),
}).superRefine((value, ctx) => {
  const serious = value.findings.some((finding) => finding.severity !== "minor")
  if (value.verdict === "pass" && serious) {
    ctx.addIssue({ code: "custom", path: ["verdict"], message: "a blocker or major finding means verdict rework" })
  }
  if (value.verdict === "rework" && !serious) {
    ctx.addIssue({ code: "custom", path: ["verdict"], message: "rework needs at least one blocker or major finding" })
  }
  const ids = value.findings.map((finding) => finding.id)
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: ["findings"], message: "finding IDs must be unique" })
})

export type ScoutOutput = z.infer<typeof scoutOutputSchema>
export type LeadOutput = z.infer<typeof leadOutputSchema>
export type CrossBorderOutput = z.infer<typeof crossBorderOutputSchema>
export type BriefingPlan = z.infer<typeof planSchema>
export type BriefingReview = z.infer<typeof reviewSchema>
export type ReviewFinding = z.infer<typeof reviewFindingSchema>

export function outputSchemaFor(role: BriefingRole) {
  switch (role) {
    case "lead": return leadOutputSchema
    case "cross_border": return crossBorderOutputSchema
    default: return scoutOutputSchema
  }
}

/** Zod issues as one line each, for an agent to fix. */
export function describeIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join(".") || "(file)"}: ${issue.message}`)
}
