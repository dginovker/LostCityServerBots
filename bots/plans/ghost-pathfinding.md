# Ghost Pathfinding: Autonomous Door/Gate Traversal

## Problem

`walkToWithPathfinding` fails on gated enclosures (chicken pens, cow fields, sheep pens, compound gate+door sequences). Scripts work around this with manual `openGate()`/`openDoor()` calls, retry loops, and try/catch fallbacks — fragile boilerplate duplicated across every script.

## Solution: Two-pass "ghost" pathfinding

When a path segment is blocked, temporarily remove collision for all registered doors in the area, re-pathfind to get the ideal route, identify which door tiles the path crosses, restore collision, then walk to and open each door in sequence.

## Red/Green Test

### Test script: `bots/scripts/navigation-obstacles.ts`

A ScriptMeta-based script with `buildStates`. Each obstacle scenario is a state in the state machine, so `--state=` gives instant iteration on individual scenarios. The script uses **only** `walkToWithPathfinding` — no manual `openGate`/`openDoor`.

### Scenarios (each is a state)

Each state: skipTutorial → walk to start → `walkToWithPathfinding(end)` → assert position.

1. **nav/lumbridge-castle-door** — (3222,3218) → (3215,3218) — single door (baseline, already works)
2. **nav/chicken-pen** — (3237,3300) → (3233,3300) — single gate in fence
3. **nav/cow-field** — (3252,3266) → (3254,3270) — gate in fence
4. **nav/wheat-field** — (3160,3290) → (3163,3292) — gate in fence
5. **nav/sheep-pen** — (3187,3280) → (3190,3278) — single gate
6. **nav/fred-house** — (3187,3280) → (3189,3274) — gate then door in sequence (compound)
7. **nav/chicken-pen-roundtrip** — (3237,3300) → (3233,3300) → (3237,3300) — enter and exit

### Red/green iteration workflow

```bash
# Start persistent server once
bun engine/bots/test/server.ts

# Red: individual scenario fails
bun engine/bots/test/run.ts navigation-obstacles --state="nav/chicken-pen"

# Edit bots/runtime/api.ts (ghost pathfind fix — hot-reloaded, no restart)

# Green: same scenario passes
bun engine/bots/test/run.ts navigation-obstacles --state="nav/chicken-pen"

# Parallel: all scenarios at once
bun engine/bots/test/run.ts navigation-obstacles --state="nav/chicken-pen" &
bun engine/bots/test/run.ts navigation-obstacles --state="nav/cow-field" &
bun engine/bots/test/run.ts navigation-obstacles --state="nav/wheat-field" &
bun engine/bots/test/run.ts navigation-obstacles --state="nav/sheep-pen" &
bun engine/bots/test/run.ts navigation-obstacles --state="nav/fred-house" &
wait

# Full E2E once all states pass
bun engine/bots/test/run.ts navigation-obstacles
```

Hot-reload picks up changes to both `bots/scripts/` and `bots/runtime/` (including `api.ts`) without server restart.

## Implementation

### Step 1: Write the red test script

Create `bots/scripts/navigation-obstacles.ts` exporting a `ScriptMeta` with:
- `name: 'navigation-obstacles'`
- `type: 'activity'`
- `maxTicks: 3000`
- `buildStates(bot)` returning a state machine where each child state is one obstacle scenario
- `run(bot)` that runs all scenarios sequentially (for full E2E)

Each state function: `skipTutorial(bot)` → `walkToWithPathfinding(startX, startZ)` → `walkToWithPathfinding(endX, endZ)` → assert `bot.player.x === endX && bot.player.z === endZ`.

Run against persistent server. Confirm most scenarios fail (scenarios 2-7).

### Step 2: Implement ghost pathfinding in `walkToWithPathfinding`

In `bots/runtime/api.ts`, replace the current "find closest single door → open → retry" block (lines ~618-659) with:

```
When findPathSegment returns empty:
1. Collect all doors from doorRegistry.findDoorsNear(midpoint, level, segmentDist)
2. For each door, get its LocType and call changeLocCollision(shape, angle, blockrange, length, width, active, x, z, level, false) to temporarily remove collision
3. Re-run findPathSegment — this is the "ghost path"
4. Immediately restore collision for all doors: changeLocCollision(..., true)
5. If ghost path is still empty → throw (no path even without doors)
6. Walk the ghost path tile-by-tile, checking doorRegistry.isDoorAt() for each tile
7. When a door tile is encountered: stop, walk to adjacent tile, find the live Loc, interactLoc(loc, 1), waitForTicks, then resume walking
```

Import `changeLocCollision` from `GameMap.ts`. `LocType` is already imported.

### Step 3: Run green tests

Re-run each scenario with `--state=`. All should pass. Then full E2E.

### Step 4: Simplify existing scripts (optional cleanup)

Remove manual `openGate`/`openDoor` calls from scripts where `walkToWithPathfinding` now handles it:
- `cooks-assistant.ts`: `getEgg()`, `getMilk()`, `getGrain()`
- `sheep-shearer.ts`: `walkToFred()`, `exitFredArea()`
- Other scripts with gate/door boilerplate

## Files to modify

- `bots/scripts/navigation-obstacles.ts` — new script (red test)
- `bots/runtime/api.ts` — ghost pathfinding in `walkToWithPathfinding` (green fix)

## Out of scope

- Upper-floor pathfinding (no collision data for level 1+ — separate issue)
- One-way doors (haunted manor — script-level concern)
- Non-wall-shaped obstacles not in door registry (e.g., `inaccastledoubledoorropen` — separate registry fix)
