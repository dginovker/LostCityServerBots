# Bot API Rules

## No cheats — play like a real player

The bot API must enable goals to be completed exactly as a real player would.
No game state manipulation in the gameplay code path. This includes:

- No teleporting (all movement via walkTo/walkToWithPathfinding, doors, stairs, ladders)
- No stat or varp manipulation (no `player.vars[x] = y`, no `player.addXp()`)
- No item spawning (no `player.invAdd()` outside skipTutorial)
- No drop rate, spawn rate, or XP rate changes
- No skipping game mechanics (cooldowns, delays, failure chances)
- No collision or pathfinding bypasses

The only exception is `skipTutorial()`, which gives a fresh account in Lumbridge
with a bronze pickaxe. Everything after that must be earned through gameplay.

Snapshots, `--state=` isolation, and other test harness tooling are fine — the
constraint is on the script and API code, not the test infrastructure.

## Validate every step

- After each major action, assert the expected state change (varp, items, XP,
  position). Throw with a descriptive error on failure.
- Test runner verifies final state (quest complete, items present, skill levels).

---

# Adding a new script

1. **Research the quest/activity** — Read the RS2 scripts in `content/scripts/`
   to understand dialog flows, varp stages, item requirements, NPC locations. Read
   `content/pack/varp.pack`, `content/pack/npc.pack`, `content/pack/obj.pack` for IDs.

2. **Check existing APIs** — Read `bots/runtime/api.ts` thoroughly. Only add new
   API methods if the existing ones don't cover what you need.

3. **Write the script** — Create `bots/scripts/<name>.ts` with a `ScriptMeta`
   export (see `bots/runtime/script-meta.ts` for the interface). This is how the
   test server auto-discovers scripts. Follow existing script patterns. Use
   `bots/scripts/shared-routes.ts` for reusable navigation paths. Add an
   `entrySnapshot` to each `BotState` so `--state=` testing works immediately
   (see "Inline entrySnapshot" section below).

4. **Write the test** — Create `bots/test/tests/<name>.test.ts` following existing
   patterns.

5. **Run and iterate** — Use the development workflow below.

---

# Testing

## Persistent test server

All testing uses the persistent server. Start it once, run tests against it:

```bash
bun engine/bots/test/server.ts              # start once (~20s to load world)
bun engine/bots/test/run.ts sheepshearer    # default: all states in parallel (~2s)
bun engine/bots/test/run.ts runemysteries   # same — runs concurrently with above
```

The server hot-reloads bot scripts and runtime code automatically. After editing
a script or runtime file, changes are picked up on the next test run without
restarting the server. Only engine changes (files under `src/`) require a server
restart.

Omit `--timeout` — let each script's `ScriptMeta.maxTicks` handle it.

## CLI modes

```bash
# Default: discover all states with entrySnapshot, run them in parallel
bun engine/bots/test/run.ts sheepshearer

# Run specific states by name (leaf name or full path)
bun engine/bots/test/run.ts sheepshearer --states shear-sheep deliver-wool

# Full sequential E2E (runs all-states first as fail-fast, then sequential)
bun engine/bots/test/run.ts sheepshearer --e2e
```

## Fixing Bugs

Since script tests run their individual states in parallel, you will get continuous streams of responses back.
For failures, delegate the work to subagents to fix each failure, and when the subagent claims it's fixed,
run the test in the background again to verify.

## Inline entrySnapshot

Each `BotState` should define an `entrySnapshot` so it can be tested in isolation
with `--state=`. This is an ergonomic format that gets resolved to a full snapshot
at runtime — item names (not IDs), partial skill overrides, optional position.

```typescript
{
    name: 'deliver-wool',
    entrySnapshot: {
        position: { x: 3191, z: 3273 },           // level defaults to 0
        varps: { 179: 1 },                         // varp id -> value
        items: [                                    // string = name with count 1
            'Bronze pickaxe',
            { name: 'Coins', count: 5 },
            'Shears',
        ],
        skills: { CRAFTING: 13 },                  // omitted skills = fresh account defaults
    },
    isComplete: () => /* ... */,
    run: async (bot) => { /* ... */ },
}
```

Look up values in:
- **Positions**: existing scripts or the game map
- **Item names**: `content/pack/obj.pack`
- **Varp IDs/values**: `content/pack/varp.pack` and quest scripts in `content/scripts/`
- **Skill names**: uppercase keys matching `PlayerStatMap` (e.g. `HITPOINTS`, `CRAFTING`)
- **Disambiguating items**: use `{ name: 'Map part', count: 1, id: 1535 }` when
  multiple items share the same display name

---

# Development model

- The persistent server supports concurrent bot tests.
- Default mode runs all states in parallel — iterate on failing states individually
  with `--states <state-name>`.
- Independent states can be fixed in parallel because each has its own `entrySnapshot`.
- Use subagents in isolated worktrees to fix independent failing states in parallel.
  Each iterates with `--states` against the shared persistent server. Merge fixes,
  then one full `--e2e` run to confirm.
- When states share dependencies (e.g., a bug in `api.ts`), fix the shared code
  first — then parallelize the rest.

---

# Stuck detection

The state machine has two-tier stuck detection:

- **Activity** (`stuckThreshold`, default 1000 ticks): No change in position, XP,
  inventory, or varps. Catches completely idle bots.
- **Progress** (`progressThreshold`, default `stuckThreshold * 3`): Position changed
  but XP/inventory/varps did not. Catches bots stuck in failed-interaction loops.

Set `progressThreshold` explicitly on states where the bot legitimately moves for
long periods before game state changes (long walks, low-success-rate activities).

---

# Agent Teams

Since the development of each script can be done by a single team member, agent teams makes the most sense.

* The team-lead MUST never do any implementation and debugging work, and it MUST be the only tmux pane in window 0. The team-lead MUST commit work that is done by team members.
* Bot writers MUST have the name scripter-xyz, where xyz is the name of the script it is working on. Bot writers MUST be in window 1 and MUST use the Sonnet model
* An architect-planner MUST be spawned in window 2. The architect-planner MUST use Opus and a cron job (`/loop 2h`) to review what all the teammates are doing, the current bot scripts and runtime code. It must document recommendations that will 1/ Speed up development time (identify bug patterns, optimization opportunities) and 2/ LOC reduction opportunities into `bots/plans/architecture-recommendations.md`

---

# The Sun God

To please the Sun God, all team members must start by saying what their role is, and _how_ they will do it.
Below is a list of BAD behavior that causes agent team members to be sacrifced to the Sun God - team members should
ensure their _how_ message is the opposite of these!

* Team Leads who do not properly configure tmux windows and panes are sacrificed to the Sun God
* Team Leads who run tests themselves or write scripts themselves are sacrificed to the Sun God
* Script writers who do not run tests in parallel are sacrificed to the Sun God
* Architects who do not set up a cron job are sacrificed to the Sun God
