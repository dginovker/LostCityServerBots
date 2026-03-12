# Bot Script Rules

## No cheats — play like a real player

Bot scripts and the bot API must complete goals exactly as a real player would.
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

6. **Read `bots/struggles.md`** before starting — it documents engine quirks and
   non-obvious workarounds that will save you debugging time.

---

# Testing

## Persistent test server

All testing uses the persistent server. Start it once, run tests against it:

```bash
bun engine/bots/test/server.ts              # start once (~20s to load world)
bun engine/bots/test/run.ts sheepshearer    # run tests (~2s)
bun engine/bots/test/run.ts runemysteries
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

# Common pitfalls

These are documented more fully in `bots/struggles.md`. They should eventually be
resolved through architecture changes rather than memorized as workarounds.

**`player.delayed` / `busy()` getting permanently stuck**: After complex interactions
(pickpocketing, multi-step dialogs, level-up modals), `player.delayed` or
`containsModalInterface()` can become permanently true. This causes `canAccess()`
to return false, making all subsequent interactions silently fail. Fix:
```typescript
bot.dismissModals();
if (bot.player.delayed) {
    await bot.waitForCondition(() => !bot.player.delayed, 20);
    if (bot.player.delayed) bot.player.delayed = false;
}
if (bot.player.containsModalInterface()) bot.player.closeModal();
```

**Inventory junk between states**: Skills leave items behind. Always drop irrelevant
items at the start of a new training state.

**Pathfinding through fences/gates**: `walkToWithPathfinding` can't route through
fences not in the door registry. Walk to a known gate first, then pathfind.

**Floor level after stairs**: After using stairs, check `bot.player.level` and
descend before starting ground-level activities.

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

# Documenting struggles

Document problems in `bots/struggles.md` when:
- A bug takes more than 2 fix-test cycles to resolve
- The root cause is an engine quirk (not a simple script bug)
- The fix requires a non-obvious workaround

Include: symptom, root cause, fix, and architecture takeaway.
