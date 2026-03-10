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
