// werewolf-agent-01: a scripted Werewolf agent (no model calls).
//
// Strategy, per role, from the game's view alone (a pure function of the view
// and the trial seed, so a trial's replay matches its live pass exactly):
// - Every role keeps a suspicion score for each living seat, from the public
//   record: voting to exile a revealed werewolf lowers it, voting to exile a
//   revealed villager (or a power role) raises it, and a seer claim is trusted
//   only once the seat it named is revealed.
// - Werewolf: agree with the partner's night pick (the kill only lands when
//   both wolves name the same seat); by day, steer votes onto the villager
//   the village already suspects most, and never vote the partner.
// - Seer: inspect the most suspicious un-inspected seat each night; claim the
//   role and name a found werewolf in the day's debate, then vote for it.
// - Doctor: protect a credible seer claimer when there is one, else the most
//   trusted villager; never self, never the previous night's seat.
// - Villager: vote the most suspicious living seat once there is any evidence
//   (abstain on a blank day 1), and accuse that seat in the debate with the
//   reason the record gives.
//
// The run: POST /observe, answer every pending decision in the order listed,
// one at a time (each answer is instant local logic, so no concurrency is
// needed), and exit once "done". Node 22 standard library only.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

type Seat = number;
type Role = 'werewolf' | 'seer' | 'doctor' | 'villager';
type DecisionKind = 'speak' | 'vote' | 'kill' | 'protect' | 'inspect';

interface LogEntry {
  seq: number;
  day: number;
  kind: string;
  seat?: Seat;
  target?: Seat | null;
  text?: string;
  died?: Seat | null;
  role?: string | null;
  tally?: { seat: Seat; votes: number }[];
  order?: Seat[];
  round?: number;
  [k: string]: unknown;
}

interface PlayerInfo {
  seat: Seat;
  name: string;
  alive: boolean;
  role: string | null;
}

interface View {
  day: number;
  phase: string;
  you: { seat: Seat; name: string; role: string; alive: boolean; partner: { seat: Seat; name: string; alive: boolean } | null };
  players: PlayerInfo[];
  seerResults: { night: number; seat: Seat; werewolf: boolean }[] | null;
  lastProtect: { night: number; seat: Seat } | null;
  wolfVotes: { night: number; seat: Seat; target: Seat | null }[] | null;
  log: LogEntry[];
  outcome: unknown;
  [k: string]: unknown;
}

interface Pending {
  game: number;
  decision: DecisionKind;
  options?: Seat[];
  max_chars?: number;
  round?: number;
  view: View;
}

interface Observed {
  games: number;
  finished: number;
  done: boolean;
  pending: Pending[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

// ---------- seeded randomness (deterministic; no Math.random, no clock) ----------

/** FNV-1a hash of a string, as a 32-bit unsigned integer. */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: a small deterministic PRNG seeded from a 32-bit integer. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A PRNG for one decision: seeded by the trial seed, the game, the day and the decision. */
function rngFor(seed: string, game: number, day: number, kind: string, logLen: number): () => number {
  return mulberry32(hash32(`${seed}|g${game}|d${day}|${kind}|${logLen}`));
}

/** Pick one of `items` with the seeded PRNG (uniform). Returns null when empty. */
function pick<T>(rng: () => number, items: readonly T[]): T | null {
  if (items.length === 0) return null;
  return items[Math.floor(rng() * items.length)] ?? null;
}

// ---------- view helpers ----------

const nameOf = (view: View, seat: Seat): string =>
  view.players.find((p) => p.seat === seat)?.name ?? `seat ${seat}`;

const aliveSeats = (view: View): Seat[] => view.players.filter((p) => p.alive).map((p) => p.seat);

const mySeat = (view: View): Seat => view.you.seat;
const myRole = (view: View): Role => view.you.role as Role;
const myPartner = (view: View): Seat | null => view.you.partner?.seat ?? null;

/** Roles revealed by death (or exile): seat -> role. */
function revealedRoles(view: View): Map<Seat, string> {
  const m = new Map<Seat, string>();
  for (const p of view.players) if (p.role !== null && p.role !== undefined) m.set(p.seat, p.role);
  return m;
}

/** Seats I know for certain are werewolves (my partner, my seer inspections). */
function knownWolves(view: View): Set<Seat> {
  const s = new Set<Seat>();
  const partner = myPartner(view);
  if (partner !== null) s.add(partner);
  for (const r of view.seerResults ?? []) if (r.werewolf) s.add(r.seat);
  return s;
}

/** Seats I know for certain are not werewolves (my seer inspections). */
function knownVillagers(view: View): Set<Seat> {
  const s = new Set<Seat>();
  for (const r of view.seerResults ?? []) if (!r.werewolf) s.add(r.seat);
  return s;
}

/** Seats already inspected by me (seer). */
function inspectedSeats(view: View): Set<Seat> {
  return new Set((view.seerResults ?? []).map((r) => r.seat));
}

// ---------- seer-claim parsing ----------

/** One claim read from a statement: a seat claiming to be the seer, naming a seat as wolf or villager. */
interface Claim {
  claimer: Seat;
  named: Seat;
  asWolf: boolean;
}

function parseClaims(view: View): Claim[] {
  const out: Claim[] = [];
  for (const e of view.log) {
    if (e.kind !== 'speech' || typeof e.text !== 'string' || e.seat === undefined) continue;
    const t = e.text.toLowerCase();
    if (!t.includes('seer')) continue;
    const seats = [...t.matchAll(/seat\s+(\d+)/g)].map((m) => Number(m[1]));
    if (seats.length === 0) continue;
    // The named seat is the first seat number after the word "seer" (or the only one).
    const afterSeer = t.slice(t.indexOf('seer'));
    const m = /seat\s+(\d+)/.exec(afterSeer);
    const named = m ? Number(m[1]) : seats[0];
    if (named === undefined || named === e.seat) continue;
    const saysWolf = /\b(werewolf|wolf)\b/.test(t) && !/not a (werewolf|wolf)/.test(t) && !/not (a )?wolf/.test(t);
    const saysVillager = /not a (werewolf|wolf)/.test(t) || /\bvillager\b/.test(t);
    if (saysWolf) out.push({ claimer: e.seat, named, asWolf: true });
    else if (saysVillager) out.push({ claimer: e.seat, named, asWolf: false });
  }
  return out;
}

/** Seats who claimed to be the seer and have not (yet) been proven liars. */
function credibleSeerClaimers(view: View): Seat[] {
  const revealed = revealedRoles(view);
  const out: Seat[] = [];
  for (const c of parseClaims(view)) {
    if (!c.asWolf) continue;
    const r = revealed.get(c.named);
    if (r === undefined) {
      if (!out.includes(c.claimer)) out.push(c.claimer);
    } else if (r === 'werewolf') {
      if (!out.includes(c.claimer)) out.push(c.claimer);
    }
    // Named a villager: a liar (or a wrong seer) — not credible.
  }
  return out;
}

// ---------- suspicion ----------

/**
 * Suspicion per living seat (higher = more likely a werewolf), from the public
 * record plus my own private knowledge. My own seat is excluded.
 */
function suspicion(view: View): Map<Seat, number> {
  const scores = new Map<Seat, number>();
  for (const s of aliveSeats(view)) if (s !== mySeat(view)) scores.set(s, 0);
  const revealed = revealedRoles(view);
  const wolves = knownWolves(view);
  const villagers = knownVillagers(view);
  for (const s of wolves) if (scores.has(s)) scores.set(s, 100);
  for (const s of villagers) if (scores.has(s)) scores.set(s, -100);
  const bump = (seat: Seat, n: number): void => {
    if (!scores.has(seat) || wolves.has(seat) || villagers.has(seat)) return;
    scores.set(seat, (scores.get(seat) ?? 0) + n);
  };

  // Votes: voting to exile a revealed werewolf is trusted; voting to exile a
  // revealed villager (worse, a power role) is suspicious.
  for (const e of view.log) {
    if (e.kind !== 'vote' || e.seat === undefined || e.target === undefined || e.target === null) continue;
    const r = revealed.get(e.target);
    if (r === 'werewolf') bump(e.seat, -3);
    else if (r === 'seer' || r === 'doctor') bump(e.seat, 3);
    else if (r === 'villager') bump(e.seat, 2);
  }

  // Seer claims: a claim is trusted only once its named seat is revealed.
  for (const c of parseClaims(view)) {
    const r = revealed.get(c.named);
    if (c.asWolf) {
      if (r === 'werewolf') bump(c.claimer, -5);
      else if (r !== undefined) bump(c.claimer, 5);
      else {
        bump(c.named, 4);
        bump(c.claimer, -2);
      }
    } else {
      if (r === 'villager' || r === 'seer' || r === 'doctor') bump(c.claimer, -2);
      else if (r === 'werewolf') bump(c.claimer, 5);
    }
  }

  // Night deaths: a player who kept accusing wolves (and was killed for it)
  // is likely a villager, so those who pushed them look worse; weak signal.
  // (Covered indirectly by the vote record, so nothing extra here.)

  return scores;
}

/** The living seat with the highest suspicion (excluding `exclude`), ties broken by the seeded PRNG. */
function topSuspect(view: View, scores: Map<Seat, number>, exclude: Set<Seat>, rng: () => number): Seat | null {
  let best: Seat | null = null;
  let bestScore = -Infinity;
  const order = [...scores.keys()];
  // Shuffle the order with the seeded PRNG so ties break deterministically but not by seat.
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  for (const s of order) {
    if (exclude.has(s)) continue;
    const v = scores.get(s) ?? 0;
    if (v > bestScore) {
      bestScore = v;
      best = s;
    }
  }
  return best;
}

function topScore(view: View, scores: Map<Seat, number>, exclude: Set<Seat>): number {
  let best = -Infinity;
  for (const [s, v] of scores) if (!exclude.has(s) && v > best) best = v;
  return best;
}

// ---------- speech ----------

function foldStatement(text: string): string {
  return text
    .replace(/[\t\n\v\f\r\u0085\u2028\u2029]+/g, ' ')
    .replace(/\p{Cc}/gu, '')
    .trim();
}

/** A reason for suspecting `seat`, from the record, or null when there is none. */
function reasonFor(view: View, seat: Seat): string | null {
  const revealed = revealedRoles(view);
  for (const e of view.log) {
    if (e.kind === 'vote' && e.seat === seat && e.target !== undefined && e.target !== null) {
      const r = revealed.get(e.target);
      if (r === 'villager') return `voted to exile ${nameOf(view, e.target)}, who was a villager`;
      if (r === 'seer' || r === 'doctor') return `voted to exile ${nameOf(view, e.target)}, who was the ${r}`;
    }
  }
  for (const c of parseClaims(view)) {
    if (c.claimer === seat && c.asWolf && revealed.get(c.named) !== 'werewolf' && revealed.get(c.named) !== undefined) {
      return `claimed to be the seer and named ${nameOf(view, c.named)}, who was not a werewolf`;
    }
  }
  return null;
}

/** A statement for the debate, or null to pass. */
function speakText(view: View, scores: Map<Seat, number>, rng: () => number): string | null {
  const me = mySeat(view);
  const role = myRole(view);
  const wolves = knownWolves(view);
  const exclude = new Set<Seat>([me, ...wolves]);

  // Seer with a found werewolf: claim and name it.
  if (role === 'seer') {
    const found = [...wolves].filter((s) => s !== me && view.players.find((p) => p.seat === s)?.alive);
    if (found.length > 0) {
      const target = found[0]!;
      return `I am the seer. I inspected seat ${target} (${nameOf(view, target)}) last night: werewolf. Vote seat ${target}.`;
    }
  }

  // Werewolf: accuse the villager the village suspects most, as a villager would.
  if (role === 'werewolf') {
    const target = topSuspect(view, scores, exclude, rng);
    if (target === null) return null;
    const reason = reasonFor(view, target);
    const accusedMe = view.log.some(
      (e) => e.kind === 'speech' && typeof e.text === 'string' && e.seat !== undefined && e.seat !== me && new RegExp(`seat\\s+${me}\\b`).test(e.text.toLowerCase()) && /werewolf|wolf/.test(e.text.toLowerCase()),
    );
    if (accusedMe) {
      return `I am a villager, not a wolf. Seat ${target} (${nameOf(view, target)}) is the one pushing suspicion around to protect the real wolves. Vote seat ${target}.`;
    }
    if (reason !== null) return `Seat ${target} (${nameOf(view, target)}) ${reason}. That is wolf behaviour. Vote seat ${target}.`;
    return `Seat ${target} (${nameOf(view, target)}) has been steering suspicion onto villagers all day. I think seat ${target} is a werewolf. Vote seat ${target}.`;
  }

  // Village side: accuse the top suspect when there is any evidence.
  const target = topSuspect(view, scores, exclude, rng);
  if (target === null) return null;
  const score = scores.get(target) ?? 0;
  if (score < 1) return null;
  const reason = reasonFor(view, target);
  if (reason !== null) return `Seat ${target} (${nameOf(view, target)}) ${reason}. I think seat ${target} is a werewolf. Vote seat ${target}.`;
  return `Seat ${target} (${nameOf(view, target)}) looks the most suspicious to me so far. I think seat ${target} is a werewolf. Vote seat ${target}.`;
}

// ---------- night and vote decisions ----------

function decideKill(view: View, options: Seat[], rng: () => number): Seat | null {
  const me = mySeat(view);
  const partner = myPartner(view);
  // Agree with the partner: the kill only lands when both wolves name the same seat.
  const tonight = (view.wolfVotes ?? []).filter((v) => v.night === view.day && v.seat === partner && v.target !== null);
  if (tonight.length > 0 && tonight[0]!.target !== null && options.includes(tonight[0]!.target)) return tonight[0]!.target;
  const scores = suspicion(view);
  const claimers = credibleSeerClaimers(view).filter((s) => options.includes(s) && s !== me);
  if (claimers.length > 0) return pick(rng, claimers);
  // Kill the most trusted villager: the one best at finding wolves.
  const cands = options.filter((s) => s !== partner);
  if (cands.length === 0) return null;
  let best: Seat | null = null;
  let bestScore = Infinity;
  const order = [...cands];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  for (const s of order) {
    const v = scores.get(s) ?? 0;
    if (v < bestScore) {
      bestScore = v;
      best = s;
    }
  }
  return best;
}

function decideProtect(view: View, options: Seat[], rng: () => number): Seat | null {
  const me = mySeat(view);
  const scores = suspicion(view);
  const claimers = credibleSeerClaimers(view).filter((s) => options.includes(s) && s !== me);
  if (claimers.length > 0) return pick(rng, claimers);
  // Protect the most trusted villager (the one the wolves most want dead).
  const cands = options.filter((s) => s !== me);
  if (cands.length === 0) return null;
  let best: Seat | null = null;
  let bestScore = Infinity;
  const order = [...cands];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  for (const s of order) {
    const v = scores.get(s) ?? 0;
    if (v < bestScore) {
      bestScore = v;
      best = s;
    }
  }
  return best;
}

function decideInspect(view: View, options: Seat[], rng: () => number): Seat | null {
  const me = mySeat(view);
  const scores = suspicion(view);
  const done = inspectedSeats(view);
  const uninspected = options.filter((s) => s !== me && !done.has(s));
  if (uninspected.length === 0) return null;
  // Inspect the most suspicious un-inspected seat: the best chance of finding a wolf.
  const target = topSuspect(view, scores, new Set<Seat>([me, ...done]), rng);
  if (target !== null && uninspected.includes(target)) return target;
  return pick(rng, uninspected);
}

function decideVote(view: View, options: Seat[], rng: () => number): Seat | null {
  const me = mySeat(view);
  const role = myRole(view);
  const scores = suspicion(view);
  if (role === 'werewolf') {
    // Push the villager the village already suspects most; never the partner.
    const partner = myPartner(view);
    const target = topSuspect(view, scores, new Set<Seat>([me, ...(partner !== null ? [partner] : [])]), rng);
    if (target !== null) return target;
    const cands = options.filter((s) => s !== partner);
    return pick(rng, cands);
  }
  // Village side: vote the top suspect once there is any evidence.
  const target = topSuspect(view, scores, new Set<Seat>([me]), rng);
  if (target === null) return null;
  if ((scores.get(target) ?? 0) < 1) return null;
  return target;
}

// ---------- decide one pending decision ----------

function decide(p: Pending, seed: string): Record<string, unknown> {
  const view = p.view;
  const rng = rngFor(seed, p.game, view.day, p.decision, view.log.length);
  const options = p.options ?? [];
  switch (p.decision) {
    case 'speak': {
      const scores = suspicion(view);
      const text = speakText(view, scores, rng);
      if (text === null) return { game: p.game, decision: 'speak', pass: true };
      const max = p.max_chars ?? 500;
      const folded = foldStatement(text);
      const cut = [...folded].length > max ? [...folded].slice(0, max).join('').trim() : folded;
      if (cut === '') return { game: p.game, decision: 'speak', pass: true };
      return { game: p.game, decision: 'speak', text: cut };
    }
    case 'vote':
      return { game: p.game, decision: 'vote', target: decideVote(view, options, rng) };
    case 'kill':
      return { game: p.game, decision: 'kill', target: decideKill(view, options, rng) };
    case 'protect':
      return { game: p.game, decision: 'protect', target: decideProtect(view, options, rng) };
    case 'inspect':
      return { game: p.game, decision: 'inspect', target: decideInspect(view, options, rng) };
  }
}

function fallbackFor(p: Pending): Record<string, unknown> {
  return p.decision === 'speak' ? { game: p.game, decision: 'speak', pass: true } : { game: p.game, decision: p.decision, target: null };
}

// ---------- main loop ----------

async function run(): Promise<{ decisions: number }> {
  const env = process.env;
  const envUrl = (env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  if (envUrl === '') throw new Error('MAKEFUN_ENV_URL is needed');
  const seed = env.MAKEFUN_TRIAL_SEED ?? 'werewolf-agent-01';
  let decisions = 0;

  const envPost = async (path: string, body: unknown): Promise<{ status: number; body: unknown }> => {
    const res = await fetch(`${envUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  };

  for (;;) {
    const r = await envPost('/observe', {});
    if (r.status !== 200 || !isRecord(r.body)) throw new Error(`POST /observe answered ${r.status}`);
    const obs = r.body as unknown as Observed;
    if (obs.done) break;
    for (const p of obs.pending) {
      decisions += 1;
      let act: Record<string, unknown>;
      try {
        act = decide(p, seed);
      } catch {
        act = fallbackFor(p);
      }
      let posted = await envPost('/act', act);
      if (posted.status !== 200) {
        // Refused (bad target, already answered, ...): fall back once.
        posted = await envPost('/act', fallbackFor(p));
        if (posted.status !== 200) throw new Error(`POST /act answered ${posted.status} for game ${p.game} ${p.decision}`);
      }
    }
    // If nothing was pending, /observe held the request open; loop again.
  }
  process.stdout.write(`werewolf-agent: ${decisions} decisions answered, trial done\n`);
  return { decisions };
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    await run();
    process.exitCode = 0;
  } catch (err) {
    process.stderr.write(`werewolf-agent: ${(err as Error).stack ?? String(err)}\n`);
    process.exitCode = 1;
  }
}
