/**
 * Offline comparison of the briefing budget policies on simulated runs.
 *
 *   bun scripts/briefing-budget-sim.ts [runs] [seed]
 *
 * SIMULATED. Agent spending is drawn from a made-up distribution loosely shaped on one earlier live run (scouts
 * stopped near 207k fresh tokens, a lead at 305k, the chief at 144k, the reviewer at 60k). It compares how the two
 * policies allocate a fixed budget; it does not measure real token use or savings, and its numbers must not be
 * reported as such.
 *
 * "before": the 90 % gate (no new research once 90 % of the run budget is spent, counting only reported usage) with
 * the earlier caps. "after": `authorize` from src/server/briefing-budget.ts with the current defaults.
 */
import { authorize, type BudgetPlan, type BudgetTask } from "../src/server/briefing-budget"

const RUN = 3_000_000

const BEFORE = { scout: 300_000, lead: 600_000, cross_border: 200_000, reviewer: 300_000, chief: 600_000 }
const AFTER: BudgetPlan = {
  run: RUN,
  task: { scout: 250_000, lead: 400_000, cross_border: 150_000, reviewer: 250_000, chief: 500_000 },
  reserve: { synthesis: 250_000, review: 250_000, rework: 250_000 },
  inFlightMargin: 25_000,
  wrapUpAt: 0.8,
}
const REWORK_CAP = 150_000

function rng(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

/** What an agent would spend left alone: a right-skewed draw around `typical`. */
function demand(random: () => number, typical: number) {
  return Math.round(typical * Math.exp((random() + random() + random() - 1.5) * 0.9))
}

interface Outcome { scouts: number; reviewed: boolean; reworked: boolean; secondReview: boolean; exhausted: boolean; spent: number; overshoot: number }

function simulate(policy: "before" | "after", seed: number): Outcome {
  const random = rng(seed)
  const caps = policy === "before" ? BEFORE : AFTER.task
  let spent = 0
  let exhausted = false
  const charge = (amount: number) => {
    spent += amount
    if (spent > RUN) exhausted = true
  }
  // The leads start first; each wants four scouts, at most four running at once.
  const tasks: BudgetTask[] = []
  const mayStart = (role: "lead" | "scout") => {
    if (policy === "before") return spent < RUN * 0.9
    return authorize("research", caps[role], spent, tasks, AFTER).ok
  }
  const leads: BudgetTask[] = []
  for (const id of ["us-lead", "cn-lead"]) {
    if (!mayStart("lead")) continue
    const lead: BudgetTask = { id, role: "lead", state: "running", fresh: 0, cap: caps.lead }
    tasks.push(lead)
    leads.push(lead)
  }
  let scouts = 0
  for (let wave = 0; wave < 2 && !exhausted; wave += 1) {
    const started: BudgetTask[] = []
    for (let slot = 0; slot < 4; slot += 1) {
      if (!mayStart("scout")) break
      const scout: BudgetTask = { id: `s${scouts}`, role: "scout", state: "running", fresh: 0, cap: caps.scout }
      tasks.push(scout)
      started.push(scout)
      scouts += 1
    }
    for (const scout of started) {
      // Under "after" an agent told to wrap up at 80 % of its cap stops a little past it; otherwise it runs to the cap.
      const wanted = demand(random, 180_000)
      const stop = policy === "after" && wanted > scout.cap * AFTER.wrapUpAt ? Math.round(scout.cap * (AFTER.wrapUpAt + 0.05)) : scout.cap
      scout.fresh = Math.min(wanted, stop)
      scout.state = "accepted"
      charge(scout.fresh)
    }
  }
  for (const lead of leads) {
    lead.fresh = Math.min(demand(random, 280_000), lead.cap)
    lead.state = "accepted"
    charge(lead.fresh)
  }
  if (exhausted) return { scouts, reviewed: false, reworked: false, secondReview: false, exhausted, spent, overshoot: Math.max(0, spent - RUN) }
  charge(Math.min(demand(random, 150_000), caps.chief))
  const review = () => {
    if (exhausted) return false
    if (policy === "after" && !authorize("review", caps.reviewer, spent, [], AFTER).ok) return false
    charge(Math.min(demand(random, 70_000), caps.reviewer))
    return !exhausted
  }
  const reviewed = review()
  let reworked = false
  let secondReview = false
  if (reviewed && random() < 0.6) {
    const cap = policy === "before" ? caps.lead : REWORK_CAP
    if (policy === "before" || authorize("rework", cap, spent, [], AFTER).ok) {
      charge(Math.min(demand(random, 60_000), cap) + Math.min(demand(random, 40_000), caps.chief))
      reworked = !exhausted
      secondReview = reworked && review()
    }
  }
  return { scouts, reviewed, reworked, secondReview, exhausted, spent, overshoot: Math.max(0, spent - RUN) }
}

const runs = Number(process.argv[2] ?? 1000)
const seed = Number(process.argv[3] ?? 7)
const pct = (count: number) => `${((100 * count) / runs).toFixed(1)} %`
console.log(`SIMULATED budget allocation, ${runs} runs, seed ${seed}, run budget ${RUN} fresh tokens. Not a measurement of real usage.\n`)
console.log("| Policy | Scouts started (mean) | Review ran | Rework done | Second review after rework | Ended over budget | Mean simulated spend |")
console.log("|---|---:|---:|---:|---:|---:|---:|")
for (const policy of ["before", "after"] as const) {
  const outcomes = Array.from({ length: runs }, (_, index) => simulate(policy, seed * 100_003 + index))
  const reworked = outcomes.filter((outcome) => outcome.reworked).length
  console.log(`| ${policy} | ${(outcomes.reduce((sum, outcome) => sum + outcome.scouts, 0) / runs).toFixed(2)} | ${pct(outcomes.filter((outcome) => outcome.reviewed).length)} | `
    + `${pct(reworked)} | ${reworked ? `${((100 * outcomes.filter((outcome) => outcome.secondReview).length) / reworked).toFixed(1)} %` : "—"} | `
    + `${pct(outcomes.filter((outcome) => outcome.exhausted).length)} | ${Math.round(outcomes.reduce((sum, outcome) => sum + outcome.spent, 0) / runs)} |`)
}
