# Werewolf agent (werewolf-agent-01)

A scripted Werewolf agent: no model calls, no API key, pure local logic.

## Strategy

Every decision is a pure function of the game's view and the trial seed
(`MAKEFUN_TRIAL_SEED`), so a trial's replay matches its live pass exactly.

- **Suspicion model** — each living seat gets a score from the public record:
  voting to exile a revealed werewolf lowers it, voting to exile a revealed
  villager (worse, a power role) raises it, and a seer claim is trusted only
  once the seat it named is revealed. The seer's own inspections are certain
  (+100 wolf / -100 villager).
- **Werewolf** — agrees with the partner's night pick (the kill only lands
  when both wolves name the same seat); by day it steers votes onto the
  villager the village already suspects most and never votes its partner.
  It kills a credible seer claimer first, else the most trusted villager.
- **Seer** — inspects the most suspicious un-inspected seat each night, and
  claims the role to name a found werewolf in the day's debate.
- **Doctor** — protects a credible seer claimer when there is one, else the
  most trusted villager; never self, never the previous night's seat.
- **Villager** — votes the most suspicious living seat once there is any
  evidence (abstains on a blank day 1), and accuses that seat in the debate
  with the reason the record gives.

## Run

`node /bot/main.ts` (Node 22, standard library only). It loops on
`POST /observe` at `MAKEFUN_ENV_URL`, answers every pending decision in
order, and exits once the trial is done.

## Files

- `main.ts` — the agent.
- `LICENSE` — MIT.
