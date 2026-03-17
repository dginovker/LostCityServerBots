import NpcType from '../../../src/cache/config/NpcType.js';
import type Npc from '../../../src/engine/entity/Npc.js';
import { BotAPI } from '../../runtime/api.js';
import { skipTutorial } from '../skip-tutorial.js';
import { type BotState, runStateMachine } from '../../runtime/state-machine.js';
import type { ScriptMeta } from '../../runtime/script-meta.js';
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

// Bears southwest of Lumbridge (map m49_50)
// Spawn at (3176,3223) and (3159,3233) — much closer than Varrock
const BEAR_AREA_X = 3176;
const BEAR_AREA_Z = 3223;

// Route waypoints from Lumbridge westward
const ROUTE_LUMBRIDGE_TO_DRAYNOR = { x: 3105, z: 3250 };
const ROUTE_DRAYNOR_TO_FALADOR_SOUTH = { x: 2965, z: 3370 };
// Enter Falador via south gate, then go through town to north exit
const ROUTE_FALADOR_SOUTH_GATE = { x: 2965, z: 3394 };
const ROUTE_FALADOR_SOUTH_TO_NORTH = { x: 2945, z: 3400 };
const ROUTE_FALADOR_PARK = { x: 2960, z: 3430 };
// Waypoint through Taverley village, west of castle walls, toward the druid circle
const ROUTE_TAVERLEY_VILLAGE = { x: 2920, z: 3440 };

// Taverley village area (Sanfew's house)
// Target the east door entrance at (2901,3428) rather than the house interior (2899,3429)
// which may be blocked by walls the pathfinder can't traverse.
const SANFEW_HOUSE_X = 2901;
const SANFEW_HOUSE_Z = 3428;

// Druid Circle north of Taverley (where Kaqemeex is)
// Kaqemeex spawns at (2925,3486). Target a walkable tile outside the henge stones
// rather than the center which is blocked by the guthix_altar at (2925,3483).
const DRUID_CIRCLE_X = 2928;
const DRUID_CIRCLE_Z = 3484;

// Taverley dungeon entrance (ladder going underground, loc_1759 with op1=Climb-Down)
// The ladder is at (2884, 3397). Target one tile north to approach without wall issues.
const DUNGEON_ENTRANCE_X = 2884;
const DUNGEON_ENTRANCE_Z = 3398;

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

        // Detect bot death — bail immediately instead of spinning for the full timeout
        if (bot.isDead()) {
            bot.log('STATE', `Bot died fighting ${npcType.name} at tick ${tick}`);
            return null;
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
 * Trains attack first for accuracy, then strength for damage.
 * Both stats are needed to fight bears (level 21).
 */
async function killChickensForMeatAndXP(bot: BotAPI, targetAttackLevel: number, targetStrengthLevel: number): Promise<void> {
    bot.log('STATE', `=== Killing chickens for raw chicken and training to attack ${targetAttackLevel}, strength ${targetStrengthLevel} ===`);

    // Equip bronze pickaxe for combat
    if (bot.findItem('Bronze pickaxe')) {
        await bot.equipItem('Bronze pickaxe');
        await bot.waitForTicks(1);
    }

    await bot.walkToWithPathfinding(CHICKEN_AREA_X, CHICKEN_AREA_Z);

    // Start with Accurate (0) for Attack XP
    bot.setCombatStyle(0);

    let hasRawChicken = bot.findItem('Raw chicken') !== null;
    let totalTicks = 0;
    const MAX_TICKS = 15000;

    while (totalTicks < MAX_TICKS) {
        const attackLevel = bot.getSkill('Attack').baseLevel;
        const strengthLevel = bot.getSkill('Strength').baseLevel;

        // Switch to Aggressive (1) once attack target is reached
        if (attackLevel >= targetAttackLevel && strengthLevel < targetStrengthLevel) {
            bot.setCombatStyle(1);
        }

        if (hasRawChicken && attackLevel >= targetAttackLevel && strengthLevel >= targetStrengthLevel) {
            bot.log('EVENT', `Done killing chickens: attack=${attackLevel}, strength=${strengthLevel}, hasRawChicken=${hasRawChicken}`);
            return;
        }

        await bot.clearPendingState();

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
            const str = bot.getSkill('Strength').baseLevel;
            bot.log('STATE', `Training chickens: attack=${atk}/${targetAttackLevel} strength=${str}/${targetStrengthLevel} rawChicken=${hasRawChicken} ticks=${totalTicks}`);
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
        await bot.clearPendingState();

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
        await bot.clearPendingState();

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
 * some combat training first. Bears spawn southwest of Lumbridge.
 *
 * Uses attackNpcClearingCollision from the API which properly detects
 * bot death and handles NPC collision clearing for size-2 NPCs.
 */
async function killBearForMeat(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Killing bear for raw bear meat ===');

    // Equip bronze pickaxe for combat
    if (bot.findItem('Bronze pickaxe')) {
        await bot.equipItem('Bronze pickaxe');
        await bot.waitForTicks(1);
    }

    // Set to Aggressive for strength XP while killing bear
    bot.setCombatStyle(1);

    // Walk to bear area southwest of Lumbridge
    await bot.walkToWithPathfinding(BEAR_AREA_X, BEAR_AREA_Z);

    let attempts = 0;
    const MAX_ATTEMPTS = 50; // Bears are tough (level 21) — bot may die several times

    while (bot.findItem('Raw bear meat') === null && attempts < MAX_ATTEMPTS) {
        await bot.clearPendingState();

        // Check for death — respawn and walk back
        if (bot.isDead()) {
            bot.log('STATE', 'Bot died fighting bear, recovering...');
            await bot.waitForRespawn();
            bot.enableRun(true);
            if (bot.findItem('Bronze pickaxe')) {
                await bot.equipItem('Bronze pickaxe');
                await bot.waitForTicks(1);
            }
            bot.setCombatStyle(1);
            await bot.walkToWithPathfinding(BEAR_AREA_X, BEAR_AREA_Z);
            attempts++;
            continue;
        }

        // Find a bear — search both spawn points
        let bear = bot.findNearbyNpc('Bear', 20);
        if (!bear) {
            // Try the other spawn point at (3159,3233)
            await bot.walkToWithPathfinding(3159, 3233);
            await bot.waitForTicks(5);
            bear = bot.findNearbyNpc('Bear', 20);
        }
        if (!bear) {
            // Walk back to primary spawn and wait for respawn
            await bot.walkToWithPathfinding(BEAR_AREA_X, BEAR_AREA_Z);
            await bot.waitForTicks(15);
            attempts++;
            continue;
        }

        bot.log('STATE', `Attacking bear at (${bear.x},${bear.z}), bot at (${bot.player.x},${bot.player.z})`);

        // Use attackNpcClearingCollision which handles death detection and
        // NPC collision clearing for size-2 NPCs
        const deathPos = await bot.attackNpcClearingCollision(bear, 300);
        if (deathPos) {
            bot.dismissModals();
            await pickUpIfPresent(bot, 'Raw bear meat', deathPos.x, deathPos.z);
        } else {
            // Combat failed (bot died, timed out, or couldn't engage)
            bot.dismissModals();
            if (bot.isDead()) {
                bot.log('STATE', 'Bot died fighting bear, recovering...');
                await bot.waitForRespawn();
                bot.enableRun(true);
                if (bot.findItem('Bronze pickaxe')) {
                    await bot.equipItem('Bronze pickaxe');
                    await bot.waitForTicks(1);
                }
                bot.setCombatStyle(1);
                await bot.walkToWithPathfinding(BEAR_AREA_X, BEAR_AREA_Z);
            }
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
    await bot.walkToWithPathfinding(ROUTE_FALADOR_SOUTH_GATE.x, ROUTE_FALADOR_SOUTH_GATE.z);
    await bot.walkToWithPathfinding(ROUTE_FALADOR_SOUTH_TO_NORTH.x, ROUTE_FALADOR_SOUTH_TO_NORTH.z);
    await bot.walkToWithPathfinding(ROUTE_FALADOR_PARK.x, ROUTE_FALADOR_PARK.z);
    await bot.walkToWithPathfinding(ROUTE_TAVERLEY_VILLAGE.x, ROUTE_TAVERLEY_VILLAGE.z);
    await bot.walkToWithPathfinding(DRUID_CIRCLE_X, DRUID_CIRCLE_Z);
    bot.log('STATE', `At Druid Circle: pos=(${bot.player.x},${bot.player.z})`);
}

/**
 * Walk from the Lumbridge area to Taverley.
 * Route west through Draynor to Falador, then north to Taverley.
 */
async function walkToTaverleyFromLumbridge(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Walking from Lumbridge area to Taverley ===');
    await bot.walkToWithPathfinding(ROUTE_LUMBRIDGE_TO_DRAYNOR.x, ROUTE_LUMBRIDGE_TO_DRAYNOR.z);
    await bot.walkToWithPathfinding(ROUTE_DRAYNOR_TO_FALADOR_SOUTH.x, ROUTE_DRAYNOR_TO_FALADOR_SOUTH.z);
    await bot.walkToWithPathfinding(ROUTE_FALADOR_SOUTH_GATE.x, ROUTE_FALADOR_SOUTH_GATE.z);
    await bot.walkToWithPathfinding(ROUTE_FALADOR_SOUTH_TO_NORTH.x, ROUTE_FALADOR_SOUTH_TO_NORTH.z);
    await bot.walkToWithPathfinding(ROUTE_FALADOR_PARK.x, ROUTE_FALADOR_PARK.z);
    await bot.walkToWithPathfinding(ROUTE_TAVERLEY_VILLAGE.x, ROUTE_TAVERLEY_VILLAGE.z);
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

    // The bot lands at (2898,3427) after climbing up, but the down-stairs (loc_1739)
    // are at (2898,3428). There's a wall between these tiles on level 1, so we can't
    // walkToWithPathfinding to the stairs. Try both loc_1739 and loc_1743 (alternate
    // stair type with same model). If neither is found by debugname, search by
    // display name "Staircase".
    let stairs = bot.findNearbyLoc('loc_1739', 10);
    if (!stairs) {
        stairs = bot.findNearbyLoc('loc_1743', 10);
    }
    if (!stairs) {
        // Try by display name
        stairs = bot.findNearbyLocByDisplayName('Staircase', 10);
    }
    if (!stairs) {
        // Debug: log all nearby locs on this level
        const allLocs = bot.findAllNearbyLocs(10);
        for (const locInfo of allLocs) {
            bot.log('STATE', `  Level 1 loc: ${locInfo.debugname} "${locInfo.displayName}" at (${locInfo.x},${locInfo.z})`);
        }
        throw new Error(`goDownFromSanfew: no staircase found on level 1 at (${bot.player.x},${bot.player.z})`);
    }

    bot.log('STATE', `goDownFromSanfew: using staircase "${stairs.type}" at (${stairs.x},${stairs.z})`);
    await bot.interactLoc(stairs, 3); // op3 = Climb-down
    await bot.waitForTicks(5);

    if ((bot.player.level as number) !== 0) {
        // Try op1 (Climb) which on some staircase types handles both up and down
        await bot.interactLoc(stairs, 1);
        await bot.waitForTicks(5);
    }

    if ((bot.player.level as number) !== 0) {
        throw new Error(`Failed to climb down to level 0: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    bot.log('STATE', `Back on ground floor: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
}

/**
 * Open the prison doors in Taverley dungeon.
 *
 * Opening from outside triggers suits of armour (level 19, 29 HP). The door
 * script (prison_doors.rs2) checks for suitofarmour_darkknight locs:
 *   - First interaction: activates northern suit, loc_del(500), door stays closed
 *   - Second interaction: activates southern suit, loc_del(500), door stays closed
 *   - Third interaction: both locs deleted → door opens
 *
 * Strategy: interact 3 times rapidly, triggering both suits but not fighting
 * them. The suits attack but the bot just needs to survive long enough to open
 * the door and walk through. The suits will be left behind in the corridor.
 *
 * Bot must be at (2885, 9830) — end of the corridor, west of the doors.
 */
async function openPrisonDoorsAndFightSuits(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Opening prison doors ===');

    // The prison_doors.rs2 script works like this:
    // - 1st interaction from outside: deletes northern suitofarmour_darkknight loc (500 ticks), spawns NPC
    // - 2nd interaction: deletes southern suit loc (500 ticks), spawns NPC
    // - 3rd interaction: both locs deleted → door opens
    // Strategy: interact 3 times rapidly. Don't fight the suits — just survive the hits.
    for (let attempt = 0; attempt < 5; attempt++) {
        const door = bot.findNearbyLoc('cauldrondoor', 15) ?? bot.findNearbyLoc('cauldrondoor_l', 15);
        if (!door) {
            bot.log('STATE', 'No prison door found, may already be open');
            break;
        }

        bot.log('STATE', `Interacting with prison door at (${door.x},${door.z}), attempt ${attempt + 1}`);

        // Clear any busy/modal state before interacting
        await bot.clearPendingState();

        await bot.interactLoc(door, 1); // op1 = Open
        await bot.waitForTicks(2);

        if (bot.isDead()) {
            throw new Error('Bot died at prison doors');
        }
    }

    // Walk through the now-open door to the cauldron area
    await bot.walkToWithPathfinding(2892, 9831);
    bot.log('STATE', `Through prison doors: pos=(${bot.player.x},${bot.player.z})`);
}

/**
 * Enter Taverley dungeon and enchant all 4 raw meats at the Cauldron of Thunder.
 * The dungeon entrance is a ladder (loc_1759) south of Taverley.
 *
 * Dungeon layout (from map m45_153):
 *   Entrance ladder (loc_1755) at (2884, 9797) — lands at ~(2885, 9797)
 *   Corridor goes north through x=2883-2885, walls on both sides
 *   Prison doors (cauldrondoor/cauldrondoor_l) at (2889, 9830-9831) — blocks west side
 *   Cauldron of Thunder at (2893, 9831)
 *
 * The pathfinder has a 25-tile search radius, so the 33-tile corridor needs
 * intermediate waypoints.
 */
async function enchantMeatsAtCauldron(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Entering Taverley dungeon to enchant meats ===');

    // If still upstairs in Sanfew's house (level 1), climb down first
    if ((bot.player.level as number) === 1) {
        bot.log('STATE', `Still on level 1 at (${bot.player.x},${bot.player.z}), climbing down`);
        await goDownFromSanfew(bot);
    }

    // If already underground (e.g. from a failed retry), skip the entrance walk
    const alreadyUnderground = bot.player.z >= UNDERGROUND_Z_OFFSET;
    if (!alreadyUnderground) {
        // Walk to dungeon entrance
        await bot.walkToWithPathfinding(DUNGEON_ENTRANCE_X, DUNGEON_ENTRANCE_Z);
        bot.log('STATE', `At dungeon entrance: pos=(${bot.player.x},${bot.player.z})`);

        // Climb down the ladder (loc_1759, op1=Climb-down, z+6400)
        await bot.climbStairs('loc_1759', 1);
        await bot.waitForTicks(3);

        // Verify we're underground
        if (bot.player.z < UNDERGROUND_Z_OFFSET) {
            throw new Error(`Failed to enter dungeon: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
        }
    }
    bot.log('STATE', `In dungeon: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Navigate through the dungeon corridor to the prison doors.
    // The corridor runs north (x=2883-2885) from entrance ~(2885, 9797) to ~(2885, 9830).
    // Pathfinder search radius is 25 tiles, so we need intermediate waypoints
    // for the 33-tile corridor.
    await bot.walkToWithPathfinding(2885, 9815); // mid-corridor waypoint
    await bot.walkToWithPathfinding(2885, 9830); // end of corridor

    // Prison doors (cauldrondoor/cauldrondoor_l) at (2889, 9830-9831).
    // Opening from outside triggers suits of armour. Interact 3 times to open.
    await openPrisonDoorsAndFightSuits(bot);

    // Walk adjacent to the cauldron at (2893, 9831). The cauldron is a centrepiece
    // that blocks its tile, so walk to (2892, 9831) — one tile west.
    await bot.walkToWithPathfinding(2892, 9831);
    bot.log('STATE', `Adjacent to cauldron: pos=(${bot.player.x},${bot.player.z})`);

    // Find the cauldron
    const cauldron = bot.findNearbyLoc('cauldron_of_thunder', 20);
    if (!cauldron) {
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

    // Exit the dungeon - walk back through corridor with waypoints, climb ladder
    bot.log('STATE', 'Exiting dungeon...');

    // Walk back west out of cauldron room, then south through corridor
    await bot.walkToWithPathfinding(2885, 9830);
    await bot.walkToWithPathfinding(2885, 9815);

    // Walk to the entrance ladder area
    const entranceUndergroundZ = DUNGEON_ENTRANCE_Z + UNDERGROUND_Z_OFFSET;
    await bot.walkToWithPathfinding(DUNGEON_ENTRANCE_X, entranceUndergroundZ);

    // Find and climb the exit ladder (loc_1755, Climb-up)
    const exitLadder = bot.findNearbyLoc('loc_1755', 10);
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
        entrySnapshot: {
            position: { x: 3222, z: 3218 },
            varps: { [DRUIDIC_RITUAL_VARP]: 0 },
            items: ['Bronze pickaxe'],
        },
        children: [
            {
                name: 'train-combat',
                entrySnapshot: {
                    position: { x: 3222, z: 3218 },
                    varps: { [DRUIDIC_RITUAL_VARP]: 0 },
                    items: ['Bronze pickaxe'],
                },
                isComplete: () => {
                    const atk = bot.getSkill('Attack').baseLevel;
                    const str = bot.getSkill('Strength').baseLevel;
                    // Need attack 15+ and strength 10+ to fight bears (level 21).
                    // Prison doors are handled by interacting 3 times without fighting.
                    return (atk as number) >= 15 && (str as number) >= 10 && bot.findItem('Raw chicken') !== null;
                },
                maxRetries: 5,
                run: async () => {
                    bot.enableRun(true);
                    await killChickensForMeatAndXP(bot, 15, 10);
                }
            },
            // Fight bear FIRST while inventory is minimal (Raw chicken + equipped pickaxe = 2 items).
            // On death, all items are kept (you keep 3 most valuable).
            // After this, collect beef and rat meat — those fights are easier.
            {
                name: 'collect-raw-bear-meat',
                entrySnapshot: {
                    position: { x: 3184, z: 3276 },
                    skills: { ATTACK: 15, STRENGTH: 10, HITPOINTS: 14 },
                    varps: { [DRUIDIC_RITUAL_VARP]: 0 },
                    items: ['Raw chicken'],
                },
                isComplete: () => bot.findItem('Raw bear meat') !== null || bot.findItem('Enchanted bear') !== null,
                maxRetries: 10,
                stuckThreshold: 3000,
                progressThreshold: 5000,
                run: async () => {
                    await killBearForMeat(bot);
                }
            },
            {
                name: 'collect-raw-beef',
                entrySnapshot: {
                    position: { x: 3179, z: 3222 },
                    skills: { ATTACK: 15, STRENGTH: 11, HITPOINTS: 14 },
                    varps: { [DRUIDIC_RITUAL_VARP]: 0 },
                    items: ['Raw chicken', 'Raw bear meat'],
                },
                isComplete: () => bot.findItem('Raw beef') !== null || bot.findItem('Enchanted beef') !== null,
                maxRetries: 5,
                run: async () => {
                    await killCowForBeef(bot);
                }
            },
            {
                name: 'collect-raw-rat-meat',
                entrySnapshot: {
                    position: { x: 3253, z: 3264 },
                    skills: { ATTACK: 15, STRENGTH: 11, HITPOINTS: 14 },
                    varps: { [DRUIDIC_RITUAL_VARP]: 0 },
                    items: ['Raw chicken', 'Raw bear meat', 'Raw beef'],
                },
                isComplete: () => bot.findItem('Raw rat meat') !== null || bot.findItem('Enchanted rat') !== null,
                maxRetries: 5,
                run: async () => {
                    await killGiantRatForMeat(bot);
                }
            },
            {
                name: 'start-quest',
                entrySnapshot: {
                    position: { x: 3197, z: 3203 },
                    skills: { ATTACK: 15, STRENGTH: 11, HITPOINTS: 15 },
                    varps: { [DRUIDIC_RITUAL_VARP]: 0 },
                    items: ['Raw chicken', 'Raw bear meat', 'Raw beef', 'Raw rat meat'],
                },
                isComplete: () => bot.getQuestProgress(DRUIDIC_RITUAL_VARP) >= STAGE_STARTED,
                run: async () => {
                    // If already near Taverley/druid circle (e.g. on retry), skip the long walk
                    const distToCircle = Math.abs(bot.player.x - DRUID_CIRCLE_X) + Math.abs(bot.player.z - DRUID_CIRCLE_Z);
                    if (distToCircle > 200) {
                        await walkToTaverleyFromLumbridge(bot);
                    } else {
                        bot.log('STATE', `Already near Taverley (dist=${distToCircle}), walking directly to druid circle`);
                        await bot.walkToWithPathfinding(DRUID_CIRCLE_X, DRUID_CIRCLE_Z);
                    }
                    await talkToKaqemeexStart(bot);
                }
            },
            {
                name: 'talk-to-sanfew',
                entrySnapshot: {
                    position: { x: 2925, z: 3488 },
                    skills: { ATTACK: 15, STRENGTH: 11, HITPOINTS: 15 },
                    varps: { [DRUIDIC_RITUAL_VARP]: 1 },
                    items: ['Raw chicken', 'Raw bear meat', 'Raw beef', 'Raw rat meat'],
                },
                isComplete: () => bot.getQuestProgress(DRUIDIC_RITUAL_VARP) >= STAGE_SPOKEN_SANFEW,
                run: async () => {
                    await talkToSanfew(bot);
                }
            },
            {
                name: 'enchant-meats',
                entrySnapshot: {
                    position: { x: 2897, z: 3428 },
                    skills: { ATTACK: 15, STRENGTH: 11, HITPOINTS: 15 },
                    varps: { [DRUIDIC_RITUAL_VARP]: 2 },
                    items: ['Raw chicken', 'Raw bear meat', 'Raw beef', 'Raw rat meat'],
                },
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
                entrySnapshot: {
                    position: { x: 2884, z: 3398 },
                    skills: { ATTACK: 15, STRENGTH: 11, HITPOINTS: 15 },
                    varps: { [DRUIDIC_RITUAL_VARP]: 2 },
                    items: ['Enchanted chicken', 'Enchanted bear', 'Enchanted beef', 'Enchanted rat'],
                },
                isComplete: () => bot.getQuestProgress(DRUIDIC_RITUAL_VARP) >= STAGE_GIVEN_INGREDIENTS,
                run: async () => {
                    await returnToSanfewWithMeats(bot);
                }
            },
            {
                name: 'complete-quest',
                entrySnapshot: {
                    position: { x: 2897, z: 3428 },
                    skills: { ATTACK: 15, STRENGTH: 11, HITPOINTS: 15 },
                    varps: { [DRUIDIC_RITUAL_VARP]: 3 },
                    items: [],
                },
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
    await runStateMachine(bot, { root, varpIds: [DRUIDIC_RITUAL_VARP] });
}

export const metadata: ScriptMeta = {
    name: 'druidicroitual',
    type: 'quest',
    varpId: DRUIDIC_RITUAL_VARP,
    varpComplete: STAGE_COMPLETE,
    maxTicks: 90000, // Combat training + 4 meat types + dungeon navigation
    run: druidicRitual,
    buildStates: buildDruidicRitualStates,
};
