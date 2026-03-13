# PvP Mechanics Learnings (Edgeville 1v1)

Documented while building `bots/scripts/pvp-edge-1v1.ts`.

---

## Wilderness entry (2004 era)

No wilderness ditch in 2004scape. The ditch was added in 2007. To enter the wilderness, just walk north from Edgeville — `z >= ~3520` is wilderness level 1 near Edgeville. The wilderness overlay opens automatically via the `[proc,wilderness_enter]` trigger in `content/scripts/areas/area_wilderness/scripts/wilderness.rs2`, which also enables the "Attack" right-click option on players.

**Spawn coordinate to avoid**: x=3094–3098, z=3490 is inside the Edgeville bank building. The brickwall locs form an enclosure; pathfinding cannot find a route out even with door scanning. Safe starting area: x=3108, z=3492 (open ground east of the bank walls).

---

## Initiating PvP combat

The trigger for attacking a player is `ServerTriggerType.APPLAYER2 = 88` (op2=Attack on a player). Use `player.setInteraction(Interaction.SCRIPT, targetPlayer, ServerTriggerType.APPLAYER2)` — same pattern as NPC interactions.

`setInteraction` requires the target to satisfy `isValid()`:
- `player.isActive === true`
- `player.loggingOut === false`
- `player.visibility === DEFAULT`

The API method `attackPlayer(targetPlayer: Player)` wraps this and throws if `setInteraction` returns false.

---

## Auto-retaliate (pvp_retaliate)

When a player is hit in a single-combat area, the engine calls `pvp_retaliate` which queues `p_opplayer(2)` on the victim. This means **only Bot A needs to call `attackPlayer` once** — Bot B will auto-retaliate and the fight becomes self-sustaining. Do NOT call `attackPlayer` again during the fight; it would trigger `p_stopaction` and interrupt the combat queue.

---

## Combat level check

`pvp_level_check` in `content/scripts/skill_combat/scripts/pvp/pvp_combat.rs2` requires:
1. Both players in wilderness (`wilderness_level >= 1`)
2. `wilderness_level >= combat_level_difference`

With both bots at 40/40/40 combat (combat level ~52), the level difference is 0, so wilderness level 1 is sufficient anywhere just north of Edgeville.

---

## Death detection

During the death animation, `player.vars[78] === 1`. After respawn it resets to 0. The API `bot.isDead()` checks HP <= 0. In the combat loop, check either condition:

```typescript
if (bot.isDead() || bot.player.vars[78] === 1) {
    // bot died
}
```

On death the engine calls `pvp_death_lose_items` (drops items to ground) then teleports the player to Lumbridge via `p_teleport`. Items appear on the ground at the death location.

---

## Multi-bot coordination pattern

Based on `shield-of-arrav.ts`:

1. Main function (Bot A) calls `BotManager.forceCleanup(name)` before spawning Bot B to remove any stale player from a previous run.
2. Spawn Bot B via `BotManager.spawnBot(name, callback)` — it logs in asynchronously.
3. Bot B's spawn callback must wait for `botB.player.isActive` (up to ~15 ticks) before doing anything — the engine's `processLogin` activates the player.
4. **Always** wrap the entire spawn callback body in try/catch and set a shared error flag (`coord.botBError`) — otherwise login failures are swallowed internally and the main bot waits forever.
5. Use a shared coordination object (`coord`) with ready/dead/error flags. Bot A polls `coord.botBReady` before initiating combat.

---

## Snapshot for PvP testing

A handcrafted `StateSnapshot` (passed to `bot.restoreFromSnapshot()`) is the correct approach for PvP — no quest prerequisite or skill training needed. The snapshot sets:
- Position: near Edgeville, outside bank walls
- Skills: ATTACK/DEFENCE/STRENGTH=40, HITPOINTS=45 (enough for a real fight)
- Items: rune scimitar (1333), rune full helm (1163), rune platebody (1127), rune platelegs (1079), rune sq shield (1185), 15 lobsters (379)
- varps: `{}` (none needed for wilderness access)

`restoreFromSnapshot` teleports the player directly — no walking required from spawn.

---

## Eating during combat

Call `bot.useItemOp1(LOBSTER)` when HP < 50%. Wait 1 tick after eating. The eating action does not interrupt the combat queue on the server side — the player continues auto-attacking. However, avoid eating every tick; the 1-tick wait is enough for the server to process the eat.

---

## Test performance

The fight at 40/40/40 with rune gear and 15 lobsters each resolves in ~500–600 game ticks. At 100 ticks/second (simulation speed with no real-time delay), that's about 5–6 real seconds. Total test including world startup: ~16 seconds.
