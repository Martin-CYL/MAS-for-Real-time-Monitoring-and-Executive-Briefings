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

/** A media-lane scout's pointer to the document or statement a reported event rests on (source lanes). */
export const primaryLeadSchema = z.object({
  event_id: eventId,
  agency: text,
  document_hint: text,
  url_hint: z.string().optional(),
  why: z.string().optional(),
})

/** A follow-up scout's answer for one primary lead it was given. */
export const leadResultSchema = z.object({
  lead_id: z.string().regex(/^L\d{3,}$/, "lead IDs look like L001"),
  outcome: z.enum(["found", "not_found"]),
  event_id: eventId.optional(),
  note: z.string().default(""),
}).superRefine((value, ctx) => {
  if (value.outcome === "found" && !value.event_id) ctx.addIssue({ code: "custom", path: ["event_id"], message: "a found lead names the event that records it" })
  if (value.outcome === "not_found" && !value.note.trim()) ctx.addIssue({ code: "custom", path: ["note"], message: "a lead not found needs a note saying what was searched" })
})

export const scoutOutputSchema = z.object({
  ...research,
  primary_leads: z.array(primaryLeadSchema).optional(),
  lead_results: z.array(leadResultSchema).optional(),
}).superRefine(partialNeedsReason)

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
export type PrimaryLeadOutput = z.infer<typeof primaryLeadSchema>
export type LeadResult = z.infer<typeof leadResultSchema>
export type LeadOutput = z.infer<typeof leadOutputSchema>
export type CrossBorderOutput = z.infer<typeof crossBorderOutputSchema>
export type BriefingPlan = z.infer<typeof planSchema>
export type BriefingReview = z.infer<typeof reviewSchema>
export type ReviewFinding = z.infer<typeof reviewFindingSchema>
export type BriefingVerification = z.infer<typeof verificationSchema>

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
