import path from 'path';
import { BotAPI } from '../../runtime/api.js';
import { type BotState, runStateMachine } from '../../runtime/state-machine.js';
import type { ScriptMeta } from '../../runtime/script-meta.js';
import { skipTutorial } from '../skip-tutorial.js';
import NpcType from '../../../src/cache/config/NpcType.js';
import type Npc from '../../../src/engine/entity/Npc.js';

// ---- Varp IDs ----
const VARP_ACTION_DELAY = 58;
const VARP_STUNNED = 103;
const _VARP_COM_MODE = 43; // combat style: 0=accurate, 1=aggressive1, 2=aggressive2, 3=defensive

// ---- Key locations ----
const LUMBRIDGE_SPAWN_X = 3222;
const LUMBRIDGE_SPAWN_Z = 3218;

// Lumbridge General Store (Shop keeper inside)
const GENERAL_STORE_X = 3212;
const GENERAL_STORE_Z = 3247;

// Bob's Axes (Lumbridge)
const BOB_SHOP_X = 3230;
const BOB_SHOP_Z = 3203;

// Lumbridge furnace
const FURNACE_AREA_X = 3226;
const FURNACE_AREA_Z = 3254;

// SE Varrock mine (copper, tin rocks)
const MINE_AREA_X = 3298;
const MINE_AREA_Z = 3315;

// Draynor Village fishing spots — Net/Bait spot coordinates
// From fishing_movement_draynor_village_enum: (3086,3227), (3086,3228), (3085,3230), (3085,3231)
const DRAYNOR_FISH_AREA_X = 3087;
const DRAYNOR_FISH_AREA_Z = 3228;

// Lumbridge Castle stairs
const STAIRS_AREA_X = 3206;
const STAIRS_AREA_Z = 3210;

// Spinning wheel area on level 1 (Lumbridge Castle)
const SPINNING_WHEEL_X = 3209;
const SPINNING_WHEEL_Z = 3213;

// Sheep area (east of Fred's farm) — sheep wander x=3193-3210, z=3258-3276
const _SHEEP_FIELD_ENTRY_X = 3214;
const _SHEEP_FIELD_ENTRY_Z = 3262;
const SHEEP_AREA_X = 3198;
const SHEEP_AREA_Z = 3274;

// Chicken area — Lumbridge chicken coop (east of Lumbridge, north of cow field)
const CHICKEN_AREA_X = 3231;
const CHICKEN_AREA_Z = 3298;

// Varrock route waypoints (from rune-mysteries.ts)
const VARROCK_ROUTE = [
    { x: 3105, z: 3250, name: 'North past Draynor Village' },
    { x: 3082, z: 3336, name: 'North-west to Barbarian Village area' },
    { x: 3080, z: 3400, name: 'North along west side of Varrock wall' },
    { x: 3175, z: 3427, name: 'East to Varrock west gate area' },
];

// Lowe's Archery Emporium (Varrock)
const LOWE_AREA_X = 3233;
const LOWE_AREA_Z = 3421;

// Aubury's Rune Shop (Varrock)
const AUBURY_AREA_X = 3253;
const AUBURY_AREA_Z = 3401;

// Varrock bank (booth at ~3253,3420)
const _VARROCK_BANK_X = 3253;
const _VARROCK_BANK_Z = 3420;

// Wind Strike spell component ID (from interface.pack: 1152=magic:wind_strike)
const WIND_STRIKE_COM = 1152;

// Air altar entrance (for runecrafting)
// The mysterious ruins (air altar) are south of Falador at (2985, 3292)
const _AIR_ALTAR_RUINS_X = 2985;
const _AIR_ALTAR_RUINS_Z = 3292;

// Lumbridge anvil — there's an anvil in the Lumbridge basement area
// Actually, the Varrock west bank has an anvil nearby. Let's use the one near the mine.
// Varrock anvil (Varrock west, near Dorics): but easiest is the Lumbridge one if there is one.
// Actually, Lumbridge doesn't have a convenient anvil. Let's use Varrock south anvil.
// The anvil at (3188, 3427) in the building west of Varrock square.
const VARROCK_ANVIL_X = 3188;
const VARROCK_ANVIL_Z = 3427;

// XP needed for level 10 = 1154 (RS2 XP table, 10x scale means 11540 internal)
// Actually the engine stores XP in tenths, so level 10 = 1154 XP means 1154 stored.
// Let me check: in the thieving test, getSkill returns .exp which is the raw stat value.
// RS2 stores XP * 10 internally. Level 10 needs 1154.3 XP = 11543 stored.
// But looking at the code, player.stats[] stores the raw value.
// Let me just check the level field instead of XP.

// ---- Helper functions ----

/**
 * Wait for stun/delay to clear before performing next action.
 */
async function _waitForClear(bot: BotAPI): Promise<void> {
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
}

/**
 * Pickpocket men to earn coins.
 * Mirrors the working thieving-men.ts pattern exactly.
 */
async function earnCoins(bot: BotAPI, targetGp: number): Promise<void> {
    bot.log('STATE', `=== Earning ${targetGp}gp by pickpocketing men ===`);

    let attempts = 0;
    let lastProgressAttempt = 0;
    let lastKnownGp = 0;
    const MAX_TICKS = 60000; // generous limit (with HP regen waits)
    const STALL_LIMIT = 100; // throw after 100 consecutive attempts with no progress
    const startTick = bot.getCurrentTick();

    while (bot.getCurrentTick() - startTick < MAX_TICKS) {
        const coins = bot.findItem('Coins');
        const currentGp = coins ? coins.count : 0;
        if (currentGp >= targetGp) {
            bot.log('EVENT', `Earned ${currentGp}gp (target: ${targetGp}gp) in ${attempts} attempts`);
            return;
        }

        // Track progress — detect stalls early
        if (currentGp > lastKnownGp) {
            lastKnownGp = currentGp;
            lastProgressAttempt = attempts;
        } else if (attempts - lastProgressAttempt > STALL_LIMIT && attempts > STALL_LIMIT) {
            throw new Error(`Pickpocketing stalled: no progress for ${STALL_LIMIT} attempts (stuck at ${currentGp}gp). Retrying from fresh state.`);
        }

        // Check HP — if too low, wait for natural regeneration to avoid death
        // Death drops all items including coins. HP regen is 1 per ~100 ticks.
        const hp = bot.getHealth();
        if (hp.current <= 2) {
            const regenWait = (hp.max - hp.current) * 100; // wait for substantial regen
            bot.log('STATE', `HP low (${hp.current}/${hp.max}), waiting ${regenWait} ticks for regen`);
            await bot.waitForTicks(Math.min(regenWait, 500));
            continue;
        }

        // Clear any modal/delayed state before next pickpocket attempt
        await bot.clearPendingState();

        // Wait until stun and action_delay varps have expired (exact same as thieving-men.ts)
        const stunnedUntil = bot.getVarp(VARP_STUNNED);
        const actionDelayUntil = bot.getVarp(VARP_ACTION_DELAY);
        const currentTick = bot.getCurrentTick();

        if (stunnedUntil > currentTick || actionDelayUntil > currentTick) {
            const waitUntil = Math.max(stunnedUntil, actionDelayUntil);
            const ticksToWait = waitUntil - currentTick + 1;
            await bot.waitForTicks(ticksToWait);
        }

        // Find a nearby Man NPC
        let man = bot.findNearbyNpc('Man');
        if (!man) {
            await bot.walkTo(LUMBRIDGE_SPAWN_X, LUMBRIDGE_SPAWN_Z);
            await bot.waitForTicks(2);
            man = bot.findNearbyNpc('Man');
            if (!man) {
                throw new Error('No Man NPC found for pickpocketing');
            }
        }

        attempts++;
        const expBefore = bot.getSkill('Thieving').exp;

        // Set interaction - engine will auto-walk to NPC and execute pickpocket
        await bot.interactNpc(man, 3);

        // Wait for the pickpocket action to resolve (same as thieving-men.ts)
        await bot.waitForTicks(5);

        const expAfter = bot.getSkill('Thieving').exp;
        if (expAfter > expBefore) {
            // Wait 1 tick then dismiss modals (same as thieving-men.ts)
            await bot.waitForTicks(1);
            bot.dismissModals();
        }

        if (attempts % 50 === 0) {
            const c = bot.findItem('Coins');
            const hpNow = bot.getHealth();
            bot.log('STATE', `Pickpocket progress: ${c ? c.count : 0}gp after ${attempts} attempts (thieving xp=${bot.getSkill('Thieving').exp}, hp=${hpNow.current}/${hpNow.max})`);
        }
    }

    const finalCoins = bot.findItem('Coins');
    throw new Error(`Failed to earn ${targetGp}gp after ${attempts} attempts / ${MAX_TICKS} ticks. Current gp: ${finalCoins ? finalCoins.count : 0}`);
}

/**
 * Buy items from a shop. Shop must already be open.
 */
async function buyItems(bot: BotAPI, itemName: string, quantity: number): Promise<void> {
    await bot.buyFromShop(itemName, quantity);
    await bot.waitForTicks(1);
}

/**
 * Open the Lumbridge General Store by talking to Shop keeper (op3=Trade).
 */
async function openLumbridgeGeneralStore(bot: BotAPI): Promise<void> {
    await bot.walkToWithPathfinding(GENERAL_STORE_X, GENERAL_STORE_Z);
    const door = bot.findNearbyLoc('poordooropen', 5);
    if (door) {
        await bot.interactLoc(door, 1);
        await bot.waitForTicks(2);
    }
    const shopkeeper = bot.findNearbyNpc('Shop keeper');
    if (!shopkeeper) {
        throw new Error('Shop keeper not found near general store');
    }
    await bot.interactNpc(shopkeeper, 3); // op3 = Trade
    await bot.waitForTicks(3);
}

/**
 * Open Bob's Axes shop.
 */
async function openBobsAxes(bot: BotAPI): Promise<void> {
    await bot.walkToWithPathfinding(BOB_SHOP_X, BOB_SHOP_Z);
    // Bob's shop may or may not have a door. Try opening if one exists nearby.
    const door = bot.findNearbyLoc('poordooropen', 5);
    if (door) {
        await bot.interactLoc(door, 1);
        await bot.waitForTicks(2);
    }
    const bob = bot.findNearbyNpc('Bob');
    if (!bob) {
        throw new Error('Bob not found near his shop');
    }
    await bot.interactNpc(bob, 3); // op3 = Trade
    await bot.waitForTicks(3);
}

/**
 * Walk from Lumbridge to Varrock using intermediate waypoints.
 */
async function walkToVarrock(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Walking from Lumbridge to Varrock ===');
    for (const wp of VARROCK_ROUTE) {
        await bot.walkToWithPathfinding(wp.x, wp.z);
    }
    bot.log('STATE', `Arrived in Varrock: pos=(${bot.player.x},${bot.player.z})`);
}

/**
 * Walk from Varrock back to Lumbridge.
 */
async function walkToLumbridge(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Walking from Varrock to Lumbridge ===');
    for (const wp of [...VARROCK_ROUTE].reverse()) {
        await bot.walkToWithPathfinding(wp.x, wp.z);
    }
    await bot.walkToWithPathfinding(LUMBRIDGE_SPAWN_X, LUMBRIDGE_SPAWN_Z);
    bot.log('STATE', `Arrived in Lumbridge: pos=(${bot.player.x},${bot.player.z})`);
}

/**
 * Navigate to bank booths in Lumbridge (upstairs, level 2).
 * Lumbridge has a bank on the top floor of the castle.
 */
async function _goToLumbridgeBank(bot: BotAPI): Promise<void> {
    // Navigate into the castle
    await bot.walkToWithPathfinding(3218, 3218);
    await bot.openDoor('openbankdoor_l');
    await bot.walkToWithPathfinding(3215, 3215);
    await bot.openDoor('poordooropen');
    await bot.walkToWithPathfinding(STAIRS_AREA_X, STAIRS_AREA_Z);

    // Climb to level 1
    await bot.climbStairs('loc_1738', 1);
    await bot.waitForTicks(2);

    if (bot.player.level as number !== 1) {
        throw new Error(`Failed to climb to level 1: ${bot.player.level}`);
    }

    // Climb to level 2
    await bot.climbStairs('loc_1739', 2); // op2=Climb-up
    await bot.waitForTicks(2);

    if (bot.player.level as number !== 2) {
        throw new Error(`Failed to climb to level 2: ${bot.player.level}`);
    }

    // Walk to the bank booth area on level 2
    await bot.walkToWithPathfinding(3208, 3220);
    bot.log('STATE', `At Lumbridge bank: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
}

/**
 * Navigate down from Lumbridge bank (level 2) to ground floor.
 */
async function _goDownFromLumbridgeBank(bot: BotAPI): Promise<void> {
    // Walk to stair area on level 2
    await bot.walkToWithPathfinding(3206, 3214);

    // Climb down from level 2 to level 1
    await bot.climbStairs('loc_1740', 1); // op1=Climb-down
    await bot.waitForTicks(2);

    if (bot.player.level as number !== 1) {
        throw new Error(`Failed to climb down to level 1: ${bot.player.level}`);
    }

    // Climb down from level 1 to ground floor
    await bot.climbStairs('loc_1739', 3); // op3=Climb-down
    await bot.waitForTicks(2);

    if (bot.player.level as number !== 0) {
        throw new Error(`Failed to climb down to level 0: ${bot.player.level}`);
    }

    bot.log('STATE', `Back on ground floor: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
}

/**
 * Navigate to the spinning wheel on level 1 of Lumbridge Castle.
 */
async function goToSpinningWheel(bot: BotAPI): Promise<void> {
    await bot.walkToWithPathfinding(3218, 3218);
    await bot.openDoor('openbankdoor_l');
    await bot.walkToWithPathfinding(3215, 3215);
    await bot.openDoor('poordooropen');
    await bot.walkToWithPathfinding(STAIRS_AREA_X, STAIRS_AREA_Z);

    await bot.climbStairs('loc_1738', 1);
    await bot.waitForTicks(2);

    if (bot.player.level !== 1) {
        throw new Error(`Failed to climb to level 1: ${bot.player.level}`);
    }

    await bot.openDoor('poordooropen');
    await bot.waitForTicks(1);
    await bot.walkToWithPathfinding(SPINNING_WHEEL_X, SPINNING_WHEEL_Z);
    bot.log('STATE', `Near spinning wheel: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
}

/**
 * Navigate down from spinning wheel (level 1) to ground floor.
 */
async function goDownFromSpinningWheel(bot: BotAPI): Promise<void> {
    // Clear any leftover modal/delay from spinning wheel before climbing stairs
    await bot.clearPendingState();
    await bot.waitForTicks(2);

    await bot.walkToWithPathfinding(3206, 3210);

    // Try climbing stairs with retry — spinning wheel sometimes leaves stale state
    for (let attempt = 1; attempt <= 3; attempt++) {
        await bot.clearPendingState();
        await bot.climbStairs('loc_1739', 3);
        await bot.waitForTicks(3);

        if (bot.player.level === 0) break;

        bot.log('STATE', `Climb down attempt ${attempt}/3 failed, still on level ${bot.player.level}`);
        if (attempt === 3) {
            throw new Error(`Failed to climb down to level 0 after 3 attempts: level=${bot.player.level}`);
        }
        // Wait and retry
        await bot.waitForTicks(5);
        await bot.walkToWithPathfinding(3206, 3210);
    }

    bot.log('STATE', `Back on ground floor: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Walk out of the castle to the Lumbridge spawn area
    await bot.openDoor('poordooropen');
    await bot.waitForTicks(1);
    await bot.walkToWithPathfinding(3215, 3215);
    await bot.openDoor('openbankdoor_l');
    await bot.waitForTicks(1);
    await bot.walkToWithPathfinding(LUMBRIDGE_SPAWN_X, LUMBRIDGE_SPAWN_Z);
}

/**
 * Attack an NPC and wait for it to die. Returns death position or null.
 */
async function attackNpcAndWait(bot: BotAPI, npc: Npc, maxTicks: number = 400): Promise<{ x: number; z: number } | null> {
    const npcType = NpcType.get(npc.type);
    bot.log('ACTION', `Attacking ${npcType.name} at (${npc.x},${npc.z})`);

    try {
        await bot.interactNpc(npc, 2); // op2 = Attack
    } catch {
        return null;
    }

    let lastX = npc.x;
    let lastZ = npc.z;
    const _HITPOINTS_STAT = 3;

    for (let tick = 0; tick < maxTicks; tick++) {
        await bot.waitForTick();

        if (npc.isActive) {
            lastX = npc.x;
            lastZ = npc.z;
        }

        if (!npc.isActive) {
            bot.log('EVENT', `${npcType.name} died at (${lastX},${lastZ}) after ~${tick} ticks`);
            await bot.waitForTicks(2);
            return { x: lastX, z: lastZ };
        }

        // Do NOT re-engage — the engine's player_melee_attack script ends with
        // p_opnpc(2) which self-sustains the combat loop. Re-engaging cancels the
        // pending p_opnpc(2), resetting the combat cycle and preventing hits.
    }

    bot.log('STATE', `Combat timed out after ${maxTicks} ticks`);
    return null;
}

// ================================================================
// SKILL TRAINING SECTIONS
// ================================================================

/**
 * Train Woodcutting to level 10.
 * Chop normal trees near Lumbridge. Trees give 25 XP each. Need ~37 logs for 1154 XP.
 * Bot should already have a bronze axe (bought from Bob's Axes).
 */
async function trainWoodcutting(bot: BotAPI): Promise<void> {
    bot.log('STATE', '========== WOODCUTTING ==========');
    const targetLevel = 10;

    // Tree areas near Lumbridge
    const TREE_AREA_X = 3220;
    const TREE_AREA_Z = 3244;
    let failedInteractions = 0;

    await bot.walkToWithPathfinding(TREE_AREA_X, TREE_AREA_Z);

    while (bot.getSkill('Woodcutting').baseLevel < targetLevel) {
        await bot.clearPendingState();

        // Check inv space - drop any non-essential items
        if (bot.freeSlots() < 1) {
            const droppable = bot.findItem('Logs')
                ?? bot.findItem('Raw shrimps')
                ?? bot.findItem('Raw anchovies')
                ?? bot.findItem('Shrimps')
                ?? bot.findItem('Burnt fish');
            if (droppable) {
                await bot.dropItem(droppable.name);
                await bot.waitForTicks(1);
                continue;
            }
            throw new Error('Inventory full during woodcutting but nothing to drop');
        }

        // Find a tree (only search within 10 tiles to avoid wandering far)
        const tree = bot.findNearbyLoc('tree', 10)
            ?? bot.findNearbyLoc('tree2', 10)
            ?? bot.findNearbyLoc('deadtree1', 10)
            ?? bot.findNearbyLoc('deadtree2', 10);
        if (!tree) {
            // No trees nearby - walk back to tree area and wait for respawns
            await bot.walkToWithPathfinding(TREE_AREA_X, TREE_AREA_Z);
            await bot.waitForTicks(10);
            continue;
        }

        const xpBefore = bot.getSkill('Woodcutting').exp;
        await bot.interactLoc(tree, 1);

        // Wait for XP gain or timeout
        for (let i = 0; i < 20; i++) {
            await bot.waitForTick();
            if (bot.getSkill('Woodcutting').exp > xpBefore) break;
        }

        await bot.waitForTicks(1);
        bot.dismissModals();

        if (bot.getSkill('Woodcutting').exp === xpBefore) {
            // Failed to gain XP from this tree (stump or depleted)
            failedInteractions++;
            if (failedInteractions >= 5) {
                // Walk back to the tree area to find fresh trees
                await bot.walkToWithPathfinding(TREE_AREA_X, TREE_AREA_Z);
                await bot.waitForTicks(5);
                failedInteractions = 0;
            }
        } else {
            failedInteractions = 0;
        }

        if (bot.getSkill('Woodcutting').baseLevel % 2 === 0 || bot.getSkill('Woodcutting').baseLevel >= targetLevel) {
            bot.log('EVENT', `Woodcutting level: ${bot.getSkill('Woodcutting').baseLevel}, XP: ${bot.getSkill('Woodcutting').exp}`);
        }
    }

    bot.log('EVENT', `Woodcutting trained to level ${bot.getSkill('Woodcutting').baseLevel}!`);
}

/**
 * Train Firemaking to level 10.
 * Use tinderbox on logs. 40 XP per log.
 * Bot should have a tinderbox and logs in inventory.
 */
async function trainFiremaking(bot: BotAPI): Promise<void> {
    bot.log('STATE', '========== FIREMAKING ==========');
    const targetLevel = 10;

    // Walk to open area near Lumbridge for firemaking
    await bot.walkToWithPathfinding(3220, 3244);

    while (bot.getSkill('Firemaking').baseLevel < targetLevel) {
        await bot.clearPendingState();

        // Check if we have logs
        let logs = bot.findItem('Logs');
        if (!logs) {
            // Need to chop more trees
            const tree = bot.findNearbyLoc('tree') ?? bot.findNearbyLoc('tree2');
            if (!tree) {
                await bot.walkToWithPathfinding(3220, 3244);
                await bot.waitForTicks(5);
                continue;
            }

            if (bot.freeSlots() < 1) {
                // Try to make space by burning any logs we might have missed
                throw new Error('No logs and no space during firemaking');
            }

            await bot.interactLoc(tree, 1);
            // Wait up to 60 ticks for logs - tree may take time or be depleted
            for (let i = 0; i < 60; i++) {
                await bot.waitForTick();
                if (bot.findItem('Logs') !== null) break;
            }
            await bot.waitForTicks(1);
            bot.dismissModals();
            logs = bot.findItem('Logs');
            if (!logs) continue;
        }

        // Use tinderbox on logs
        const fmXpBefore = bot.getSkill('Firemaking').exp;
        await bot.useItemOnItem('Tinderbox', 'Logs');

        // Wait for the fire to light (may take multiple attempts)
        for (let i = 0; i < 40; i++) {
            await bot.waitForTick();
            if (bot.getSkill('Firemaking').exp > fmXpBefore) break;
            // The firemaking script calls p_opobj(4) to re-interact, which we need to wait for
        }

        await bot.waitForTicks(2);
        bot.dismissModals();

        if (bot.getSkill('Firemaking').exp > fmXpBefore) {
            bot.log('EVENT', `Firemaking level: ${bot.getSkill('Firemaking').baseLevel}, XP: ${bot.getSkill('Firemaking').exp}`);
        }
    }

    bot.log('EVENT', `Firemaking trained to level ${bot.getSkill('Firemaking').baseLevel}!`);
}

/**
 * Train Mining to level 10.
 * Mine copper/tin at SE Varrock mine. Copper/tin give 17.5 XP each.
 * Need ~66 ores for level 10. Bot starts with bronze pickaxe.
 */
async function trainMining(bot: BotAPI): Promise<void> {
    bot.log('STATE', '========== MINING ==========');
    const targetLevel = 10;

    // Walk to the SE Varrock mine
    await bot.walkToWithPathfinding(MINE_AREA_X, MINE_AREA_Z);
    bot.log('STATE', `At mine area: pos=(${bot.player.x},${bot.player.z})`);

    while (bot.getSkill('Mining').baseLevel < targetLevel) {
        await bot.clearPendingState();

        // Drop ores if inventory is full (keep pickaxe and other tools)
        if (bot.freeSlots() < 1) {
            const copper = bot.findItem('Copper ore');
            if (copper) { await bot.dropItem('Copper ore'); await bot.waitForTicks(1); continue; }
            const tin = bot.findItem('Tin ore');
            if (tin) { await bot.dropItem('Tin ore'); await bot.waitForTicks(1); continue; }
            throw new Error('Inventory full during mining but no ores to drop');
        }

        // Find a rock to mine (alternate between copper and tin)
        const rock = bot.findNearbyLoc('copperrock1') ?? bot.findNearbyLoc('tinrock1')
            ?? bot.findNearbyLoc('copperrock2') ?? bot.findNearbyLoc('tinrock2');
        if (!rock) {
            // Rocks are depleted, wait for respawn
            await bot.waitForTicks(10);
            continue;
        }

        const xpBefore = bot.getSkill('Mining').exp;
        await bot.interactLoc(rock, 1);

        for (let i = 0; i < 30; i++) {
            await bot.waitForTick();
            if (bot.getSkill('Mining').exp > xpBefore) break;
        }

        await bot.waitForTicks(1);
        bot.dismissModals();
    }

    bot.log('EVENT', `Mining trained to level ${bot.getSkill('Mining').baseLevel}!`);
}

/**
 * Train Smithing to level 10.
 * Smelt copper+tin into bronze bars (6.2 XP each), then smith bronze items.
 * Bronze bar smelting = 6.2 XP. Need to mine ores, smelt, and smith.
 * Bronze dagger = 12.5 XP per bar. Each item = 1 bar at level 1.
 * Level 10 = 1154 XP. Smelting alone: 1154/6.2 = ~186 bars. That's too many.
 * Better to smith: dagger = 12.5 + 6.2 = 18.7 per ore pair. Need ~62 pairs.
 * Actually let's mix: smelt bars, smith daggers for 12.5 XP each.
 * 1154 / 12.5 = ~93 daggers = 93 bars. Plus 93 * 6.2 = 577 smelt XP.
 * Total from smelting + smithing = 577 + 1162 = ~1739. So need ~62 bars to smith.
 * Wait: 1154 total needed. First smelt 62 bars = 62*6.2 = 384 XP.
 * Then smith 62 daggers = 62*12.5 = 775 XP. Total = 384+775 = 1159. That works.
 * But mining 62 copper + 62 tin = 124 ores takes a while. Let's do batches.
 */
async function trainSmithing(bot: BotAPI): Promise<void> {
    bot.log('STATE', '========== SMITHING ==========');
    const targetLevel = 10;

    // Drop junk items from previous skills to free inventory space for ores
    const smithJunk = ['Shrimps', 'Raw shrimps', 'Raw anchovies', 'Burnt fish', 'Logs',
        'Uncut sapphire', 'Uncut emerald', 'Uncut ruby', 'Uncut diamond', 'Wool', 'Ball of wool'];
    for (const junk of smithJunk) {
        while (bot.findItem(junk)) {
            await bot.dropItem(junk);
            await bot.waitForTicks(1);
        }
    }
    bot.log('STATE', `Freed inventory for smithing, ${bot.freeSlots()} slots available`);

    while (bot.getSkill('Smithing').baseLevel < targetLevel) {
        // Phase 1: Mine copper and tin ores at the mine
        bot.log('STATE', 'Mining ores for smithing...');
        await bot.walkToWithPathfinding(MINE_AREA_X, MINE_AREA_Z);

        // Mine alternating copper and tin, waiting for rocks to respawn.
        // SE Varrock has few copper rocks; we stay at the mine and patiently
        // wait for respawns rather than making long trips with 1 ore.
        const batchTarget = Math.min(Math.floor(bot.freeSlots() / 2), 10);

        // Drop any leftover ores/bars/daggers from previous cycle
        for (const junkOre of ['Copper ore', 'Tin ore', 'Bronze bar', 'Bronze dagger', 'Uncut sapphire', 'Uncut emerald']) {
            while (bot.findItem(junkOre)) {
                await bot.dropItem(junkOre);
                await bot.waitForTicks(1);
            }
        }

        // Wait for rocks to respawn from mining training
        bot.log('STATE', `Waiting for rocks to respawn (target: ${batchTarget} pairs)...`);
        await bot.waitForTicks(100);

        // Mine alternating: 1 copper, 1 tin, repeat until batch is full
        let copperMined = 0;
        let tinMined = 0;
        let totalWaitTicks = 0;
        const MAX_WAIT_TICKS = 3000; // give up after 3000 ticks of cumulative waiting

        while (copperMined < batchTarget && bot.getSkill('Smithing').baseLevel < targetLevel && totalWaitTicks < MAX_WAIT_TICKS) {
            // Mine one copper
            if (bot.freeSlots() < 2) break; // need room for both copper and tin

            await bot.clearPendingState();

            let rock = bot.findNearbyLoc('copperrock1') ?? bot.findNearbyLoc('copperrock2');
            while (!rock && totalWaitTicks < MAX_WAIT_TICKS) {
                await bot.waitForTicks(30);
                totalWaitTicks += 30;
                rock = bot.findNearbyLoc('copperrock1') ?? bot.findNearbyLoc('copperrock2');
            }
            if (!rock) break;

            const copperBefore = bot.countItem('Copper ore');
            await bot.interactLoc(rock, 1);
            for (let i = 0; i < 30; i++) {
                await bot.waitForTick();
                if (bot.countItem('Copper ore') > copperBefore) break;
            }
            await bot.waitForTicks(1);
            bot.dismissModals();
            copperMined = bot.countItem('Copper ore');

            // Mine one tin
            if (bot.freeSlots() < 1) break;

            rock = bot.findNearbyLoc('tinrock1') ?? bot.findNearbyLoc('tinrock2');
            while (!rock && totalWaitTicks < MAX_WAIT_TICKS) {
                await bot.waitForTicks(30);
                totalWaitTicks += 30;
                rock = bot.findNearbyLoc('tinrock1') ?? bot.findNearbyLoc('tinrock2');
            }
            if (!rock) break;

            const tinBefore = bot.countItem('Tin ore');
            await bot.interactLoc(rock, 1);
            for (let i = 0; i < 30; i++) {
                await bot.waitForTick();
                if (bot.countItem('Tin ore') > tinBefore) break;
            }
            await bot.waitForTicks(1);
            bot.dismissModals();
            tinMined = bot.countItem('Tin ore');
        }

        if (copperMined === 0 || tinMined === 0) {
            bot.log('STATE', `Mining retry: copper=${copperMined}, tin=${tinMined}, waited ${totalWaitTicks} ticks`);
            continue;
        }

        const pairs = Math.min(copperMined, tinMined);
        bot.log('EVENT', `Mined ${copperMined} copper, ${tinMined} tin (${pairs} pairs)`);

        // Phase 2: Smelt at Lumbridge furnace
        bot.log('STATE', 'Smelting bronze bars...');
        await bot.walkToWithPathfinding(FURNACE_AREA_X, FURNACE_AREA_Z);

        for (let i = 0; i < pairs; i++) {
            if (bot.getSkill('Smithing').baseLevel >= targetLevel) break;

            await bot.clearPendingState();

            const copper = bot.findItem('Copper ore');
            if (!copper) break;

            const barsBefore = bot.countItem('Bronze bar');
            await bot.useItemOnLoc('Copper ore', 'furnace1');
            await bot.waitForCondition(() => bot.countItem('Bronze bar') > barsBefore, 20);
            await bot.waitForTicks(1);
            bot.dismissModals();
        }

        const barsSmelt = bot.countItem('Bronze bar');
        bot.log('EVENT', `Smelted ${barsSmelt} bronze bars. Smithing XP: ${bot.getSkill('Smithing').exp}`);

        if (bot.getSkill('Smithing').baseLevel >= targetLevel) break;

        // Phase 3: Smith bronze daggers at Varrock anvil
        bot.log('STATE', 'Walking to anvil to smith daggers...');

        // Need hammer for smithing — should already have one (bought from general store)
        if (!bot.findItem('Hammer')) {
            throw new Error('No hammer in inventory for smithing');
        }

        // Walk from Lumbridge furnace to Varrock anvil via known route waypoints
        await walkToVarrock(bot);
        await bot.walkToWithPathfinding(VARROCK_ANVIL_X, VARROCK_ANVIL_Z);

        // Open the door if needed
        await bot.openDoor('poordooropen');

        // Smith bronze daggers (1 bar each, 12.5 XP each)
        while (bot.findItem('Bronze bar') && bot.getSkill('Smithing').baseLevel < targetLevel) {
            await bot.clearPendingState();

            // Use bar on anvil to open smithing interface
            await bot.useItemOnLoc('Bronze bar', 'anvil');
            await bot.waitForTicks(3);

            // Click bronze dagger in the smithing interface (slot 0 of column1)
            const smithXpBefore = bot.getSkill('Smithing').exp;
            await bot.smithItem('bronze_dagger', 'column1', 0);

            // Wait for the smithing action to complete
            for (let j = 0; j < 10; j++) {
                await bot.waitForTick();
                if (bot.getSkill('Smithing').exp > smithXpBefore) break;
            }
            await bot.waitForTicks(2);
            bot.dismissModals();

            // Drop the daggers to free up space
            while (bot.findItem('Bronze dagger') && bot.freeSlots() < 3) {
                await bot.dropItem('Bronze dagger');
                await bot.waitForTicks(1);
            }
        }

        bot.log('EVENT', `Smithing level: ${bot.getSkill('Smithing').baseLevel}, XP: ${bot.getSkill('Smithing').exp}`);
    }

    bot.log('EVENT', `Smithing trained to level ${bot.getSkill('Smithing').baseLevel}!`);
}

/**
 * Train Fishing to level 10.
 * Fish shrimp at Draynor Village with small fishing net.
 * Shrimp give 10 XP each. Need ~116 shrimp for level 10.
 * Keeps raw shrimps in inventory for later cooking training.
 * Only drops anchovies to make room.
 */
async function trainFishing(bot: BotAPI): Promise<void> {
    bot.log('STATE', '========== FISHING ==========');
    const targetLevel = 10;

    // Walk to Draynor Village fishing spot
    await bot.walkToWithPathfinding(DRAYNOR_FISH_AREA_X, DRAYNOR_FISH_AREA_Z);
    bot.log('STATE', `At Draynor fishing area: pos=(${bot.player.x},${bot.player.z})`);

    while (bot.getSkill('Fishing').baseLevel < targetLevel) {
        await bot.clearPendingState();

        // Drop anchovies to make room, but keep raw shrimps for cooking training later
        if (bot.freeSlots() < 1) {
            const anchovy = bot.findItem('Raw anchovies');
            if (anchovy) { await bot.dropItem('Raw anchovies'); await bot.waitForTicks(1); continue; }
            // If inventory is full of raw shrimps, drop one to allow fishing to continue
            const shrimp = bot.findItem('Raw shrimps');
            if (shrimp) { await bot.dropItem('Raw shrimps'); await bot.waitForTicks(1); continue; }
            throw new Error('Inventory full during fishing');
        }

        // Find a fishing spot (NPC named "Fishing spot")
        const spot = bot.findNearbyNpc('Fishing spot', 20);
        if (!spot) {
            await bot.walkToWithPathfinding(DRAYNOR_FISH_AREA_X, DRAYNOR_FISH_AREA_Z);
            await bot.waitForTicks(10);
            continue;
        }

        const xpBefore = bot.getSkill('Fishing').exp;
        await bot.interactNpc(spot, 1); // op1 = Net

        // Wait for catch or timeout
        for (let i = 0; i < 30; i++) {
            await bot.waitForTick();
            if (bot.getSkill('Fishing').exp > xpBefore) break;
        }

        await bot.waitForTicks(1);
        bot.dismissModals();
    }

    bot.log('EVENT', `Fishing trained to level ${bot.getSkill('Fishing').baseLevel}! Raw shrimps in inventory: ${bot.countItem('Raw shrimps')}`);
}

/**
 * Train Cooking to level 10.
 * Cook shrimp on fires/ranges. Shrimp give 30 XP each.
 * Need ~39 cooked shrimp for level 10.
 * Strategy: fish shrimp at Draynor, walk back to Lumbridge tree area, cook on fire.
 * Bot should already be in Lumbridge area after firemaking training.
 */
async function trainCooking(bot: BotAPI): Promise<void> {
    bot.log('STATE', '========== COOKING ==========');
    const targetLevel = 10;

    // Area between Draynor and Lumbridge — open, has trees, easy to reach from fishing
    const COOK_AREA_X = 3110;
    const COOK_AREA_Z = 3260;

    while (bot.getSkill('Cooking').baseLevel < targetLevel) {
        // Check if we have raw shrimp
        let rawCount = bot.countItem('Raw shrimps');
        if (rawCount === 0) {
            // Walk to Draynor fishing from cook area
            bot.log('STATE', 'Walking to Draynor to fish shrimp for cooking...');
            await bot.walkToWithPathfinding(DRAYNOR_FISH_AREA_X, DRAYNOR_FISH_AREA_Z);

            while (rawCount < 20 && bot.freeSlots() > 1) {
                await bot.clearPendingState();

                const spot = bot.findNearbyNpc('Fishing spot', 20);
                if (!spot) {
                    await bot.waitForTicks(10);
                    continue;
                }

                const countBefore = bot.countItem('Raw shrimps');
                await bot.interactNpc(spot, 1);
                for (let i = 0; i < 30; i++) {
                    await bot.waitForTick();
                    if (bot.countItem('Raw shrimps') > countBefore) break;
                }
                await bot.waitForTicks(1);
                bot.dismissModals();
                rawCount = bot.countItem('Raw shrimps');
            }

            // Walk back to cooking area.
            // The Draynor fishing area at z=3228 has a wall at z=3230 blocking northward movement.
            // Walk east along the shoreline to get around the wall, then north.
            bot.log('STATE', `Walking back to cook with ${rawCount} raw shrimp...`);
            await bot.walkToWithPathfinding(3098, 3228);
            await bot.walkToWithPathfinding(COOK_AREA_X, COOK_AREA_Z);
        }

        bot.log('STATE', `Cooking ${rawCount} raw shrimp...`);

        // Make sure we're in the Lumbridge tree area
        const pos = bot.getPosition();
        if (Math.abs(pos.x - COOK_AREA_X) > 20 || Math.abs(pos.z - COOK_AREA_Z) > 20) {
            await bot.walkToWithPathfinding(COOK_AREA_X, COOK_AREA_Z);
        }

        // Ensure at least 1 free slot for logs
        // Drop junk first, then cooked shrimp, then if still full drop a raw shrimp
        while (bot.freeSlots() < 1) {
            if (bot.findItem('Burnt fish')) {
                await bot.dropItem('Burnt fish');
            } else if (bot.findItem('Shrimps')) {
                await bot.dropItem('Shrimps');
            } else if (bot.findItem('Raw anchovies')) {
                await bot.dropItem('Raw anchovies');
            } else {
                // All else fails, drop one raw shrimp to make room
                await bot.dropItem('Raw shrimps');
            }
            await bot.waitForTicks(1);
        }

        // If we have logs and tinderbox, make a fire
        // If not, chop a tree first
        if (!bot.findItem('Logs')) {
            let tree = bot.findNearbyLoc('tree', 20) ?? bot.findNearbyLoc('tree2', 20);
            if (!tree) {
                bot.log('STATE', `No trees nearby at (${bot.getPosition().x},${bot.getPosition().z}), walking to tree area`);
                await bot.walkToWithPathfinding(COOK_AREA_X, COOK_AREA_Z);
                await bot.waitForTicks(50);
                tree = bot.findNearbyLoc('tree', 20) ?? bot.findNearbyLoc('tree2', 20);
            }
            if (tree) {
                await bot.interactLoc(tree, 1);
                for (let i = 0; i < 150; i++) {
                    await bot.waitForTick();
                    if (bot.findItem('Logs') !== null) break;
                }
                await bot.waitForTicks(1);
                bot.dismissModals();
            } else {
                bot.log('STATE', 'Still no trees, waiting for respawn...');
                await bot.waitForTicks(100);
                continue;
            }
        }

        // Light the fire
        if (bot.findItem('Logs') && bot.findItem('Tinderbox')) {
            const fmXp = bot.getSkill('Firemaking').exp;
            await bot.useItemOnItem('Tinderbox', 'Logs');
            for (let i = 0; i < 40; i++) {
                await bot.waitForTick();
                if (bot.getSkill('Firemaking').exp > fmXp) break;
            }
            await bot.waitForTicks(2);
            bot.dismissModals();
        }

        // Now find the fire and cook shrimp on it
        const fire = bot.findNearbyLoc('loc_2732', 5); // lit fire
        if (!fire) {
            bot.log('STATE', `No fire found after attempt, logs=${bot.findItem('Logs') !== null}, tinderbox=${bot.findItem('Tinderbox') !== null}`);
            await bot.waitForTicks(10);
            continue;
        }

        // Cook each raw shrimp on the fire
        while (bot.findItem('Raw shrimps') && bot.getSkill('Cooking').baseLevel < targetLevel) {
            await bot.clearPendingState();

            const fireCheck = bot.findNearbyLoc('loc_2732', 5);
            if (!fireCheck) {
                bot.log('STATE', 'Fire burnt out, need new fire');
                break;
            }

            const cookXpBefore = bot.getSkill('Cooking').exp;
            await bot.useItemOnLoc('Raw shrimps', 'loc_2732');

            for (let i = 0; i < 20; i++) {
                await bot.waitForTick();
                if (bot.getSkill('Cooking').exp > cookXpBefore) break;
            }
            await bot.waitForTicks(1);
            bot.dismissModals();

            // Drop cooked shrimp and burnt fish to save space
            const cooked = bot.findItem('Shrimps');
            if (cooked && bot.freeSlots() < 3) {
                await bot.dropItem('Shrimps');
                await bot.waitForTicks(1);
            }
            const burnt = bot.findItem('Burnt fish');
            if (burnt) {
                await bot.dropItem('Burnt fish');
                await bot.waitForTicks(1);
            }
        }

        bot.log('EVENT', `Cooking level: ${bot.getSkill('Cooking').baseLevel}, XP: ${bot.getSkill('Cooking').exp}`);
    }

    bot.log('EVENT', `Cooking trained to level ${bot.getSkill('Cooking').baseLevel}!`);
}

/**
 * Train Crafting to level 10 by spinning wool at Lumbridge Castle.
 * Ball of wool = 2.5 XP crafting per spin.
 * Wait, actually spinning wool gives Crafting XP. Let me check.
 * Actually in RS2, spinning flax gives crafting XP and spinning wool also gives crafting XP.
 * Wool -> Ball of wool = 2.5 XP. Need ~462 for level 10. That's 462 wool!
 * Better approach: craft leather. But that requires tanning.
 * Actually, let's check: Sheep Shearer quest gives crafting XP too.
 * The most practical is spinning wool since we already know the pattern.
 * 462 wool is a lot though. Let me reconsider.
 *
 * Actually ball of wool is only 2.5 xp. Pottery gives more: unfired pot = 6.3 xp, fired pot = 6.3 xp.
 * Leather crafting: tanning cowhide gives leather, then craft leather gloves = 13.8 xp.
 * But tanning requires going to Al-Kharid.
 *
 * Actually let me just do wool spinning. 462 balls is tedious but doable in batches.
 * With 26 wool per batch (shears + coins in inv), that's 18 batches.
 * Actually, I already need to level crafting and can use the sheep field pattern from sheep-shearer.
 *
 * Wait: I can also craft pottery. That might be easier.
 * Soft clay + water -> use on pottery wheel -> unfired pot (6.3 xp) -> fire in pottery oven -> pot (6.3 xp).
 * Total 12.6 xp per pot. Need ~92 pots. Mining clay is slow though.
 *
 * Let's do leather crafting instead:
 * 1. Kill cows for cowhides (also good for combat training)
 * 2. Tan at Al-Kharid (1gp per hide)
 * 3. Craft leather gloves (level 1, 13.8 xp) or leather body (level 14... too high)
 * Leather gloves = 13.8 xp per hide. Need ~84 hides.
 *
 * Actually simplest: just spin wool. Let me do batches of 26.
 */

/**
 * Open a gate and walk through it with retries.
 * Same pattern as sheep-shearer: opens both gate panels, then walks to the
 * target tile. Retries up to 3 times if the walkTo fails (gate may auto-close).
 */
async function openGateAndCross(bot: BotAPI, targetX: number, targetZ: number, label: string): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt++) {
        // Clear any stale modals/delayed state that would block the interaction
        await bot.clearPendingState();
        await bot.waitForTicks(1);

        await bot.openGate(5);
        await bot.waitForTicks(1);
        await bot.openGate(5);
        await bot.waitForTicks(2);

        try {
            await bot.walkTo(targetX, targetZ);
            return;
        } catch {
            // walkTo failed (gate collision or timeout) — try walkToWithPathfinding
            // which can route around open gate panels
            bot.log('STATE', `Gate walkTo failed (${label}, attempt ${attempt}/3), trying pathfinding...`);
            try {
                await bot.walkToWithPathfinding(targetX, targetZ);
                return;
            } catch (err2) {
                bot.log('STATE', `Gate pathfinding also failed (${label}, attempt ${attempt}/3): ${(err2 as Error).message}`);
                if (attempt === 3) {
                    throw new Error(`Failed to cross gate after 3 attempts (${label}): ${(err2 as Error).message}`);
                }
                await bot.waitForTicks(3);
            }
        }
    }
}

async function trainCrafting(bot: BotAPI): Promise<void> {
    bot.log('STATE', '========== CRAFTING ==========');
    const targetLevel = 10;

    // Drop junk items from previous skills to free inventory space.
    // Smithing leaves bronze bars, tin ore, copper ore, daggers, etc.
    const junkItems = ['Bronze bar', 'Tin ore', 'Copper ore', 'Bronze dagger', 'Logs',
        'Uncut sapphire', 'Uncut emerald', 'Uncut ruby', 'Uncut diamond'];
    for (const junk of junkItems) {
        while (bot.findItem(junk)) {
            await bot.dropItem(junk);
            await bot.waitForTicks(1);
        }
    }
    bot.log('STATE', `Freed inventory, ${bot.freeSlots()} slots available`);

    // Spin wool at Lumbridge Castle spinning wheel.
    // Pattern: walk to sheep field, shear sheep, walk to spinning wheel, spin.
    // The sheep field has an internal east-west fence at z=3277 with no gate.
    // Sheep roam south of this fence (z=3271-3276). The east gate at (3213,3261-3262)
    // leads to the SOUTH section, so we enter there and walk to the sheep area.
    const NPC_SHEEPUNSHEERED = 43;

    while (bot.getSkill('Crafting').baseLevel < targetLevel) {
        // Spin any wool already in inventory before collecting more
        const existingWool = bot.countItem('Wool');
        if (existingWool > 0) {
            bot.log('STATE', `Spinning ${existingWool} existing wool first`);
            await goToSpinningWheel(bot);
            for (let i = 0; i < existingWool; i++) {
                const wool = bot.findItem('Wool');
                if (!wool) break;
                if (bot.player.delayed) {
                    await bot.waitForCondition(() => !bot.player.delayed, 20);
                }
                await bot.useItemOnLoc('Wool', 'spinning_wheel');
                await bot.waitForTicks(6);
                bot.dismissModals();
            }
            while (bot.findItem('Ball of wool')) {
                await bot.dropItem('Ball of wool');
                await bot.waitForTicks(1);
            }
            await goDownFromSpinningWheel(bot);
            continue; // Re-check level after spinning
        }

        const woolNeeded = Math.min(bot.freeSlots(), Math.ceil((11540 - bot.getSkill('Crafting').exp) / 25)); // 2.5 xp * 10 scale = 25; level 10 = 1154 real xp = 11540 internal
        if (woolNeeded <= 0) break;

        bot.log('STATE', `Need ~${woolNeeded} more wool to spin. Crafting XP: ${bot.getSkill('Crafting').exp}, free=${bot.freeSlots()}`);

        // Phase 1: Enter sheep field through the east gate.
        // Route east first (x=3230) to avoid the east fence (x=3213) and south fence (z=3257),
        // then approach the gate from the north-east.
        await bot.walkToWithPathfinding(3230, 3262);
        await bot.walkToWithPathfinding(3214, 3262);
        // Open the gate — the open gate panels swing west, so walk to (3209,3262) to clear them
        await openGateAndCross(bot, 3209, 3262, 'enter sheep field');
        await bot.walkToWithPathfinding(SHEEP_AREA_X, SHEEP_AREA_Z);

        let woolCollected = 0;
        let waitTicks = 0;
        const MAX_WAIT = 2000;

        while (woolCollected < woolNeeded && waitTicks < MAX_WAIT) {
            await bot.clearPendingState();

            if (bot.freeSlots() < 1) break;

            const sheep = bot.findNearbyNpcByTypeId(NPC_SHEEPUNSHEERED, 10);
            if (!sheep) {
                await bot.waitForTicks(5);
                waitTicks += 5;
                continue;
            }

            const woolBefore = bot.countItem('Wool');
            await bot.useItemOnNpcDirect('Shears', sheep);
            await bot.waitForTicks(5);
            bot.dismissModals();

            if (bot.countItem('Wool') > woolBefore) {
                woolCollected++;
            }
            waitTicks++;
        }

        bot.log('EVENT', `Collected ${woolCollected} wool`);

        // Phase 2: Exit sheep field through east gate, then go to spinning wheel
        await bot.walkToWithPathfinding(3212, 3262);
        await openGateAndCross(bot, 3214, 3262, 'exit sheep field');
        await goToSpinningWheel(bot);

        for (let i = 0; i < woolCollected; i++) {
            const wool = bot.findItem('Wool');
            if (!wool) break;

            if (bot.player.delayed) {
                await bot.waitForCondition(() => !bot.player.delayed, 20);
            }

            await bot.useItemOnLoc('Wool', 'spinning_wheel');
            await bot.waitForTicks(6);
            bot.dismissModals();
        }

        // Drop balls of wool to free space
        while (bot.findItem('Ball of wool')) {
            await bot.dropItem('Ball of wool');
            await bot.waitForTicks(1);
        }

        await goDownFromSpinningWheel(bot);

        bot.log('EVENT', `Crafting level: ${bot.getSkill('Crafting').baseLevel}, XP: ${bot.getSkill('Crafting').exp}`);
    }

    // Ensure we're on ground floor — crafting loop uses level 1 spinning wheel
    if (bot.player.level > 0) {
        bot.log('STATE', `Still on level ${bot.player.level} after crafting, going down...`);
        await goDownFromSpinningWheel(bot);
    }

    bot.log('EVENT', `Crafting trained to level ${bot.getSkill('Crafting').baseLevel}!`);
}

/**
 * Train a single combat skill (Attack, Strength, or Defence) by fighting giant rats.
 * Also buries bones for Prayer XP during combat.
 *
 * Combat style 0 (Accurate) = Attack XP
 * Combat style 1 (Aggressive) = Strength XP
 * Combat style 3 (Defensive) = Defence XP (for pickaxe: style 3)
 */
async function trainSingleCombatSkill(bot: BotAPI, skillName: string, combatStyle: number): Promise<void> {
    const targetLevel = 10;
    bot.log('STATE', `========== COMBAT: ${skillName} (style=${combatStyle}) ==========`);

    // Safety: if stuck on upper floor, get down first
    if (bot.player.level > 0) {
        bot.log('STATE', `Combat: recovering from level ${bot.player.level}, climbing down...`);
        await bot.clearPendingState();
        await goDownFromSpinningWheel(bot);
    }

    // Walk to combat area (Lumbridge town center)
    await bot.walkToWithPathfinding(CHICKEN_AREA_X, CHICKEN_AREA_Z);
    bot.log('STATE', `At combat area: pos=(${bot.player.x},${bot.player.z})`);

    // Equip bronze pickaxe as weapon if in inventory
    if (bot.findItem('Bronze pickaxe')) {
        await bot.equipItem('Bronze pickaxe');
        await bot.waitForTicks(1);
    }

    bot.setCombatStyle(combatStyle);

    while (bot.getSkill(skillName).baseLevel < targetLevel) {
        await bot.clearPendingState();

        // Bury any bones in inventory (Prayer training)
        while (bot.findItem('Bones')) {
            if (bot.player.delayed) {
                await bot.waitForCondition(() => !bot.player.delayed, 20);
            }
            await bot.useItemOp1('Bones');
            await bot.waitForTicks(3);
            bot.dismissModals();
        }

        // Drop feathers and raw chicken to save space
        if (bot.freeSlots() < 5) {
            if (bot.findItem('Feather')) { await bot.dropItem('Feather'); await bot.waitForTicks(1); }
            if (bot.findItem('Raw chicken')) { await bot.dropItem('Raw chicken'); await bot.waitForTicks(1); }
        }

        // Find a chicken
        let chicken = bot.findNearbyNpc('Chicken', 16);
        if (!chicken) {
            await bot.walkToWithPathfinding(CHICKEN_AREA_X, CHICKEN_AREA_Z);
            await bot.waitForTicks(3);
            chicken = bot.findNearbyNpc('Chicken', 16);
            if (!chicken) {
                await bot.waitForTicks(10);
                continue;
            }
        }

        const deathPos = await attackNpcAndWait(bot, chicken);
        bot.dismissModals();

        // Death recovery — if bot died during combat, respawn and walk back
        if (bot.isDead()) {
            bot.log('STATE', 'Bot died during combat training, recovering...');
            await bot.waitForRespawn();
            await bot.walkToWithPathfinding(CHICKEN_AREA_X, CHICKEN_AREA_Z);
            if (bot.findItem('Bronze pickaxe')) {
                await bot.equipItem('Bronze pickaxe');
                await bot.waitForTicks(1);
            }
            bot.setCombatStyle(combatStyle);
            continue;
        }

        if (deathPos) {
            // Pick up bones
            await bot.waitForTicks(1);
            const bonesGround = bot.findNearbyGroundItem('Bones', 5);
            if (bonesGround && bot.freeSlots() > 0) {
                try {
                    await bot.takeGroundItem('Bones', bonesGround.x, bonesGround.z);
                    await bot.waitForTicks(2);
                } catch { /* ground item may have been taken */ }
            }
        }
    }

    // Bury remaining bones for prayer
    while (bot.findItem('Bones')) {
        if (bot.player.delayed) {
            await bot.waitForCondition(() => !bot.player.delayed, 20);
        }
        await bot.useItemOp1('Bones');
        await bot.waitForTicks(3);
        bot.dismissModals();
    }

    bot.log('EVENT', `${skillName} trained to level ${bot.getSkill(skillName).baseLevel}!`);
}

/**
 * Train Prayer to level 10 by burying bones.
 * Regular bones give 4.5 XP (45 internal) each.
 * Level 10 = 1154 XP. Need ~26 bones if starting from 0.
 * We'll kill giant rats and bury their bones.
 */
async function trainPrayer(bot: BotAPI): Promise<void> {
    bot.log('STATE', '========== PRAYER ==========');
    const targetLevel = 10;

    if (bot.getSkill('Prayer').baseLevel >= targetLevel) {
        bot.log('STATE', `Prayer already level ${bot.getSkill('Prayer').baseLevel}, skipping`);
        return;
    }

    // Walk to combat area (giant rats in Lumbridge swamp)
    await bot.walkToWithPathfinding(CHICKEN_AREA_X, CHICKEN_AREA_Z);

    // Set to accurate style for fastest kills
    bot.setCombatStyle(0);

    while (bot.getSkill('Prayer').baseLevel < targetLevel) {
        await bot.clearPendingState();

        // Bury any bones we have
        while (bot.findItem('Bones') && bot.getSkill('Prayer').baseLevel < targetLevel) {
            if (bot.player.delayed) {
                await bot.waitForCondition(() => !bot.player.delayed, 20);
            }
            await bot.useItemOp1('Bones');
            await bot.waitForTicks(3);
            bot.dismissModals();
        }

        if (bot.getSkill('Prayer').baseLevel >= targetLevel) break;

        // Drop junk
        if (bot.findItem('Feather')) { await bot.dropItem('Feather'); await bot.waitForTicks(1); }
        if (bot.findItem('Raw chicken')) { await bot.dropItem('Raw chicken'); await bot.waitForTicks(1); }

        // Kill a chicken for bones
        let chicken = bot.findNearbyNpc('Chicken', 16);
        if (!chicken) {
            await bot.walkToWithPathfinding(CHICKEN_AREA_X, CHICKEN_AREA_Z);
            await bot.waitForTicks(3);
            chicken = bot.findNearbyNpc('Chicken', 16);
            if (!chicken) { await bot.waitForTicks(10); continue; }
        }

        const deathPos = await attackNpcAndWait(bot, chicken);
        bot.dismissModals();

        // Death recovery
        if (bot.isDead()) {
            await bot.waitForRespawn();
            await bot.walkToWithPathfinding(CHICKEN_AREA_X, CHICKEN_AREA_Z);
            continue;
        }

        if (deathPos) {
            await bot.waitForTicks(1);
            const bonesGround = bot.findNearbyGroundItem('Bones', 5);
            if (bonesGround && bot.freeSlots() > 0) {
                try {
                    await bot.takeGroundItem('Bones', bonesGround.x, bonesGround.z);
                    await bot.waitForTicks(2);
                } catch { /* may be taken */ }
            }
        }
    }

    bot.log('EVENT', `Prayer trained to level ${bot.getSkill('Prayer').baseLevel}!`);
}

/**
 * Train Ranged to level 10.
 * Buy shortbow + bronze arrows from Lowe's in Varrock.
 * Shoot giant rats. Bronze arrows + shortbow.
 * Shortbow = 1 attack speed (4 ticks). Ranged accurate = 0 style.
 * Need to equip bow and have arrows in inventory.
 */
async function trainRanged(bot: BotAPI): Promise<void> {
    bot.log('STATE', '========== RANGED ==========');
    const targetLevel = 10;

    if (bot.getSkill('Ranged').baseLevel >= targetLevel) {
        bot.log('STATE', `Ranged already level ${bot.getSkill('Ranged').baseLevel}, skipping`);
        return;
    }

    // We need to be in Varrock to buy from Lowe's
    // Walk to Varrock if not already there
    if (Math.abs(bot.player.x - LOWE_AREA_X) > 50 || Math.abs(bot.player.z - LOWE_AREA_Z) > 50) {
        await walkToVarrock(bot);
    }

    // Buy shortbow and bronze arrows from Lowe's Archery Emporium
    await bot.walkToWithPathfinding(LOWE_AREA_X, LOWE_AREA_Z);
    await bot.openDoor('poordooropen');
    const lowe = bot.findNearbyNpc('Lowe');
    if (!lowe) {
        throw new Error('Lowe not found near his shop');
    }
    await bot.interactNpc(lowe, 3); // op3 = Trade
    await bot.waitForTicks(3);

    // Buy a shortbow and lots of bronze arrows
    await buyItems(bot, 'Shortbow', 1);
    await buyItems(bot, 'Bronze arrow', 500);
    bot.dismissModals();

    // Equip the shortbow
    await bot.equipItem('Shortbow');
    await bot.waitForTicks(1);

    // Equip arrows
    await bot.equipItem('Bronze arrow');
    await bot.waitForTicks(1);

    // Set ranged combat style to accurate (style 0 for bows)
    bot.setCombatStyle(0);

    // Walk to combat area (giant rats in Lumbridge swamp)
    await walkToLumbridge(bot);
    await bot.walkToWithPathfinding(CHICKEN_AREA_X, CHICKEN_AREA_Z);

    while (bot.getSkill('Ranged').baseLevel < targetLevel) {
        await bot.clearPendingState();

        // Drop junk
        if (bot.freeSlots() < 3) {
            if (bot.findItem('Feather')) { await bot.dropItem('Feather'); await bot.waitForTicks(1); }
            if (bot.findItem('Raw chicken')) { await bot.dropItem('Raw chicken'); await bot.waitForTicks(1); }
            if (bot.findItem('Bones')) { await bot.dropItem('Bones'); await bot.waitForTicks(1); }
        }

        let chicken = bot.findNearbyNpc('Chicken', 16);
        if (!chicken) {
            await bot.walkToWithPathfinding(CHICKEN_AREA_X, CHICKEN_AREA_Z);
            await bot.waitForTicks(5);
            chicken = bot.findNearbyNpc('Chicken', 16);
            if (!chicken) { await bot.waitForTicks(10); continue; }
        }

        await attackNpcAndWait(bot, chicken);
        bot.dismissModals();
    }

    bot.log('EVENT', `Ranged trained to level ${bot.getSkill('Ranged').baseLevel}!`);
}

/**
 * Train Magic to level 10.
 * Buy mind runes and air runes from Aubury's shop in Varrock.
 * Cast Wind Strike (1 mind + 1 air per cast, 5.5 XP per cast) on giant rats.
 * Level 10 = 1154 XP. 1154 / 5.5 = ~210 casts.
 * But we also get 2 XP per damage on hitpoints, and magic XP varies.
 * Wind Strike gives 5.5 XP base per cast (hit or miss).
 */
async function trainMagic(bot: BotAPI): Promise<void> {
    bot.log('STATE', '========== MAGIC ==========');
    const targetLevel = 10;

    if (bot.getSkill('Magic').baseLevel >= targetLevel) {
        bot.log('STATE', `Magic already level ${bot.getSkill('Magic').baseLevel}, skipping`);
        return;
    }

    // Walk to Varrock if needed
    if (Math.abs(bot.player.x - AUBURY_AREA_X) > 50 || Math.abs(bot.player.z - AUBURY_AREA_Z) > 50) {
        await walkToVarrock(bot);
    }

    // Unequip bow (need to switch back to melee/unarmed for magic)
    // Actually for magic, we don't need a weapon. We can cast with anything equipped.
    // But let's drop any ranged equipment to be safe.

    // Buy runes from Aubury's shop
    await bot.walkToWithPathfinding(AUBURY_AREA_X, AUBURY_AREA_Z);
    await bot.openDoor('poordooropen');
    const aubury = bot.findNearbyNpc('Aubury');
    if (!aubury) {
        throw new Error('Aubury not found near his shop');
    }
    await bot.interactNpc(aubury, 3); // op3 = Trade
    await bot.waitForTicks(3);

    await buyItems(bot, 'Mind rune', 300);
    await buyItems(bot, 'Air rune', 300);
    bot.dismissModals();

    bot.log('EVENT', `Bought runes. Mind: ${bot.countItem('Mind rune')}, Air: ${bot.countItem('Air rune')}`);

    // Walk to combat area (giant rats in Lumbridge swamp)
    await walkToLumbridge(bot);
    await bot.walkToWithPathfinding(CHICKEN_AREA_X, CHICKEN_AREA_Z);

    while (bot.getSkill('Magic').baseLevel < targetLevel) {
        await bot.clearPendingState();

        // Check rune supply
        if (bot.countItem('Mind rune') < 1 || bot.countItem('Air rune') < 1) {
            throw new Error(`Ran out of runes! Mind: ${bot.countItem('Mind rune')}, Air: ${bot.countItem('Air rune')}`);
        }

        // Drop junk
        if (bot.freeSlots() < 3) {
            if (bot.findItem('Feather')) { await bot.dropItem('Feather'); await bot.waitForTicks(1); }
            if (bot.findItem('Raw chicken')) { await bot.dropItem('Raw chicken'); await bot.waitForTicks(1); }
            if (bot.findItem('Bones')) { await bot.dropItem('Bones'); await bot.waitForTicks(1); }
        }

        let chicken = bot.findNearbyNpc('Chicken', 16);
        if (!chicken) {
            await bot.walkToWithPathfinding(CHICKEN_AREA_X, CHICKEN_AREA_Z);
            await bot.waitForTicks(5);
            chicken = bot.findNearbyNpc('Chicken', 16);
            if (!chicken) { await bot.waitForTicks(10); continue; }
        }

        // Cast Wind Strike on the chicken
        const xpBefore = bot.getSkill('Magic').exp;
        await bot.castSpellOnNpc(chicken, WIND_STRIKE_COM);

        // Wait for the spell to resolve (including projectile travel)
        for (let i = 0; i < 10; i++) {
            await bot.waitForTick();
            if (bot.getSkill('Magic').exp > xpBefore) break;
        }
        await bot.waitForTicks(3);
        bot.dismissModals();
    }

    bot.log('EVENT', `Magic trained to level ${bot.getSkill('Magic').baseLevel}!`);
}

/**
 * Train Runecraft to level 10.
 * Requires: Rune Mysteries quest complete, air talisman, rune essence.
 *
 * Steps:
 * 1. Complete Rune Mysteries quest (gives air talisman, unlocks essence mine)
 * 2. Mine rune essence from essence mine (teleported by Aubury in Varrock)
 * 3. Use air talisman on mysterious ruins to enter air altar
 * 4. Craft air runes at the altar for 5 XP each
 *
 * Level 10 = 1154 XP. At 5 XP per essence: 231 essences needed.
 * Essence mine: mine rune_essence rocks. Each gives 5 mining XP.
 *
 * This is complex. Since Rune Mysteries is already implemented as a separate bot,
 * we need to run that quest first. But it starts from skipTutorial.
 * The quest bot does its own skipTutorial which would conflict.
 *
 * Alternative: For now, skip Runecraft since it requires quest completion
 * and complex multi-step process. We can note it as a limitation.
 *
 * Actually, looking at the requirements more carefully:
 * The Rune Mysteries quest gives the air talisman AND unlocks the ability to
 * mine rune essence via Aubury's teleport. The quest itself is long.
 *
 * For this bot, let's just skip Runecraft. The user asked for "at least level 10"
 * and acknowledged Runecraft might be impractical. Let's note it.
 *
 * Actually, let me implement it. We can run the rune mysteries quest script inline
 * but we need to make sure it doesn't call skipTutorial again.
 * Since skipTutorial just sets vars and teleports, calling it again would be fine
 * (it's idempotent for the tutorial var, and we'd lose our position/items).
 *
 * Let's skip Runecraft for now and document why.
 */

// ================================================================
// STATE MACHINE
// ================================================================

/**
 * Build the F2P skills hierarchical state tree.
 * Each leaf state maps to one of the existing training functions.
 */
export function buildF2pSkillsStates(bot: BotAPI): BotState {
    return {
        name: 'f2p-skills',
        isComplete: () => {
            const skills = [
                'Attack', 'Strength', 'Defence', 'Ranged', 'Prayer',
                'Magic', 'Hitpoints', 'Mining', 'Smithing', 'Fishing',
                'Cooking', 'Woodcutting', 'Firemaking', 'Crafting'
            ];
            return skills.every(s => bot.getSkill(s).baseLevel >= 10);
        },
        run: async () => {},
        children: [
            {
                name: 'setup',
                stuckThreshold: 3000,
                isComplete: () =>
                    bot.findItem('Tinderbox') !== null &&
                    bot.findItem('Shears') !== null &&
                    bot.findItem('Hammer') !== null &&
                    bot.findItem('Bronze axe') !== null &&
                    bot.findItem('Small fishing net') !== null,
                run: async () => {
                    await earnCoins(bot, 200);
                    await openLumbridgeGeneralStore(bot);
                    await buyItems(bot, 'Tinderbox', 1);
                    await buyItems(bot, 'Shears', 1);
                    await buyItems(bot, 'Hammer', 1);
                    bot.dismissModals();
                    await openBobsAxes(bot);
                    await buyItems(bot, 'Bronze axe', 1);
                    bot.dismissModals();
                    // Buy small fishing net from Port Sarim
                    await bot.walkToWithPathfinding(LUMBRIDGE_SPAWN_X, LUMBRIDGE_SPAWN_Z);
                    await bot.walkToWithPathfinding(3110, 3260);
                    await bot.walkToWithPathfinding(3047, 3237);
                    await bot.walkToWithPathfinding(3016, 3215);
                    await bot.walkToWithPathfinding(3014, 3224);
                    const door = bot.findNearbyLoc('poordooropen', 5);
                    if (door) { await bot.interactLoc(door, 1); await bot.waitForTicks(2); }
                    const gerrant = bot.findNearbyNpc('Gerrant');
                    if (!gerrant) throw new Error('Gerrant not found in Port Sarim fishing shop');
                    await bot.interactNpc(gerrant, 3);
                    await bot.waitForTicks(3);
                    await buyItems(bot, 'Small fishing net', 1);
                    bot.dismissModals();
                    bot.log('EVENT', `Bought tools: ${bot.getInventory().map(i => i.name).join(', ')}`);
                }
            },
            {
                name: 'fishing',
                stuckThreshold: 5000,
                isComplete: () => bot.getSkill('Fishing').baseLevel >= 10,
                run: async () => {
                    await bot.walkToWithPathfinding(3047, 3237);
                    await bot.walkToWithPathfinding(DRAYNOR_FISH_AREA_X, DRAYNOR_FISH_AREA_Z);
                    await trainFishing(bot);
                }
            },
            {
                name: 'woodcutting',
                stuckThreshold: 3000,
                isComplete: () => bot.getSkill('Woodcutting').baseLevel >= 10,
                run: async () => {
                    await bot.walkToWithPathfinding(LUMBRIDGE_SPAWN_X, LUMBRIDGE_SPAWN_Z);
                    for (const junk of ['Raw shrimps', 'Raw anchovies', 'Shrimps', 'Burnt fish']) {
                        while (bot.findItem(junk)) { await bot.dropItem(junk); await bot.waitForTicks(1); }
                    }
                    await trainWoodcutting(bot);
                }
            },
            {
                name: 'firemaking',
                stuckThreshold: 3000,
                isComplete: () => bot.getSkill('Firemaking').baseLevel >= 10,
                run: async () => {
                    await trainFiremaking(bot);
                }
            },
            {
                name: 'cooking',
                stuckThreshold: 8000,
                maxRetries: 10,
                isComplete: () => bot.getSkill('Cooking').baseLevel >= 10,
                run: async () => {
                    await bot.walkToWithPathfinding(3110, 3260);
                    await trainCooking(bot);
                }
            },
            {
                name: 'mining',
                stuckThreshold: 5000,
                isComplete: () => bot.getSkill('Mining').baseLevel >= 10,
                run: async () => {
                    await walkToVarrock(bot);
                    await bot.walkToWithPathfinding(MINE_AREA_X, MINE_AREA_Z);
                    await trainMining(bot);
                }
            },
            {
                name: 'smithing',
                stuckThreshold: 15000,
                isComplete: () => bot.getSkill('Smithing').baseLevel >= 10,
                run: async () => {
                    await trainSmithing(bot);
                }
            },
            {
                name: 'crafting',
                stuckThreshold: 10000,
                maxRetries: 6,
                isComplete: () => bot.getSkill('Crafting').baseLevel >= 10 && bot.player.level === 0,
                run: async () => {
                    // Clear stale modals/delayed state from smithing before crafting
                    await bot.clearPendingState();
                    // Recovery: if stuck on upper floor (from previous failed stair descent)
                    if (bot.player.level > 0) {
                        bot.log('STATE', `Recovering from level ${bot.player.level}, climbing down...`);
                        await goDownFromSpinningWheel(bot);
                    }
                    // Recovery: if inside sheep field on retry, exit through gate
                    const px = bot.player.x;
                    const pz = bot.player.z;
                    if (px >= 3193 && px <= 3213 && pz >= 3258 && pz <= 3276) {
                        bot.log('STATE', `Recovering from inside sheep field at (${px},${pz})`);
                        await bot.walkToWithPathfinding(3212, 3262);
                        await openGateAndCross(bot, 3214, 3262, 'exit sheep field (recovery)');
                    }
                    // Ensure bot is near Lumbridge before crafting.
                    // After smithing the bot may be near Varrock.
                    const pos = bot.getPosition();
                    const distToLumbridge = Math.abs(pos.x - LUMBRIDGE_SPAWN_X) + Math.abs(pos.z - LUMBRIDGE_SPAWN_Z);
                    if (distToLumbridge > 100) {
                        await bot.walkToWithPathfinding(3175, 3427);
                        await walkToLumbridge(bot);
                    }
                    await trainCrafting(bot);
                }
            },
            {
                name: 'combat',
                isComplete: () =>
                    bot.getSkill('Attack').baseLevel >= 10 &&
                    bot.getSkill('Strength').baseLevel >= 10 &&
                    bot.getSkill('Defence').baseLevel >= 10,
                run: async () => {},
                children: [
                    {
                        name: 'train-attack',
                        stuckThreshold: 10000,
                        isComplete: () => bot.getSkill('Attack').baseLevel >= 10,
                        run: async () => {
                            await trainSingleCombatSkill(bot, 'Attack', 0);
                        }
                    },
                    {
                        name: 'train-strength',
                        stuckThreshold: 10000,
                        isComplete: () => bot.getSkill('Strength').baseLevel >= 10,
                        run: async () => {
                            await trainSingleCombatSkill(bot, 'Strength', 1);
                        }
                    },
                    {
                        name: 'train-defence',
                        stuckThreshold: 10000,
                        isComplete: () => bot.getSkill('Defence').baseLevel >= 10,
                        run: async () => {
                            await trainSingleCombatSkill(bot, 'Defence', 3);
                        }
                    }
                ]
            },
            {
                name: 'prayer',
                stuckThreshold: 5000,
                isComplete: () => bot.getSkill('Prayer').baseLevel >= 10,
                run: async () => {
                    await trainPrayer(bot);
                }
            },
            {
                name: 'earn-coins-ranged-magic',
                stuckThreshold: 5000,
                maxRetries: 5,
                isComplete: () =>
                    bot.getSkill('Ranged').baseLevel >= 10 && bot.getSkill('Magic').baseLevel >= 10,
                run: async () => {
                    await bot.clearPendingState();
                    await bot.waitForTicks(2);

                    // Escape chicken pen — fully fenced, must use north gate at (3236,3295).
                    const pos = bot.getPosition();
                    if (pos.z > 3270) {
                        await bot.walkTo(3234, 3294);
                        await openGateAndCross(bot, 3238, 3296, 'exit chicken pen north');
                        await bot.walkToWithPathfinding(3238, 3250);
                    }
                    await bot.walkToWithPathfinding(LUMBRIDGE_SPAWN_X, LUMBRIDGE_SPAWN_Z);
                    // Need ~6000gp for ranged gear + magic runes:
                    // Shortbow (~50gp) + 500 bronze arrows (~1500gp)
                    // + 300 mind runes (~3600gp) + 300 air runes (~1200gp) = ~6350gp
                    const coins = bot.findItem('Coins');
                    if (!coins || coins.count < 7000) {
                        await earnCoins(bot, 7000);
                    }
                }
            },
            {
                name: 'ranged',
                stuckThreshold: 10000,
                isComplete: () => bot.getSkill('Ranged').baseLevel >= 10,
                run: async () => {
                    await trainRanged(bot);
                }
            },
            {
                name: 'magic',
                stuckThreshold: 10000,
                isComplete: () => bot.getSkill('Magic').baseLevel >= 10,
                run: async () => {
                    await trainMagic(bot);
                }
            }
        ]
    };
}

// ================================================================
// MAIN SCRIPT
// ================================================================

export async function f2pSkills(bot: BotAPI): Promise<void> {
    await skipTutorial(bot);
    await bot.waitForTicks(2);
    bot.log('STATE', `Starting F2P skills training at (${bot.player.x},${bot.player.z})`);

    const states = buildF2pSkillsStates(bot);
    const snapshotDir = path.resolve(import.meta.dir, '..', 'test', 'snapshots');
    await runStateMachine(bot, {
        root: states,
        captureSnapshots: true,
        snapshotDir,
    });

    // --- Final verification ---
    const f2pSkillsList = [
        'Attack', 'Strength', 'Defence', 'Ranged', 'Prayer',
        'Magic', 'Hitpoints', 'Mining', 'Smithing', 'Fishing',
        'Cooking', 'Woodcutting', 'Firemaking', 'Crafting'
    ];

    bot.log('STATE', '=== FINAL SKILL LEVELS ===');
    let allPassed = true;
    for (const skill of f2pSkillsList) {
        const info = bot.getSkill(skill);
        const passed = info.baseLevel >= 10;
        if (!passed) allPassed = false;
        bot.log('STATE', `  ${skill}: level ${info.baseLevel} (XP: ${info.exp}) ${passed ? 'PASS' : 'FAIL'}`);
    }

    const rcInfo = bot.getSkill('Runecraft');
    bot.log('STATE', `  Runecraft: level ${rcInfo.baseLevel} (XP: ${rcInfo.exp}) SKIPPED`);

    if (!allPassed) {
        const failed = f2pSkillsList.filter(s => bot.getSkill(s).baseLevel < 10);
        throw new Error(`Not all F2P skills reached level 10. Failed: ${failed.join(', ')}`);
    }

    bot.log('SUCCESS', 'All F2P skills (except Runecraft) trained to level 10+!');
}

export const metadata: ScriptMeta = {
    name: 'f2pskills',
    type: 'activity',
    maxTicks: 200000,
    run: f2pSkills,
    buildStates: buildF2pSkillsStates,
    extraAssertions: (api: BotAPI) => {
        const f2pSkills = [
            'Attack', 'Strength', 'Defence', 'Ranged', 'Prayer',
            'Magic', 'Hitpoints', 'Mining', 'Smithing', 'Fishing',
            'Cooking', 'Woodcutting', 'Firemaking', 'Crafting'
        ];
        return f2pSkills.map(s => ({
            name: `${s} >= 10`,
            pass: api.getSkill(s).baseLevel >= 10,
        }));
    },
};
