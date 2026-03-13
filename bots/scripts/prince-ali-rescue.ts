import path from 'path';
import LocType from '../../src/cache/config/LocType.js';
import { BotAPI } from '../runtime/api.js';
import { skipTutorial } from './skip-tutorial.js';
import { type BotState, runStateMachine } from '../runtime/state-machine.js';
import type { ScriptMeta } from '../runtime/script-meta.js';

// Varp IDs (from content/pack/varp.pack)
const PRINCEQUEST_VARP = 273;
const PRINCE_KEYSTATUS_VARP = 274;

// Quest stages (from content/scripts/quests/quest_prince/configs/quest_prince.constant)
const STAGE_NOT_STARTED = 0;
const STAGE_STARTED = 10;
const STAGE_SPOKEN_OSMAN = 20;
const STAGE_PREP_FINISHED = 30;
const STAGE_GUARD_DRUNK = 40;
const STAGE_TIED_KELI = 50;
const STAGE_SAVED = 100;
const STAGE_COMPLETE = 110;

// Varp values for key status
const KEY_MADE = 1;
const _KEY_CLAIMED = 2;

// Stun/delay varps (same as thieving-men.ts)
const VARP_ACTION_DELAY = 58;
const VARP_STUNNED = 103;

// ---- Key locations ----

// Lumbridge spawn
const LUMBRIDGE_SPAWN_X = 3222;
const LUMBRIDGE_SPAWN_Z = 3218;

// Al-Kharid palace area - OUTSIDE the palace door (Hassan is inside)
// The palace door blocks pathfinding, so walk to just outside first, then open the door.
const AL_KHARID_PALACE_X = 3293;
const AL_KHARID_PALACE_Z = 3167;

// SE Varrock mine area (copper, tin rocks)
const MINE_AREA_X = 3298;
const MINE_AREA_Z = 3315;

// Champion's Guild mine (clay rocks at 3180,3372 / 3183,3377)
// Walk to (3184,3377) which is adjacent to the eastern clay rock
const CLAY_MINE_X = 3184;
const CLAY_MINE_Z = 3377;

// Lumbridge furnace (the furnace loc is at 3226,3255 but approach from south at z=3254)
const FURNACE_AREA_X = 3226;
const FURNACE_AREA_Z = 3254;

// Lumbridge General Store
const GENERAL_STORE_X = 3212;
const GENERAL_STORE_Z = 3247;

// Varrock clothes shop (Thessalia) - east side of Varrock square
const THESSALIA_X = 3206;
const THESSALIA_Z = 3417;

// Blue Moon Inn (Varrock) - south Varrock
// Blue Moon Inn: door at (3229,3396). Approach from west at (3228,3396).
const BLUE_MOON_DOOR_X = 3228;
const BLUE_MOON_DOOR_Z = 3396;
const BLUE_MOON_X = 3226;
const BLUE_MOON_Z = 3399;

// Onion field south of Fred's farm / east of Lumbridge
// Onion locs spawn around (3184-3190, 3259-3263)
// Onion field is enclosed by fencing. Entry is via a gate at (3186,3268)/(3186,3269).
// Approach from the west side to open the gate.
const ONION_GATE_X = 3185;
const ONION_GATE_Z = 3268;

// Sheep shearing area (same as sheep-shearer.ts)
const SHEEP_AREA_X = 3198;
const SHEEP_AREA_Z = 3274;

// Lumbridge Castle stairs
const STAIRS_AREA_X = 3206;
const STAIRS_AREA_Z = 3210;

// Spinning wheel on level 1 (Lumbridge Castle)
const SPINNING_WHEEL_X = 3209;
const SPINNING_WHEEL_Z = 3213;

// Ned in Draynor Village
// Ned is inside his house. Door at (3101,3258) faces east; approach from east side.
const NED_DOOR_X = 3102;
const NED_DOOR_Z = 3258;
const NED_X = 3100;
const NED_Z = 3258;

// Aggie in Draynor Village
// Aggie is inside her house. Door at (3088,3258) faces east; approach from east side.
const AGGIE_DOOR_X = 3089;
const AGGIE_DOOR_Z = 3258;
const AGGIE_X = 3086;
const AGGIE_Z = 3259;

// Port Sarim food store (Wydin)
// Wydin is at (3014,3204). Store is open on the east side (desertdoor at 3017,3206 is open).
// Walk in from the east. No door to open.
const WYDIN_X = 3014;
const WYDIN_Z = 3204;

// Draynor jail area (Lady Keli, Joe, Prince Ali)
// The jail building has a door (poordooropen) at (3128,3246) angle=1.
// Approach from the north side (3128,3247), open door, walk inside.
const JAIL_DOOR_X = 3128;
const JAIL_DOOR_Z = 3247;
const JAIL_X = 3128;
const JAIL_Z = 3244;

// Leela is near the jail, lurking to the north-west
const LEELA_X = 3113;
const LEELA_Z = 3263;

// NPC type IDs
const NPC_SHEEPUNSHEERED = 43;

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
 * Navigate through the Al-Kharid toll gate.
 * The gate locs (border_gate_toll_left/right) are at approximately (3268, 3227).
 * Interacting with the gate triggers a border guard dialog that asks for 10gp.
 * After the Prince Ali Rescue quest is complete, passage is free.
 *
 * The dialog flow:
 *   chatplayer "Can I come through this gate?"
 *   chatnpc "You must pay a toll of 10 gold coins to pass."
 *   p_choice3: (1) "No thank you..." (2) "Who does my money go to?" (3) "Yes, ok."
 *   -> select 3: "Yes, ok." -> pays 10gp -> gate opens and teleports through
 *
 * After quest completion (varp >= prince_saved):
 *   chatplayer "Can I come through this gate?"
 *   chatnpc "You may pass for free, you are a friend of Al-Kharid."
 *   -> gate opens automatically
 */
async function crossAlKharidGate(bot: BotAPI, goingEast: boolean): Promise<void> {
    if (goingEast) {
        // Walk to the west side of the gate
        await bot.walkToWithPathfinding(3267, 3227);
    } else {
        // Walk to the east side of the gate
        await bot.walkToWithPathfinding(3269, 3227);
    }

    bot.log('ACTION', `crossAlKharidGate: goingEast=${goingEast} pos=(${bot.player.x},${bot.player.z})`);

    // Find and interact with the toll gate loc (border_gate_toll_left or border_gate_toll_right)
    const gateLoc = bot.findNearbyLoc('border_gate_toll_left', 5) ?? bot.findNearbyLoc('border_gate_toll_right', 5);
    if (!gateLoc) {
        throw new Error(`crossAlKharidGate: no toll gate found near (${bot.player.x},${bot.player.z})`);
    }

    await bot.interactLoc(gateLoc, 1); // op1 = Open

    // The gate interaction triggers dialog with a nearby border guard
    await bot.waitForDialog(15);

    // chatplayer "Can I come through this gate?"
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // Check if quest is complete (free passage)
    if (bot.getQuestProgress(PRINCEQUEST_VARP) >= STAGE_SAVED) {
        // chatnpc "You may pass for free..."
        await bot.continueDialog();
    } else {
        // chatnpc "You must pay a toll of 10 gold coins to pass."
        await bot.continueDialog();

        // p_choice3: (1) No (2) Who gets money? (3) Yes, ok.
        await bot.waitForDialog(10);
        await bot.selectDialogOption(3); // "Yes, ok."

        // chatplayer "Yes, ok."
        await bot.waitForDialog(10);
        await bot.continueDialog();
    }

    // The gate script handles opening/teleporting through the gate.
    // Wait for the teleport to complete.
    await bot.waitForTicks(5);
    bot.dismissModals();

    bot.log('STATE', `crossAlKharidGate: after crossing pos=(${bot.player.x},${bot.player.z})`);
}

/**
 * Walk from Lumbridge to Al-Kharid palace.
 * Route: Lumbridge spawn -> north to bridge area -> cross bridge east -> toll gate -> Al-Kharid
 * The River Lum runs N-S between Lumbridge and Al-Kharid. The bridge is around z=3226-3230.
 * Must cross the bridge first, then walk east to the toll gate.
 */
async function walkToAlKharid(bot: BotAPI): Promise<void> {
    bot.log('STATE', 'Walking to Al-Kharid...');

    // Walk east of the river (bridge is crossable at z<=3226)
    // (3253,3226) is reachable from Lumbridge spawn and east of the River Lum
    await bot.walkToWithPathfinding(3253, 3226);

    // Cross the toll gate (pays 10gp if quest not complete)
    await crossAlKharidGate(bot, true);

    // Continue south-east to Al-Kharid palace
    await bot.walkToWithPathfinding(AL_KHARID_PALACE_X, AL_KHARID_PALACE_Z);
    bot.log('STATE', `At Al-Kharid palace: pos=(${bot.player.x},${bot.player.z})`);
}

/**
 * Walk from Al-Kharid back to Lumbridge.
 * Route: Al-Kharid -> toll gate -> bridge -> south to Lumbridge spawn
 */
async function _walkFromAlKharidToLumbridge(bot: BotAPI): Promise<void> {
    bot.log('STATE', 'Walking from Al-Kharid to Lumbridge...');

    // Cross the toll gate going west (free after quest completion)
    await crossAlKharidGate(bot, false);

    // Walk south-west from east of river back to Lumbridge spawn
    // After crossing the gate westward, we're around (3267,3227).
    // Path via (3253,3226) to cross back over the river area.
    await bot.walkToWithPathfinding(3253, 3226);
    await bot.walkToWithPathfinding(LUMBRIDGE_SPAWN_X, LUMBRIDGE_SPAWN_Z);
    bot.log('STATE', `At Lumbridge: pos=(${bot.player.x},${bot.player.z})`);
}

/**
 * Mine a rock by debugname. Waits for the ore to appear in inventory.
 */
async function mineRock(bot: BotAPI, rockDebugname: string, oreName: string): Promise<void> {
    for (let attempt = 1; attempt <= 5; attempt++) {
        if (bot.player.delayed) {
            await bot.waitForCondition(() => !bot.player.delayed, 30);
        }
        bot.dismissModals();

        // Try primary debugname, then fall back to variant (rock1 <-> rock2)
        let rock = bot.findNearbyLoc(rockDebugname, 16);
        if (!rock) {
            const altName = rockDebugname.endsWith('1')
                ? rockDebugname.slice(0, -1) + '2'
                : rockDebugname.endsWith('2') ? rockDebugname.slice(0, -1) + '1' : null;
            if (altName) {
                rock = bot.findNearbyLoc(altName, 16);
            }
        }
        if (!rock) {
            throw new Error(`mineRock: "${rockDebugname}" not found near (${bot.player.x},${bot.player.z})`);
        }
        bot.log('ACTION', `Mining ${rockDebugname} at (${rock.x},${rock.z}) (attempt ${attempt})`);

        await bot.interactLoc(rock, 1);

        try {
            await bot.waitForCondition(() => bot.findItem(oreName) !== null, 60);
            await bot.waitForTicks(1);
            bot.dismissModals();
            bot.log('EVENT', `Mined ${oreName}`);
            return;
        } catch {
            bot.log('STATE', `Mining attempt ${attempt} timed out, retrying...`);
            await bot.waitForTicks(5);
        }
    }
    throw new Error(`mineRock: failed to mine "${oreName}" after 5 attempts`);
}

/**
 * Navigate into Lumbridge Castle and up to spinning wheel on level 1.
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
        throw new Error(`Failed to climb to level 1: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }

    await bot.openDoor('poordooropen');
    await bot.waitForTicks(1);
    await bot.walkToWithPathfinding(SPINNING_WHEEL_X, SPINNING_WHEEL_Z);
    bot.log('STATE', `Near spinning wheel: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
}

/**
 * Climb back down from level 1 to ground floor.
 */
async function goDownFromSpinningWheel(bot: BotAPI): Promise<void> {
    await bot.walkToWithPathfinding(3206, 3210);
    await bot.climbStairs('loc_1739', 3); // op3=Climb-down
    await bot.waitForTicks(2);

    if (bot.player.level !== 0) {
        throw new Error(`Failed to climb down to level 0: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    bot.log('STATE', `Back on ground floor: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
}

/**
 * Exit Lumbridge Castle to the outside.
 */
async function exitLumbridgeCastle(bot: BotAPI): Promise<void> {
    await bot.walkToWithPathfinding(3215, 3210);
    await bot.openDoor('poordooropen');
    await bot.walkToWithPathfinding(3215, 3215);
    await bot.walkToWithPathfinding(3217, 3218);
    await bot.openDoor('openbankdoor_l');
    await bot.walkToWithPathfinding(LUMBRIDGE_SPAWN_X, LUMBRIDGE_SPAWN_Z);
}

/**
 * Navigate to Aggie's house: walk to the door, open it, then walk inside.
 */
async function walkToAggie(bot: BotAPI): Promise<void> {
    await bot.walkToWithPathfinding(AGGIE_DOOR_X, AGGIE_DOOR_Z);
    await bot.openDoor('inaccastledoubledoorropen');
    await bot.walkToWithPathfinding(AGGIE_X, AGGIE_Z);
    bot.log('STATE', `At Aggie: pos=(${bot.player.x},${bot.player.z})`);
}

/**
 * Navigate into the Draynor jail building: walk to door, open it, walk inside.
 */
async function walkToJail(bot: BotAPI): Promise<void> {
    await bot.walkToWithPathfinding(JAIL_DOOR_X, JAIL_DOOR_Z);
    await bot.openDoor('poordooropen');
    await bot.walkToWithPathfinding(JAIL_X, JAIL_Z);
    bot.log('STATE', `Inside jail: pos=(${bot.player.x},${bot.player.z})`);
}

/**
 * Walk from Draynor Village area to Varrock (Thessalia's shop area).
 * Route: east toward Lumbridge, cross bridge, north along east side of Varrock, west into city.
 */
async function walkDraynorToVarrock(bot: BotAPI): Promise<void> {
    bot.log('STATE', 'Walking Draynor -> Varrock via Lumbridge bridge...');
    await bot.walkToWithPathfinding(3253, 3226);
    await bot.walkToWithPathfinding(3253, 3340);
    await bot.walkToWithPathfinding(3253, 3420);
    await bot.walkToWithPathfinding(3210, 3420);
}

/**
 * Walk from Varrock area back to Draynor Village area.
 * Reverse route: east to SE opening, south along east side, west across bridge.
 */
async function walkVarrockToDraynor(bot: BotAPI): Promise<void> {
    bot.log('STATE', 'Walking Varrock -> Draynor via Lumbridge bridge...');
    await bot.walkToWithPathfinding(3253, 3420);
    await bot.walkToWithPathfinding(3253, 3340);
    await bot.walkToWithPathfinding(3253, 3226);
    await bot.walkToWithPathfinding(3110, 3260);
}

/**
 * Open a double gate and walk through to the target tile.
 */
async function openGateAndCross(bot: BotAPI, targetX: number, targetZ: number, label: string): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt++) {
        await bot.openGate(5);
        await bot.waitForTicks(1);
        await bot.openGate(5);
        await bot.waitForTicks(2);

        try {
            await bot.walkTo(targetX, targetZ);
            return;
        } catch (err) {
            bot.log('STATE', `Gate crossing failed (${label}, attempt ${attempt}/3): ${(err as Error).message}`);
            if (attempt === 3) {
                throw new Error(`Failed to cross gate after 3 attempts (${label}): ${(err as Error).message}`);
            }
            await bot.waitForTicks(3);
        }
    }
}

/**
 * Navigate to the sheep wander area (same strategy as sheep-shearer.ts).
 */
async function walkToSheepArea(bot: BotAPI): Promise<void> {
    const px = bot.player.x;
    const pz = bot.player.z;

    if (px >= 3193 && px <= 3210 && pz >= 3271 && pz <= 3276) {
        bot.log('STATE', `Already in sheep area: pos=(${px},${pz})`);
        return;
    }

    // Enter from the east gate
    await bot.walkToWithPathfinding(3214, 3262);
    await openGateAndCross(bot, 3211, 3262, 'enter sheep field');
    await bot.walkToWithPathfinding(SHEEP_AREA_X, SHEEP_AREA_Z);
    bot.log('STATE', `In sheep area: pos=(${bot.player.x},${bot.player.z})`);
}

/**
 * Shear sheep and collect wool. Returns when we have the target count.
 */
async function shearSheep(bot: BotAPI, count: number): Promise<void> {
    bot.log('STATE', `=== Shearing ${count} sheep ===`);

    let woolCollected = 0;
    let waitTicks = 0;
    const MAX_WAIT_TICKS = 3000;

    while (woolCollected < count && waitTicks < MAX_WAIT_TICKS) {
        await bot.clearPendingState();

        // Find a nearby unsheered sheep
        const sheep = bot.findNearbyNpcByTypeId(NPC_SHEEPUNSHEERED, 16);
        if (!sheep) {
            await bot.walkToWithPathfinding(SHEEP_AREA_X, SHEEP_AREA_Z);
            await bot.waitForTicks(5);
            waitTicks += 5;
            continue;
        }

        const dist = Math.max(Math.abs(sheep.x - bot.player.x), Math.abs(sheep.z - bot.player.z));
        if (dist > 1) {
            bot.player.queueWaypoint(sheep.x, sheep.z);
            await bot.waitForTicks(Math.min(dist, 5));
            waitTicks += Math.min(dist, 5);
            continue;
        }

        const woolBefore = countItem(bot, 'Wool');
        await bot.useItemOnNpcDirect('Shears', sheep);
        await bot.waitForTicks(5);
        bot.dismissModals();

        const woolAfter = countItem(bot, 'Wool');
        if (woolAfter > woolBefore) {
            woolCollected++;
            bot.log('EVENT', `Wool collected: ${woolCollected}/${count}`);
        }

        // Keep sheep area bounds
        if (bot.player.x < 3193 || bot.player.x > 3210 || bot.player.z < 3258 || bot.player.z > 3276) {
            await bot.walkToWithPathfinding(SHEEP_AREA_X, SHEEP_AREA_Z);
        }

        await bot.waitForTicks(1);
        waitTicks++;
    }

    if (woolCollected < count) {
        throw new Error(`Failed to shear ${count} sheep after ${MAX_WAIT_TICKS} ticks (got ${woolCollected})`);
    }
}

/**
 * Spin all wool into balls of wool at the spinning wheel.
 */
async function spinAllWool(bot: BotAPI): Promise<void> {
    const woolCount = countItem(bot, 'Wool');
    bot.log('STATE', `Spinning ${woolCount} wool...`);

    for (let i = 0; i < woolCount; i++) {
        const wool = bot.findItem('Wool');
        if (!wool) {
            throw new Error(`Wool disappeared while spinning (spun ${i}/${woolCount})`);
        }

        if (bot.player.delayed) {
            await bot.waitForCondition(() => !bot.player.delayed, 20);
        }

        await bot.useItemOnLoc('Wool', 'spinning_wheel');
        await bot.waitForTicks(6);
        bot.dismissModals();
        bot.log('EVENT', `Spun ball of wool: ${i + 1}/${woolCount}`);
    }
}

// ================================================================
// Helper functions for individual quest steps (extracted for state machine use)
// ================================================================

async function talkToHassan(bot: BotAPI): Promise<void> {
    await walkToAlKharid(bot);

    await bot.openDoor('loc_1506');
    await bot.openDoor('loc_1508');
    await bot.waitForTicks(1);

    await bot.talkToNpc('Hassan');
    await bot.waitForDialog(30);
    await bot.continueDialog();

    await bot.waitForDialog(10);
    await bot.selectDialogOption(1);

    await bot.waitForDialog(10);
    await bot.continueDialog();

    await bot.waitForDialog(10);
    await bot.continueDialog();

    await bot.waitForTicks(2);
    const varpAfterHassan = bot.getQuestProgress(PRINCEQUEST_VARP);
    if (varpAfterHassan !== STAGE_STARTED) {
        throw new Error(`Quest varp after Hassan is ${varpAfterHassan}, expected ${STAGE_STARTED}`);
    }
    bot.log('EVENT', `Quest started! varp=${varpAfterHassan}`);
}

async function talkToOsman(bot: BotAPI): Promise<void> {
    await bot.walkToWithPathfinding(3286, 3181);
    await bot.talkToNpc('Osman');

    await bot.waitForDialog(15);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.selectDialogOption(1);
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.selectDialogOption(3);
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();

    await bot.waitForTicks(2);
    const varpAfterOsman = bot.getQuestProgress(PRINCEQUEST_VARP);
    if (varpAfterOsman !== STAGE_SPOKEN_OSMAN) {
        throw new Error(`Quest varp after Osman is ${varpAfterOsman}, expected ${STAGE_SPOKEN_OSMAN}`);
    }
    bot.log('EVENT', `Spoken to Osman! varp=${varpAfterOsman}`);
}

async function gatherMaterials(bot: BotAPI): Promise<void> {
    // Mine copper, tin, clay
    await bot.walkToWithPathfinding(MINE_AREA_X, MINE_AREA_Z);
    bot.log('STATE', `At SE Varrock mine: pos=(${bot.player.x},${bot.player.z})`);

    await mineRock(bot, 'copperrock1', 'Copper ore');
    await mineRock(bot, 'tinrock1', 'Tin ore');

    await bot.walkToWithPathfinding(CLAY_MINE_X, CLAY_MINE_Z);
    const clayRock = bot.findNearbyLoc('clayrock2', 16) ?? bot.findNearbyLoc('clayrock1', 16);
    if (!clayRock) {
        throw new Error(`No clay rock found near (${bot.player.x},${bot.player.z})`);
    }
    const clayLocType = LocType.get(clayRock.type);
    await mineRock(bot, clayLocType.debugname!, 'Clay');

    // Smelt bronze bar
    await bot.walkToWithPathfinding(FURNACE_AREA_X, FURNACE_AREA_Z);
    if (bot.player.delayed) {
        await bot.waitForCondition(() => !bot.player.delayed, 20);
    }
    await bot.useItemOnLoc('Copper ore', 'furnace1');
    await bot.waitForCondition(() => bot.findItem('Bronze bar') !== null, 20);
    await bot.waitForTicks(1);
    bot.dismissModals();
    bot.log('EVENT', 'Smelted bronze bar');

    // Buy bucket, fill with water, make soft clay
    await bot.walkToWithPathfinding(GENERAL_STORE_X, GENERAL_STORE_Z);
    await bot.openDoor('poordooropen');
    const shopkeeper = bot.findNearbyNpc('Shop keeper');
    if (!shopkeeper) throw new Error(`Shop keeper not found near (${bot.player.x},${bot.player.z})`);
    await bot.interactNpc(shopkeeper, 3);
    await bot.waitForTicks(3);
    await bot.buyFromShop('Bucket', 1);
    await bot.waitForTicks(1);
    bot.dismissModals();
    if (!bot.findItem('Bucket')) throw new Error('Failed to buy bucket');
    bot.log('EVENT', 'Bought bucket');

    await bot.walkToWithPathfinding(3221, 3213);
    const fountain = bot.findNearbyLoc('fountain');
    if (!fountain) throw new Error(`No fountain found near (${bot.player.x},${bot.player.z})`);
    const locType = LocType.get(fountain.type);
    await bot.useItemOnLoc('Bucket', locType.debugname!);
    await bot.waitForTicks(3);
    bot.dismissModals();
    if (!bot.findItem('Bucket of water')) throw new Error('Failed to fill bucket with water');
    bot.log('EVENT', 'Filled bucket with water');

    await bot.useItemOnItem('Bucket of water', 'Clay');
    await bot.waitForTicks(3);
    bot.dismissModals();
    if (!bot.findItem('Soft clay')) throw new Error('Failed to make soft clay');
    bot.log('EVENT', 'Made soft clay');

    // Shear sheep and spin wool
    if (!bot.findItem('Shears')) {
        await bot.walkToWithPathfinding(GENERAL_STORE_X, GENERAL_STORE_Z);
        await bot.openDoor('poordooropen');
        const sk2 = bot.findNearbyNpc('Shop keeper');
        if (!sk2) throw new Error('Shop keeper not found');
        await bot.interactNpc(sk2, 3);
        await bot.waitForTicks(3);
        await bot.buyFromShop('Shears', 1);
        await bot.waitForTicks(1);
        bot.dismissModals();
        if (!bot.findItem('Shears')) throw new Error('Failed to buy shears');
        bot.log('EVENT', 'Bought shears');
    }

    await walkToSheepArea(bot);
    await shearSheep(bot, 3);

    await bot.walkToWithPathfinding(3212, 3262);
    await openGateAndCross(bot, 3214, 3262, 'exit sheep field');

    await goToSpinningWheel(bot);
    await spinAllWool(bot);

    const ballsOfWool = countItem(bot, 'Ball of wool');
    if (ballsOfWool < 3) throw new Error(`Expected 3 balls of wool, found ${ballsOfWool}`);
    bot.log('EVENT', `Spun ${ballsOfWool} balls of wool`);

    await goDownFromSpinningWheel(bot);
    await exitLumbridgeCastle(bot);

    // Pick onions
    await bot.walkToWithPathfinding(ONION_GATE_X, ONION_GATE_Z);
    await bot.openGate(5);
    await bot.waitForTicks(2);
    await bot.walkToWithPathfinding(3189, 3267);

    for (let i = 0; i < 2; i++) {
        await bot.clearPendingState();
        const onionsBefore = countItem(bot, 'Onion');
        const onionLoc = bot.findNearbyLoc('onion', 10);
        if (!onionLoc) throw new Error(`No onion loc found near (${bot.player.x},${bot.player.z})`);
        await bot.interactLoc(onionLoc, 2);
        await bot.waitForCondition(() => countItem(bot, 'Onion') > onionsBefore, 20);
        bot.dismissModals();
        bot.log('EVENT', `Picked onion ${i + 1}/2`);
    }

    // Get wig from Ned
    await bot.walkToWithPathfinding(NED_DOOR_X, NED_DOOR_Z);
    await bot.openDoor('inaccastledoubledoorropen');
    await bot.walkToWithPathfinding(NED_X, NED_Z);

    await bot.talkToNpc('Ned');
    await bot.waitForDialog(15);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.selectDialogOption(1);
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.selectDialogOption(2);
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.selectDialogOption(1);
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    const moreDialog = await bot.waitForDialog(5);
    if (moreDialog) await bot.continueDialog();
    await bot.waitForTicks(2);
    if (!bot.findItem('Wig')) throw new Error('Failed to get plain wig from Ned');
    bot.log('EVENT', 'Got plain wig from Ned');

    // Buy rope from Ned
    await bot.talkToNpc('Ned');
    await bot.waitForDialog(15);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.selectDialogOption(2);
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.selectDialogOption(1);
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForTicks(2);
    bot.dismissModals();
    if (!bot.findItem('Rope')) throw new Error('Failed to buy rope from Ned');
    bot.log('EVENT', 'Bought rope from Ned');

    // Get yellow dye from Aggie
    await walkToAggie(bot);
    await bot.talkToNpc('Aggie');
    await bot.waitForDialog(15);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.selectDialogOption(5);
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.selectDialogOption(2);
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.selectDialogOption(1);
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForTicks(2);
    bot.dismissModals();
    if (!bot.findItem('Yellow dye')) throw new Error('Failed to get yellow dye from Aggie');
    bot.log('EVENT', 'Got yellow dye from Aggie');

    // Dye wig blonde
    await bot.useItemOnItem('Yellow dye', 'Wig');
    await bot.waitForTicks(3);
    bot.dismissModals();
    if (bot.findItem('Yellow dye')) throw new Error('Yellow dye was not consumed - blonde wig creation may have failed');
    bot.log('EVENT', 'Made blonde wig');

    // Buy pink skirt and beers in Varrock
    await bot.openDoor('inaccastledoubledoorropen');
    await walkDraynorToVarrock(bot);
    await bot.walkToWithPathfinding(THESSALIA_X, THESSALIA_Z);

    const thessalia = bot.findNearbyNpc('Thessalia');
    if (!thessalia) throw new Error(`Thessalia not found near (${bot.player.x},${bot.player.z})`);
    await bot.interactNpc(thessalia, 3);
    await bot.waitForTicks(3);
    if (bot.isDialogOpen()) {
        await bot.continueDialog();
        await bot.waitForDialog(5);
        if (bot.isDialogOpen()) await bot.continueDialog();
        await bot.waitForTicks(2);
    }
    await bot.buyFromShop('Pink skirt', 1);
    await bot.waitForTicks(1);
    bot.dismissModals();
    if (!bot.findItem('Pink skirt')) throw new Error('Failed to buy pink skirt');
    bot.log('EVENT', 'Bought pink skirt');

    await bot.walkToWithPathfinding(BLUE_MOON_DOOR_X, BLUE_MOON_DOOR_Z);
    await bot.openDoor('inaccastledoubledoorropen');
    await bot.walkToWithPathfinding(BLUE_MOON_X, BLUE_MOON_Z);

    for (let i = 0; i < 3; i++) {
        if (bot.player.delayed) await bot.waitForCondition(() => !bot.player.delayed, 20);
        await bot.talkToNpc('Bartender');
        await bot.waitForDialog(15);
        await bot.continueDialog();
        await bot.waitForDialog(10);
        await bot.selectDialogOption(1);
        await bot.waitForDialog(10);
        await bot.continueDialog();
        await bot.waitForDialog(10);
        await bot.continueDialog();
        await bot.waitForTicks(3);
        bot.dismissModals();
        bot.log('EVENT', `Bought beer ${i + 1}/3`);
    }
    if (countItem(bot, 'Beer') < 3) throw new Error(`Expected 3 beers, found ${countItem(bot, 'Beer')}`);

    // Buy flour and redberries from Wydin
    await bot.openDoor('inaccastledoubledoorropen');
    await walkVarrockToDraynor(bot);
    await bot.walkToWithPathfinding(3047, 3237);
    await bot.walkToWithPathfinding(3016, 3215);
    await bot.walkToWithPathfinding(WYDIN_X, WYDIN_Z);

    const wydin = bot.findNearbyNpc('Wydin');
    if (!wydin) throw new Error(`Wydin not found near (${bot.player.x},${bot.player.z})`);
    await bot.interactNpc(wydin, 3);
    await bot.waitForTicks(3);
    await bot.buyFromShop('Pot of flour', 1);
    await bot.waitForTicks(1);
    await bot.buyFromShop('Redberries', 1);
    await bot.waitForTicks(1);
    bot.dismissModals();
    if (!bot.findItem('Pot of flour')) throw new Error('Failed to buy pot of flour');
    if (!bot.findItem('Redberries')) throw new Error('Failed to buy redberries');
    bot.log('EVENT', 'Bought pot of flour and redberries');

    // Get ashes
    await bot.walkToWithPathfinding(3016, 3215);
    await bot.walkToWithPathfinding(3093, 3243);

    let ashesFound = false;
    for (let searchAttempt = 0; searchAttempt < 5 && !ashesFound; searchAttempt++) {
        const ashesObj = bot.findNearbyGroundItem('Ashes', 20);
        if (ashesObj) {
            await bot.takeGroundItem('Ashes', ashesObj.x, ashesObj.z);
            await bot.waitForTicks(3);
            if (bot.findItem('Ashes')) {
                ashesFound = true;
                bot.log('EVENT', 'Picked up ashes from ground');
            }
        } else {
            const searchPoints = [
                [3080, 3250], [3093, 3243], [3100, 3245],
                [3110, 3250], [3120, 3244]
            ];
            if (searchAttempt < searchPoints.length) {
                const [sx, sz] = searchPoints[searchAttempt]!;
                await bot.walkToWithPathfinding(sx, sz);
                await bot.waitForTicks(3);
            }
        }
    }

    if (!ashesFound) {
        bot.log('STATE', 'No ashes found on ground, will burn logs...');
        if (!bot.findItem('Tinderbox')) {
            await bot.walkToWithPathfinding(GENERAL_STORE_X, GENERAL_STORE_Z);
            await bot.openDoor('poordooropen');
            const sk3 = bot.findNearbyNpc('Shop keeper');
            if (!sk3) throw new Error('Shop keeper not found for tinderbox');
            await bot.interactNpc(sk3, 3);
            await bot.waitForTicks(3);
            await bot.buyFromShop('Tinderbox', 1);
            await bot.waitForTicks(1);
            bot.dismissModals();
        }

        await bot.walkToWithPathfinding(3232, 3205);
        const bob = bot.findNearbyNpc('Bob');
        if (bob) {
            await bot.interactNpc(bob, 3);
            await bot.waitForTicks(3);
            await bot.buyFromShop('Bronze axe', 1);
            await bot.waitForTicks(1);
            bot.dismissModals();
        }

        await bot.walkToWithPathfinding(3233, 3213);
        const tree = bot.findNearbyLoc('tree', 20) ?? bot.findNearbyLoc('tree2', 20) ?? bot.findNearbyLoc('tree3', 20);
        if (!tree) throw new Error(`No tree found near (${bot.player.x},${bot.player.z})`);
        await bot.interactLoc(tree, 1);
        await bot.waitForCondition(() => bot.findItem('Logs') !== null, 60);
        await bot.waitForTicks(1);
        bot.dismissModals();

        await bot.useItemOnItem('Tinderbox', 'Logs');
        await bot.waitForTicks(8);
        bot.dismissModals();

        await bot.waitForCondition(() => bot.findNearbyGroundItem('Ashes', 10) !== null, 250);
        const ashesOnGround = bot.findNearbyGroundItem('Ashes', 10);
        if (!ashesOnGround) throw new Error('Ashes appeared but then disappeared');
        await bot.takeGroundItem('Ashes', ashesOnGround.x, ashesOnGround.z);
        await bot.waitForTicks(3);
        if (!bot.findItem('Ashes')) throw new Error('Failed to pick up ashes from fire');
        bot.log('EVENT', 'Picked up ashes from fire');
    }

    // Get skin paste from Aggie
    if (!bot.findItem('Bucket of water') && !bot.findItem('Jug of water')) {
        if (!bot.findItem('Bucket')) throw new Error('No bucket found for water — needed for skin paste');
        await bot.walkToWithPathfinding(3221, 3213);
        const fountain2 = bot.findNearbyLoc('fountain');
        if (!fountain2) throw new Error(`No fountain found near (${bot.player.x},${bot.player.z})`);
        const locType2 = LocType.get(fountain2.type);
        await bot.useItemOnLoc('Bucket', locType2.debugname!);
        await bot.waitForTicks(3);
        bot.dismissModals();
        if (!bot.findItem('Bucket of water')) throw new Error('Failed to fill bucket with water at fountain');
        bot.log('EVENT', 'Refilled bucket with water for skin paste');
    }

    await walkToAggie(bot);
    await bot.talkToNpc('Aggie');
    await bot.waitForDialog(15);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.selectDialogOption(1);
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.selectDialogOption(1);
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForTicks(2);
    bot.dismissModals();
    if (!bot.findItem('Paste')) throw new Error('Failed to get skin paste from Aggie');
    bot.log('EVENT', 'Got skin paste');

    // Get key imprint from Lady Keli
    await bot.openDoor('inaccastledoubledoorropen');
    await walkToJail(bot);

    await bot.talkToNpc('Lady Keli');
    await bot.waitForDialog(15);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.selectDialogOption(1);
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.selectDialogOption(2);
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.selectDialogOption(3);
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.selectDialogOption(1);
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.selectDialogOption(1);
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForTicks(2);
    bot.dismissModals();
    if (!bot.findItem('Key print')) throw new Error('Failed to get key imprint from Lady Keli');
    bot.log('EVENT', 'Got key imprint');

    // Give Osman key imprint + bronze bar
    await bot.walkToWithPathfinding(3253, 3226);
    await crossAlKharidGate(bot, true);
    await bot.walkToWithPathfinding(3286, 3181);

    await bot.talkToNpc('Osman');
    await bot.waitForDialog(15);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.selectDialogOption(1);
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForTicks(2);
    bot.dismissModals();

    const keystatus = bot.getVarp(PRINCE_KEYSTATUS_VARP);
    if (keystatus !== KEY_MADE) throw new Error(`Key status after Osman is ${keystatus}, expected ${KEY_MADE}`);
    bot.log('EVENT', `Key made! keystatus=${keystatus}`);

    // Get key from Leela
    await crossAlKharidGate(bot, false);
    await bot.walkToWithPathfinding(3253, 3226);
    await bot.walkToWithPathfinding(LEELA_X, LEELA_Z);

    await bot.talkToNpc('Leela');
    await bot.waitForDialog(15);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForTicks(2);
    bot.dismissModals();

    if (!bot.findItem('Bronze key')) throw new Error('Failed to get bronze key from Leela');

    const varpAfterLeela = bot.getQuestProgress(PRINCEQUEST_VARP);
    if (varpAfterLeela !== STAGE_PREP_FINISHED) {
        throw new Error(`Quest varp after Leela is ${varpAfterLeela}, expected ${STAGE_PREP_FINISHED}`);
    }
    bot.log('EVENT', `Prep finished! varp=${varpAfterLeela}`);
}

async function getJoeDrunk(bot: BotAPI): Promise<void> {
    await walkToJail(bot);

    await bot.talkToNpc('Joe');
    await bot.waitForDialog(15);
    await bot.selectDialogOption(1);
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForTicks(2);
    bot.dismissModals();

    const varpAfterJoe = bot.getQuestProgress(PRINCEQUEST_VARP);
    if (varpAfterJoe !== STAGE_GUARD_DRUNK) {
        throw new Error(`Quest varp after Joe is ${varpAfterJoe}, expected ${STAGE_GUARD_DRUNK}`);
    }
    bot.log('EVENT', `Guard is drunk! varp=${varpAfterJoe}`);
}

async function tieUpKeli(bot: BotAPI): Promise<void> {
    await bot.useItemOnNpc('Rope', 'Lady Keli');
    await bot.waitForTicks(3);
    if (bot.isDialogOpen()) await bot.continueDialog();
    await bot.waitForTicks(2);
    bot.dismissModals();

    const varpAfterKeli = bot.getQuestProgress(PRINCEQUEST_VARP);
    if (varpAfterKeli !== STAGE_TIED_KELI) {
        throw new Error(`Quest varp after tying Keli is ${varpAfterKeli}, expected ${STAGE_TIED_KELI}`);
    }
    bot.log('EVENT', `Keli is tied up! varp=${varpAfterKeli}`);
}

async function rescuePrince(bot: BotAPI): Promise<void> {
    await bot.useItemOnLoc('Bronze key', 'alidoor');
    await bot.waitForTicks(5);
    bot.dismissModals();
    await bot.waitForTicks(2);

    await bot.talkToNpc('Prince Ali');
    await bot.waitForDialog(15);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForDialog(10);
    await bot.continueDialog();
    await bot.waitForTicks(3);
    bot.dismissModals();

    const varpAfterRescue = bot.getQuestProgress(PRINCEQUEST_VARP);
    if (varpAfterRescue !== STAGE_SAVED) {
        throw new Error(`Quest varp after rescue is ${varpAfterRescue}, expected ${STAGE_SAVED}`);
    }
    bot.log('EVENT', `Prince saved! varp=${varpAfterRescue}`);
}

async function returnToHassan(bot: BotAPI): Promise<void> {
    await bot.openDoor('alidoor');
    await bot.walkToWithPathfinding(JAIL_DOOR_X, JAIL_DOOR_Z);
    await bot.openDoor('poordooropen');
    await bot.waitForTicks(1);

    await walkToAlKharid(bot);

    await bot.openDoor('loc_1506');
    await bot.openDoor('loc_1508');
    await bot.waitForTicks(1);

    await bot.talkToNpc('Hassan');
    await bot.waitForDialog(30);
    await bot.continueDialog();

    await bot.waitForTicks(5);
    bot.dismissModals();

    const finalVarp = bot.getQuestProgress(PRINCEQUEST_VARP);
    if (finalVarp !== STAGE_COMPLETE) {
        throw new Error(`Quest not complete: varp is ${finalVarp}, expected ${STAGE_COMPLETE}`);
    }

    const finalCoins = bot.findItem('Coins');
    bot.log('SUCCESS', `Prince Ali Rescue quest complete! varp=${finalVarp}, coins=${finalCoins ? finalCoins.count : 0}`);
}

// ================================================================
// State machine builder
// ================================================================

export function buildPrinceAliRescueStates(bot: BotAPI): BotState {
    return {
        name: 'prince-ali-rescue',
        isComplete: () => bot.getQuestProgress(PRINCEQUEST_VARP) === STAGE_COMPLETE,
        run: async () => { throw new Error('Composite state should not be called directly'); },
        children: [
            {
                name: 'earn-coins',
                stuckThreshold: 3000,
                isComplete: () => {
                    const coins = bot.findItem('Coins');
                    return coins !== null && coins.count >= 150;
                },
                run: async () => {
                    await earnCoins(bot, 150);
                }
            },
            {
                name: 'start-quest',
                isComplete: () => bot.getQuestProgress(PRINCEQUEST_VARP) >= STAGE_STARTED,
                run: async () => {
                    await talkToHassan(bot);
                }
            },
            {
                name: 'speak-osman',
                isComplete: () => bot.getQuestProgress(PRINCEQUEST_VARP) >= STAGE_SPOKEN_OSMAN,
                run: async () => {
                    await talkToOsman(bot);
                }
            },
            {
                name: 'gather-and-prepare',
                isComplete: () => bot.getQuestProgress(PRINCEQUEST_VARP) >= STAGE_PREP_FINISHED,
                stuckThreshold: 5000,
                run: async () => {
                    await gatherMaterials(bot);
                }
            },
            {
                name: 'get-joe-drunk',
                isComplete: () => bot.getQuestProgress(PRINCEQUEST_VARP) >= STAGE_GUARD_DRUNK,
                run: async () => {
                    await getJoeDrunk(bot);
                }
            },
            {
                name: 'tie-up-keli',
                isComplete: () => bot.getQuestProgress(PRINCEQUEST_VARP) >= STAGE_TIED_KELI,
                run: async () => {
                    await tieUpKeli(bot);
                }
            },
            {
                name: 'rescue-prince',
                isComplete: () => bot.getQuestProgress(PRINCEQUEST_VARP) >= STAGE_SAVED,
                run: async () => {
                    await rescuePrince(bot);
                }
            },
            {
                name: 'return-to-hassan',
                isComplete: () => bot.getQuestProgress(PRINCEQUEST_VARP) === STAGE_COMPLETE,
                run: async () => {
                    await returnToHassan(bot);
                }
            }
        ]
    };
}

// ================================================================
// Main quest function
// ================================================================

export async function princeAliRescue(bot: BotAPI): Promise<void> {
    await skipTutorial(bot);
    await bot.waitForTicks(2);

    bot.log('STATE', `Starting Prince Ali Rescue quest at (${bot.player.x},${bot.player.z},${bot.player.level})`);

    const initialVarp = bot.getQuestProgress(PRINCEQUEST_VARP);
    if (initialVarp !== STAGE_NOT_STARTED) {
        throw new Error(`Quest varp is ${initialVarp}, expected ${STAGE_NOT_STARTED} (not started)`);
    }

    const root = buildPrinceAliRescueStates(bot);
    const snapshotDir = path.resolve(import.meta.dir, '..', 'test', 'snapshots');
    await runStateMachine(bot, { root, varpIds: [PRINCEQUEST_VARP, PRINCE_KEYSTATUS_VARP], captureSnapshots: true, snapshotDir });
}

export const metadata: ScriptMeta = {
    name: 'princeali',
    type: 'quest',
    varpId: PRINCEQUEST_VARP,
    varpComplete: STAGE_COMPLETE,
    maxTicks: 40000,
    run: princeAliRescue,
    buildStates: buildPrinceAliRescueStates,
};
