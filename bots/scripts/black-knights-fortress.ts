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

// Black Knights' Fortress (north of Falador on Ice Mountain)
const FORTRESS_APPROACH_X = 3016;
const FORTRESS_APPROACH_Z = 3514;

// Inside fortress:
// Grate at (3025, 3508, 0)
const GRATE_X = 3025;
const GRATE_Z = 3508;

// Hole at (3031, 3508, 1)
const HOLE_X = 3031;
const HOLE_Z = 3508;

// ---- Route waypoints ----

// Lumbridge -> Barbarian Village / Falador route
const LUMBRIDGE_TO_BARBVILLAGE = [
    { x: 3170, z: 3250, name: 'West past Lumbridge' },
    { x: 3105, z: 3250, name: 'West toward Draynor' },
    { x: 3082, z: 3336, name: 'North to Barbarian Village area' },
];

// Barbarian Village -> Falador
const BARBVILLAGE_TO_FALADOR = [
    { x: 3006, z: 3356, name: 'West from Barbarian Village' },
    { x: 2970, z: 3343, name: 'South to Falador entrance' },
];

// Falador -> Black Knights' Fortress (north via Ice Mountain)
const FALADOR_TO_FORTRESS = [
    { x: 2970, z: 3370, name: 'North from Falador' },
    { x: 2985, z: 3430, name: 'North past Falador walls' },
    { x: 3008, z: 3475, name: 'North-east toward Ice Mountain' },
    { x: 3016, z: 3510, name: 'Approach fortress from south' },
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

    // Step 1: Walk from Lumbridge to Barbarian Village for bronze med helm
    bot.log('STATE', '--- Buying bronze med helm from Peksa ---');
    await walkRoute(bot, LUMBRIDGE_TO_BARBVILLAGE);
    await bot.walkToWithPathfinding(PEKSA_X, PEKSA_Z);

    // Talk to Peksa and buy bronze med helm
    // Dialog: "Are you interested in buying or selling a helmet?"
    // -> Option 1: "I could be, yes." -> opens shop
    await bot.talkToNpc('Peksa');
    await bot.waitForDialog(15);
    await bot.continueDialog(); // chatnpc greeting

    await bot.waitForDialog(10);
    await bot.selectDialogOption(1); // "I could be, yes."

    await bot.waitForDialog(10);
    await bot.continueDialog(); // chatplayer response

    // Shop should be open now
    await bot.waitForTicks(3);
    await bot.buyFromShop('Bronze med helm', 1);
    bot.dismissModals();

    const helm = bot.findItem('Bronze med helm');
    if (!helm) {
        throw new Error('Failed to buy Bronze med helm from Peksa');
    }
    bot.log('EVENT', 'Bought Bronze med helm');

    // Step 2: Walk from Barbarian Village to Falador for iron chainbody
    bot.log('STATE', '--- Buying iron chainbody from Wayne ---');
    await walkRoute(bot, BARBVILLAGE_TO_FALADOR);
    await bot.walkToWithPathfinding(WAYNE_X, WAYNE_Z);

    // Talk to Wayne and buy iron chainbody
    // Dialog: "Welcome to Wayne's Chains. Do you wanna buy or sell some chain mail?"
    // -> Option 1: "Yes please." -> opens shop
    await bot.talkToNpc('Wayne');
    await bot.waitForDialog(15);
    await bot.continueDialog(); // chatnpc greeting

    await bot.waitForDialog(10);
    await bot.selectDialogOption(1); // "Yes please."

    await bot.waitForDialog(10);
    await bot.continueDialog(); // chatplayer response

    // Shop should be open now
    await bot.waitForTicks(3);
    await bot.buyFromShop('Iron chainbody', 1);
    bot.dismissModals();

    const chain = bot.findItem('Iron chainbody');
    if (!chain) {
        throw new Error('Failed to buy Iron chainbody from Wayne');
    }
    bot.log('EVENT', 'Bought Iron chainbody');

    // Step 3: Pick a cabbage from the field south of Falador
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

    bot.log('EVENT', 'Equipment acquired: Bronze med helm, Iron chainbody, Cabbage');
}

/**
 * Navigate into the White Knights' Castle and up to level 2 to find Sir Amik Varze.
 * The castle has staircases on the west side near (2960, 3339).
 */
async function walkToSirAmik(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Walking to Sir Amik Varze in White Knights\' Castle ===');

    // Walk to the castle entrance (Falador center area)
    await bot.walkToWithPathfinding(FALADOR_CASTLE_ENTRANCE_X, FALADOR_CASTLE_ENTRANCE_Z);
    bot.log('STATE', `At castle entrance: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Enter the castle - the castle has open archways, no doors needed to enter
    // Walk inside toward the stairwell on the west side
    await bot.walkToWithPathfinding(2960, 3339);
    bot.log('STATE', `Near castle stairs: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Climb up from level 0 to level 1
    // Look for staircase loc (loc_1742 = Climb-up, loc_1743 = mid-level)
    await bot.climbStairs('loc_1742', 1);
    await bot.waitForTicks(3);

    if ((bot.player.level as number) !== 1) {
        throw new Error(`Failed to climb to level 1 in White Knights' Castle: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    bot.log('STATE', `On level 1: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Climb up from level 1 to level 2
    await bot.climbStairs('loc_1743', 2); // op2=Climb-up
    await bot.waitForTicks(3);

    if ((bot.player.level as number) !== 2) {
        throw new Error(`Failed to climb to level 2 in White Knights' Castle: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    bot.log('STATE', `On level 2: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Walk to Sir Amik Varze's area
    await bot.walkToWithPathfinding(SIR_AMIK_X, SIR_AMIK_Z);
    bot.log('STATE', `Near Sir Amik Varze: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
}

/**
 * Climb back down from level 2 to ground floor of White Knights' Castle.
 */
async function leaveWhiteKnightsCastle(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Leaving White Knights\' Castle ===');

    // Walk to the stairwell area
    await bot.walkToWithPathfinding(2960, 3339);

    // Climb down from level 2 to level 1
    await bot.climbStairs('loc_1743', 3); // op3=Climb-down
    await bot.waitForTicks(3);

    if ((bot.player.level as number) !== 1) {
        throw new Error(`Failed to climb down to level 1: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }

    // Climb down from level 1 to level 0
    await bot.climbStairs('loc_1745', 1); // op1=Climb-down
    await bot.waitForTicks(3);

    if ((bot.player.level as number) !== 0) {
        throw new Error(`Failed to climb down to level 0: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
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
 * Navigate through the Black Knights' Fortress to the grate,
 * listen to the witch's conversation, then sabotage the potion.
 *
 * Fortress layout overview:
 * - Entrance: bkfortressdoor1 on level 0, requires disguise (bronze med helm + iron chainbody)
 * - Level 0: Main hall, guard rooms
 * - Level 1: Accessible via ladder from level 0
 *   - Secret wall passage (bksecretdoor) on level 1
 *   - Hole (blackknighthole) at (3031, 3508, 1) for dropping cabbage
 * - Grate (witchgrill) at (3025, 3508, 0) for eavesdropping
 *
 * Route:
 * 1. Enter through bkfortressdoor1 wearing disguise
 * 2. Climb up ladder to level 1
 * 3. Push through bksecretdoor (secret wall)
 * 4. Climb down ladder to level 0 (other side of fortress)
 * 5. Go through bkfortressdoor3
 * 6. Climb down another ladder to reach grate area
 * 7. Listen at witchgrill (varp -> 2)
 * 8. Climb back up
 * 9. Navigate to level 1 to the hole
 * 10. Use cabbage on blackknighthole (varp -> 3)
 */
async function infiltrateFortress(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Infiltrating Black Knights\' Fortress ===');

    // Equip the disguise
    bot.log('ACTION', 'Equipping fortress guard disguise');
    await bot.equipItem('Bronze med helm');
    await bot.equipItem('Iron chainbody');
    await bot.waitForTicks(2);

    // Walk to the fortress entrance
    await walkRoute(bot, FALADOR_TO_FORTRESS);
    await bot.walkToWithPathfinding(FORTRESS_APPROACH_X, FORTRESS_APPROACH_Z);
    bot.log('STATE', `At fortress entrance: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Step 1: Enter through the main door (bkfortressdoor1)
    // The door checks for disguise. With correct equipment, it opens normally.
    bot.log('ACTION', 'Opening fortress entrance door (bkfortressdoor1)');
    await bot.openDoor('bkfortressdoor1');
    await bot.waitForTicks(2);

    // Walk inside the fortress
    await bot.walkToWithPathfinding(3016, 3516);
    bot.log('STATE', `Inside fortress entrance: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Step 2: Navigate inside and climb up the ladder to level 1
    // The east ladder in the fortress is around (3022, 3518, 0)
    await bot.walkToWithPathfinding(3022, 3518);
    bot.log('STATE', `Near east ladder: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Climb ladder up to level 1
    await bot.climbStairs('loc_1747', 1); // loc_1747 is Climb-up ladder
    await bot.waitForTicks(3);

    if ((bot.player.level as number) !== 1) {
        // Try alternative ladder names
        bot.log('STATE', 'Ladder climb did not reach level 1, trying loc_1750');
        await bot.climbStairs('loc_1750', 1);
        await bot.waitForTicks(3);
    }

    if ((bot.player.level as number) !== 1) {
        throw new Error(`Failed to climb to level 1 in fortress: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    bot.log('STATE', `On fortress level 1: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Step 3: Navigate to the secret wall passage (bksecretdoor) on level 1
    // The secret door is on the south-west area of level 1
    // Walk toward the passage area
    await bot.walkToWithPathfinding(3030, 3510);
    bot.log('STATE', `Looking for secret wall: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Push through the secret wall (bksecretdoor, op1=Push)
    const secretWall = bot.findNearbyLoc('bksecretdoor', 16);
    if (!secretWall) {
        // Log nearby locs for debugging
        const nearbyLocs = bot.findAllNearbyLocs(16);
        const locNames = nearbyLocs.slice(0, 20).map(l => `${l.debugname}@(${l.x},${l.z})`).join(', ');
        throw new Error(`Secret wall (bksecretdoor) not found on level 1 near (${bot.player.x},${bot.player.z}). Nearby locs: [${locNames}]`);
    }
    bot.log('ACTION', `Pushing secret wall at (${secretWall.x},${secretWall.z})`);
    await bot.interactLoc(secretWall, 1); // op1 = Push
    await bot.waitForTicks(3);

    // Walk through the passage
    // After pushing the secret wall, there should be a gap to walk through
    // The passage leads to the other side of the fortress on level 1
    await bot.waitForTicks(2);
    bot.log('STATE', `After secret wall: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Step 4: Climb down ladder to level 0 (south area of fortress)
    // Look for a ladder down
    let ladderDown = bot.findNearbyLoc('loc_1746', 16);
    if (!ladderDown) {
        ladderDown = bot.findNearbyLoc('loc_1749', 16);
    }
    if (ladderDown) {
        bot.log('ACTION', `Climbing down ladder at (${ladderDown.x},${ladderDown.z})`);
        await bot.interactLoc(ladderDown, 1); // op1 = Climb-down
        await bot.waitForTicks(3);
    }

    // If we're not on level 0 yet, try finding any ladder down
    if ((bot.player.level as number) !== 0) {
        bot.log('STATE', `Still on level ${bot.player.level}, looking for ladder down`);
        const allLocs = bot.findAllNearbyLocs(16);
        for (const locInfo of allLocs) {
            if (locInfo.debugname.includes('loc_174') || locInfo.debugname.includes('loc_175')) {
                bot.log('STATE', `Trying ladder: ${locInfo.debugname} at (${locInfo.x},${locInfo.z})`);
                await bot.interactLoc(locInfo.loc, 1);
                await bot.waitForTicks(3);
                if ((bot.player.level as number) === 0) break;
            }
        }
    }

    if ((bot.player.level as number) !== 0) {
        throw new Error(`Failed to climb down to level 0 in fortress: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    bot.log('STATE', `On fortress level 0 (south area): pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Step 5: Go through bkfortressdoor3
    // This door leads to the area with the ladder down to the grill
    // Black knights will aggro when going through this door from the inside
    bot.log('ACTION', 'Opening bkfortressdoor3');
    await bot.openDoor('bkfortressdoor3');
    await bot.waitForTicks(3);

    // Step 6: Climb down the ladder to the grate area
    // The grate (witchgrill) is at (3025, 3508, 0)
    // Walk toward the grate area
    await bot.walkToWithPathfinding(GRATE_X, GRATE_Z);
    bot.log('STATE', `Near grate: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Step 7: Listen at the grate (witchgrill, op1=Listen-at)
    bot.log('ACTION', 'Listening at grate (witchgrill)');
    const grill = bot.findNearbyLoc('witchgrill', 10);
    if (!grill) {
        const nearbyLocs = bot.findAllNearbyLocs(16);
        const locNames = nearbyLocs.slice(0, 20).map(l => `${l.debugname}@(${l.x},${l.z})`).join(', ');
        throw new Error(`Grate (witchgrill) not found near (${bot.player.x},${bot.player.z}). Nearby locs: [${locNames}]`);
    }
    await bot.interactLoc(grill, 1); // op1 = Listen-at
    await bot.waitForTicks(3);

    // The grill interaction triggers a long dialog sequence between witch, knight, and greldo
    // chatnpc_specific "Black Knight" -> "So, how's the secret weapon coming along?"
    // chatnpc_specific "Witch" -> several lines about invincibility potion
    // chatnpc_specific "Greldo" -> "Yes mithreth."
    // Then varp increments to 2
    for (let i = 0; i < 20; i++) {
        const hasDialog = await bot.waitForDialog(10);
        if (!hasDialog) break;
        if (bot.isMultiChoiceOpen()) break;
        await bot.continueDialog();
    }

    await bot.waitForTicks(3);

    // Verify we've advanced to stage 2
    const varpAfterGrill = bot.getQuestProgress(BKF_VARP);
    if (varpAfterGrill !== STAGE_LISTENED) {
        throw new Error(`Quest varp after listening at grate is ${varpAfterGrill}, expected ${STAGE_LISTENED}`);
    }
    bot.log('EVENT', `Listened at grate: varp=${varpAfterGrill}`);

    // Step 8: Navigate back up and to the hole on level 1
    // Need to go back up through the fortress to reach (3031, 3508, 1)
    // Climb up the ladder we came down
    bot.log('STATE', '--- Navigating to cabbage hole on level 1 ---');

    // Walk back toward the ladder area
    // First, find a ladder up nearby
    let ladderUp = bot.findNearbyLoc('loc_1747', 16);
    if (!ladderUp) {
        ladderUp = bot.findNearbyLoc('loc_1750', 16);
    }
    if (!ladderUp) {
        ladderUp = bot.findNearbyLoc('loc_1755', 16);
    }

    if (ladderUp) {
        bot.log('ACTION', `Climbing up ladder at (${ladderUp.x},${ladderUp.z})`);
        await bot.interactLoc(ladderUp, 1); // op1 = Climb-up
        await bot.waitForTicks(3);
    }

    // If we're not on level 1 yet, search more broadly
    if ((bot.player.level as number) !== 1) {
        // Try walking around to find a ladder
        const allLocs = bot.findAllNearbyLocs(20);
        for (const locInfo of allLocs) {
            if (locInfo.displayName === 'Ladder' && (locInfo.debugname.includes('1747') || locInfo.debugname.includes('1750') || locInfo.debugname.includes('1755'))) {
                bot.log('STATE', `Trying ladder up: ${locInfo.debugname} at (${locInfo.x},${locInfo.z})`);
                await bot.interactLoc(locInfo.loc, 1);
                await bot.waitForTicks(3);
                if ((bot.player.level as number) === 1) break;
            }
        }
    }

    if ((bot.player.level as number) !== 1) {
        throw new Error(`Failed to climb to level 1 for cabbage hole: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    bot.log('STATE', `On fortress level 1: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Walk to the hole location (3031, 3508, 1)
    await bot.walkToWithPathfinding(HOLE_X, HOLE_Z);
    bot.log('STATE', `Near cabbage hole: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Step 9: Use cabbage on the hole (blackknighthole)
    bot.log('ACTION', 'Using cabbage on hole (blackknighthole)');
    await bot.useItemOnLoc('Cabbage', 'blackknighthole');
    await bot.waitForTicks(3);

    // The script shows several messages:
    // "You drop a cabbage down the hole." -> p_delay(2)
    // "The cabbage lands in the cauldron below." -> p_delay(2)
    // "The mixture starts to froth and bubble." -> p_delay(2)
    // "You hear the witch groan in dismay." -> p_delay(2)
    // chatplayer "Right I think that's successfully sabotaged..."
    // varp increments to 3

    // Wait for the message sequence to complete
    await bot.waitForTicks(12);

    // Continue through remaining dialog
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

    // Walk south out of the fortress and back to Falador
    bot.log('STATE', `Leaving fortress: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    await bot.walkToWithPathfinding(3016, 3510);
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
            await questFn(bot);
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
                    // Leave castle if on upper floor
                    if ((bot.player.level as number) > 0) {
                        await leaveWhiteKnightsCastle(bot);
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
