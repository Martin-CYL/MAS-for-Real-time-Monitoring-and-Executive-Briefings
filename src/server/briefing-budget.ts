import type { BriefingRole } from "./briefing-contracts"

/**
 * Token budget planning for a briefing run: whether another agent may start
 * now, given what the run has spent, what its running agents may still spend
 * and what the mandatory stages after research need.
 *
 * Pure functions over a snapshot, so the allocation policy can be tested and,
 * later, swapped or compared without touching the workflow controller.
 *
 * All figures are fresh tokens (uncached input + output) as the provider
 * reports them per request. A running agent may spend up to its cap plus an
 * in-flight margin before Nex can stop it, so that whole amount is counted as
 * committed. The result is a conservative plan, not a hard cap: the provider
 * reports usage only after each request.
 */

export type BudgetStage = "research" | "review" | "rework"

export interface BudgetPlan {
  /** Ceiling for the whole run. */
  run: number
  /** Ceiling per task, by role. A reopened lead gets `rework` for its rework window instead. */
  task: Record<BriefingRole, number>
  /** Held back from research for the stages every report needs. */
  reserve: { synthesis: number; review: number; rework: number }
  /** What one request may still add after the last reported one. */
  inFlightMargin: number
  /** Fraction of its cap at which a research agent is told to wrap up. */
  wrapUpAt: number
}

export interface BudgetTask {
  id: string
  role: BriefingRole
  state: "queued" | "running" | "accepted" | "failed" | "cancelled"
  /** Fresh tokens counted against this task's current cap. */
  fresh: number
  /** The task's current cap (its role's, or the rework allowance while reworking). */
  cap: number
}

export interface BudgetSnapshot {
  spent: number
  /** What running agents may still spend: up to their caps, plus the in-flight margin each. */
  outstanding: number
  reserve: number
  /** What a new research task may still be given. */
  researchAvailable: number
  run: number
}

const RESEARCH_ROLES: ReadonlySet<BriefingRole> = new Set(["lead", "scout", "cross_border"])

/** The chief's own spending is covered by the synthesis reserve, so it is not counted as outstanding. */
function outstanding(tasks: BudgetTask[], plan: BudgetPlan, roles: (role: BriefingRole) => boolean) {
  return tasks
    .filter((task) => task.state === "running" && roles(task.role))
    .reduce((sum, task) => sum + Math.max(0, task.cap - task.fresh) + plan.inFlightMargin, 0)
}

export function reserveTotal(plan: BudgetPlan) {
  return plan.reserve.synthesis + plan.reserve.review + plan.reserve.rework
}

export function snapshot(spent: number, tasks: BudgetTask[], plan: BudgetPlan): BudgetSnapshot {
  const out = outstanding(tasks, plan, (role) => role !== "chief")
  const reserve = reserveTotal(plan)
  return { spent, outstanding: out, reserve, researchAvailable: Math.max(0, plan.run - spent - out - reserve), run: plan.run }
}

export interface Authorization {
  ok: boolean
  /** The worst case this start adds: the task's cap plus the in-flight margin. */
  requested: number
  snapshot: BudgetSnapshot
  reason?: string
  /** Refused now, but would fit once the running agents have finished and released what they did not spend. */
  fitsLater?: boolean
}

/**
 * May an agent for `stage` start now? Research must leave the whole reserve
 * untouched. A review may use the review and rework reserves; rework may use
 * the rework reserve but must leave a second review possible.
 */
export function authorize(stage: BudgetStage, cap: number, spent: number, tasks: BudgetTask[], plan: BudgetPlan): Authorization {
  const snap = snapshot(spent, tasks, plan)
  const requested = cap + plan.inFlightMargin
  const held = stage === "research" ? snap.reserve : stage === "rework" ? plan.reserve.review : 0
  const free = plan.run - spent - snap.outstanding - held
  if (requested <= free) return { ok: true, requested, snapshot: snap }
  const fitsLater = requested <= plan.run - spent - held
  const label = stage === "research" ? "new research" : stage === "rework" ? "rework" : "an independent review"
  const keep = held > 0 ? `, keeping ${held} for ${stage === "research" ? "synthesis, review and rework" : "a second review"}` : ""
  return {
    ok: false,
    requested,
    snapshot: snap,
    fitsLater,
    reason: `${label} needs up to ${requested} fresh tokens but only ${Math.max(0, free)} remain${keep}`
      + (fitsLater ? "; running agents may release enough when they finish" : "; the run cannot afford it"),
  }
}

/**
 * Running research agents that should wrap up now: near their own cap, or
 * when what research may still spend no longer covers everyone's remaining
 * caps. Each is told once (`alreadyWarned`).
 */
export function wrapUpCandidates(spent: number, tasks: BudgetTask[], plan: BudgetPlan, alreadyWarned: ReadonlySet<string>) {
  const research = tasks.filter((task) => task.state === "running" && RESEARCH_ROLES.has(task.role) && !alreadyWarned.has(task.id))
  const poolLeft = plan.run - spent - reserveTotal(plan)
  const committed = outstanding(tasks, plan, (role) => RESEARCH_ROLES.has(role))
  const poolShort = committed > poolLeft
  return research
    .filter((task) => poolShort || task.fresh >= task.cap * plan.wrapUpAt)
    .map((task) => ({ id: task.id, reason: poolShort ? "run research budget" : "task budget" as const }))
}
