# Bot Script Rules

## No cheats — play like a real player

Bot scripts must complete their goals exactly as a real player would. No cheats,
no shortcuts, no game state manipulation of any kind. This includes but is not
limited to:

- No teleporting (all movement via walkTo/walkToWithPathfinding, open doors,
  climb stairs, use ladders)
- No stat or varp manipulation (no player.vars[x] = y, no player.addXp())
- No item spawning (no player.invAdd() outside skipTutorial)
- No drop rate, spawn rate, or XP rate changes
- No skipping game mechanics (cooldowns, delays, failure chances)
- No collision or pathfinding bypasses

The only exception is skipTutorial(), which gives a fresh account in Lumbridge
with a bronze pickaxe. Everything after that must be earned through gameplay.

## Validate every step

- After each major action, assert the expected state change (varp, items, XP,
  position). Throw with a descriptive error on failure.
- Test runner verifies final state (quest complete, items present, skill levels).

## Bot development workflow

### Adding a new bot

1. **Research the quest/activity** — Read the RS2 scripts in `content/scripts/` to
   understand dialog flows, varp stages, item requirements, NPC locations, and game
   mechanics. Read `content/pack/varp.pack` for varp IDs, `content/pack/npc.pack`
   for NPC names, `content/pack/obj.pack` for item names.

2. **Check existing APIs** — Read `bots/runtime/api.ts` thoroughly. There are many
   methods already implemented: dialog, shops, combat, item-on-NPC, item-on-loc,
   item-on-item, ground items, doors, gates, stairs, pathfinding, etc. Only add new
   API methods if the existing ones don't cover what you need.

3. **Write the script** — Create `bots/scripts/<name>.ts` exporting an async function.
   Follow the patterns in existing scripts (sheep-shearer.ts, prince-ali-rescue.ts,
   rune-mysteries.ts). Start from `skipTutorial()`, earn everything through gameplay.

4. **Write the test** — Create `bots/test/tests/<name>.test.ts` following existing
   patterns. Add the test name to the switch in `bots/test/runner.ts`. Validate the
   final state (quest varp, items, XP).

5. **Run and iterate** — `bun engine/bots/test/runner.ts <name>` from the project
   root. The test runner starts the world in-process with fast ticks (no 600ms delay).
   If the test fails, read the error, fix, retry.

6. **Verify no regressions** — Run existing tests to make sure nothing broke.

### Architecture overview

- `bots/integration/bot-player.ts` — BotPlayer extends Player (not NetworkPlayer).
  Override write() captures dialog messages; everything else is no-op (no network).
- `bots/runtime/controller.ts` — Tick-synchronized async controller. Bot scripts use
  `await waitForTick()` which resolves each game tick via processBotInput().
- `bots/runtime/manager.ts` — BotManager creates BotPlayers and registers them with
  the World.
- `bots/runtime/api.ts` — BotAPI wraps controller+player. All bot interaction methods
  live here.
- `bots/runtime/pathfinding.ts` — Wrapper around engine's rsmod pathfinder.
- `bots/test/runner.ts` — Test runner starts World in-process, drives ticks in a tight
  loop, spawns bot, validates assertions.

### Key patterns

- **Dialog**: `talkToNpc()` → `waitForDialog()` → `continueDialog()` or
  `selectDialogOption(n)`. Repeat for each dialog page.
- **Loc interaction**: Bot must pre-compute path via `findPathToLoc` and queue
  waypoints BEFORE calling `setInteraction` (engine's pathToPathingTarget returns
  immediately for non-entity targets).
- **Doors/gates**: `openDoor(debugname)` / `openGate()`. Walk through after opening.
- **Shops**: `interactNpc(shopkeeper, 3)` (Trade) → `buyFromShop(itemName, qty)`.
- **Combat**: `attackNpc(npc)` → wait for NPC death → pick up ground items.
- **Idle logout**: Controller updates `lastConnected`/`lastResponse` each tick to
  prevent the 50-tick idle logout.
