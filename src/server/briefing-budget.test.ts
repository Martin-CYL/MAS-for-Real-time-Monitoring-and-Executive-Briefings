import { describe, expect, test } from "bun:test"
import { authorize, type BudgetPlan, type BudgetTask, reserveTotal, snapshot, wrapUpCandidates } from "./briefing-budget"
import type { BriefingRole } from "./briefing-contracts"

/**
 * The allocation policy over many generated runs. The generator varies run
 * sizes, caps, reserves, task counts and spending, so the properties below
 * are checked against no particular run.
 */

function rng(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

const ROLES: BriefingRole[] = ["lead", "scout", "cross_border", "reviewer", "chief"]
const STATES: BudgetTask["state"][] = ["queued", "running", "accepted", "failed", "cancelled"]

function generate(seed: number) {
  const random = rng(seed)
  const int = (low: number, high: number) => Math.floor(low + random() * (high - low))
  const run = int(200_000, 5_000_000)
  const plan: BudgetPlan = {
    run,
    task: { scout: int(10_000, run / 4), lead: int(10_000, run / 3), cross_border: int(10_000, run / 5), reviewer: int(10_000, run / 4), chief: int(10_000, run / 3) },
    reserve: { synthesis: int(0, run / 8), review: int(0, run / 8), rework: int(0, run / 8) },
    inFlightMargin: int(0, 50_000),
    wrapUpAt: 0.5 + random() * 0.5,
  }
  const tasks: BudgetTask[] = Array.from({ length: int(0, 12) }, (_, index) => {
    const role = ROLES[int(0, ROLES.length)]!
    const cap = plan.task[role]
    return { id: `t${index}`, role, state: STATES[int(0, STATES.length)]!, fresh: int(0, cap * 1.2), cap }
  })
  const spent = tasks.reduce((sum, task) => sum + task.fresh, 0) + int(0, run / 10)
  return { plan, tasks, spent }
}

describe("budget plan", () => {
  test("authorised research never eats into the reserve, even with every running agent spending its whole cap", () => {
    for (let seed = 1; seed <= 2_000; seed += 1) {
      const { plan, tasks, spent } = generate(seed)
      for (const role of ["lead", "scout", "cross_border"] as const) {
        const decision = authorize("research", plan.task[role], spent, tasks, plan)
        const worstCase = spent + decision.snapshot.outstanding + decision.requested
        if (decision.ok) expect(worstCase + reserveTotal(plan)).toBeLessThanOrEqual(plan.run)
        else expect(decision.reason).toContain("fresh tokens")
      }
    }
  })

  test("while research is refused for lack of budget, a review can still be authorised from the reserve", () => {
    let checked = 0
    for (let seed = 1; seed <= 2_000; seed += 1) {
      const { plan, tasks, spent } = generate(seed)
      const research = authorize("research", plan.task.scout, spent, tasks, plan)
      const review = authorize("review", plan.task.reviewer, spent, tasks, plan)
      const reviewFits = spent + review.snapshot.outstanding + plan.task.reviewer + plan.inFlightMargin <= plan.run
      expect(review.ok).toBe(reviewFits)
      if (!research.ok && review.ok) checked += 1
    }
    expect(checked).toBeGreaterThan(0)
  })

  test("rework always leaves room for the second review", () => {
    for (let seed = 1; seed <= 2_000; seed += 1) {
      const { plan, tasks, spent } = generate(seed)
      const decision = authorize("rework", plan.task.lead, spent, tasks, plan)
      if (decision.ok) expect(spent + decision.snapshot.outstanding + decision.requested + plan.reserve.review).toBeLessThanOrEqual(plan.run)
    }
  })

  test("a refusal says whether waiting for running agents can help", () => {
    const plan: BudgetPlan = { run: 1_000, task: { scout: 200, lead: 300, cross_border: 100, reviewer: 200, chief: 300 },
      reserve: { synthesis: 100, review: 100, rework: 100 }, inFlightMargin: 10, wrapUpAt: 0.8 }
    const running: BudgetTask[] = [{ id: "a", role: "scout", state: "running", fresh: 0, cap: 200 }, { id: "b", role: "scout", state: "running", fresh: 0, cap: 200 }]
    const busy = authorize("research", 200, 100, running, plan)
    expect(busy).toMatchObject({ ok: false, fitsLater: true })
    expect(busy.reason).toContain("may release enough")
    const broke = authorize("research", 200, 600, [], plan)
    expect(broke).toMatchObject({ ok: false, fitsLater: false })
    expect(broke.reason).toContain("cannot afford")
  })

  test("over-cap agents are counted as committing nothing more, not a negative amount", () => {
    const plan: BudgetPlan = { run: 1_000, task: { scout: 100, lead: 100, cross_border: 100, reviewer: 100, chief: 100 },
      reserve: { synthesis: 0, review: 0, rework: 0 }, inFlightMargin: 5, wrapUpAt: 0.8 }
    const tasks: BudgetTask[] = [{ id: "a", role: "scout", state: "running", fresh: 180, cap: 100 }]
    expect(snapshot(180, tasks, plan).outstanding).toBe(5)
  })

  test("wrap-up: near its own cap, or everyone when research would reach the reserve; each agent once", () => {
    const plan: BudgetPlan = { run: 10_000, task: { scout: 1_000, lead: 2_000, cross_border: 500, reviewer: 1_000, chief: 2_000 },
      reserve: { synthesis: 1_000, review: 1_000, rework: 1_000 }, inFlightMargin: 0, wrapUpAt: 0.8 }
    const tasks: BudgetTask[] = [
      { id: "near", role: "scout", state: "running", fresh: 850, cap: 1_000 },
      { id: "fresh", role: "scout", state: "running", fresh: 100, cap: 1_000 },
      { id: "done", role: "scout", state: "accepted", fresh: 990, cap: 1_000 },
      { id: "chief", role: "chief", state: "running", fresh: 1_900, cap: 2_000 },
    ]
    expect(wrapUpCandidates(3_000, tasks, plan, new Set()).map((entry) => entry.id)).toEqual(["near"])
    expect(wrapUpCandidates(3_000, tasks, plan, new Set(["near"]))).toEqual([])
    // Research may now spend only 500 more, less than the running scouts' remaining caps.
    expect(wrapUpCandidates(6_500, tasks, plan, new Set()).map((entry) => [entry.id, entry.reason]))
      .toEqual([["near", "run research budget"], ["fresh", "run research budget"]])
  })
})
