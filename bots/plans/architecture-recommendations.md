# Architecture Recommendations

Updated: 2026-03-14 (revision 17 — cycle 11)

---

## Current Agent Status

2 scripter agents active (Dragon Slayer, Black Knight's Fortress).
Knight's Sword and Monk's Friend completed. api.ts unchanged at 2474 LOC.
**Engine change still present:** `src/engine/entity/Player.ts` debug instrumentation — MUST remove.
**5 debug scripts at engine root** (`check_bkf.ts`, `check_bkf2.ts`, `check_door.ts`,
`check_inviswall.ts`, `check_poordoor.ts`) — BKF scripter debugging door/wall collision.
These MUST NOT be committed.

### Monk's Friend (#1) — 1148 LOC | COMPLETED
### Knight's Sword (#4) — 1862 LOC | COMPLETED

---

### BKF (#3) — 1092 LOC | ACTIVE (was 1077, +15 LOC)
`infiltrateFortress` back up to 208 lines (was 193 in cycle 10) — scripter adding
retry/debug logic for door interaction issues (evidenced by 5 check_*.ts scripts).
**Dead code still present:** `_completePrerequisiteQuests()` (line 160, ~40 LOC unused).
Still has `earnGp()` inline (line 87) and `walkRoute()` dup with KS (line 144).

---

### Dragon Slayer (#2) — 1538 LOC | ACTIVE (was 1549, -11 LOC — cleanup)
All 13 states with entrySnapshot. All 5 `executeScript` calls present.
**`navigateMelzarsMaze` is 235 lines** — longest function in any script.

---

## API Style Migration Status

api.ts defines inline namespace objects (`inventory`, `walking`, `dialog`, `interaction`, `shop`)
as convenience wrappers — the underlying methods remain on the class. 4 scripts use the new
accessor style, 25 scripts still use old-style direct calls.

| Style | Scripts | Call Count |
|-------|---------|------------|
| New (`bot.inventory.find()`) | 4 (DS, BKF, KS, MF) | ~1,070 |
| Old (`bot.findItem()`) | 25 | ~2,396 |

api.ts is a 2474 LOC monolith. The namespace accessors are thin wrappers within api.ts itself.

### api.ts changes this cycle
- `describeNearbyLocs` made public (was private) — now accessible via `interaction` namespace
- `isMultiChoiceOpen()` now includes `multiobj3` component
- `selectDialogOption()` improved with `buttonStart` for multiobj3 dialogs
- New diagnostic: `debugLocReach(loc)` — prints reachability from 4 directions with collision flags
- New imports: `isFlagged`, `reachedLoc` from GameMap, `CollisionFlag` from rsmod-pathfinder
- Debug logging added to `useItemOnLoc` (target state, tick count, per-tick debug)
- **Warning:** Debug console.log in `useItemOnLoc` should be removed before production

---

## Codebase Size Summary

| Category | LOC |
|----------|-----|
| Scripts (31 files) | 25,586 |
| Runtime (11 files) | 3,697 |
| **Total** | **29,283** |

Top 5 largest scripts: knights-sword (1862), f2p-skills (est ~1900), demon-slayer (est ~2039),
dragon-slayer (1538), pirates-treasure (est ~1543).

Longest functions: `navigateMelzarsMaze` (DS, 235 LOC), `infiltrateFortress` (BKF, 208 LOC),
`acquireEquipment` (BKF, ~119 LOC), `craftPieDish` (KS, 112 LOC), `getPortrait` (KS, 101 LOC).

---

## Priority 1: Reduce Bot Bugs

### 1a-1c. clearPendingState() [DONE]

### 1d. Better error messages on silent interaction failures [NOT STARTED]
When `interactNpc`/`interactLoc` silently fails (NPC wandered, loc unreachable),
the bot enters a failed-interaction loop caught only by progressThreshold.
**Recommendation:** Add optional `expectedResult` param or automatic varp/inv
delta check after interaction, throwing immediately on no-change.

### 1e. Dragon Slayer direct script execution [RECLASSIFIED — NECESSARY]
5 `executeScript(ScriptRunner.init(...))` calls remain (lines 233, 736, 836, 879, 1112).
Deep analysis shows these are **intentional**: they bypass AP-walk pathfinding when the
bot is already at the target position (e.g., inside Oziach's hut). Using `talkToNpc()`
or `interactNpc()` would trigger unnecessary pathfinding that can fail in tight spaces.
Line 836 (map piece combine) has no API equivalent — it's a direct item-on-item script.
**Reclassified from "bug" to "design decision."** Still a maintenance risk if engine
script signatures change, but not replaceable without a new API method like
`interactNpcDirect(npc, op)` that skips pathfinding.

### 1f. BKF inline delayed clearing [RESOLVED]
All `bot.player.delayed = false` instances gone. 0 remaining.

### 1g. NPC wander desync (NEW — recurring pattern)
Scripts find NPC → walk to NPC location → interact. But NPC may have wandered during
the walk. **Current workaround:** find → walk → re-find → interact. Scripts that don't
do this (especially in busy areas like Lumbridge) will intermittently fail.
**Recommendation:** `interaction.talkToNpc()` could auto-refind by name before interacting.

---

## Priority 2: Reduce Codebase Size (~445 LOC potential savings)

| # | Recommendation | LOC Delta | Effort | Status |
|---|---|---|---|---|
| 2a | Migrate 5 scripts to earnCoinsViaPickpocket | -100 | Low | Not started |
| 2b | Delete duplicate countItem (3 scripts) | -45 | Trivial | Not started |
| 2c | Zone iteration helper | -200 | Medium | Not started |
| 2d | Shared walkRoute helper in shared-routes.ts | -20 | Trivial | Not started |
| 2e | DS executeScript → API calls | -40 | Medium | Reclassified (see 1e) |
| 2f | DS local clearState → API | -- | -- | DONE |
| 2g | BKF inline clearPendingState | -- | -- | DONE |

### 2a: earnCoinsViaPickpocket migration
`bot.earnCoinsViaPickpocket(targetGp, npcName?, area?)` exists on BotAPI (line 2383).
Already migrated: sheep-shearer, vampire-slayer, demon-slayer, witchs-potion,
gertrudes-cat, shield-of-arrav, monks-friend (7 scripts use it).

Still have inline `earnCoins()`/`earnGp()`:
- `cooks-assistant.ts` (line 52, called line 708)
- `f2p-skills.ts` (line 125, called lines 1635, 1816)
- `goblin-diplomacy.ts` (line 99, called lines 965, 1029)
- `knights-sword.ts` (line 153, called line 1655)
- `black-knights-fortress.ts` (line 87, called line 225)
- `pirates-treasure.ts` (line 77, called line 1363)
- `prince-ali-rescue.ts` (line 143, called line 1238)

Each inline function is ~20 LOC. Migration is a simple find-replace.

### 2b: countItem duplication
Three scripts still define `countItem(bot, name)` identical to `bot.inventory.count(name)`:
- `sheep-shearer.ts` (line 336)
- `prince-ali-rescue.ts` (line 128)
- `goblin-diplomacy.ts` (line 84)

### 2c: Zone iteration helper
Multiple scripts iterate over zones to find NPCs/locs using identical boilerplate
loops. Extracting to a helper in api.ts or a utility module would save ~200 LOC.

### 2d: Shared walkRoute
Both `knights-sword.ts` (line 109) and `black-knights-fortress.ts` (line 144)
define `walkRoute()` — sequential waypoint walking with logging. Slight difference:
BKF includes `name` in waypoint type, KS does not.
**Recommendation:** Add to `shared-routes.ts` with optional name field.

### 2e: DS executeScript calls [RECLASSIFIED]
5 calls that directly execute engine scripts. Analysis shows these are **necessary** —
they avoid AP-walk pathfinding in tight spaces and one (line 836) is a direct item-on-item
script with no API equivalent. To properly replace, would need a new `interactNpcDirect(npc, op)`
method that triggers NPC interaction without pathfinding. Effort reclassified to Medium.

---

## Priority 3: Speed Up Bot Testing

### 3a. Diagnostic on interaction timeout (same as 1d)

### 3b. Pre-made quest chain snapshots for DS and KS
Inline `entrySnapshot`s exist on both DS and KS states.
KS still needs validation of later states through actual test runs.

### 3c. Inline entrySnapshot on BotState [DONE — COMMITTED]

### 3d. New test CLI [DONE — COMMITTED]

### 3e. captureSnapshots cleanup [READY — UNSTAGED]
15 scripts cleaned up in prior cycle. Awaiting team-lead commit.

### 3f. Migrate remaining scripts to inline entrySnapshot [NOT STARTED]
Scripts with JSON snapshots still in `bots/test/snapshots/`:
all-skills, cooks-assistant, demon-slayer, f2p-skills, gertrudes-cat,
goblin-diplomacy, imp-catcher, nav, pirates-treasure, prince-ali-rescue,
restless-ghost, romeo-and-juliet, rune-mysteries, shield-of-arrav-phoenix,
vampire-slayer, witchs-potion.

### 3g. Inconsistent API style slows onboarding (NEW)
New scripts (DS, BKF, KS, MF) use `bot.inventory.find()` accessor style.
25 older scripts use `bot.findItem()` direct style. Both work because api.ts
has both. But it's confusing for new scripters who see two styles. Scripts
should converge on one style — the accessor style is more readable.

---

## Common Bug Patterns Observed

### Pattern: NPC wander desync
Scripts find NPC → walk → interact. NPC moves. **Fix:** find → walk → re-find → interact.
Seen in: most quest scripts interacting with wandering NPCs.

### Pattern: Inline clearPendingState [RESOLVED]
BKF no longer manually clears `bot.player.delayed`. All 0 instances.

### Pattern: Direct script execution bypass [DS — unchanged]
5 `executeScript(ScriptRunner.init(...))` calls bypass API error handling.

### Pattern: Gate double-open
`openGate(10)` called twice for double gates. Works but fragile.
Ghost pathfinding (committed `091ecb8`) may reduce need for manual gate handling.

### Pattern: Modal dismissal after quest rewards
Follow double-dismiss pattern. All current scripts handle correctly.

### Pattern: Stale pickpocket loop (NEW)
The 7 inline `earnCoins`/`earnGp` functions have slightly drifted from each other
and from `bot.earnCoinsViaPickpocket()`. For example, some check `bot.player.delayed`
directly while others use `waitForActionReady()`. When bugs are fixed in one copy,
the others don't get the fix. **Risk:** Silent pickpocket failures that only show
up in specific scripts.

---

## Observations

### Ghost pathfinding committed
Commit `091ecb8` added ghost pathfinding — `walkToWithPathfinding` now auto-opens
doors and gates along the ideal path. This should reduce manual `openDoor`/`openGate`
calls in future scripts.

### api.ts namespace pattern works well
The inline namespace objects (`bot.inventory`, `bot.walking`, `bot.dialog`,
`bot.interaction`, `bot.shop`) provide clean grouping without the overhead of
separate files. The 4 scripts using this style are more readable. Consider this
the canonical pattern for new scripts.

### Missing `combat` namespace
api.ts defines `inventory`, `walking`, `dialog`, `interaction`, `shop` namespaces
but NOT `combat`. Scripts still use `bot.attackNpcUntilDead()`, `bot.setCombatStyle()`,
etc. directly. Adding a `combat` namespace would complete the pattern.

### Missing `bank` namespace
Same as above — no `bank` namespace on api.ts. Scripts use `bot.openBank()`,
`bot.depositItem()`, etc. directly.

### DS executeScript calls are necessary (cycle 7)
Previously classified as a bug/LOC-reduction opportunity. Deep analysis shows all 5
calls intentionally bypass AP-walk pathfinding when the bot is already at the NPC.
Using `talkToNpc()` would trigger pathfinding that can fail in tight spaces (inside
Oziach's hut, next to Klarense on the dock, etc.). Line 836 combines map pieces via
a direct `[opheldu]` script — no API equivalent exists. To properly replace these,
a new `interactNpcDirect(npc, op)` API method would be needed.

### entrySnapshot coverage across scripts (cycle 8, updated)
| Script | States | With Snapshot | Coverage |
|--------|--------|---------------|----------|
| Dragon Slayer | 13 | 13 | 100% |
| Knight's Sword | 13 | 13 | 100% |
| BKF | 11 | 10 | 90.9% |
| Monk's Friend | 8 | 8 | 100% |

Only `verify-qp` in BKF lacks entrySnapshot — acceptable since it's a verification
gate that must run after all 6 prerequisite quests.

### BKF rewrite and cleanup (cycles 8-10)
BKF underwent major rewriting then cleanup (373+, 282- vs committed). Key additions:
- **`prerequisiteState()` factory** (line 843): Generic function that wraps any quest
  as a prerequisite state. Detects mid-progress quests and resumes via `buildStates`
  state machine. This pattern could be extracted to shared-routes.ts if other scripts
  need prerequisite quest chains.
- **`eatLobster()` helper** (line 542): Reusable health-check-and-eat pattern.
- **`infiltrateFortress` refactored down to 193 lines** (peak was 232 in cycle 9).
  Good cleanup — removed redundant fallback code while keeping phase markers and
  retry loops.
- **Dead code still present:** `_completePrerequisiteQuests()` at line 160 is
  underscore-prefixed and never called — should be removed (~40 LOC savings).

### Knight's Sword completed (cycle 9)
Task #4 marked complete. KS shrank from 1877→1862 LOC (-15) during final cleanup.
Still has `earnGp()` inline and `walkRoute()` dup — these are now safe to clean up
since the script is stable. Low priority since it's working.

### Debug artifacts for commit cleanup (cycles 8-11 — ALL STILL PRESENT)
1. **`src/engine/entity/Player.ts`** — `_debugInteract` console.log in `tryInteract`. REMOVE.
2. **`bots/runtime/api.ts`** — 3 debug log lines in `useItemOnLoc`. REMOVE.
3. **5 debug scripts at engine root** (cycle 11) — `check_bkf.ts`, `check_bkf2.ts`,
   `check_door.ts`, `check_inviswall.ts`, `check_poordoor.ts`. DO NOT COMMIT. DELETE.
   These are BKF scripter's door/wall collision diagnostics.
