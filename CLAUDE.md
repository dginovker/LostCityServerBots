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
   `bots/scripts/shared-routes.ts` for reusable navigation paths.

4. **Write the test** — Create `bots/test/tests/<name>.test.ts` following existing
   patterns.

5. **Run and iterate** — Use the development workflow below.

---

# Testing

## Persistent test server

All testing uses the persistent server. Start it once, run tests against it:

```bash
bun engine/bots/test/server.ts              # start once (~20s to load world)
bun engine/bots/test/run.ts sheepshearer &   # run tests (~2s)
bun engine/bots/test/run.ts runemysteries &
```

The server hot-reloads bot scripts and runtime code automatically. After editing
a script or runtime file, changes are picked up on the next test run without
restarting the server. Only engine changes (files under `src/`) require a server
restart.

Omit `--timeout` — let each script's `ScriptMeta.maxTicks` handle it.

## Single-state iteration with --state=

Full E2E runs are expensive. Use `--state=` to test independent states in
parallel in seconds. Snapshots are captured automatically during E2E runs, or
you can handcraft them.

```bash
# Run states in parallel against the persistent server:
bun engine/bots/test/run.ts f2pskills --state="f2p-skills/smithing" &
bun engine/bots/test/run.ts f2pskills --state="f2p-skills/woodcutting" &
wait
# Each process exits 0 (PASS) or 1 (FAIL) and prints a [RESULT] line.

# Once all states pass individually, do a full E2E:
bun engine/bots/test/run.ts f2pskills
```

## Fixing Bugs

Since script tests run their individual states in parallel, you will get continuous streams of responses back.
For failures, delegate the work to subagents to fix each failure, and when the subagent claims it's fixed,
run the test in the background again to verify. 

### Where snapshots come from

Snapshots live in `bots/test/snapshots/<root-state-name>.json`. They are
generated automatically during full E2E runs (saved incrementally, so partial
runs produce snapshots for every state the bot entered). You can also write
them by hand.

### Handcrafting snapshots

The file must be named after the root state name returned by `buildStates()`
(e.g. `sheep-shearer.json` for a root with `name: 'sheep-shearer'`). Format:

```json
{
  "test": "sheep-shearer",
  "states": [
    {
      "path": "sheep-shearer/deliver-wool",
      "snapshot": {
        "position": { "x": 3191, "z": 3273, "level": 0 },
        "skills": {
          "ATTACK": 1, "DEFENCE": 1, "STRENGTH": 1, "HITPOINTS": 10,
          "RANGED": 1, "PRAYER": 1, "MAGIC": 1, "COOKING": 1,
          "WOODCUTTING": 1, "FLETCHING": 1, "FISHING": 1, "FIREMAKING": 1,
          "CRAFTING": 1, "SMITHING": 1, "MINING": 1, "HERBLORE": 1,
          "AGILITY": 1, "THIEVING": 1, "STAT18": 1, "STAT19": 1,
          "RUNECRAFT": 1
        },
        "varps": { "179": 1 },
        "items": [
          { "id": 1265, "name": "Bronze pickaxe", "count": 1 },
          { "id": 995, "name": "Coins", "count": 5 },
          { "id": 1735, "name": "Shears", "count": 1 }
        ]
      }
    }
  ]
}
```

Look up values in:
- **Positions**: existing snapshots, scripts, or the game map
- **Item IDs/names**: `content/pack/obj.pack`
- **Varp IDs/values**: `content/pack/varp.pack` and quest scripts in `content/scripts/`
- **Skill names**: use the uppercase keys shown above (match `PlayerStatMap`)

---

# Development model

- The persistent server supports concurrent bot tests.
- `--state=` lets you iterate on one failing state without re-running the full quest.
- Independent states can be fixed in parallel because snapshots are per-state.
- Use subagents in isolated worktrees to fix independent failing states in parallel.
  Each iterates with `--state=` against the shared persistent server. Merge fixes,
  then one full E2E run to confirm.
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
