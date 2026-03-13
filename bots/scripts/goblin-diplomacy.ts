import path from 'path';
import { BotAPI } from '../runtime/api.js';
import { skipTutorial } from './skip-tutorial.js';
import { type BotState, runStateMachine } from '../runtime/state-machine.js';
import type { ScriptMeta } from '../runtime/script-meta.js';
import { findPathSegment } from '../runtime/pathfinding.js';
import { ensureWestOfTollGate } from './shared-routes.js';

// Varp ID for Goblin Diplomacy quest progress (from content/pack/varp.pack: 62=goblinquest)
export const GOBLIN_QUEST_VARP = 62;

// Quest stages (from content/scripts/quests/quest_gobdip/configs/quest_gobdip.constant)
const STAGE_NOT_STARTED = 0;
const STAGE_STARTED = 1;
const STAGE_WILL_BRING_ARMOUR = 2;
const STAGE_GAVE_ORANGE = 3;
const STAGE_GAVE_BLUE = 4;
const _STAGE_GAVE_BROWN = 5;
const STAGE_COMPLETE = 6;

// Stun/delay varps (same as other bot scripts)
const VARP_ACTION_DELAY = 58;
const VARP_STUNNED = 103;

// NPC attack op (from all.npc: goblin has op2=Attack)
const ATTACK_OP = 2;

// NPC stat index for hitpoints
const _HITPOINTS_STAT = 3;

// ---- Key locations ----

const LUMBRIDGE_SPAWN_X = 3222;
const LUMBRIDGE_SPAWN_Z = 3218;

// Port Sarim - Rusty Anchor bar area
// The bar is at approximately (3047, 3257). Approach from the east.
const PORT_SARIM_BAR_X = 3047;
const PORT_SARIM_BAR_Z = 3257;

// Goblin Village: north of Falador
// The generals are around (2957,3514). Approach from the east on the open path.
const GOBLIN_VILLAGE_X = 2963;
const GOBLIN_VILLAGE_Z = 3514;

// Onion field south of Fred's farm
// Entry via gate at (3186,3268)/(3186,3269). Approach from west.
const ONION_GATE_X = 3185;
const ONION_GATE_Z = 3268;

// Aggie in Draynor Village (inside her house)
const AGGIE_DOOR_X = 3089;
const AGGIE_DOOR_Z = 3258;
const AGGIE_X = 3086;
const AGGIE_Z = 3259;

// Wyson the Gardener in Falador Park
// Park is around (2996-3019, 3367-3390). Wyson wanders in the park.
const FALADOR_PARK_X = 3002;
const FALADOR_PARK_Z = 3376;

// Wydin in Port Sarim food store
const WYDIN_X = 3014;
const WYDIN_Z = 3204;

// Goblin patrol route for hunting (goblins WEST of the River Lum, near Lumbridge).
// Goblin spawns west of river: (3211,3247), (3212,3220), (3215,3237), (3215,3240).
// (3213,3228) is inside Lumbridge castle walls — avoid it.
// Staying west avoids the Al Kharid toll gate at x=3268 and fenced fields east
// of the bridge. The open field is around x=3208-3220, z=3232-3250.
const GOBLIN_PATROL_ROUTE = [
    { x: 3215, z: 3237, name: 'Goblin spawn mid (open)' },
    { x: 3215, z: 3240, name: 'Goblin spawn north (open)' },
    { x: 3211, z: 3247, name: 'Goblin spawn far north (open)' },
    { x: 3210, z: 3240, name: 'West field (open)' },
    { x: 3212, z: 3232, name: 'South field (open)' },
];

// ---- Utility functions ----

/**
 * Count total number of items with a given name in inventory (across all slots).
 */
function countItem(bot: BotAPI, name: string): number {
    const items = bot.getInventory();
    const lowerName = name.toLowerCase();
    let total = 0;
    for (const item of items) {
        if (item.name.toLowerCase() === lowerName) {
            total += item.count;
        }
    }
    return total;
}

/**
 * Pickpocket men in Lumbridge to earn coins.
 */
async function earnCoins(bot: BotAPI, targetGp: number): Promise<void> {
    bot.log('STATE', `=== Earning ${targetGp}gp by pickpocketing men ===`);

    let attempts = 0;
    const MAX_ATTEMPTS = 600;

    while (attempts < MAX_ATTEMPTS) {
        const coins = bot.findItem('Coins');
        const currentGp = coins ? coins.count : 0;
        if (currentGp >= targetGp) {
            bot.log('EVENT', `Earned ${currentGp}gp (target: ${targetGp}gp) in ${attempts} pickpocket attempts`);
            return;
        }

        bot.dismissModals();

        const stunnedUntil = bot.getVarp(VARP_STUNNED);
        const actionDelayUntil = bot.getVarp(VARP_ACTION_DELAY);
        const currentTick = bot.getCurrentTick();

        if (stunnedUntil > currentTick || actionDelayUntil > currentTick) {
            const waitUntil = Math.max(stunnedUntil, actionDelayUntil);
            const ticksToWait = waitUntil - currentTick + 1;
            await bot.waitForTicks(ticksToWait);
        }

        if (bot.player.delayed) {
            await bot.waitForCondition(() => !bot.player.delayed, 20);
        }

        let man = bot.findNearbyNpc('Man');
        if (!man) {
            await bot.walkTo(LUMBRIDGE_SPAWN_X, LUMBRIDGE_SPAWN_Z);
            await bot.waitForTicks(2);
            man = bot.findNearbyNpc('Man');
            if (!man) {
                throw new Error(`No Man NPC found near (${LUMBRIDGE_SPAWN_X},${LUMBRIDGE_SPAWN_Z})`);
            }
        }

        attempts++;
        await bot.interactNpc(man, 3); // op3 = Pickpocket
        await bot.waitForTicks(5);
        await bot.waitForTicks(1);
        bot.dismissModals();
    }

    const finalCoins = bot.findItem('Coins');
    throw new Error(`Failed to earn ${targetGp}gp after ${MAX_ATTEMPTS} attempts. Current gp: ${finalCoins ? finalCoins.count : 0}`);
}

/**
 * Walk to a location, catching pathfinding failures gracefully.
 */
async function tryWalkTo(bot: BotAPI, x: number, z: number): Promise<boolean> {
    try {
        await bot.walkToWithPathfinding(x, z);
        return true;
    } catch {
        const dist = Math.max(Math.abs(bot.player.x - x), Math.abs(bot.player.z - z));
        bot.log('STATE', `Pathfinding to (${x},${z}) failed, ended at (${bot.player.x},${bot.player.z}), dist=${dist}`);
        return dist <= 5;
    }
}

/**
 * Attack a goblin and wait for it to die.
 * Returns the coordinates where it died (for loot pickup), or null if it escaped.
 */
async function attackGoblinAndWait(bot: BotAPI, goblin: import('../../src/engine/entity/Npc.js').default): Promise<{ x: number; z: number } | null> {
    bot.log('ACTION', `Attacking goblin at (${goblin.x},${goblin.z}), bot at (${bot.player.x},${bot.player.z})`);

    if (!bot.player.run && bot.player.runenergy >= 500) {
        bot.enableRun(true);
    }

    try {
        await bot.interactNpc(goblin, ATTACK_OP);
    } catch {
        bot.log('STATE', 'Failed to initiate attack on goblin');
        return null;
    }

    // IMPORTANT: Do NOT re-engage after the initial interactNpc.
    // The engine's player_melee_attack script ends with p_opnpc(2) which
    // self-sustains the combat loop. Re-engaging (calling interactNpc again)
    // triggers p_stopaction which cancels the pending p_opnpc(2), resetting
    // the combat cycle and preventing attacks from landing.

    let lastKnownX = goblin.x;
    let lastKnownZ = goblin.z;
    const COMBAT_TIMEOUT = 200;

    for (let tick = 0; tick < COMBAT_TIMEOUT; tick++) {
        await bot.waitForTick();

        if (goblin.isActive) {
            lastKnownX = goblin.x;
            lastKnownZ = goblin.z;
        }

        if (!goblin.isActive) {
            if (bot.player.run) {
                bot.enableRun(false);
            }
            bot.log('EVENT', `Goblin died at (${lastKnownX},${lastKnownZ}) after ~${tick} ticks`);
            await bot.waitForTicks(2);
            return { x: lastKnownX, z: lastKnownZ };
        }
    }

    if (bot.player.run) { bot.enableRun(false); }
    bot.log('STATE', `Combat timed out after ${COMBAT_TIMEOUT} ticks`);
    return null;
}

/**
 * Try to pick up goblin armour from a death location.
 */
async function pickUpGoblinArmour(bot: BotAPI, deathX: number, deathZ: number): Promise<boolean> {
    // Look for "Goblin mail" ground item (display name from obj config)
    // The obj debugname is goblin_armour, but display name is "Goblin mail"
    const groundItem = bot.findNearbyGroundItem('Goblin mail', 5);
    if (groundItem) {
        bot.log('ACTION', `Found Goblin mail on ground at (${groundItem.x},${groundItem.z})`);
        try {
            await bot.takeGroundItem('Goblin mail', groundItem.x, groundItem.z);
            await bot.waitForTicks(2);
            if (bot.findItem('Goblin mail')) {
                bot.log('EVENT', 'Picked up Goblin mail!');
                return true;
            }
        } catch (err) {
            bot.log('STATE', `Failed to pick up Goblin mail: ${(err as Error).message}`);
        }
    }

    // Also try at exact death location
    if (!groundItem) {
        try {
            await bot.takeGroundItem('Goblin mail', deathX, deathZ);
            await bot.waitForTicks(2);
            if (bot.findItem('Goblin mail')) {
                bot.log('EVENT', 'Picked up Goblin mail from death tile!');
                return true;
            }
        } catch {
            // No goblin mail dropped this time — normal
        }
    }

    return false;
}

/**
 * Check if an NPC is reachable (no fence/wall between bot and NPC).
 * Uses pathfinding to verify the bot can path to adjacent tiles.
 * For nearby NPCs (within 5 tiles), skips the strict pathfinding check
 * because walls between adjacent tiles (e.g. low fences near goblin spawns)
 * may block the pathfinder but not actual combat interactions.
 */
function isNpcReachable(bot: BotAPI, npc: import('../../src/engine/entity/Npc.js').default): boolean {
    const dist = Math.max(Math.abs(bot.player.x - npc.x), Math.abs(bot.player.z - npc.z));

    // For nearby NPCs (within findNearbyNpc search radius), skip the strict
    // pathfinding check. The western Lumbridge goblin area has walls/fences
    // that block the pathfinder but not actual combat interactions (the player
    // walks to the nearest accessible adjacent tile and attacks from there).
    if (dist <= 10) {
        return true;
    }

    const level = bot.player.level as number;
    const pathResult = findPathSegment(level, bot.player.x, bot.player.z, npc.x, npc.z);
    if (pathResult.length === 0) {
        return false;
    }
    // Check if the last waypoint is adjacent to the NPC (within 2 tiles)
    const lastWaypoint = pathResult[pathResult.length - 1]!;
    const wx = lastWaypoint & 0x3FFF;
    const wz = (lastWaypoint >> 14) & 0x3FFF;
    const endDist = Math.max(Math.abs(wx - npc.x), Math.abs(wz - npc.z));
    return endDist <= 2;
}

/**
 * Patrol for goblins near Lumbridge. Returns first reachable goblin found.
 * Checks pathfinding reachability to avoid attacking goblins behind fences.
 */
async function patrolForGoblins(bot: BotAPI): Promise<import('../../src/engine/entity/Npc.js').default | null> {
    for (const point of GOBLIN_PATROL_ROUTE) {
        const nearbyGoblin = bot.findNearbyNpc('Goblin', 10);
        if (nearbyGoblin && isNpcReachable(bot, nearbyGoblin)) {
            return nearbyGoblin;
        }

        await tryWalkTo(bot, point.x, point.z);
        await bot.waitForTicks(2);

        const goblin = bot.findNearbyNpc('Goblin', 10);
        if (goblin && isNpcReachable(bot, goblin)) {
            bot.log('EVENT', `Found reachable goblin near ${point.name} at (${goblin.x},${goblin.z})`);
            return goblin;
        }
    }
    return null;
}

/**
 * Kill goblins near Lumbridge until we have the desired number of goblin mails.
 */
async function collectGoblinMails(bot: BotAPI, targetCount: number): Promise<void> {
    bot.log('STATE', `=== Collecting ${targetCount} Goblin mails by killing goblins ===`);

    // Equip bronze pickaxe for better DPS
    if (bot.findItem('Bronze pickaxe')) {
        await bot.equipItem('Bronze pickaxe');
        await bot.waitForTicks(1);
        bot.log('EVENT', 'Equipped bronze pickaxe');
    }

    // Walk to goblin area west of the River Lum (near Lumbridge spawn).
    // Goblins spawn at x=3211-3215, z=3232-3247 — all west of the river.
    // Staying west avoids the Al Kharid toll gate and fenced fields entirely.
    // Avoid (3213,3228) which is inside Lumbridge castle walls.
    await bot.walkToWithPathfinding(3215, 3237);

    let goblinsKilled = 0;
    let totalTicks = 0;
    const MAX_TICKS = 50000;

    while (countItem(bot, 'Goblin mail') < targetCount && totalTicks < MAX_TICKS) {
        const currentCount = countItem(bot, 'Goblin mail');
        if (goblinsKilled % 10 === 0 || goblinsKilled === 0) {
            bot.log('STATE', `Goblin mails: ${currentCount}/${targetCount}, goblins killed: ${goblinsKilled}, ticks: ${totalTicks}`);
        }

        bot.dismissModals();

        if (bot.player.delayed) {
            await bot.waitForCondition(() => !bot.player.delayed, 20);
        }

        // Conserve run energy while patrolling
        if (bot.player.run) {
            bot.enableRun(false);
        }

        // Rest if low on energy
        if (bot.player.runenergy < 3000) {
            const restTicks = Math.min(30, Math.floor((3000 - bot.player.runenergy) / 80));
            if (restTicks > 5) {
                bot.log('STATE', `Resting ${restTicks} ticks for run energy`);
                await bot.waitForTicks(restTicks);
                totalTicks += restTicks;
            }
        }

        let goblin = bot.findNearbyNpc('Goblin', 10);
        // Skip goblins behind fences/walls
        if (goblin && !isNpcReachable(bot, goblin)) {
            bot.log('STATE', `Goblin at (${goblin.x},${goblin.z}) unreachable (fence?), skipping`);
            goblin = null;
        }
        if (!goblin) {
            goblin = await patrolForGoblins(bot);
            totalTicks += 30;

            if (!goblin) {
                await bot.waitForTicks(10);
                totalTicks += 10;
                continue;
            }
        }

        const deathPos = await attackGoblinAndWait(bot, goblin);
        totalTicks += 15;

        if (deathPos) {
            goblinsKilled++;
            bot.dismissModals();

            await pickUpGoblinArmour(bot, deathPos.x, deathPos.z);
            totalTicks += 5;

            if (goblinsKilled % 10 === 0) {
                bot.log('STATE', `Progress: ${goblinsKilled} goblins killed, mails: ${countItem(bot, 'Goblin mail')}/${targetCount}`);
            }
        }

        await bot.waitForTicks(2);
        totalTicks += 2;
    }

    const finalCount = countItem(bot, 'Goblin mail');
    if (finalCount < targetCount) {
        throw new Error(`Failed to collect ${targetCount} goblin mails after ${goblinsKilled} kills and ${totalTicks} ticks (got ${finalCount})`);
    }

    bot.log('EVENT', `Collected ${finalCount} goblin mails after ${goblinsKilled} goblin kills`);
}

/**
 * Pick onions from the enclosed field near Fred's farm.
 */
async function pickOnions(bot: BotAPI, count: number): Promise<void> {
    bot.log('STATE', `=== Picking ${count} onions ===`);

    await bot.walkToWithPathfinding(ONION_GATE_X, ONION_GATE_Z);
    bot.log('STATE', `At onion gate: pos=(${bot.player.x},${bot.player.z})`);
    await bot.openGate(5);
    await bot.waitForTicks(2);
    await bot.walkToWithPathfinding(3189, 3267);
    bot.log('STATE', `Inside onion field: pos=(${bot.player.x},${bot.player.z})`);

    for (let i = 0; i < count; i++) {
        bot.dismissModals();
        if (bot.player.delayed) {
            await bot.waitForCondition(() => !bot.player.delayed, 20);
        }

        const onionsBefore = countItem(bot, 'Onion');
        const onionLoc = bot.findNearbyLoc('onion', 10);
        if (!onionLoc) {
            throw new Error(`No onion loc found near (${bot.player.x},${bot.player.z})`);
        }

        bot.log('ACTION', `Picking onion at (${onionLoc.x},${onionLoc.z})`);
        await bot.interactLoc(onionLoc, 2); // op2 = Pick

        await bot.waitForCondition(() => countItem(bot, 'Onion') > onionsBefore, 20);
        bot.dismissModals();
        bot.log('EVENT', `Picked onion ${i + 1}/${count}`);
    }

    if (countItem(bot, 'Onion') < count) {
        throw new Error(`Expected ${count} onions, found ${countItem(bot, 'Onion')}`);
    }
}

/**
 * Navigate to Aggie's house in Draynor Village.
 */
async function walkToAggie(bot: BotAPI): Promise<void> {
    await bot.walkToWithPathfinding(AGGIE_DOOR_X, AGGIE_DOOR_Z);
    await bot.openDoor('inaccastledoubledoorropen');
    await bot.walkToWithPathfinding(AGGIE_X, AGGIE_Z);
    bot.log('STATE', `At Aggie: pos=(${bot.player.x},${bot.player.z})`);
}

/**
 * Get yellow dye from Aggie (2 onions + 5 coins).
 * Uses the shortcut: use onion on Aggie directly.
 */
async function getYellowDyeFromAggie(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Getting yellow dye from Aggie ===');

    // Use onion on Aggie to trigger @aggie_yellow_dye directly
    await bot.useItemOnNpc('Onion', 'Aggie');
    await bot.waitForTicks(3);

    // The script checks for 2 onions + 5 coins, then makes dye
    // If there's a dialog (chatplayer/objbox), continue through it
    for (let i = 0; i < 5; i++) {
        const hasDialog = await bot.waitForDialog(5);
        if (!hasDialog) break;
        await bot.continueDialog();
    }
    await bot.waitForTicks(2);
    bot.dismissModals();

    if (!bot.findItem('Yellow dye')) {
        throw new Error('Failed to get yellow dye from Aggie');
    }
    bot.log('EVENT', 'Got yellow dye from Aggie');
}

/**
 * Get red dye from Aggie (3 redberries + 5 coins).
 * Uses the shortcut: use redberries on Aggie directly.
 */
async function getRedDyeFromAggie(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Getting red dye from Aggie ===');

    await bot.useItemOnNpc('Redberries', 'Aggie');
    await bot.waitForTicks(3);

    for (let i = 0; i < 5; i++) {
        const hasDialog = await bot.waitForDialog(5);
        if (!hasDialog) break;
        await bot.continueDialog();
    }
    await bot.waitForTicks(2);
    bot.dismissModals();

    if (!bot.findItem('Red dye')) {
        throw new Error('Failed to get red dye from Aggie');
    }
    bot.log('EVENT', 'Got red dye from Aggie');
}

/**
 * Get blue dye from Aggie (2 woad leaves + 5 coins).
 * Uses the shortcut: use woad leaf on Aggie directly.
 */
async function getBlueDyeFromAggie(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Getting blue dye from Aggie ===');

    await bot.useItemOnNpc('Woad leaf', 'Aggie');
    await bot.waitForTicks(3);

    for (let i = 0; i < 5; i++) {
        const hasDialog = await bot.waitForDialog(5);
        if (!hasDialog) break;
        await bot.continueDialog();
    }
    await bot.waitForTicks(2);
    bot.dismissModals();

    if (!bot.findItem('Blue dye')) {
        throw new Error('Failed to get blue dye from Aggie');
    }
    bot.log('EVENT', 'Got blue dye from Aggie');
}

/**
 * Make orange dye by using red dye on yellow dye (or vice versa).
 * From dye_cape.rs2: [opheldu,yellowdye] case reddye -> @craft_dyes(orangedye)
 */
async function makeOrangeDye(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Making orange dye (red + yellow) ===');

    await bot.useItemOnItem('Red dye', 'Yellow dye');
    await bot.waitForTicks(3);
    bot.dismissModals();

    if (!bot.findItem('Orange dye')) {
        throw new Error('Failed to make orange dye from red + yellow dye');
    }
    bot.log('EVENT', 'Made orange dye');
}

/**
 * Buy woad leaves from Wyson the Gardener in Falador Park.
 * Dialog flow: "I'm looking for woad leaves." -> "How about 20 coins?" -> gets 2 leaves
 */
async function buyWoadLeaves(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Buying woad leaves from Wyson ===');

    await bot.walkToWithPathfinding(FALADOR_PARK_X, FALADOR_PARK_Z);
    bot.log('STATE', `At Falador Park: pos=(${bot.player.x},${bot.player.z})`);

    await bot.talkToNpc('Wyson the gardener');
    await bot.waitForDialog(30);
    await bot.continueDialog(); // "I'm the gardener around here..."

    // Multi2: "I'm looking for woad leaves." (1), "Not right now, thanks." (2)
    await bot.waitForDialog(10);
    await bot.selectDialogOption(1);

    await bot.waitForDialog(10);
    await bot.continueDialog(); // chatplayer "I'm looking for woad leaves."

    await bot.waitForDialog(10);
    await bot.continueDialog(); // chatnpc "How much are you willing to pay?"

    // Multi4: "5 coins?" (1), "10 coins?" (2), "15 coins?" (3), "20 coins?" (4)
    // Pick 20 coins to get 2 woad leaves at once
    await bot.waitForDialog(10);
    await bot.selectDialogOption(4);

    await bot.waitForDialog(10);
    await bot.continueDialog(); // chatplayer "How about 20 coins?"

    await bot.waitForDialog(10);
    await bot.continueDialog(); // chatnpc "Okay, that's more than fair."

    // chatnpc "Here, have two, you're a generous person."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    await bot.waitForTicks(3);
    bot.dismissModals();

    const woadCount = countItem(bot, 'Woad leaf');
    if (woadCount < 2) {
        throw new Error(`Expected 2 woad leaves, got ${woadCount}`);
    }
    bot.log('EVENT', `Got ${woadCount} woad leaves from Wyson`);
}

/**
 * Open Wydin's shop via dialog and buy items.
 * Returns with the shop interface still open.
 */
async function openWydinShop(bot: BotAPI): Promise<void> {
    await bot.talkToNpc('Wydin');
    await bot.waitForDialog(15);
    await bot.continueDialog(); // "Welcome to my food store..."

    // Multi3 (no pirate quest): "Yes please." (1), "No, thank you." (2), "What can you recommend?" (3)
    await bot.waitForDialog(10);
    await bot.selectDialogOption(1); // "Yes please."

    await bot.waitForDialog(10);
    await bot.continueDialog(); // chatplayer "Yes please."

    // p_opnpc(3) opens the shop
    await bot.waitForTicks(5);
}

/**
 * Buy redberries from Wydin's food store in Port Sarim.
 *
 * Wydin stocks only 1 redberry at a time (restocks every 100 ticks).
 * To get 3, buy 1, wait for restock, reopen the shop, and repeat.
 */
async function buyRedberries(bot: BotAPI): Promise<void> {
    const TARGET = 3;
    const alreadyHave = countItem(bot, 'Redberries');
    if (alreadyHave >= TARGET) {
        bot.log('STATE', `Already have ${alreadyHave} redberries, skipping shop`);
        return;
    }
    const needed = TARGET - alreadyHave;
    bot.log('STATE', `=== Buying ${needed} redberries from Wydin (have ${alreadyHave}, need ${TARGET}) ===`);

    // Navigate to Port Sarim via waypoints (pathfinder can't cross long distances directly)
    await bot.walkToWithPathfinding(3047, 3237); // Port Sarim area
    await bot.walkToWithPathfinding(WYDIN_X, WYDIN_Z);
    bot.log('STATE', `At Wydin: pos=(${bot.player.x},${bot.player.z})`);

    const wydin = bot.findNearbyNpc('Wydin');
    if (!wydin) {
        throw new Error(`Wydin not found near (${bot.player.x},${bot.player.z})`);
    }

    // The shop restocks 1 redberry every 100 ticks. Buy 1, wait, repeat.
    // Restock fires when (tick % stockrate === 0), so we may need up to 100 ticks.
    const RESTOCK_WAIT = 110; // slightly more than 100 to ensure restock fires

    for (let bought = 0; bought < needed; bought++) {
        if (bought > 0) {
            // Wait for restock before reopening
            bot.log('STATE', `Waiting ~${RESTOCK_WAIT} ticks for redberry restock (${alreadyHave + bought}/${TARGET} have)...`);
            await bot.waitForTicks(RESTOCK_WAIT);
        }

        // Clear any lingering state from previous shop visit
        bot.dismissModals();
        if (bot.player.delayed) {
            await bot.waitForCondition(() => !bot.player.delayed, 20);
            if (bot.player.delayed) bot.player.delayed = false;
        }
        if (bot.player.containsModalInterface()) bot.player.closeModal();

        // Walk back to Wydin (bot may have drifted during restock wait)
        await bot.walkToWithPathfinding(WYDIN_X, WYDIN_Z);

        // Open shop fresh each time
        await openWydinShop(bot);

        // Buy 1 redberry
        await bot.buyFromShop('Redberries', 1);
        await bot.waitForTicks(1);
        bot.dismissModals();

        const current = countItem(bot, 'Redberries');
        bot.log('EVENT', `Bought redberry ${alreadyHave + bought + 1}/${TARGET} (have ${current})`);
    }

    const redberryCount = countItem(bot, 'Redberries');
    if (redberryCount < TARGET) {
        throw new Error(`Expected ${TARGET} redberries, got ${redberryCount}`);
    }
    bot.log('EVENT', `Bought ${redberryCount} redberries from Wydin`);
}

/**
 * Start the quest by talking to the bartender in the Rusty Anchor, Port Sarim.
 * Dialog flow:
 * 1. Multi2/3 depending on barcrawl status — pick "Not very busy in here today, is it?" (option 2)
 * 2. chatplayer "Not very busy in here today, is it?"
 * 3. chatnpc "No, it was earlier..." (about goblins arguing)
 * 4. chatnpc "Knowing the goblins, it could easily turn into a full blown war..."
 * 5. chatplayer "Well, if I have time, I'll see if I can go..."
 * -> %goblinquest = ^gobdip_started (1)
 */
async function startQuest(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Starting Goblin Diplomacy quest ===');

    await bot.walkToWithPathfinding(PORT_SARIM_BAR_X, PORT_SARIM_BAR_Z);
    bot.log('STATE', `At Rusty Anchor: pos=(${bot.player.x},${bot.player.z})`);

    // Open the bar door if needed
    await bot.openDoor('poordooropen');
    await bot.waitForTicks(1);

    await bot.talkToNpc('Bartender');
    await bot.waitForDialog(30);

    // Multi2: "Could I buy a beer please?" (1), "Not very busy in here today, is it?" (2)
    // (When gobdip not started AND no barcrawl, it's a 2-choice)
    await bot.selectDialogOption(2); // "Not very busy in here today, is it?"

    // chatplayer "Not very busy in here today, is it?"
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "No, it was earlier..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Knowing the goblins..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatplayer "Well, if I have time, I'll see if I can go..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    await bot.waitForTicks(3);
    bot.dismissModals();
}

/**
 * Talk to the generals at Goblin Village to advance the quest.
 * The bot talks to General Wartface (simpler dialog, no treasure trail checks).
 *
 * Stage 1: Offer to pick a colour -> selects option 3 "Do you want me to pick..."
 *   Leads to orange_armour label -> varp becomes 2 (will_bring_armour)
 *
 * Stage 2: Has orange goblin armour -> dialog auto-advances -> varp becomes 3
 * Stage 3: Has blue goblin armour -> dialog auto-advances -> varp becomes 4
 * Stage 4: Has brown goblin armour -> dialog auto-advances -> varp becomes 5, then queued to 6
 */
async function talkToGenerals(bot: BotAPI): Promise<void> {
    const stage = bot.getQuestProgress(GOBLIN_QUEST_VARP);
    bot.log('STATE', `Talking to generals at Goblin Village, quest stage=${stage}`);

    // Walk to Goblin Village
    await bot.walkToWithPathfinding(GOBLIN_VILLAGE_X, GOBLIN_VILLAGE_Z);
    bot.log('STATE', `At Goblin Village: pos=(${bot.player.x},${bot.player.z})`);

    // Clear any lingering state
    bot.dismissModals();
    if (bot.player.delayed) {
        await bot.waitForCondition(() => !bot.player.delayed, 20);
        if (bot.player.delayed) bot.player.delayed = false;
    }
    if (bot.player.containsModalInterface()) bot.player.closeModal();

    // The generals spawn around (2957,3511). Try multiple positions to find
    // one that's reachable and adjacent to the generals.
    const wartface = bot.findNearbyNpc('General Wartface', 30);
    if (!wartface) {
        throw new Error(`General Wartface not found near (${bot.player.x},${bot.player.z})`);
    }
    bot.log('STATE', `Wartface at (${wartface.x},${wartface.z}), bot at (${bot.player.x},${bot.player.z})`);

    // Try walking to nearby open tiles around the general
    const offsets = [
        { dx: 0, dz: 1 }, { dx: 1, dz: 0 }, { dx: 0, dz: -1 }, { dx: -1, dz: 0 },
        { dx: 1, dz: 1 }, { dx: -1, dz: 1 }, { dx: 1, dz: -1 }, { dx: -1, dz: -1 },
        { dx: 0, dz: 2 }, { dx: 2, dz: 0 }, { dx: 0, dz: -2 }, { dx: -2, dz: 0 },
    ];
    let reached = false;
    for (const { dx, dz } of offsets) {
        const tx = wartface.x + dx;
        const tz = wartface.z + dz;
        try {
            await bot.walkToWithPathfinding(tx, tz);
            bot.log('STATE', `Reached (${tx},${tz}) near Wartface`);
            reached = true;
            break;
        } catch {
            bot.log('STATE', `Can't reach (${tx},${tz}), trying next`);
        }
    }
    if (!reached) {
        throw new Error(`Cannot reach any tile adjacent to General Wartface at (${wartface.x},${wartface.z}) from (${bot.player.x},${bot.player.z})`);
    }

    // Talk to General Wartface (simpler script, no treasure trail branching)
    await bot.talkToNpc('General Wartface');
    await bot.waitForDialog(30);

    if (stage === STAGE_STARTED) {
        // @goblin_diplomacy_greet_general_wartface:
        // chatnpc "Green armour best."
        await bot.continueDialog();
        // chatnpc_specific "No, no, red every time."
        await bot.waitForDialog(10);
        await bot.continueDialog();
        // chatnpc "Go away, human, we busy."
        await bot.waitForDialog(10);
        await bot.continueDialog();

        // @goblin_diplomacy_greet_player_reply -> stage 1
        // Multi3: "Why are you arguing..." (1), "Wouldn't you prefer peace?" (2),
        //         "Do you want me to pick an armour colour for you?" (3)
        await bot.waitForDialog(10);
        await bot.selectDialogOption(3);

        // @goblin_diplomacy_orange_armour:
        // chatplayer "Do you want me to pick an armour colour for you?"
        await bot.waitForDialog(10);
        await bot.continueDialog();
        // chatplayer "Different to either green or red?"
        await bot.waitForDialog(10);
        await bot.continueDialog();
        // chatnpc_specific Wartface: "Hmm, me dunno..."
        await bot.waitForDialog(10);
        await bot.continueDialog();
        // chatnpc_specific Bentnoze: "Yep, bring us orange armour."
        await bot.waitForDialog(10);
        await bot.continueDialog();
        // chatnpc_specific Wartface: "Yep orange might be good."
        await bot.waitForDialog(10);
        await bot.continueDialog();

        await bot.waitForTicks(3);
        bot.dismissModals();

    } else if (stage === STAGE_WILL_BRING_ARMOUR) {
        // @goblin_diplomacy_greet_general_wartface -> greet_player_reply -> stage 2
        // chatnpc "Green armour best."
        await bot.continueDialog();
        await bot.waitForDialog(10);
        await bot.continueDialog(); // Bentnoze: "No, no, red every time."
        await bot.waitForDialog(10);
        await bot.continueDialog(); // "Go away, human, we busy."

        // @goblin_diplomacy_greet_player_reply_stage_2:
        // chatnpc "Oh it you."
        await bot.waitForDialog(10);
        await bot.continueDialog();

        // If has orange armour -> @goblin_diplomacy_blue_armour
        // chatplayer "I have some orange armour."
        await bot.waitForDialog(10);
        await bot.continueDialog();
        // mesbox "You give some goblin armour to the goblins."
        await bot.waitForDialog(10);
        await bot.continueDialog();
        // chatnpc Wartface: "No. I don't like that much."
        await bot.waitForDialog(10);
        await bot.continueDialog();
        // chatnpc Bentnoze: "It clashes with my skin colour."
        await bot.waitForDialog(10);
        await bot.continueDialog();
        // chatnpc Wartface: "Try bringing us blue armour."
        await bot.waitForDialog(10);
        await bot.continueDialog();

        await bot.waitForTicks(3);
        bot.dismissModals();

    } else if (stage === STAGE_GAVE_ORANGE) {
        // @goblin_diplomacy_greet_general_wartface -> greet_player_reply -> stage 3
        // chatnpc "Green armour best."
        await bot.continueDialog();
        await bot.waitForDialog(10);
        await bot.continueDialog(); // Bentnoze
        await bot.waitForDialog(10);
        await bot.continueDialog(); // "Go away"

        // @goblin_diplomacy_greet_player_reply_stage_3:
        // If has blue armour -> @goblin_diplomacy_brown_armour
        // chatplayer "I have some blue armour."
        await bot.waitForDialog(10);
        await bot.continueDialog();
        // mesbox "You give some goblin armour to the goblins."
        await bot.waitForDialog(10);
        await bot.continueDialog();
        // chatnpc Wartface: "Doesn't seem quite right."
        await bot.waitForDialog(10);
        await bot.continueDialog();
        // chatnpc Bentnoze: "Maybe if it was a bit lighter."
        await bot.waitForDialog(10);
        await bot.continueDialog();
        // chatnpc Wartface: "Yeah try brown."
        await bot.waitForDialog(10);
        await bot.continueDialog();
        // chatplayer "I thought that was the armour you were changing from?..."
        await bot.waitForDialog(10);
        await bot.continueDialog();

        await bot.waitForTicks(3);
        bot.dismissModals();

    } else if (stage === STAGE_GAVE_BLUE) {
        // @goblin_diplomacy_greet_general_wartface -> greet_player_reply -> stage 4
        // chatnpc "Green armour best."
        await bot.continueDialog();
        await bot.waitForDialog(10);
        await bot.continueDialog(); // Bentnoze
        await bot.waitForDialog(10);
        await bot.continueDialog(); // "Go away"

        // @goblin_diplomacy_greet_player_reply_stage_4:
        // If has brown armour -> @goblin_diplomacy_finish
        // chatplayer "Ok I've got brown armour."
        await bot.waitForDialog(10);
        await bot.continueDialog();
        // mesbox "You give some goblin armour to the goblins."
        await bot.waitForDialog(10);
        await bot.continueDialog();
        // chatnpc Wartface: "This is rather nice."
        await bot.waitForDialog(10);
        await bot.continueDialog();
        // chatnpc Bentnoze: "Yes I could see myself wearing somethin' like that."
        await bot.waitForDialog(10);
        await bot.continueDialog();
        // chatnpc Wartface: "It's a deal then brown armour it is."
        await bot.waitForDialog(10);
        await bot.continueDialog();
        // chatnpc Wartface: "Thank you for sorting our argument."
        await bot.waitForDialog(10);
        await bot.continueDialog();

        // queue(goblin_diplomacy_complete_quest) fires next tick
        await bot.waitForTicks(5);
        bot.dismissModals();
    }
}

/**
 * Walk from the current position to Goblin Village (north of Falador).
 * Route: Lumbridge -> Draynor -> Falador -> north to Goblin Village
 */
async function walkToGoblinVillage(bot: BotAPI): Promise<void> {
    bot.log('STATE', 'Walking to Goblin Village...');

    // Skip if already near Goblin Village (handles retries)
    const dist = Math.max(Math.abs(bot.player.x - GOBLIN_VILLAGE_X), Math.abs(bot.player.z - GOBLIN_VILLAGE_Z));
    if (dist <= 20) {
        bot.log('STATE', `Already near Goblin Village at (${bot.player.x},${bot.player.z}), dist=${dist}`);
        return;
    }

    // Go via Draynor/Falador road, avoiding statue at (2964,3380)
    await bot.walkToWithPathfinding(3110, 3260); // Draynor area
    await bot.walkToWithPathfinding(3007, 3327); // West toward Falador
    await bot.walkToWithPathfinding(2968, 3382); // North toward Falador (offset east to avoid statue)
    await bot.walkToWithPathfinding(2965, 3440); // Continue north
    await bot.walkToWithPathfinding(GOBLIN_VILLAGE_X, GOBLIN_VILLAGE_Z);

    bot.log('STATE', `At Goblin Village: pos=(${bot.player.x},${bot.player.z})`);
}

/**
 * Walk from Goblin Village back to Draynor/Lumbridge area.
 */
async function _walkFromGoblinVillageToLumbridge(bot: BotAPI): Promise<void> {
    bot.log('STATE', 'Walking from Goblin Village to Lumbridge area...');

    await bot.walkToWithPathfinding(2965, 3440);
    await bot.walkToWithPathfinding(2968, 3382); // offset east to avoid statue at (2964,3380)
    await bot.walkToWithPathfinding(3007, 3327);
    await bot.walkToWithPathfinding(3110, 3260);
    await bot.walkToWithPathfinding(LUMBRIDGE_SPAWN_X, LUMBRIDGE_SPAWN_Z);

    bot.log('STATE', `At Lumbridge: pos=(${bot.player.x},${bot.player.z})`);
}

/**
 * Build the Goblin Diplomacy state machine.
 */
export function buildGoblinDiplomacyStates(bot: BotAPI): BotState {
    return {
        name: 'goblin-diplomacy',
        isComplete: () => bot.getQuestProgress(GOBLIN_QUEST_VARP) === STAGE_COMPLETE,
        run: async () => { throw new Error('Composite state should not be called directly'); },
        children: [
            {
                name: 'earn-coins',
                stuckThreshold: 3000,
                isComplete: () => {
                    const coins = bot.findItem('Coins');
                    return coins !== null && coins.count >= 80;
                },
                run: async () => {
                    await earnCoins(bot, 80);
                }
            },
            {
                name: 'collect-goblin-mails',
                isComplete: () => countItem(bot, 'Goblin mail') + countItem(bot, 'Orange goblin mail') + countItem(bot, 'Blue goblin mail') >= 3,
                maxRetries: 5,
                run: async () => {
                    await collectGoblinMails(bot, 3);
                }
            },
            {
                name: 'collect-ingredients',
                isComplete: () => {
                    // Complete when we have onions (or already have dyes)
                    return countItem(bot, 'Onion') >= 2 || (bot.findItem('Yellow dye') !== null || bot.findItem('Orange dye') !== null);
                },
                run: async () => {
                    // Safety: ensure we're west of the Al Kharid toll gate
                    // before navigating to Lumbridge/onion field.
                    await ensureWestOfTollGate(bot);
                    await bot.walkToWithPathfinding(LUMBRIDGE_SPAWN_X, LUMBRIDGE_SPAWN_Z);
                    await pickOnions(bot, 2);
                }
            },
            {
                name: 'start-quest',
                isComplete: () => bot.getQuestProgress(GOBLIN_QUEST_VARP) >= STAGE_STARTED,
                run: async () => {
                    await bot.walkToWithPathfinding(3110, 3260);
                    await bot.walkToWithPathfinding(3047, 3237);
                    await startQuest(bot);

                    const varp = bot.getQuestProgress(GOBLIN_QUEST_VARP);
                    if (varp !== STAGE_STARTED) {
                        throw new Error(`Quest varp after start is ${varp}, expected ${STAGE_STARTED}`);
                    }
                    bot.log('EVENT', `Quest started! varp=${varp}`);
                }
            },
            {
                name: 'prepare-dyes',
                isComplete: () => {
                    return bot.findItem('Orange goblin mail') !== null && bot.findItem('Blue goblin mail') !== null && bot.findItem('Goblin mail') !== null;
                },
                run: async () => {
                    // Calculate how many coins we still need:
                    // Redberries: 3gp each * (3 - already owned)
                    // Yellow dye: 5gp, Red dye: 5gp, Woad leaves: 20gp
                    const redberriesOwned = countItem(bot, 'Redberries');
                    const redberryCost = (3 - redberriesOwned) * 3;
                    const dyeCost = (bot.findItem('Yellow dye') || bot.findItem('Orange dye')) ? 0 : 5;
                    const redDyeCost = bot.findItem('Red dye') ? 0 : 5;
                    const woadCost = (countItem(bot, 'Woad leaf') >= 2 || bot.findItem('Blue dye')) ? 0 : 20;
                    const COINS_NEEDED = Math.max(0, redberryCost + dyeCost + redDyeCost + woadCost) + 5; // +5 safety margin
                    const currentCoins = bot.findItem('Coins');
                    const currentGp = currentCoins ? currentCoins.count : 0;
                    if (currentGp < COINS_NEEDED) {
                        bot.log('STATE', `Only ${currentGp}gp, need ${COINS_NEEDED}gp — earning more by pickpocketing`);
                        await ensureWestOfTollGate(bot);
                        // Navigate to Lumbridge via waypoints (pathfinder can't cross long distances)
                        await bot.walkToWithPathfinding(3047, 3237); // Port Sarim area
                        await bot.walkToWithPathfinding(3110, 3260); // Draynor area
                        await bot.walkToWithPathfinding(LUMBRIDGE_SPAWN_X, LUMBRIDGE_SPAWN_Z);
                        await earnCoins(bot, COINS_NEEDED);
                    }

                    // Each step checks if already done so retries are idempotent.

                    // Step 1: Get onions (if we don't have dyes yet)
                    if (!bot.findItem('Yellow dye') && !bot.findItem('Orange dye') && !bot.findItem('Orange goblin mail')) {
                        if (countItem(bot, 'Onion') < 2) {
                            bot.log('STATE', 'Need onions — picking from field');
                            await ensureWestOfTollGate(bot);
                            await bot.walkToWithPathfinding(3110, 3260);
                            await bot.walkToWithPathfinding(LUMBRIDGE_SPAWN_X, LUMBRIDGE_SPAWN_Z);
                            await pickOnions(bot, 2);
                        }
                    }

                    // Step 2: Get redberries (if we don't have red dye yet)
                    if (!bot.findItem('Red dye') && !bot.findItem('Orange dye') && !bot.findItem('Orange goblin mail')) {
                        await buyRedberries(bot);
                    }

                    // Step 3: Make orange dye (yellow + red -> orange)
                    if (!bot.findItem('Orange dye') && !bot.findItem('Orange goblin mail')) {
                        // Navigate to Aggie via waypoints from wherever we are
                        await bot.walkToWithPathfinding(3047, 3237); // Port Sarim north
                        await bot.walkToWithPathfinding(3110, 3260); // Draynor
                        await walkToAggie(bot);

                        if (!bot.findItem('Yellow dye')) {
                            await getYellowDyeFromAggie(bot);
                        }
                        if (!bot.findItem('Red dye')) {
                            await getRedDyeFromAggie(bot);
                        }
                        await makeOrangeDye(bot);

                        await bot.openDoor('inaccastledoubledoorropen');
                        await bot.waitForTicks(1);
                    }

                    // Step 4: Get woad leaves + blue dye
                    if (!bot.findItem('Blue dye') && !bot.findItem('Blue goblin mail')) {
                        if (countItem(bot, 'Woad leaf') < 2) {
                            await bot.walkToWithPathfinding(3007, 3327); // Falador south
                            await buyWoadLeaves(bot);
                        }

                        // Navigate from Falador Park back to Draynor via waypoints
                        await bot.walkToWithPathfinding(3007, 3327); // Falador south
                        await bot.walkToWithPathfinding(3047, 3237); // Port Sarim area
                        await bot.walkToWithPathfinding(3110, 3260); // Draynor
                        await walkToAggie(bot);
                        await getBlueDyeFromAggie(bot);

                        await bot.openDoor('inaccastledoubledoorropen');
                        await bot.waitForTicks(1);
                    }

                    // Step 5: Dye the goblin mails
                    if (!bot.findItem('Orange goblin mail')) {
                        await bot.useItemOnItem('Orange dye', 'Goblin mail');
                        await bot.waitForTicks(3);
                        bot.dismissModals();
                        if (!bot.findItem('Orange goblin mail')) {
                            throw new Error('Failed to dye goblin mail orange');
                        }
                        bot.log('EVENT', 'Dyed goblin mail orange');
                    }

                    if (!bot.findItem('Blue goblin mail')) {
                        await bot.useItemOnItem('Blue dye', 'Goblin mail');
                        await bot.waitForTicks(3);
                        bot.dismissModals();
                        if (!bot.findItem('Blue goblin mail')) {
                            throw new Error('Failed to dye goblin mail blue');
                        }
                        bot.log('EVENT', 'Dyed goblin mail blue');
                    }

                    if (!bot.findItem('Goblin mail')) {
                        throw new Error('No brown goblin mail remaining in inventory');
                    }
                    bot.log('EVENT', 'Brown goblin mail ready');
                }
            },
            {
                name: 'deliver-to-generals',
                isComplete: () => bot.getQuestProgress(GOBLIN_QUEST_VARP) === STAGE_COMPLETE,
                run: async () => {
                    bot.log('STATE', `Inventory before generals: ${bot.getInventory().map(i => i.name).join(', ')}`);

                    // Walk to Goblin Village and deliver armours
                    await walkToGoblinVillage(bot);

                    // Stage 1 -> 2: offer to help
                    if (bot.getQuestProgress(GOBLIN_QUEST_VARP) === STAGE_STARTED) {
                        await talkToGenerals(bot);
                        const varp = bot.getQuestProgress(GOBLIN_QUEST_VARP);
                        if (varp !== STAGE_WILL_BRING_ARMOUR) {
                            throw new Error(`Quest varp after offering is ${varp}, expected ${STAGE_WILL_BRING_ARMOUR}`);
                        }
                        bot.log('EVENT', `Offered to bring armour! varp=${varp}`);
                    }

                    // Stage 2 -> 3: give orange
                    if (bot.getQuestProgress(GOBLIN_QUEST_VARP) === STAGE_WILL_BRING_ARMOUR) {
                        await talkToGenerals(bot);
                        const varp = bot.getQuestProgress(GOBLIN_QUEST_VARP);
                        if (varp !== STAGE_GAVE_ORANGE) {
                            throw new Error(`Quest varp after giving orange is ${varp}, expected ${STAGE_GAVE_ORANGE}`);
                        }
                        bot.log('EVENT', `Gave orange armour! varp=${varp}`);
                    }

                    // Stage 3 -> 4: give blue
                    if (bot.getQuestProgress(GOBLIN_QUEST_VARP) === STAGE_GAVE_ORANGE) {
                        await talkToGenerals(bot);
                        const varp = bot.getQuestProgress(GOBLIN_QUEST_VARP);
                        if (varp !== STAGE_GAVE_BLUE) {
                            throw new Error(`Quest varp after giving blue is ${varp}, expected ${STAGE_GAVE_BLUE}`);
                        }
                        bot.log('EVENT', `Gave blue armour! varp=${varp}`);
                    }

                    // Stage 4 -> 5 -> 6: give brown
                    if (bot.getQuestProgress(GOBLIN_QUEST_VARP) === STAGE_GAVE_BLUE) {
                        await talkToGenerals(bot);
                    }

                    await bot.waitForTicks(5);
                    bot.dismissModals();

                    const finalVarp = bot.getQuestProgress(GOBLIN_QUEST_VARP);
                    const craftingSkill = bot.getSkill('Crafting');

                    if (finalVarp !== STAGE_COMPLETE) {
                        throw new Error(`Quest not complete: varp is ${finalVarp}, expected ${STAGE_COMPLETE}`);
                    }
                    if (craftingSkill.exp <= 0) {
                        throw new Error('No crafting XP gained during quest');
                    }

                    const hasGoldBar = bot.findItem('Gold bar') !== null;
                    if (!hasGoldBar) {
                        throw new Error('Gold bar reward not received');
                    }

                    bot.log('SUCCESS', `Goblin Diplomacy quest complete! varp=${finalVarp}, crafting_xp=${craftingSkill.exp}, has_gold_bar=${hasGoldBar}`);
                }
            }
        ]
    };
}

export async function goblinDiplomacy(bot: BotAPI): Promise<void> {
    // === Setup: skip tutorial, start in Lumbridge ===
    await skipTutorial(bot);
    await bot.waitForTicks(2);

    bot.log('STATE', `Starting Goblin Diplomacy quest at (${bot.player.x},${bot.player.z},${bot.player.level})`);

    const initialVarp = bot.getQuestProgress(GOBLIN_QUEST_VARP);
    if (initialVarp !== STAGE_NOT_STARTED) {
        throw new Error(`Quest varp is ${initialVarp}, expected ${STAGE_NOT_STARTED} (not started)`);
    }

    const root = buildGoblinDiplomacyStates(bot);
    const snapshotDir = path.resolve(import.meta.dir, '..', 'test', 'snapshots');
    await runStateMachine(bot, { root, varpIds: [GOBLIN_QUEST_VARP], captureSnapshots: true, snapshotDir });
}

export const metadata: ScriptMeta = {
    name: 'goblindiplomacy',
    type: 'quest',
    varpId: GOBLIN_QUEST_VARP,
    varpComplete: STAGE_COMPLETE,
    maxTicks: 80000, // RNG-heavy: ~77 goblin kills needed for 3 goblin mail drops
    run: goblinDiplomacy,
    buildStates: buildGoblinDiplomacyStates,
};
