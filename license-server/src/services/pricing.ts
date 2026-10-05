// Per-user price slabs. The whole order is priced at the slab its user count
// falls into (e.g. 1–25 users ₹1,200/user, 26–100 ₹1,000/user, 101+ ₹850/user).
//   Subscription plans (term_months > 0): price per user per year, AMC included.
//   Perpetual plans (term_months = 0): one-time price per user; AMC yearly at amc_pct %
//   of the licence price (first year included).
export interface Slab {
  upTo: number | null;
  pricePerUser: number;
}

export interface PlanPricing {
  slabs: Slab[];
  amc_pct: number;
  term_months: number;
  min_users: number;
}

export interface Quote {
  users: number;
  years: number;
  unitPrice: number;
  base: number;
  discountPct: number;
  discount: number;
  net: number;
  gst: number;
  total: number;
  amcPerYear: number;
  perpetual: boolean;
}

export const GST_PCT = 18;
const r2 = (n: number) => Math.round(n * 100) / 100;

export function validateSlabs(slabs: Slab[]): string | null {
  if (!slabs.length) return 'Add at least one price slab';
  const sorted = [...slabs].sort((a, b) => (a.upTo ?? Infinity) - (b.upTo ?? Infinity));
  if (sorted.at(-1)!.upTo !== null) return 'The last slab must have no upper limit';
  if (sorted.filter((s) => s.upTo === null).length > 1) return 'Only one slab can be unlimited';
  if (new Set(sorted.map((s) => s.upTo)).size !== sorted.length) return 'Two slabs have the same upper limit';
  return null;
}

export function slabFor(slabs: Slab[], users: number): Slab {
  const sorted = [...slabs].sort((a, b) => (a.upTo ?? Infinity) - (b.upTo ?? Infinity));
  return sorted.find((s) => s.upTo === null || users <= s.upTo) ?? sorted.at(-1)!;
}

export function quote(plan: PlanPricing, users: number, years = 1, discountPct = 0): Quote {
  const n = Math.max(users, plan.min_users);
  const perpetual = plan.term_months === 0;
  const unitPrice = slabFor(plan.slabs, n).pricePerUser;
  const base = r2(n * unitPrice * (perpetual ? 1 : years));
  const discount = r2((base * discountPct) / 100);
  const net = r2(base - discount);
  const gst = r2((net * GST_PCT) / 100);
  return { users: n, years: perpetual ? 1 : years, unitPrice, base, discountPct, discount, net, gst, total: r2(net + gst), amcPerYear: perpetual ? r2((net * plan.amc_pct) / 100) : 0, perpetual };
}
