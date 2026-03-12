import path from 'path';
import NpcType from '../../src/cache/config/NpcType.js';
import type Npc from '../../src/engine/entity/Npc.js';
import { BotAPI } from '../runtime/api.js';
import { skipTutorial } from './skip-tutorial.js';
import { type BotState, runStateMachine } from '../runtime/state-machine.js';
import type { ScriptMeta } from '../runtime/script-meta.js';
// Combat verification uses XP gain checks — no external pathfinding imports needed

// Varp ID for Druidic Ritual quest progress (from content/pack/varp.pack: 80=druidquest)
export const DRUIDIC_RITUAL_VARP = 80;

// Quest stages (from content/scripts/quests/quest_druid/configs/quest_druid.constant
// and content/scripts/general/configs/quest.constant)
const STAGE_NOT_STARTED = 0;
const STAGE_STARTED = 1;
const STAGE_SPOKEN_SANFEW = 2;
const STAGE_GIVEN_INGREDIENTS = 3;
const STAGE_COMPLETE = 4;

// Hitpoints stat index
const _HITPOINTS_STAT = 3;

// ---- Key locations ----

// Fred the Farmer's chickens — OPEN area west of Lumbridge (no enclosed coop)
// Spawns at (3185-3191, 3277-3279) from map n49_51
const CHICKEN_AREA_X = 3188;
const CHICKEN_AREA_Z = 3278;

// Open area near cows south of Lumbridge cow field fence
// Cows spawn at (3254,3258), (3258,3260), (3261,3259)
// Walk BETWEEN spawns to avoid NPC collision blocking pathfinding
const _COW_FIELD_X = 3250;
const _COW_FIELD_Z = 3252;

// Giant rats west of Lumbridge (near HAM hideout area)
// Spawns at (3192,3207), (3194,3203), (3195,3207), (3197,3201) from map n49_50
const GIANT_RAT_AREA_X = 3195;
const GIANT_RAT_AREA_Z = 3205;

// Bears south of Varrock (east side, near Champions Guild)
const BEAR_AREA_X = 3290;
const BEAR_AREA_Z = 3350;

// Route waypoints from Lumbridge westward
const ROUTE_LUMBRIDGE_TO_DRAYNOR = { x: 3105, z: 3250 };
const ROUTE_DRAYNOR_TO_FALADOR_SOUTH = { x: 2965, z: 3380 };
const ROUTE_FALADOR_SOUTH_TO_NORTH = { x: 2945, z: 3400 };

// Taverley village area (Sanfew's house)
const SANFEW_HOUSE_X = 2899;
const SANFEW_HOUSE_Z = 3429;

// Stair inside Sanfew's house to go upstairs
// From ladders+stairs script: case 0_45_53_18_36 : p_telejump(1_45_53_18_35)
// World coords: x = 45*64+18 = 2898, z = 53*64+36 = 3428
const SANFEW_STAIRS_X = 2898;
const SANFEW_STAIRS_Z = 3428;

// Druid Circle north of Taverley (where Kaqemeex is)
const DRUID_CIRCLE_X = 2925;
const DRUID_CIRCLE_Z = 3484;

// Taverley dungeon entrance (ladder going underground, loc_1754)
// Approximately (2884, 3397) on surface
const DUNGEON_ENTRANCE_X = 2884;
const DUNGEON_ENTRANCE_Z = 3397;

// Underground offset
const UNDERGROUND_Z_OFFSET = 6400;

// Cauldron of Thunder approximate location in Taverley dungeon
// The cauldron room is behind the prison doors at roughly (2887, 9829-9832)
// The cauldron itself should be near (2893, 9831) based on dungeon layout
const _CAULDRON_SEARCH_X = 2893;
const _CAULDRON_SEARCH_Z = DUNGEON_ENTRANCE_Z + UNDERGROUND_Z_OFFSET;

/**
 * Walk adjacent to an NPC using walkToIgnoringNpcs, then attack it.
 * Returns the death position or null if the NPC couldn't be reached or combat failed.
 *
 * For size-2 NPCs grouped together (cows, giant rats), the engine's pathfinder
 * can't route through NPC collision. walkToIgnoringNpcs temporarily clears
 * NPC collision to path the bot adjacent, then interactNpc fires from melee range.
 */
async function walkAdjacentAndAttack(bot: BotAPI, npc: Npc, maxTicks: number = 200): Promise<{ x: number; z: number } | null> {
    const npcType = NpcType.get(npc.type);
    bot.log('ACTION', `walkAdjacentAndAttack: ${npcType.name} at (${npc.x},${npc.z})`);

    // Try multiple adjacent positions. The NPC's tile (and +1 for size-2) is blocked.
    // Try offsets: west, south, east, north of the NPC's SW corner.
    const offsets = [
        { dx: -1, dz: 0 },  // west
        { dx: 0, dz: -1 },  // south
        { dx: -1, dz: -1 }, // southwest
        { dx: 2, dz: 0 },   // east (past size-2 NPC width)
        { dx: 0, dz: 2 },   // north (past size-2 NPC height)
    ];

    let reachedAdjacent = false;
    for (const off of offsets) {
        const targetX = npc.x + off.dx;
        const targetZ = npc.z + off.dz;
        try {
            await bot.walkToIgnoringNpcs(targetX, targetZ);
            reachedAdjacent = true;
            break;
        } catch {
            // This adjacent position is blocked by terrain/walls, try next
            continue;
        }
    }

    if (!reachedAdjacent) {
        bot.log('STATE', `Could not walk adjacent to ${npcType.name} at (${npc.x},${npc.z})`);
        return null;
    }

    // Now adjacent — initiate combat. Engine pathfinder should trivially succeed.
    try {
        await bot.interactNpc(npc, 2); // op2 = Attack
    } catch {
        bot.log('STATE', `Failed to initiate attack on ${npcType.name}`);
        return null;
    }

    // IMPORTANT: Do NOT re-engage after the initial interactNpc.
    // The engine's player_melee_attack script ends with p_opnpc(2) which
    // self-sustains the combat loop.

    const _startExp = bot.getSkill('Attack').exp + bot.getSkill('Strength').exp + bot.getSkill('Defence').exp;
    let lastX = npc.x;
    let lastZ = npc.z;

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
    }

    bot.log('STATE', `Combat timed out after ${maxTicks} ticks`);
    return null;
}

/**
 * Pick up a ground item if it exists nearby.
 */
async function pickUpIfPresent(bot: BotAPI, itemName: string, _deathX: number, _deathZ: number): Promise<void> {
    await bot.waitForTicks(2);
    const ground = bot.findNearbyGroundItem(itemName, 5);
    if (ground) {
        try {
            await bot.takeGroundItem(itemName, ground.x, ground.z);
            await bot.waitForTicks(2);
            bot.log('EVENT', `Picked up ${itemName}`);
        } catch (err) {
            bot.log('STATE', `Failed to pick up ${itemName}: ${(err as Error).message}`);
        }
    }
}

/**
 * Kill chickens near Lumbridge to get raw chicken and train combat.
 * Returns when we have at least 1 raw_chicken and the specified minimum attack level.
 */
async function killChickensForMeatAndXP(bot: BotAPI, targetAttackLevel: number): Promise<void> {
    bot.log('STATE', `=== Killing chickens for raw chicken and training to attack ${targetAttackLevel} ===`);

    // Equip bronze pickaxe for combat
    if (bot.findItem('Bronze pickaxe')) {
        await bot.equipItem('Bronze pickaxe');
        await bot.waitForTicks(1);
    }

    await bot.walkToWithPathfinding(CHICKEN_AREA_X, CHICKEN_AREA_Z);

    // Set combat style to Accurate (0) for Attack XP
    bot.setCombatStyle(0);

    let hasRawChicken = bot.findItem('Raw chicken') !== null;
    let totalTicks = 0;
    const MAX_TICKS = 5000;

    while (totalTicks < MAX_TICKS) {
        const attackLevel = bot.getSkill('Attack').baseLevel;
        if (hasRawChicken && attackLevel >= targetAttackLevel) {
            bot.log('EVENT', `Done killing chickens: attack=${attackLevel}, hasRawChicken=${hasRawChicken}`);
            return;
        }

        bot.dismissModals();
        if (bot.player.delayed) {
            await bot.waitForCondition(() => !bot.player.delayed, 20);
        }

        // Check for death and respawn
        if (bot.isDead()) {
            await bot.waitForRespawn();
            await bot.walkToWithPathfinding(CHICKEN_AREA_X, CHICKEN_AREA_Z);
            totalTicks += 30;
            continue;
        }

        // Find a chicken
        let chicken = bot.findNearbyNpc('Chicken', 15);
        if (!chicken) {
            await bot.walkToWithPathfinding(CHICKEN_AREA_X, CHICKEN_AREA_Z);
            await bot.waitForTicks(5);
            totalTicks += 10;
            chicken = bot.findNearbyNpc('Chicken', 15);
            if (!chicken) {
                await bot.waitForTicks(10);
                totalTicks += 10;
                continue;
            }
        }

        const deathPos = await walkAdjacentAndAttack(bot, chicken);
        if (deathPos) {
            bot.dismissModals();

            // Pick up raw chicken if we don't have one yet
            if (!hasRawChicken) {
                await pickUpIfPresent(bot, 'Raw chicken', deathPos.x, deathPos.z);
                hasRawChicken = bot.findItem('Raw chicken') !== null;
            }

            totalTicks += 30;
        } else {
            totalTicks += 20;
        }

        if (totalTicks % 200 === 0) {
            const atk = bot.getSkill('Attack').baseLevel;
            bot.log('STATE', `Training chickens: attack=${atk}/${targetAttackLevel} rawChicken=${hasRawChicken} ticks=${totalTicks}`);
        }
    }

    throw new Error(`Failed to finish chicken training after ${MAX_TICKS} ticks`);
}

/**
 * Kill a cow to get raw beef.
 * Uses cows in the cow field INSIDE the fence (map n50_51, z >= 3270).
 * The gate at (3253, 3266) lets us in. Inside the field, cows are spread out
 * enough that the engine's pathfinder can usually reach at least one.
 */
async function killCowForBeef(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Killing cow for raw beef ===');

    // Walk to the cow field gate and enter. The gate auto-opens via walkToWithPathfinding.
    // Target (3253, 3268) is just inside the gate at (3253, 3266-3267).
    await bot.walkToWithPathfinding(3253, 3268);
    // Now inside the field — walk deeper, ignoring cow NPC collision
    const COW_FIELD_INSIDE_X = 3250;
    const COW_FIELD_INSIDE_Z = 3285;
    await bot.walkToIgnoringNpcs(COW_FIELD_INSIDE_X, COW_FIELD_INSIDE_Z);

    // Set combat style to Aggressive (1) for Strength XP
    bot.setCombatStyle(1);

    let attempts = 0;
    const MAX_ATTEMPTS = 40;

    while (bot.findItem('Raw beef') === null && attempts < MAX_ATTEMPTS) {
        bot.dismissModals();
        if (bot.player.delayed) {
            await bot.waitForCondition(() => !bot.player.delayed, 20);
        }

        if (bot.isDead()) {
            await bot.waitForRespawn();
            await bot.walkToWithPathfinding(3253, 3268);
            await bot.walkToIgnoringNpcs(COW_FIELD_INSIDE_X, COW_FIELD_INSIDE_Z);
            continue;
        }

        const cow = bot.findNearbyNpc('Cow', 15);
        if (!cow) {
            bot.log('STATE', 'No cows found nearby, repositioning...');
            await bot.walkToIgnoringNpcs(COW_FIELD_INSIDE_X, COW_FIELD_INSIDE_Z);
            await bot.waitForTicks(10);
            attempts++;
            continue;
        }

        bot.log('STATE', `Attacking cow at (${cow.x},${cow.z}), bot at (${bot.player.x},${bot.player.z})`);

        try {
            await bot.interactNpc(cow, 2); // op2 = Attack
        } catch {
            bot.log('STATE', 'Failed to initiate cow attack');
            attempts++;
            continue;
        }

        // Wait for cow to die. Do NOT re-engage (p_opnpc(2) self-sustains).
        let cowDied = false;
        let lastX = cow.x;
        let lastZ = cow.z;

        for (let tick = 0; tick < 120; tick++) {
            await bot.waitForTick();

            if (cow.isActive) {
                lastX = cow.x;
                lastZ = cow.z;
            }

            if (!cow.isActive) {
                cowDied = true;
                break;
            }
        }

        if (cowDied) {
            bot.log('EVENT', `Cow killed at (${lastX},${lastZ})`);
            bot.dismissModals();
            await pickUpIfPresent(bot, 'Raw beef', lastX, lastZ);
        } else {
            bot.log('STATE', 'Cow combat timed out, retrying...');
        }
        attempts++;
    }

    if (bot.findItem('Raw beef') === null) {
        throw new Error('Failed to obtain Raw beef from cows');
    }
    bot.log('EVENT', 'Got Raw beef');

    // Exit the cow field — walk to the gate (ignoring cow collision) and out
    await bot.walkToIgnoringNpcs(3253, 3268);
    await bot.walkToWithPathfinding(3253, 3264); // south of fence
}

/**
 * Kill a giant rat for raw rat meat.
 * Giant rats spawn in Lumbridge Swamp and other areas.
 */
async function killGiantRatForMeat(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Killing giant rat for raw rat meat ===');

    // Navigate via Lumbridge road to avoid swamp terrain obstacles
    await bot.walkToWithPathfinding(3200, 3218); // West along Lumbridge road
    await bot.walkToWithPathfinding(GIANT_RAT_AREA_X, GIANT_RAT_AREA_Z);

    let attempts = 0;
    const MAX_ATTEMPTS = 50;

    while (bot.findItem('Raw rat meat') === null && attempts < MAX_ATTEMPTS) {
        bot.dismissModals();
        if (bot.player.delayed) {
            await bot.waitForCondition(() => !bot.player.delayed, 20);
        }

        if (bot.isDead()) {
            await bot.waitForRespawn();
            await bot.walkToWithPathfinding(GIANT_RAT_AREA_X, GIANT_RAT_AREA_Z);
            continue;
        }

        const rat = bot.findNearbyNpc('Giant rat', 20);
        if (!rat) {
            await bot.walkToWithPathfinding(GIANT_RAT_AREA_X, GIANT_RAT_AREA_Z);
            await bot.waitForTicks(10);
            attempts++;
            continue;
        }

        const deathPos = await walkAdjacentAndAttack(bot, rat);
        if (deathPos) {
            bot.dismissModals();
            await pickUpIfPresent(bot, 'Raw rat meat', deathPos.x, deathPos.z);
        }
        attempts++;
    }

    if (bot.findItem('Raw rat meat') === null) {
        throw new Error('Failed to obtain Raw rat meat from giant rats');
    }
    bot.log('EVENT', 'Got Raw rat meat');
}

/**
 * Kill a bear for raw bear meat. Bears are level 21 so the bot needs
 * some combat training first. Bears spawn south of Varrock.
 */
async function killBearForMeat(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Killing bear for raw bear meat ===');

    // Route to bear area south of Varrock via Lumbridge road.
    // Need to clear any fenced areas first.
    await bot.walkToWithPathfinding(3222, 3218); // Lumbridge center
    await bot.walkToWithPathfinding(3260, 3230); // East road, south of fence line
    await bot.walkToWithPathfinding(BEAR_AREA_X, BEAR_AREA_Z);

    // Set to Aggressive for strength XP while killing bear
    bot.setCombatStyle(1);

    let attempts = 0;
    const MAX_ATTEMPTS = 50;

    while (bot.findItem('Raw bear meat') === null && attempts < MAX_ATTEMPTS) {
        bot.dismissModals();
        if (bot.player.delayed) {
            await bot.waitForCondition(() => !bot.player.delayed, 20);
        }

        if (bot.isDead()) {
            await bot.waitForRespawn();
            // Respawn in Lumbridge, walk back via road
            await bot.walkToWithPathfinding(3260, 3230);
            await bot.walkToWithPathfinding(BEAR_AREA_X, BEAR_AREA_Z);
            continue;
        }

        const bear = bot.findNearbyNpc('Bear', 20);
        if (!bear) {
            await bot.walkToWithPathfinding(BEAR_AREA_X, BEAR_AREA_Z);
            await bot.waitForTicks(10);
            attempts++;
            continue;
        }

        const deathPos = await walkAdjacentAndAttack(bot, bear, 400);
        if (deathPos) {
            bot.dismissModals();
            await pickUpIfPresent(bot, 'Raw bear meat', deathPos.x, deathPos.z);
        }
        attempts++;
    }

    if (bot.findItem('Raw bear meat') === null) {
        throw new Error('Failed to obtain Raw bear meat from bears');
    }
    bot.log('EVENT', 'Got Raw bear meat');
}

/**
 * Walk from Lumbridge area to Taverley (west of Falador).
 */
async function _walkToTaverley(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Walking to Taverley ===');
    await bot.walkToWithPathfinding(ROUTE_LUMBRIDGE_TO_DRAYNOR.x, ROUTE_LUMBRIDGE_TO_DRAYNOR.z);
    await bot.walkToWithPathfinding(ROUTE_DRAYNOR_TO_FALADOR_SOUTH.x, ROUTE_DRAYNOR_TO_FALADOR_SOUTH.z);
    await bot.walkToWithPathfinding(ROUTE_FALADOR_SOUTH_TO_NORTH.x, ROUTE_FALADOR_SOUTH_TO_NORTH.z);
    await bot.walkToWithPathfinding(DRUID_CIRCLE_X, DRUID_CIRCLE_Z);
    bot.log('STATE', `At Druid Circle: pos=(${bot.player.x},${bot.player.z})`);
}

/**
 * Walk from the bear area to Taverley.
 * Bears are south of Varrock; route west through Barbarian Village to Taverley.
 */
async function walkFromBearAreaToTaverley(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Walking from bear area to Taverley ===');
    // Go west from Varrock area toward Barbarian Village
    await bot.walkToWithPathfinding(3082, 3420); // Barbarian Village
    await bot.walkToWithPathfinding(2945, 3400); // North of Falador
    await bot.walkToWithPathfinding(DRUID_CIRCLE_X, DRUID_CIRCLE_Z);
    bot.log('STATE', `At Druid Circle: pos=(${bot.player.x},${bot.player.z})`);
}

/**
 * Talk to Kaqemeex to start the quest.
 * He's at the Druid Circle north of Taverley.
 */
async function talkToKaqemeexStart(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Talking to Kaqemeex to start quest ===');

    // Walk to the druid circle
    await bot.walkToWithPathfinding(DRUID_CIRCLE_X, DRUID_CIRCLE_Z);

    await bot.talkToNpc('Kaqemeex');

    // Dialog: chatplayer "Hello there."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "What brings you to our holy monument?"
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // Multi3: "Who are you?" (1), "I'm in search of a quest." (2), "Did you build this?" (3)
    await bot.waitForDialog(10);
    await bot.selectDialogOption(2); // "I'm in search of a quest."

    // chatplayer "I'm in search of a quest."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Hmm. I think I may have a worthwhile quest for you actually..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // @kaqemeex_our_circle
    // chatnpc "That used to be OUR stone circle..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "When they cursed the rocks for their rituals..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // Multi3: "Ok, I will try and help." (1), "No, that doesn't sound..." (2), "So... is there anything in this for me?" (3)
    await bot.waitForDialog(10);
    await bot.selectDialogOption(1); // "Ok, I will try and help."

    // chatplayer "Ok, I will try to help." -> varp set to 1
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Excellent. Go to the village south of this place..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatplayer "Will do."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // Drain any remaining dialog
    await bot.continueRemainingDialogs();
    await bot.waitForTicks(2);

    const varp = bot.getQuestProgress(DRUIDIC_RITUAL_VARP);
    if (varp !== STAGE_STARTED) {
        throw new Error(`Quest varp after starting is ${varp}, expected ${STAGE_STARTED}`);
    }
    bot.log('EVENT', `Quest started! varp=${varp}`);
}

/**
 * Talk to Sanfew upstairs in Taverley village.
 * Sanfew is on level 1 of his house.
 */
async function talkToSanfew(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Talking to Sanfew ===');

    // Walk to Sanfew's house
    await bot.walkToWithPathfinding(SANFEW_HOUSE_X, SANFEW_HOUSE_Z);

    // Climb stairs to level 1 (using loc_1738 or loc_1739 stairs)
    // The stairs at Sanfew's house: coord 0_45_53_18_36 -> world (2898, 3428)
    if ((bot.player.level as number) === 0) {
        bot.log('STATE', `Near Sanfew stairs: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
        await bot.climbStairs('loc_1738', 1);
        await bot.waitForTicks(3);

        if ((bot.player.level as number) !== 1) {
            // Try finding stairs by display name
            const allLocs = bot.findAllNearbyLocs(10);
            for (const locInfo of allLocs) {
                bot.log('STATE', `  Nearby loc: ${locInfo.debugname} "${locInfo.displayName}" at (${locInfo.x},${locInfo.z})`);
            }
            throw new Error(`Failed to climb to level 1: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
        }
    }

    bot.log('STATE', `On level 1: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Find and talk to Sanfew
    await bot.talkToNpc('Sanfew');

    // At stage STARTED, Sanfew says: "What can I do for you young 'un?"
    // then multi2: "I've been sent to help purify the Varrock stone circle." (1), "Actually I don't need to speak to you." (2)
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // Multi2
    await bot.waitForDialog(10);
    await bot.selectDialogOption(1); // "I've been sent to help purify the Varrock stone circle."

    // chatplayer "I've been sent to assist you with the ritual..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Well, what I'm struggling with right now is the meats..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Each meat has to be dipped individually into the Cauldron of Thunder..."
    // varp set to 2 (STAGE_SPOKEN_SANFEW)
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // Multi2: "Where can I find this cauldron?" (1), "Ok, I'll do that then." (2)
    await bot.waitForDialog(10);
    await bot.selectDialogOption(2); // "Ok, I'll do that then."

    // chatplayer "Ok, I'll do that then."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Well thank you very much!"
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // Drain any remaining dialog
    await bot.continueRemainingDialogs();
    await bot.waitForTicks(2);

    const varp = bot.getQuestProgress(DRUIDIC_RITUAL_VARP);
    if (varp !== STAGE_SPOKEN_SANFEW) {
        throw new Error(`Quest varp after Sanfew is ${varp}, expected ${STAGE_SPOKEN_SANFEW}`);
    }
    bot.log('EVENT', `Spoken to Sanfew! varp=${varp}`);

    // Climb back down to level 0
    await goDownFromSanfew(bot);
}

/**
 * Climb down from Sanfew's house (level 1 -> level 0).
 */
async function goDownFromSanfew(bot: BotAPI): Promise<void> {
    if ((bot.player.level as number) !== 1) return;

    // Walk to stairwell area on level 1
    await bot.walkToWithPathfinding(SANFEW_STAIRS_X, SANFEW_STAIRS_Z);

    // loc_1739 is mid-level stairs with op2=Climb-up, op3=Climb-down
    await bot.climbStairs('loc_1739', 3); // op3 = Climb-down
    await bot.waitForTicks(3);

    if ((bot.player.level as number) !== 0) {
        throw new Error(`Failed to climb down to level 0: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    bot.log('STATE', `Back on ground floor: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
}

/**
 * Enter Taverley dungeon and enchant all 4 raw meats at the Cauldron of Thunder.
 * The dungeon entrance is a ladder (loc_1754) south of Taverley.
 */
async function enchantMeatsAtCauldron(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Entering Taverley dungeon to enchant meats ===');

    // Walk to dungeon entrance
    await bot.walkToWithPathfinding(DUNGEON_ENTRANCE_X, DUNGEON_ENTRANCE_Z);
    bot.log('STATE', `At dungeon entrance: pos=(${bot.player.x},${bot.player.z})`);

    // Climb down the ladder (loc_1754, op1=Climb-down, z+6400)
    await bot.climbStairs('loc_1754', 1);
    await bot.waitForTicks(3);

    // Verify we're underground
    if (bot.player.z < UNDERGROUND_Z_OFFSET) {
        throw new Error(`Failed to enter dungeon: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    bot.log('STATE', `In dungeon: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Navigate toward the Cauldron of Thunder.
    // The cauldron is in a room accessible shortly after the entrance.
    // We need to navigate through the dungeon to find it.
    // The dungeon entrance drops us at approx (DUNGEON_ENTRANCE_X, DUNGEON_ENTRANCE_Z + 6400).
    // The cauldron room has prison doors that need to be opened (cauldrondoor).

    // Walk south-east in the dungeon toward the cauldron area
    // The prison doors are at approx (2887, 9829) based on the script coords
    const prisonDoorX = 2887;
    const prisonDoorZ = 9829;

    await bot.walkToWithPathfinding(prisonDoorX, prisonDoorZ);
    bot.log('STATE', `Near prison doors: pos=(${bot.player.x},${bot.player.z})`);

    // Open the prison door (cauldrondoor) to access the cauldron room
    // These are double doors - try to open the right-side one first
    let door = bot.findNearbyLoc('cauldrondoor', 10);
    if (!door) {
        door = bot.findNearbyLoc('cauldrondoor_l', 10);
    }
    if (door) {
        bot.log('STATE', `Opening prison door at (${door.x},${door.z})`);
        await bot.interactLoc(door, 1);
        await bot.waitForTicks(3);
    } else {
        bot.log('STATE', 'Prison door not found - may already be open');
    }

    // Walk through the door into the cauldron room
    // The cauldron should be south of the prison doors
    await bot.walkToWithPathfinding(prisonDoorX + 2, prisonDoorZ + 2);
    await bot.waitForTicks(1);

    // Find the cauldron
    let cauldron = bot.findNearbyLoc('cauldron_of_thunder', 20);
    if (!cauldron) {
        // Search more broadly
        bot.log('STATE', 'Cauldron not found nearby, searching broader area...');
        const allLocs = bot.findAllNearbyLocs(30);
        for (const locInfo of allLocs) {
            if (locInfo.debugname.includes('cauldron') || locInfo.displayName.includes('Cauldron')) {
                bot.log('STATE', `Found cauldron-like loc: ${locInfo.debugname} "${locInfo.displayName}" at (${locInfo.x},${locInfo.z})`);
                cauldron = locInfo.loc;
                break;
            }
        }
    }

    if (!cauldron) {
        // Log all nearby locs for debugging
        const allLocs = bot.findAllNearbyLocs(30);
        for (const locInfo of allLocs) {
            bot.log('STATE', `  Nearby loc: ${locInfo.debugname} "${locInfo.displayName}" at (${locInfo.x},${locInfo.z})`);
        }
        throw new Error(`Cauldron of Thunder not found near (${bot.player.x},${bot.player.z})`);
    }

    bot.log('STATE', `Found Cauldron of Thunder at (${cauldron.x},${cauldron.z})`);

    // Enchant each raw meat by using it on the cauldron (oplocu trigger)
    const meatsToEnchant: Array<{ rawName: string; enchantedName: string }> = [
        { rawName: 'Raw rat meat', enchantedName: 'Enchanted rat' },
        { rawName: 'Raw beef', enchantedName: 'Enchanted beef' },
        { rawName: 'Raw bear meat', enchantedName: 'Enchanted bear' },
        { rawName: 'Raw chicken', enchantedName: 'Enchanted chicken' }
    ];

    for (const meat of meatsToEnchant) {
        const rawItem = bot.findItem(meat.rawName);
        if (!rawItem) {
            throw new Error(`${meat.rawName} not found in inventory before enchanting`);
        }

        bot.log('ACTION', `Enchanting ${meat.rawName}...`);
        await bot.useItemOnLoc(meat.rawName, 'cauldron_of_thunder');
        await bot.waitForTicks(3);

        const enchantedItem = bot.findItem(meat.enchantedName);
        if (!enchantedItem) {
            throw new Error(`${meat.enchantedName} not found in inventory after using ${meat.rawName} on cauldron`);
        }
        bot.log('EVENT', `Enchanted: ${meat.rawName} -> ${meat.enchantedName}`);
    }

    bot.log('EVENT', 'All meats enchanted!');

    // Exit the dungeon - climb back up the ladder
    bot.log('STATE', 'Exiting dungeon...');

    // Walk back to the entrance ladder area
    const entranceUndergroundZ = DUNGEON_ENTRANCE_Z + UNDERGROUND_Z_OFFSET;
    await bot.walkToWithPathfinding(DUNGEON_ENTRANCE_X, entranceUndergroundZ);

    // Find and climb the exit ladder (loc_1755, Climb-up)
    let exitLadder = bot.findNearbyLoc('loc_1755', 30);
    if (!exitLadder) {
        exitLadder = bot.findNearbyLoc('loc_1757', 30);
    }
    if (!exitLadder) {
        // Search by display name
        const allLocs = bot.findAllNearbyLocs(30);
        for (const locInfo of allLocs) {
            if (locInfo.displayName === 'Ladder') {
                bot.log('STATE', `Found ladder: ${locInfo.debugname} at (${locInfo.x},${locInfo.z})`);
                exitLadder = locInfo.loc;
                break;
            }
        }
    }

    if (!exitLadder) {
        throw new Error(`No exit ladder found at (${bot.player.x},${bot.player.z})`);
    }

    await bot.interactLoc(exitLadder, 1);
    await bot.waitForTicks(5);

    if (bot.player.z > UNDERGROUND_Z_OFFSET) {
        throw new Error(`Still underground after climbing ladder: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }

    bot.log('STATE', `Exited dungeon: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
}

/**
 * Return to Sanfew with the enchanted meats.
 */
async function returnToSanfewWithMeats(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Returning to Sanfew with enchanted meats ===');

    // Walk to Sanfew's house
    await bot.walkToWithPathfinding(SANFEW_HOUSE_X, SANFEW_HOUSE_Z);

    // Climb upstairs
    if ((bot.player.level as number) === 0) {
        await bot.climbStairs('loc_1738', 1);
        await bot.waitForTicks(3);

        if ((bot.player.level as number) !== 1) {
            throw new Error(`Failed to climb to level 1: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
        }
    }

    // Talk to Sanfew
    await bot.talkToNpc('Sanfew');

    // At stage SPOKEN_SANFEW with all enchanted meats:
    // chatnpc "Did you bring me the required ingredients for the potion?"
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatplayer "Yes, I have all four now!"
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Well hand 'em over then lad/lass!"
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Thank you so much adventurer!..."
    // Items removed, varp set to 3 (GIVEN_INGREDIENTS)
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Now go and talk to Kaqemeex..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // Drain remaining dialog
    await bot.continueRemainingDialogs();
    await bot.waitForTicks(2);

    const varp = bot.getQuestProgress(DRUIDIC_RITUAL_VARP);
    if (varp !== STAGE_GIVEN_INGREDIENTS) {
        throw new Error(`Quest varp after giving meats is ${varp}, expected ${STAGE_GIVEN_INGREDIENTS}`);
    }
    bot.log('EVENT', `Gave enchanted meats to Sanfew! varp=${varp}`);

    // Climb back down
    await goDownFromSanfew(bot);
}

/**
 * Return to Kaqemeex to complete the quest.
 */
async function returnToKaqemeexComplete(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Returning to Kaqemeex to complete quest ===');

    await bot.walkToWithPathfinding(DRUID_CIRCLE_X, DRUID_CIRCLE_Z);

    await bot.talkToNpc('Kaqemeex');

    // chatplayer "Hello there."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // At stage GIVEN_INGREDIENTS:
    // chatnpc "I have word from Sanfew that you have been very helpful..."
    // queue*(druid_quest_complete) fires, setting varp to 4
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // Quest complete dialog / reward scroll
    // Wait for the queue to fire and process
    await bot.waitForTicks(5);

    // Dismiss quest complete interface
    bot.dismissModals();

    // The druid_fundamentals label fires next with herblore tutorial dialog
    // chatnpc "I will now explain the fundamentals of Herblore:"
    // Then a long series of chatnpc dialogs about herblore basics
    for (let i = 0; i < 20; i++) {
        const hasDialog = await bot.waitForDialog(5);
        if (!hasDialog) break;

        if (bot.isMultiChoiceOpen()) {
            // Shouldn't happen in completion, but handle gracefully
            break;
        }
        await bot.continueDialog();
    }

    // Final chatplayer "Thanks for your help."
    await bot.continueRemainingDialogs();
    await bot.waitForTicks(3);
    bot.dismissModals();

    const varp = bot.getQuestProgress(DRUIDIC_RITUAL_VARP);
    if (varp !== STAGE_COMPLETE) {
        throw new Error(`Quest varp after completion is ${varp}, expected ${STAGE_COMPLETE}`);
    }
    bot.log('EVENT', `Quest complete! varp=${varp}`);
}

/**
 * Build the Druidic Ritual state machine.
 */
export function buildDruidicRitualStates(bot: BotAPI): BotState {
    return {
        name: 'druidic-ritual',
        isComplete: () => bot.getQuestProgress(DRUIDIC_RITUAL_VARP) === STAGE_COMPLETE,
        run: async () => { throw new Error('Composite state should not be called directly'); },
        children: [
            {
                name: 'train-combat',
                isComplete: () => {
                    const atk = bot.getSkill('Attack').baseLevel;
                    return (atk as number) >= 8 && bot.findItem('Raw chicken') !== null;
                },
                maxRetries: 5,
                run: async () => {
                    bot.enableRun(true);
                    await killChickensForMeatAndXP(bot, 8);
                }
            },
            {
                name: 'collect-raw-beef',
                isComplete: () => bot.findItem('Raw beef') !== null || bot.findItem('Enchanted beef') !== null,
                maxRetries: 5,
                run: async () => {
                    await killCowForBeef(bot);
                }
            },
            {
                name: 'collect-raw-rat-meat',
                isComplete: () => bot.findItem('Raw rat meat') !== null || bot.findItem('Enchanted rat') !== null,
                maxRetries: 5,
                run: async () => {
                    await killGiantRatForMeat(bot);
                }
            },
            {
                name: 'collect-raw-bear-meat',
                isComplete: () => bot.findItem('Raw bear meat') !== null || bot.findItem('Enchanted bear') !== null,
                maxRetries: 5,
                run: async () => {
                    await killBearForMeat(bot);
                }
            },
            {
                name: 'start-quest',
                isComplete: () => bot.getQuestProgress(DRUIDIC_RITUAL_VARP) >= STAGE_STARTED,
                run: async () => {
                    await walkFromBearAreaToTaverley(bot);
                    await talkToKaqemeexStart(bot);
                }
            },
            {
                name: 'talk-to-sanfew',
                isComplete: () => bot.getQuestProgress(DRUIDIC_RITUAL_VARP) >= STAGE_SPOKEN_SANFEW,
                run: async () => {
                    await talkToSanfew(bot);
                }
            },
            {
                name: 'enchant-meats',
                isComplete: () => {
                    return bot.findItem('Enchanted rat') !== null &&
                           bot.findItem('Enchanted beef') !== null &&
                           bot.findItem('Enchanted bear') !== null &&
                           bot.findItem('Enchanted chicken') !== null;
                },
                run: async () => {
                    await enchantMeatsAtCauldron(bot);
                }
            },
            {
                name: 'deliver-meats',
                isComplete: () => bot.getQuestProgress(DRUIDIC_RITUAL_VARP) >= STAGE_GIVEN_INGREDIENTS,
                run: async () => {
                    await returnToSanfewWithMeats(bot);
                }
            },
            {
                name: 'complete-quest',
                isComplete: () => bot.getQuestProgress(DRUIDIC_RITUAL_VARP) === STAGE_COMPLETE,
                run: async () => {
                    await returnToKaqemeexComplete(bot);

                    const finalVarp = bot.getQuestProgress(DRUIDIC_RITUAL_VARP);
                    const herblore = bot.getSkill('Herblore');

                    if (finalVarp !== STAGE_COMPLETE) {
                        throw new Error(`Quest not complete: varp is ${finalVarp}, expected ${STAGE_COMPLETE}`);
                    }
                    if (herblore.exp <= 0) {
                        throw new Error('No Herblore XP gained during quest');
                    }

                    bot.log('SUCCESS', `Druidic Ritual quest complete! varp=${finalVarp}, herblore_xp=${herblore.exp}`);
                }
            }
        ]
    };
}

export async function druidicRitual(bot: BotAPI): Promise<void> {
    // === Setup: skip tutorial, start in Lumbridge ===
    await skipTutorial(bot);
    await bot.waitForTicks(2);

    bot.log('STATE', `Starting Druidic Ritual at (${bot.player.x},${bot.player.z},${bot.player.level})`);

    const initialVarp = bot.getQuestProgress(DRUIDIC_RITUAL_VARP);
    if (initialVarp !== STAGE_NOT_STARTED) {
        throw new Error(`Quest varp is ${initialVarp}, expected ${STAGE_NOT_STARTED} (not started)`);
    }

    const root = buildDruidicRitualStates(bot);
    const snapshotDir = path.resolve(import.meta.dir, '..', 'test', 'snapshots');
    await runStateMachine(bot, { root, varpIds: [DRUIDIC_RITUAL_VARP], captureSnapshots: true, snapshotDir });
}

export const metadata: ScriptMeta = {
    name: 'druidicroitual',
    type: 'quest',
    varpId: DRUIDIC_RITUAL_VARP,
    varpComplete: STAGE_COMPLETE,
    maxTicks: 40000,
    run: druidicRitual,
    buildStates: buildDruidicRitualStates,
};
