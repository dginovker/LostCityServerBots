import path from 'path';
import { BotAPI } from '../runtime/api.js';
import { skipTutorial } from './skip-tutorial.js';
import { type BotState, runStateMachine } from '../runtime/state-machine.js';
import type { ScriptMeta } from '../runtime/script-meta.js';
import { cooksAssistant, metadata as cooksAssistantMeta } from './cooks-assistant.js';
import { sheepShearer, metadata as sheepShearerMeta } from './sheep-shearer.js';
import { romeoAndJuliet, metadata as romeoMeta } from './romeo-and-juliet.js';
import { impCatcher, metadata as impCatcherMeta } from './imp-catcher.js';
import { runeMysteries, metadata as runeMystMeta } from './rune-mysteries.js';
import { princeAliRescue, metadata as princeAliMeta } from './prince-ali-rescue.js';
import { ensureWestOfTollGate } from './shared-routes.js';

// Varp IDs (from content/pack/varp.pack: 130=spy)
const BKF_VARP = 130;

// Quest stages (from content/scripts/quests/quest_blackknight/scripts/blackknight_journal.rs2)
const STAGE_NOT_STARTED = 0;
const STAGE_STARTED = 1;       // Talked to Sir Amik, agreed to spy
const STAGE_LISTENED = 2;      // Listened at witchgrill, overheard witch's plot
const STAGE_SABOTAGED = 3;     // Used cabbage on hole, ruined potion
const STAGE_COMPLETE = 4;      // Turned in to Sir Amik (^blackknight_complete)

// Stun/delay varps (for pickpocketing GP)
const VARP_ACTION_DELAY = 58;
const VARP_STUNNED = 103;

// Quest points varp (from content/pack/varp.pack: 101=qp)
const QP_VARP = 101;

// QP requirement for the quest
const REQUIRED_QP = 12;

// ---- Key locations ----

// Lumbridge spawn
const LUMBRIDGE_X = 3222;
const LUMBRIDGE_Z = 3218;

// Barbarian Village - Peksa's Helmet Shop (bronze_med_helm for 100gp)
const PEKSA_X = 3079;
const PEKSA_Z = 3428;

// Falador - Wayne's Chains (iron_chainbody for 300gp)
// Wayne is inside his shop, near (2972, 3312)
const WAYNE_X = 2972;
const WAYNE_Z = 3312;

// Cabbage field south of Falador (~3054, 3288)
const CABBAGE_FIELD_X = 3054;
const CABBAGE_FIELD_Z = 3288;

// Falador White Knights' Castle
// Sir Amik Varze is on level 2 at (2962, 3338)
const FALADOR_CASTLE_ENTRANCE_X = 2970;
const FALADOR_CASTLE_ENTRANCE_Z = 3343;
const SIR_AMIK_X = 2962;
const SIR_AMIK_Z = 3338;

// Inside fortress:
// Grate at (3025, 3507, 0) — witchgrill loc
const GRATE_X = 3025;
const GRATE_Z = 3507;

// Hole at (3031, 3507, 1) — from loc dump: blackknighthole@(3031,3507)
const HOLE_X = 3031;
const HOLE_Z = 3507;

// ---- Route waypoints ----

// Falador -> Black Knights' Fortress (via west side of Ice Mountain)
// There's a cliff at z~3508 blocking direct south approach.
// Go around via the west side: south-of-cliff → west → north → east to door.
const FALADOR_TO_FORTRESS = [
    { x: 2970, z: 3370, name: 'North from Falador' },
    { x: 2985, z: 3430, name: 'North past Falador walls' },
    { x: 3008, z: 3475, name: 'North-east toward Ice Mountain' },
    { x: 2998, z: 3507, name: 'West side of cliff' },
    { x: 3006, z: 3514, name: 'North around cliff' },
    { x: 3016, z: 3514, name: 'At fortress entrance door' },
];

// ---- Utility functions ----

/**
 * Pickpocket men in Lumbridge to earn GP.
 */
async function earnGp(bot: BotAPI, targetGp: number): Promise<void> {
    bot.log('STATE', `=== Earning ${targetGp}gp by pickpocketing men ===`);

    // Walk to Lumbridge spawn area where men roam
    await bot.walkToWithPathfinding(LUMBRIDGE_X, LUMBRIDGE_Z);

    let attempts = 0;
    const MAX_ATTEMPTS = 800;

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
            await bot.walkTo(LUMBRIDGE_X, LUMBRIDGE_Z);
            await bot.waitForTicks(2);
            man = bot.findNearbyNpc('Man');
            if (!man) {
                throw new Error(`No Man NPC found near (${LUMBRIDGE_X},${LUMBRIDGE_Z})`);
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
 * Walk along a series of waypoints.
 */
async function walkRoute(bot: BotAPI, waypoints: { x: number; z: number; name: string }[]): Promise<void> {
    for (const wp of waypoints) {
        bot.log('STATE', `Walking to ${wp.name} (${wp.x},${wp.z})`);
        await bot.walkToWithPathfinding(wp.x, wp.z);
    }
}

/**
 * Run prerequisite quests to accumulate at least 12 quest points.
 * Cook's Assistant (1) + Sheep Shearer (1) + Romeo & Juliet (5) +
 * Rune Mysteries (1) + Imp Catcher (1) + Prince Ali Rescue (3) = 12 QP
 *
 * Each of these scripts calls skipTutorial internally, which teleports
 * back to Lumbridge and adds a bronze pickaxe. This is harmless (idempotent
 * tutorial var, just wastes position and inventory slot).
 */
async function _completePrerequisiteQuests(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Running prerequisite quests for 12 QP ===');

    // Cook's Assistant: 1 QP (Lumbridge area, relatively quick)
    bot.log('STATE', '--- Prerequisite: Cook\'s Assistant ---');
    await cooksAssistant(bot);
    bot.log('EVENT', `Cook's Assistant complete. QP so far: ${bot.getVarp(QP_VARP)}`);

    // Sheep Shearer: 1 QP (Lumbridge area)
    bot.log('STATE', '--- Prerequisite: Sheep Shearer ---');
    await sheepShearer(bot);
    bot.log('EVENT', `Sheep Shearer complete. QP so far: ${bot.getVarp(QP_VARP)}`);

    // Romeo & Juliet: 5 QP (Varrock area)
    bot.log('STATE', '--- Prerequisite: Romeo & Juliet ---');
    await romeoAndJuliet(bot);
    bot.log('EVENT', `Romeo & Juliet complete. QP so far: ${bot.getVarp(QP_VARP)}`);

    // Rune Mysteries: 1 QP (Lumbridge + Varrock)
    bot.log('STATE', '--- Prerequisite: Rune Mysteries ---');
    await runeMysteries(bot);
    bot.log('EVENT', `Rune Mysteries complete. QP so far: ${bot.getVarp(QP_VARP)}`);

    // Imp Catcher: 1 QP (combat, may take a while)
    bot.log('STATE', '--- Prerequisite: Imp Catcher ---');
    await impCatcher(bot);
    bot.log('EVENT', `Imp Catcher complete. QP so far: ${bot.getVarp(QP_VARP)}`);

    // Prince Ali Rescue: 3 QP (complex quest)
    bot.log('STATE', '--- Prerequisite: Prince Ali Rescue ---');
    await princeAliRescue(bot);
    bot.log('EVENT', `Prince Ali Rescue complete. QP so far: ${bot.getVarp(QP_VARP)}`);

    // Verify we have enough QP
    const qp = bot.getVarp(QP_VARP);
    if (qp < REQUIRED_QP) {
        throw new Error(`Not enough quest points after prerequisites: have ${qp}, need ${REQUIRED_QP}`);
    }
    bot.log('EVENT', `Prerequisite quests complete. Total QP: ${qp}`);
}

/**
 * Buy equipment for the fortress guard disguise:
 * - Bronze med helm (100gp from Peksa in Barbarian Village)
 * - Iron chainbody (300gp from Wayne's Chains in Falador)
 *
 * Also need a regular cabbage (pick from field south of Falador).
 * Total GP needed: 400+
 */
async function acquireEquipment(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Acquiring disguise equipment and cabbage ===');

    // After Prince Ali Rescue, the bot may be in Al-Kharid (east of the toll gate).
    // Cross back west before proceeding — PAR is complete so passage is free.
    await ensureWestOfTollGate(bot);

    // Check how much GP we have
    const coins = bot.findItem('Coins');
    const currentGp = coins ? coins.count : 0;
    bot.log('STATE', `Current GP: ${currentGp}`);

    // Need at least 500gp (400 for equipment + safety margin)
    if (currentGp < 500) {
        // Walk to Lumbridge to pickpocket
        await bot.walkToWithPathfinding(LUMBRIDGE_X, LUMBRIDGE_Z);
        await earnGp(bot, 500);
    }

    // Step 1: Buy bronze med helm from Peksa if not already owned
    if (!bot.findItem('Bronze med helm')) {
        bot.log('STATE', '--- Buying bronze med helm from Peksa ---');
        // Navigate to Barbarian Village avoiding the diagonal fencing,
        // then walk into Peksa's shop through the door at (3076,3427).
        await bot.walkToWithPathfinding(3082, 3336); // South of fence
        await bot.walkToWithPathfinding(PEKSA_X, PEKSA_Z); // Near shop
        // Open the shop door and walk inside
        await bot.openDoor('inaccastledoubledoorropen');
        await bot.walkToWithPathfinding(3075, 3429); // Inside shop

        // Use op3=Trade to directly open shop (like other working scripts)
        const peksa = bot.findNearbyNpc('Peksa');
        if (!peksa) {
            throw new Error(`Peksa not found near (${bot.player.x},${bot.player.z})`);
        }
        bot.log('ACTION', `Trading with Peksa at (${peksa.x},${peksa.z})`);
        await bot.interactNpc(peksa, 3); // op3 = Trade
        await bot.waitForTicks(5);
        await bot.buyFromShop('Bronze med helm', 1);
        bot.dismissModals();

        if (!bot.findItem('Bronze med helm')) {
            throw new Error('Failed to buy Bronze med helm from Peksa');
        }
        bot.log('EVENT', 'Bought Bronze med helm');
    }

    // Step 2: Buy iron chainbody from Wayne if not already owned
    if (!bot.findItem('Iron chainbody')) {
        bot.log('STATE', '--- Buying iron chainbody from Wayne ---');
        // Navigate south from Barbarian Village (avoid fencing and Draynor Manor),
        // then west to Falador and Wayne's shop
        await bot.walkToWithPathfinding(3082, 3250); // South below all fences/buildings
        await bot.walkToWithPathfinding(2970, 3310); // West to Falador
        await bot.walkToWithPathfinding(WAYNE_X, WAYNE_Z);

        // Use op3=Trade to directly open shop
        const wayne = bot.findNearbyNpc('Wayne');
        if (!wayne) {
            throw new Error(`Wayne not found near (${bot.player.x},${bot.player.z})`);
        }
        bot.log('ACTION', `Trading with Wayne at (${wayne.x},${wayne.z})`);
        await bot.interactNpc(wayne, 3); // op3 = Trade
        await bot.waitForTicks(5);
        await bot.buyFromShop('Iron chainbody', 1);
        bot.dismissModals();

        if (!bot.findItem('Iron chainbody')) {
            throw new Error('Failed to buy Iron chainbody from Wayne');
        }
        bot.log('EVENT', 'Bought Iron chainbody');
    }

    // Step 3: Pick a cabbage if not already owned
    if (!bot.findItem('Cabbage')) {
        bot.log('STATE', '--- Picking cabbage from field ---');
        await bot.walkToWithPathfinding(CABBAGE_FIELD_X, CABBAGE_FIELD_Z);

        // Look for a cabbage loc nearby and pick it (op2=Pick)
        for (let attempt = 0; attempt < 5; attempt++) {
            const cabbageLoc = bot.findNearbyLoc('cabbage', 10);
            if (cabbageLoc) {
                bot.log('ACTION', `Found cabbage loc at (${cabbageLoc.x},${cabbageLoc.z})`);
                await bot.interactLoc(cabbageLoc, 2); // op2 = Pick
                await bot.waitForTicks(5);

                const cabbage = bot.findItem('Cabbage');
                if (cabbage) {
                    bot.log('EVENT', 'Picked a cabbage');
                    break;
                }
            }

            // Walk around the field to find more cabbages
            const offsets = [
                { x: 3054, z: 3288 },
                { x: 3058, z: 3284 },
                { x: 3050, z: 3292 },
                { x: 3062, z: 3286 },
                { x: 3056, z: 3296 },
            ];
            const offset = offsets[attempt % offsets.length]!;
            await bot.walkToWithPathfinding(offset.x, offset.z);
            await bot.waitForTicks(3);
        }

        const cabbage = bot.findItem('Cabbage');
        if (!cabbage) {
            throw new Error('Failed to pick a cabbage from the field south of Falador');
        }
    }

    bot.log('EVENT', 'Equipment acquired: Bronze med helm, Iron chainbody, Cabbage');
}

/**
 * Navigate into the White Knights' Castle and up to level 2 to find Sir Amik Varze.
 * The castle has staircases on the west side near (2960, 3339).
 */
async function walkToSirAmik(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Walking to Sir Amik Varze in White Knights\' Castle ===');

    const currentLevel = bot.player.level as number;

    if (currentLevel === 0) {
        // Walk to the castle entrance (Falador center area)
        await bot.walkToWithPathfinding(FALADOR_CASTLE_ENTRANCE_X, FALADOR_CASTLE_ENTRANCE_Z);
        bot.log('STATE', `At castle entrance: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

        // Walk inside toward the stairwell on the west side
        await bot.walkToWithPathfinding(2960, 3339);
        bot.log('STATE', `Near castle stairs: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

        // Climb up from level 0 to level 1 (loc_1738 at (2954,3338))
        await bot.climbStairs('loc_1738', 1); // op1=Climb-up
        await bot.waitForTicks(3);

        if ((bot.player.level as number) !== 1) {
            throw new Error(`Failed to climb to level 1 in White Knights' Castle: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
        }
        bot.log('STATE', `On level 1: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }

    if ((bot.player.level as number) === 1) {
        // Find the staircase on level 1 to climb to level 2
        const l1Locs = bot.findAllNearbyLocs(20);
        const l1Stairs = l1Locs.filter(l => l.displayName === 'Staircase');
        bot.log('STATE', `Level 1 staircases: ${l1Stairs.map(s => `${s.debugname}@(${s.x},${s.z})`).join(', ') || 'NONE'}`);

        // Try loc_1739 (mid-level, op2=Climb-up), then any staircase with Climb-up
        let stairsUp = bot.findNearbyLoc('loc_1739', 20);
        if (!stairsUp) stairsUp = bot.findNearbyLoc('loc_1738', 20);
        if (!stairsUp) stairsUp = bot.findNearbyLoc('loc_1742', 20);
        if (!stairsUp && l1Stairs.length > 0) {
            // Use the first staircase found
            stairsUp = l1Stairs[0]!.loc;
            bot.log('STATE', `Using staircase: ${l1Stairs[0]!.debugname}`);
        }
        if (!stairsUp) {
            throw new Error(`No staircase found on level 1 near (${bot.player.x},${bot.player.z})`);
        }

        // Determine the right op for climbing up based on loc type
        const stairInfo = l1Stairs.find(s => s.loc === stairsUp);
        const stairDebugName = stairInfo ? stairInfo.debugname : 'unknown';
        // loc_1739 uses op2=Climb-up; loc_1738/loc_1742 use op1=Climb-up
        const climbUpOp = stairDebugName.includes('1739') ? 2 : 1;
        await bot.climbStairs(stairDebugName, climbUpOp);
        await bot.waitForTicks(3);

        if ((bot.player.level as number) !== 2) {
            throw new Error(`Failed to climb to level 2 in White Knights' Castle: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
        }
        bot.log('STATE', `On level 2: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }

    // Walk to Sir Amik Varze's area (use walkTo on upper floors — no pathfinding data)
    await bot.walkTo(SIR_AMIK_X, SIR_AMIK_Z);
    bot.log('STATE', `Near Sir Amik Varze: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
}

/**
 * Climb back down from level 2 to ground floor of White Knights' Castle.
 */
async function leaveWhiteKnightsCastle(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Leaving White Knights\' Castle ===');

    // Climb down from level 2 to level 1
    if ((bot.player.level as number) === 2) {
        // Find any Climb-down staircase on level 2
        const l2Locs = bot.findAllNearbyLocs(20);
        const l2Stairs = l2Locs.filter(l => l.displayName === 'Staircase');
        bot.log('STATE', `Level 2 staircases: ${l2Stairs.map(s => `${s.debugname}@(${s.x},${s.z})`).join(', ') || 'NONE'}`);

        // loc_1739 has op3=Climb-down; loc_1740/loc_1736 have op1=Climb-down
        let downStairs = bot.findNearbyLoc('loc_1739', 20);
        if (downStairs) {
            await bot.climbStairs('loc_1739', 3); // op3=Climb-down
        } else {
            downStairs = bot.findNearbyLoc('loc_1740', 20) ?? bot.findNearbyLoc('loc_1736', 20);
            if (!downStairs) {
                throw new Error(`No Climb-down staircase on level 2 near (${bot.player.x},${bot.player.z})`);
            }
            await bot.interactLoc(downStairs, 1); // op1=Climb-down
        }
        await bot.waitForTicks(5);

        if ((bot.player.level as number) !== 1) {
            throw new Error(`Failed to climb down to level 1: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
        }
        bot.log('STATE', `On level 1: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }

    // Climb down from level 1 to level 0
    if ((bot.player.level as number) === 1) {
        const l1Locs = bot.findAllNearbyLocs(20);
        const l1Stairs = l1Locs.filter(l => l.displayName === 'Staircase');
        bot.log('STATE', `Level 1 staircases: ${l1Stairs.map(s => `${s.debugname}@(${s.x},${s.z})`).join(', ') || 'NONE'}`);

        let downStairs = bot.findNearbyLoc('loc_1740', 20) ?? bot.findNearbyLoc('loc_1736', 20) ?? bot.findNearbyLoc('loc_1733', 20) ?? bot.findNearbyLoc('loc_1723', 20);
        if (downStairs) {
            await bot.interactLoc(downStairs, 1); // op1=Climb-down
        } else {
            // Try loc_1739 with op3=Climb-down
            downStairs = bot.findNearbyLoc('loc_1739', 20);
            if (!downStairs) {
                throw new Error(`No Climb-down staircase on level 1 near (${bot.player.x},${bot.player.z}). Staircases: ${l1Stairs.map(s => `${s.debugname}@(${s.x},${s.z})`).join(', ')}`);
            }
            await bot.climbStairs('loc_1739', 3);
        }
        await bot.waitForTicks(5);

        if ((bot.player.level as number) !== 0) {
            throw new Error(`Failed to climb down to level 0: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
        }
    }

    // Walk out of the castle
    await bot.walkToWithPathfinding(FALADOR_CASTLE_ENTRANCE_X, FALADOR_CASTLE_ENTRANCE_Z);
    bot.log('STATE', `Outside castle: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
}

/**
 * Talk to Sir Amik Varze to start the quest.
 * Dialog flow:
 *   chatnpc "I am the leader of the White Knights..."
 *   p_choice2: "I seek a quest!" (1), "I don't..." (2)
 *   -> select 1
 *   chatnpc "Well, I need some spy work doing..."
 *   p_choice2: "I laugh in the face of danger!" (1), "I go and cower..." (2)
 *   -> select 1
 *   chatplayer, chatnpc several pages about the mission
 *   -> varp becomes 1
 */
async function startQuest(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Starting Black Knights\' Fortress quest ===');

    await bot.talkToNpc('Sir Amik Varze');

    // chatnpc "I am the leader of the White Knights..."
    await bot.waitForDialog(15);
    await bot.continueDialog();

    // p_choice2: "I seek a quest!" (1), "I don't..." (2)
    await bot.waitForDialog(10);
    await bot.selectDialogOption(1); // "I seek a quest!"

    // chatplayer "I seek a quest."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Well, I need some spy work doing..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // p_choice2: "I laugh in the face of danger!" (1), "I go and cower..." (2)
    await bot.waitForDialog(10);
    await bot.selectDialogOption(1); // "I laugh in the face of danger!"

    // chatplayer "I laugh in the face of danger."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Well that's good. Don't get too overconfident though."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // @black_knights_fortress_sir_amik_come_along_at_the_right_time
    // chatnpc "You've come along just right actually..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Subtlety isn't exactly our strong point."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatplayer "So what needs doing?"
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Well the Black Knights have started making strange threats..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Now normally this wouldn't be a problem."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "But they claim to have a powerful new secret weapon."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "What I want you to do is get inside their fortress..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatplayer "Ok, I'll give it a try." -> varp set to 1
    await bot.waitForDialog(10);
    await bot.continueDialog();

    await bot.waitForTicks(3);

    // Verify quest started
    const varp = bot.getQuestProgress(BKF_VARP);
    if (varp !== STAGE_STARTED) {
        throw new Error(`Quest varp after talking to Sir Amik is ${varp}, expected ${STAGE_STARTED}`);
    }
    bot.log('EVENT', `Quest started: varp=${varp}`);
}

/**
 * Eat a lobster if HP is not full.
 */
async function eatLobster(bot: BotAPI): Promise<void> {
    const health = bot.getHealth();
    if (health.current >= health.max) return;
    const lobster = bot.findItem('Lobster');
    if (!lobster) return;
    bot.log('ACTION', `Eating Lobster (HP=${health.current}/${health.max})`);
    await bot.useItemOp1('Lobster');
    await bot.waitForTicks(2);
}

/**
 * Navigate through the Black Knights' Fortress to the grate,
 * listen to the witch's conversation, then sabotage the potion.
 *
 * Fortress layout:
 * - Entrance: bkfortressdoor1 on level 0, requires disguise (bronze med helm + iron chainbody)
 * - bkfortressdoor2: east wing door, guard dialog, triggers ~black_knights_aggro
 * - witchgrill (grate): at (3025, 3507, 0), op1=Listen-at, requires varp 1
 * - loc_1750/loc_1749: ladders at (3022, 3518), loc_1749 triggers aggro on L1
 * - bksecretdoor: secret wall on L1 at (3030, 3510), passable from either side
 * - blackknighthole: at (3031, 3507, 1), use cabbage to sabotage, requires varp 2
 *
 * Route:
 * 1. Enter through bkfortressdoor1 wearing disguise
 * 2. Go through bkfortressdoor2 (triggers ~black_knights_aggro)
 * 3. Climb up loc_1750 to L1 (escape aggro), then back down loc_1749 to L0
 *    - Climbing down loc_1749@(3022,3518,1) re-triggers aggro, but lands at
 *      (3022,3517,0) from which the grate IS walkable (unlike the bkfortressdoor2
 *      landing position which is walled off from the grate corridor)
 * 4. Eat food to tank Black Knight hits, walk to grate, listen (~25 tick dialog)
 * 5. After grate dialog (varp 1->2), climb up loc_1750 to L1
 * 6. Push through bksecretdoor on L1 to reach hole area
 * 7. Use cabbage on blackknighthole (varp 2->3)
 */
async function infiltrateFortress(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Infiltrating Black Knights\' Fortress ===');

    // Equip the disguise
    if (bot.findItem('Bronze med helm')) await bot.equipItem('Bronze med helm');
    if (bot.findItem('Iron chainbody')) await bot.equipItem('Iron chainbody');
    await bot.waitForTicks(2);

    // Walk to the fortress entrance via the west side of Ice Mountain
    await walkRoute(bot, FALADOR_TO_FORTRESS);
    bot.log('STATE', `At fortress entrance: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Step 1: Enter through the main door (bkfortressdoor1) — requires disguise
    const fortressDoor = bot.findNearbyLoc('bkfortressdoor1', 5);
    if (!fortressDoor) {
        throw new Error(`bkfortressdoor1 not found near (${bot.player.x},${bot.player.z})`);
    }
    await bot.interactLoc(fortressDoor, 1);
    await bot.waitForTicks(3);
    if (bot.player.z <= 3514) {
        throw new Error(`Failed to enter fortress: pos=(${bot.player.x},${bot.player.z}). Is disguise equipped?`);
    }
    bot.log('STATE', `Inside fortress: pos=(${bot.player.x},${bot.player.z})`);

    // Test: walk from fortress entrance SOUTH to grate at (3025,3507,0)
    // The grate might be accessible from outside the fortress walls
    bot.log('STATE', `Testing external approach from inside fortress (${bot.player.x},${bot.player.z},${bot.player.level})`);

    const extProbes = [
        { x: 3016, z: 3512, label: 'south-12' },
        { x: 3016, z: 3510, label: 'south-10' },
        { x: 3016, z: 3508, label: 'south-08' },
        { x: 3020, z: 3515, label: 'east-20' },
        { x: 3020, z: 3512, label: 'se-12' },
        { x: 3020, z: 3510, label: 'se-10' },
        { x: 3020, z: 3508, label: 'se-08' },
        { x: 3025, z: 3508, label: 'grate-area' },
        { x: 3021, z: 3510, label: 'ladder-area' },
    ];
    for (const target of extProbes) {
        try {
            // Reset to start position
            if (Math.abs(bot.player.x - 3016) > 3 || Math.abs(bot.player.z - 3515) > 3) {
                await bot.walkTo(3016, 3515);
            }
            await bot.walkTo(target.x, target.z);
            bot.log('STATE', `Ext ${target.label} -> at (${bot.player.x},${bot.player.z})`);
        } catch {
            bot.log('STATE', `Ext ${target.label} -> FAIL at (${bot.player.x},${bot.player.z})`);
        }
    }

    // Try ghost pathfinding from inside fortress to grate
    await bot.walkTo(3016, 3515);
    bot.log('STATE', `Ghost pathfind to grate from (${bot.player.x},${bot.player.z})`);
    try {
        await bot.walkToWithPathfinding(3025, 3508);
        bot.log('STATE', `Ghost to grate: SUCCESS at (${bot.player.x},${bot.player.z})`);
    } catch (e: any) {
        bot.log('STATE', `Ghost to grate: FAIL at (${bot.player.x},${bot.player.z}) - ${e.message?.substring(0, 100)}`);
    }

    // Try from outside the fortress entirely - walk from approach route
    await bot.walkTo(3016, 3515);
    // Exit through front door
    const exitDoor = bot.findNearbyLoc('bkfortressdoor1', 5);
    if (exitDoor) {
        await bot.interactLoc(exitDoor, 1);
        await bot.waitForTicks(3);
    }
    bot.log('STATE', `Outside fortress: pos=(${bot.player.x},${bot.player.z})`);

    // Walk east along south side
    const outsideProbes = [
        { x: 3020, z: 3513, label: 'outside-east-20' },
        { x: 3025, z: 3513, label: 'outside-east-25' },
        { x: 3025, z: 3510, label: 'outside-se-25' },
        { x: 3025, z: 3508, label: 'outside-grate' },
        { x: 3030, z: 3508, label: 'outside-far-east' },
    ];
    for (const target of outsideProbes) {
        try {
            await bot.walkTo(target.x, target.z);
            bot.log('STATE', `Out ${target.label} -> at (${bot.player.x},${bot.player.z})`);
        } catch {
            bot.log('STATE', `Out ${target.label} -> FAIL at (${bot.player.x},${bot.player.z})`);
        }
    }

    // Ghost pathfind to grate from outside
    try {
        await bot.walkToWithPathfinding(3025, 3508);
        bot.log('STATE', `Ghost outside to grate: SUCCESS at (${bot.player.x},${bot.player.z})`);
    } catch (e: any) {
        bot.log('STATE', `Ghost outside to grate: FAIL at (${bot.player.x},${bot.player.z}) - ${e.message?.substring(0, 100)}`);
    }

    throw new Error('External grate probe done');

    await eatLobster(bot);

    // Step 7: Walk to the grate on L0
    await bot.walkToWithPathfinding(GRATE_X, GRATE_Z);
    bot.log('STATE', `At grate area: pos=(${bot.player.x},${bot.player.z})`);

    const grill = bot.findNearbyLoc('witchgrill', 10);
    if (!grill) {
        throw new Error(`witchgrill not found near (${bot.player.x},${bot.player.z})`);
    }

    await bot.interactLoc(grill, 1); // op1 = Listen-at
    await bot.waitForTicks(3);

    // Process 9 pages of dialog (chatnpc_specific between witch, knight, greldo)
    for (let i = 0; i < 20; i++) {
        const hasDialog = await bot.waitForDialog(10);
        if (!hasDialog) break;
        if (bot.isMultiChoiceOpen()) break;
        await bot.continueDialog();
    }

    await bot.waitForTicks(3);
    bot.dismissModals();

    // Verify we've advanced to stage 2
    const varpAfterGrill = bot.getQuestProgress(BKF_VARP);
    if (varpAfterGrill !== STAGE_LISTENED) {
        throw new Error(`Quest varp after listening at grate is ${varpAfterGrill}, expected ${STAGE_LISTENED}`);
    }
    bot.log('EVENT', `Listened at grate: varp=${varpAfterGrill}`);

    // ---- PHASE 2: Sabotage the potion on level 1 ----

    // Step 7: Climb up loc_1747@(3021,3510,0) to L1.
    // Player is south of loc, so lands at (player.x, player.z, 1) — south of loc_1746.
    const wallLadderUp = bot.findNearbyLoc('loc_1747', 16);
    if (!wallLadderUp) {
        throw new Error(`loc_1747 not found near (${bot.player.x},${bot.player.z})`);
    }
    await bot.interactLoc(wallLadderUp, 1); // op1 = Climb-up
    await bot.waitForTicks(3);
    if ((bot.player.level as number) !== 1) {
        throw new Error(`Failed to climb to L1 via loc_1747: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    bot.log('STATE', `On L1 for sabotage: pos=(${bot.player.x},${bot.player.z})`);

    // Step 8: Navigate east to bkfortressdoor3@(3025,3511,1).
    // Approaching from the west triggers ~black_knights_aggro — eat food to survive.
    await eatLobster(bot);

    const door3 = bot.findNearbyLoc('bkfortressdoor3', 16);
    if (!door3) {
        throw new Error(`bkfortressdoor3 not found near (${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    bot.log('STATE', `Found bkfortressdoor3 at (${door3.x},${door3.z})`);
    await bot.interactLoc(door3, 1); // op1 triggers ~open_and_close_door + aggro
    await bot.waitForTicks(5);
    await bot.clearPendingState();
    await eatLobster(bot);
    bot.log('STATE', `After bkfortressdoor3: pos=(${bot.player.x},${bot.player.z})`);

    // Step 9: Push through bksecretdoor@(3030,3510,1) to reach the hole area.
    const secretWallL1 = bot.findNearbyLoc('bksecretdoor', 16);
    if (!secretWallL1) {
        throw new Error(`bksecretdoor not found on L1 near (${bot.player.x},${bot.player.z})`);
    }
    bot.log('STATE', `Found L1 bksecretdoor at (${secretWallL1.x},${secretWallL1.z}), pushing through`);
    await bot.interactLoc(secretWallL1, 1); // op1 = Push
    await bot.waitForTicks(5);
    await bot.clearPendingState();
    await eatLobster(bot);
    bot.log('STATE', `After bksecretdoor: pos=(${bot.player.x},${bot.player.z})`);

    // Step 10: Walk to the hole and use cabbage to sabotage the potion
    await bot.walkTo(HOLE_X, HOLE_Z);
    bot.log('STATE', `At hole: pos=(${bot.player.x},${bot.player.z})`);

    await bot.useItemOnLoc('Cabbage', 'blackknighthole');

    // The cabbage script has several mes + p_delay(2) calls then chatplayer
    await bot.waitForTicks(12);
    for (let i = 0; i < 10; i++) {
        const hasDialog = await bot.waitForDialog(5);
        if (!hasDialog) break;
        if (bot.isMultiChoiceOpen()) break;
        await bot.continueDialog();
    }
    await bot.waitForTicks(3);

    // Verify we've advanced to stage 3
    const varpAfterSabotage = bot.getQuestProgress(BKF_VARP);
    if (varpAfterSabotage !== STAGE_SABOTAGED) {
        throw new Error(`Quest varp after sabotage is ${varpAfterSabotage}, expected ${STAGE_SABOTAGED}`);
    }
    bot.log('EVENT', `Potion sabotaged: varp=${varpAfterSabotage}`);
}

/**
 * Return to Sir Amik Varze to complete the quest.
 * Dialog:
 *   chatplayer "I have ruined the Black Knight's invincibility potion..."
 *   chatnpc "Yes we have just received a message..."
 *   chatplayer "You said you were going to pay me."
 *   chatnpc "Yes, that's right."
 *   -> varp becomes 4 (complete)
 *   -> queue(black_knights_fortress_quest_complete) gives 2500gp + 3 QP
 */
async function completeQuest(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Returning to Sir Amik Varze to complete quest ===');

    // Exit the fortress - walk south out of the fortress area
    // Need to navigate back out. Start by getting to ground floor.
    if ((bot.player.level as number) !== 0) {
        // Find a ladder down
        const ladderDown = bot.findNearbyLoc('loc_1746', 16) ?? bot.findNearbyLoc('loc_1749', 16);
        if (ladderDown) {
            await bot.interactLoc(ladderDown, 1);
            await bot.waitForTicks(3);
        }
    }

    // Walk out of the fortress and back to Falador via west side of Ice Mountain
    bot.log('STATE', `Leaving fortress: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    await bot.walkToWithPathfinding(3006, 3514);
    await bot.walkToWithPathfinding(2998, 3507);
    await bot.walkToWithPathfinding(3008, 3475);
    await bot.walkToWithPathfinding(2985, 3430);
    await bot.walkToWithPathfinding(2970, 3370);
    await bot.walkToWithPathfinding(FALADOR_CASTLE_ENTRANCE_X, FALADOR_CASTLE_ENTRANCE_Z);

    // Navigate to Sir Amik Varze on level 2
    await walkToSirAmik(bot);

    // Talk to Sir Amik to turn in the quest
    await bot.talkToNpc('Sir Amik Varze');

    // chatplayer "I have ruined the Black Knight's invincibility potion..."
    await bot.waitForDialog(15);
    await bot.continueDialog();

    // chatnpc "Yes we have just received a message from the Black Knights..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatplayer "You said you were going to pay me."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Yes, that's right."
    // -> varp becomes 4 (complete)
    // -> queue(black_knights_fortress_quest_complete)
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // Wait for the queued script to fire (gives 2500gp + quest complete)
    await bot.waitForTicks(5);

    // Dismiss quest complete interface
    bot.dismissModals();

    // Verify quest completion
    const finalVarp = bot.getQuestProgress(BKF_VARP);
    if (finalVarp !== STAGE_COMPLETE) {
        throw new Error(`Quest varp after turn-in is ${finalVarp}, expected ${STAGE_COMPLETE}`);
    }
    bot.log('EVENT', `Quest complete! varp=${finalVarp}`);
}

// ================================================================
// State machine builder
// ================================================================

/**
 * Helper to create a prerequisite quest sub-state.
 * Checks the quest's varp to determine if it's already complete.
 * If complete, skip. Otherwise, run the quest script.
 */
function prerequisiteState(
    name: string,
    bot: BotAPI,
    questMeta: ScriptMeta,
    questFn: (bot: BotAPI) => Promise<void>
): BotState {
    return {
        name,
        isComplete: () => bot.getQuestProgress(questMeta.varpId!) === questMeta.varpComplete,
        run: async () => {
            bot.log('STATE', `--- Running prerequisite: ${name} ---`);
            const currentVarp = bot.getQuestProgress(questMeta.varpId!);
            // If the quest is already in progress (e.g. from a previous failed attempt),
            // use the state machine which handles partial progress via per-state isComplete.
            // The raw questFn asserts varp === 0 and throws if the quest was already started.
            if (currentVarp > 0 && currentVarp !== questMeta.varpComplete && questMeta.buildStates) {
                bot.log('STATE', `Quest "${name}" already in progress (varp=${currentVarp}), resuming via state machine`);
                const root = questMeta.buildStates(bot);
                await runStateMachine(bot, { root, varpIds: [questMeta.varpId!] });
            } else {
                await questFn(bot);
            }
            bot.log('EVENT', `${name} complete. QP: ${bot.getVarp(QP_VARP)}`);
        }
    };
}

export function buildBlackKnightsFortressStates(bot: BotAPI): BotState {
    return {
        name: 'black-knights-fortress',
        isComplete: () => bot.getQuestProgress(BKF_VARP) === STAGE_COMPLETE,
        run: async () => { throw new Error('Composite state should not be called directly'); },
        children: [
            // Prerequisite quests (each checks varp to skip if already done)
            prerequisiteState('prereq/cooks-assistant', bot, cooksAssistantMeta, cooksAssistant),
            prerequisiteState('prereq/sheep-shearer', bot, sheepShearerMeta, sheepShearer),
            prerequisiteState('prereq/romeo-and-juliet', bot, romeoMeta, romeoAndJuliet),
            prerequisiteState('prereq/rune-mysteries', bot, runeMystMeta, runeMysteries),
            prerequisiteState('prereq/imp-catcher', bot, impCatcherMeta, impCatcher),
            prerequisiteState('prereq/prince-ali-rescue', bot, princeAliMeta, princeAliRescue),
            {
                name: 'verify-qp',
                isComplete: () => bot.getVarp(QP_VARP) >= REQUIRED_QP,
                run: async () => {
                    const qp = bot.getVarp(QP_VARP);
                    throw new Error(`Not enough quest points after prerequisites: have ${qp}, need ${REQUIRED_QP}`);
                }
            },
            {
                name: 'acquire-equipment',
                isComplete: () => {
                    return bot.findItem('Bronze med helm') !== null &&
                           bot.findItem('Iron chainbody') !== null &&
                           bot.findItem('Cabbage') !== null;
                },
                stuckThreshold: 3000,
                run: async () => {
                    await acquireEquipment(bot);
                }
            },
            {
                name: 'start-quest',
                isComplete: () => bot.getQuestProgress(BKF_VARP) >= STAGE_STARTED,
                run: async () => {
                    await walkToSirAmik(bot);
                    await startQuest(bot);
                }
            },
            {
                name: 'infiltrate-and-sabotage',
                isComplete: () => bot.getQuestProgress(BKF_VARP) >= STAGE_SABOTAGED,
                stuckThreshold: 3000,
                run: async () => {
                    // On retry, bot might be stuck on upper floors inside the fortress.
                    // The leaveWhiteKnightsCastle function is only for White Knights' Castle.
                    // If inside the fortress (upper floor), try to climb down first.
                    if ((bot.player.level as number) > 0) {
                        bot.log('STATE', `On level ${bot.player.level} at (${bot.player.x},${bot.player.z}), trying to descend`);
                        // Look for any climb-down ladder
                        const downLadder = bot.findNearbyLoc('loc_1749', 16) ?? bot.findNearbyLoc('loc_1746', 16) ?? bot.findNearbyLoc('loc_1740', 16);
                        if (downLadder) {
                            await bot.interactLoc(downLadder, 1);
                            await bot.waitForTicks(3);
                        }
                        // If still not level 0, try White Knights' Castle descent
                        if ((bot.player.level as number) > 0) {
                            await leaveWhiteKnightsCastle(bot);
                        }
                    }
                    await infiltrateFortress(bot);
                }
            },
            {
                name: 'complete-quest',
                isComplete: () => bot.getQuestProgress(BKF_VARP) === STAGE_COMPLETE,
                run: async () => {
                    await completeQuest(bot);
                    bot.log('SUCCESS', `Black Knights' Fortress quest complete! Final varp=${bot.getQuestProgress(BKF_VARP)}`);
                }
            }
        ]
    };
}

// ================================================================
// MAIN SCRIPT
// ================================================================

export async function blackKnightsFortress(bot: BotAPI): Promise<void> {
    await skipTutorial(bot);
    await bot.waitForTicks(2);

    bot.log('STATE', `Starting Black Knights' Fortress quest at (${bot.player.x},${bot.player.z},${bot.player.level})`);

    const initialVarp = bot.getQuestProgress(BKF_VARP);
    if (initialVarp !== STAGE_NOT_STARTED) {
        throw new Error(`Quest varp is ${initialVarp}, expected ${STAGE_NOT_STARTED} (not started)`);
    }

    const root = buildBlackKnightsFortressStates(bot);
    const snapshotDir = path.resolve(import.meta.dir, '..', 'test', 'snapshots');
    await runStateMachine(bot, { root, varpIds: [BKF_VARP, QP_VARP], captureSnapshots: true, snapshotDir });
}

export const metadata: ScriptMeta = {
    name: 'blackknightsfortress',
    type: 'quest',
    varpId: BKF_VARP,
    varpComplete: STAGE_COMPLETE,
    maxTicks: 120000,
    run: blackKnightsFortress,
    buildStates: buildBlackKnightsFortressStates,
};
