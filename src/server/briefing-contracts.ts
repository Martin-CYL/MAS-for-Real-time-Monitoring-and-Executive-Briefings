import { z } from "zod"

/**
 * The files agents hand to the briefing workflow (`briefing-workflow.ts`).
 *
 * These are envelopes only. The facts travel in the Skill's run records
 * (sources.json, events.json, evidence_ledger.json), which the Skill's own
 * `check_handoff.py` validates; these schemas check that each agent said
 * what its parent needs to act on: status, gaps, questions, verdicts.
 */

export const BRIEFING_ROLES = ["chief", "lead", "scout", "cross_border", "reviewer", "verifier"] as const
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

const gapId = z.string().regex(/^G\d{3,}$/, "gap IDs look like G001")
export const GAP_OUTCOMES = ["filled", "searched_none", "not_reached"] as const

/**
 * What a lead reopened for the gap round says it did about one gap. The envelope only: whether the records show
 * it is the Skill's `brief.py gap-check`, run by the workflow once the round ends.
 */
export const gapResultSchema = z.object({
  gap_id: gapId,
  outcome: z.enum(GAP_OUTCOMES),
  event_ids: z.array(eventId).default([]),
  claim_ids: z.array(claimId).default([]),
  searched: z.array(z.string()).default([]),
  note: z.string().optional(),
  reason: z.string().optional(),
}).superRefine((value, ctx) => {
  if (value.outcome === "filled" && value.event_ids.length + value.claim_ids.length === 0) {
    ctx.addIssue({ code: "custom", path: ["event_ids"], message: `${value.gap_id}: a filled gap names the event_ids or claim_ids that fill it` })
  }
  if (value.outcome === "searched_none" && value.searched.filter((entry) => entry.trim()).length < 2) {
    ctx.addIssue({ code: "custom", path: ["searched"], message: `${value.gap_id}: searched_none lists at least 2 searches (also logged with brief.py search)` })
  }
  if (value.outcome === "not_reached" && !value.reason?.trim()) {
    ctx.addIssue({ code: "custom", path: ["reason"], message: `${value.gap_id}: not_reached needs a reason` })
  }
})

export const leadOutputSchema = z.object({
  ...research,
  gaps: z.array(z.object({ task_id: z.string().optional(), topic: z.string().optional(), reason: text })).default([]),
  cross_border_requests: z.array(crossBorderRequestSchema).default([]),
  /** Only after the lead was reopened for the gap round: one entry per gap it was given. */
  gap_results: z.array(gapResultSchema).optional(),
}).superRefine(partialNeedsReason)

/** The Chief Editor's decision on every gap the gap check listed (`gap_plan.json`). */
export const gapPlanSchema = z.object({
  decisions: z.array(z.object({
    gap_id: gapId,
    action: z.enum(["pursue", "skip"]),
    /** For a gap whose side is both or other and that has no lead of origin: the lead that pursues it. */
    side: z.enum(BRIEFING_COUNTRIES).optional(),
    brief: z.string().optional(),
    reason: z.string().optional(),
  }).superRefine((value, ctx) => {
    if (value.action === "skip" && !value.reason?.trim()) {
      ctx.addIssue({ code: "custom", path: ["reason"], message: `${value.gap_id}: a skipped gap needs a reason` })
    }
  })),
})

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

/** A later reviewer's verdict on an earlier finding (a review's or a verifier's), by its key (`review-1/R001`, `verify-1/V001`). */
export const previousAssessmentSchema = z.object({
  key: z.string().regex(/^(review|verify)-\d+(-a\d+)?\/[RV]\d{3,}$/, "keys look like review-1/R001 or verify-1/V001"),
  status: z.enum(["resolved", "unresolved"]),
  note: text,
})

export const reviewSchema = z.object({
  verdict: z.enum(["pass", "rework"]),
  summary: text,
  findings: z.array(reviewFindingSchema).default([]),
  previous: z.array(previousAssessmentSchema).default([]),
}).superRefine((value, ctx) => {
  const serious = value.findings.some((finding) => finding.severity !== "minor")
  if (value.verdict === "pass" && serious) {
    ctx.addIssue({ code: "custom", path: ["verdict"], message: "a blocker or major finding means verdict rework" })
  }
  // An earlier finding still unresolved also justifies rework; its severity is checked by the workflow.
  if (value.verdict === "rework" && !serious && !value.previous.some((entry) => entry.status === "unresolved")) {
    ctx.addIssue({ code: "custom", path: ["verdict"], message: "rework needs at least one blocker or major finding" })
  }
  const ids = value.findings.map((finding) => finding.id)
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: ["findings"], message: "finding IDs must be unique" })
})

export const VERIFICATION_VERDICTS = ["confirmed", "contradicted", "scope_differs", "status_differs", "not_found"] as const

/**
 * A verifier's `verification.json`. The envelope only: the Skill's `check_handoff.py --role verifier` checks that
 * each verdict covers an assigned claim and that its evidence is the verifier's own recorded claims.
 */
export const verificationSchema = z.object({
  results: z.array(z.object({
    claim_id: claimId,
    verdict: z.enum(VERIFICATION_VERDICTS),
    found_status: z.enum(["enacted", "proposed", "suspended", "expired", "reported", "unknown"]).optional(),
    evidence: z.array(claimId).default([]),
    note: text,
  })).min(1),
})

export type ScoutOutput = z.infer<typeof scoutOutputSchema>
export type LeadOutput = z.infer<typeof leadOutputSchema>
export type CrossBorderOutput = z.infer<typeof crossBorderOutputSchema>
export type BriefingPlan = z.infer<typeof planSchema>
export type BriefingReview = z.infer<typeof reviewSchema>
export type ReviewFinding = z.infer<typeof reviewFindingSchema>
export type BriefingVerification = z.infer<typeof verificationSchema>
export type GapResult = z.infer<typeof gapResultSchema>
export type GapPlan = z.infer<typeof gapPlanSchema>

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
