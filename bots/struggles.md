# Bot Development Struggles

Document problems that required significant debugging effort. Revisit periodically
to identify architecture improvements.

---

## 1. Wizard Tower stairs fail on second visit (demon-slayer)

**Symptom:** `climbStairs('loc_1739', 3)` teleports the player on the first visit
but silently fails on the second visit (after giving 25 bones to Traiborn). The
`interactLoc` returns successfully but the p_telejump never fires.

**Root cause:** The Traiborn bone-giving dialog is complex: 25 iterations of
`if_close(); inv_del(); mes(); p_delay(1)`, followed by an incantation sequence
with `mesbox`, `if_close()`, `p_delay(2)`, `chatplayer`, `chatnpc`. After the bot's
dialog handling loop exits, a modal interface may still be open from unprocessed
dialog pages. The engine's `canAccess()` check returns false when
`containsModalInterface()` is true, which prevents the staircase's OP trigger from
firing. The AP trigger sets the target, the engine tries `tryInteract()` each tick
but `canAccess()` blocks it, and eventually the target times out — no teleport.

**Key engine code:** `Player.ts: canAccess() → !this.protect && !this.busy()` and
`busy() → this.delayed || this.containsModalInterface()`.

**Fix:** Loop `dismissModals()` with tick waits until the player has no active
script and no modal interface before attempting staircase interaction.

**Architecture takeaway:** The bot API lacks a reliable "clear all pending
scripts/modals" primitive. `dismissModals()` only handles one PAUSEBUTTON state per
call. Complex NPC dialogs with `if_close()` + `p_delay()` gaps create timing-
sensitive dialog handling that's easy to get wrong. Consider adding a
`clearAllPendingState()` method or making `dismissModals()` loop internally.

---

## 2. walkToWithPathfinding fails on upper floors

**Symptom:** `walkToWithPathfinding` throws "no path" errors on level 1+ (e.g.,
Wizard Tower level 1, Varrock Palace level 2).

**Root cause:** The rsmod pathfinder has no collision data loaded for upper floors.
The collision map only covers level 0.

**Fix:** Use `walkTo` (direct waypoint, no pathfinding) on upper floors. This works
for open interiors but will fail if walls block the straight-line path.

**Architecture takeaway:** No reliable pathfinding on upper floors. Scripts must
hard-code waypoints through interior walls/doors on level 1+. Could consider loading
collision data for upper floors if rsmod supports it.

---

## 3. Stuck detection false-positives during pickpocketing

**Symptom:** Stuck detection triggers during `earnCoinsViaPickpocket` because the
bot stays in the same area for 1000+ ticks.

**Root cause:** Default `stuckThreshold: 1000` is too short for pickpocketing at low
Thieving levels. The bot legitimately stays in the same small area while repeatedly
pickpocketing, and successful pickpockets are rare at low levels.

**Fix:** Set `stuckThreshold: 3000` on all earn-coins states.

**Architecture takeaway:** Stuck detection based on position+XP+varp+inventory
change is too coarse. Pickpocketing DOES change inventory (coins) on success, but
failures are common enough that 1000 ticks can pass without a successful pickpocket.
Could track "last action attempted" instead of just "last state change".

---

## 4. HTTP idle timeout kills long-running tests

**Symptom:** Tests for quests with many prerequisites (e.g., BKF with 6 prereq
quests) would get killed mid-run.

**Root cause:** Bun.serve `idleTimeout` max is 255 seconds. Complex quests can take
longer than that.

**Fix:** Switched from single JSON response to NDJSON streaming. Heartbeat lines
keep the connection alive indefinitely.

**Architecture takeaway:** Streaming responses are fundamentally better for
long-running operations. The heartbeats also double as observability.
