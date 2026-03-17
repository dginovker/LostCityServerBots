import { BotAPI } from '../../runtime/api.js';
import { skipTutorial } from '../skip-tutorial.js';
import { type BotState, type StateEntry, runStateMachine } from '../../runtime/state-machine.js';
import type { ScriptMeta } from '../../runtime/script-meta.js';
import { cooksAssistant, metadata as cooksAssistantMeta } from './cooks-assistant.js';
import { sheepShearer, metadata as sheepShearerMeta } from './sheep-shearer.js';
import { romeoAndJuliet, metadata as romeoMeta } from './romeo-and-juliet.js';
import { impCatcher, metadata as impCatcherMeta } from './imp-catcher.js';
import { runeMysteries, metadata as runeMystMeta } from './rune-mysteries.js';
import { princeAliRescue, metadata as princeAliMeta } from './prince-ali-rescue.js';
import { ensureWestOfTollGate } from '../shared-routes.js';

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
const _GRATE_X = 3025;
const _GRATE_Z = 3507;

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
    { x: 3016, z: 3513, name: 'South of fortress entrance door' },
];

// ---- Utility functions ----

/**
 * Pickpocket men in Lumbridge to earn GP.
 */
async function earnGp(bot: BotAPI, targetGp: number): Promise<void> {
    bot.log('STATE', `=== Earning ${targetGp}gp by pickpocketing men ===`);

    // Walk to Lumbridge spawn area where men roam
    await bot.walking.walkToWithPathfinding(LUMBRIDGE_X, LUMBRIDGE_Z);

    let attempts = 0;
    const MAX_ATTEMPTS = 800;

    while (attempts < MAX_ATTEMPTS) {
        const coins = bot.inventory.find('Coins');
        const currentGp = coins ? coins.count : 0;
        if (currentGp >= targetGp) {
            bot.log('EVENT', `Earned ${currentGp}gp (target: ${targetGp}gp) in ${attempts} pickpocket attempts`);
            return;
        }

        bot.dialog.dismissModals();

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

        let man = bot.interaction.findNpc('Man');
        if (!man) {
            await bot.walking.walkTo(LUMBRIDGE_X, LUMBRIDGE_Z);
            await bot.waitForTicks(2);
            man = bot.interaction.findNpc('Man');
            if (!man) {
                throw new Error(`No Man NPC found near (${LUMBRIDGE_X},${LUMBRIDGE_Z})`);
            }
        }

        attempts++;
        await bot.interaction.npc(man, 3); // op3 = Pickpocket
        await bot.waitForTicks(5);
        await bot.waitForTicks(1);
        bot.dialog.dismissModals();
    }

    const finalCoins = bot.inventory.find('Coins');
    throw new Error(`Failed to earn ${targetGp}gp after ${MAX_ATTEMPTS} attempts. Current gp: ${finalCoins ? finalCoins.count : 0}`);
}

/**
 * Walk along a series of waypoints.
 */
async function walkRoute(bot: BotAPI, waypoints: { x: number; z: number; name: string }[]): Promise<void> {
    for (const wp of waypoints) {
        bot.log('STATE', `Walking to ${wp.name} (${wp.x},${wp.z})`);
        await bot.walking.walkToWithPathfinding(wp.x, wp.z);
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
    const coins = bot.inventory.find('Coins');
    const currentGp = coins ? coins.count : 0;
    bot.log('STATE', `Current GP: ${currentGp}`);

    // Need at least 500gp (400 for equipment + safety margin)
    if (currentGp < 500) {
        // Walk to Lumbridge to pickpocket
        await bot.walking.walkToWithPathfinding(LUMBRIDGE_X, LUMBRIDGE_Z);
        await earnGp(bot, 500);
    }

    // Step 1: Buy bronze med helm from Peksa if not already owned
    if (!bot.inventory.find('Bronze med helm')) {
        bot.log('STATE', '--- Buying bronze med helm from Peksa ---');
        // Navigate to Barbarian Village avoiding the diagonal fencing,
        // then walk into Peksa's shop through the door at (3076,3427).
        await bot.walking.walkToWithPathfinding(3082, 3336); // South of fence
        await bot.walking.walkToWithPathfinding(PEKSA_X, PEKSA_Z); // Near shop
        // Open the shop door and walk inside
        await bot.interaction.openDoor('inaccastledoubledoorropen');
        await bot.walking.walkToWithPathfinding(3075, 3429); // Inside shop

        // Use op3=Trade to directly open shop (like other working scripts)
        const peksa = bot.interaction.findNpc('Peksa');
        if (!peksa) {
            throw new Error(`Peksa not found near (${bot.player.x},${bot.player.z})`);
        }
        bot.log('ACTION', `Trading with Peksa at (${peksa.x},${peksa.z})`);
        await bot.interaction.npc(peksa, 3); // op3 = Trade
        await bot.waitForTicks(5);
        await bot.shop.buy('Bronze med helm', 1);
        bot.dialog.dismissModals();

        if (!bot.inventory.find('Bronze med helm')) {
            throw new Error('Failed to buy Bronze med helm from Peksa');
        }
        bot.log('EVENT', 'Bought Bronze med helm');
    }

    // Step 2: Buy iron chainbody from Wayne if not already owned
    if (!bot.inventory.find('Iron chainbody')) {
        bot.log('STATE', '--- Buying iron chainbody from Wayne ---');
        // Navigate south from Barbarian Village (avoid fencing and Draynor Manor),
        // then west to Falador and Wayne's shop
        await bot.walking.walkToWithPathfinding(3082, 3250); // South below all fences/buildings
        await bot.walking.walkToWithPathfinding(2970, 3310); // West to Falador
        await bot.walking.walkToWithPathfinding(WAYNE_X, WAYNE_Z);

        // Use op3=Trade to directly open shop
        const wayne = bot.interaction.findNpc('Wayne');
        if (!wayne) {
            throw new Error(`Wayne not found near (${bot.player.x},${bot.player.z})`);
        }
        bot.log('ACTION', `Trading with Wayne at (${wayne.x},${wayne.z})`);
        await bot.interaction.npc(wayne, 3); // op3 = Trade
        await bot.waitForTicks(5);
        await bot.shop.buy('Iron chainbody', 1);
        bot.dialog.dismissModals();

        if (!bot.inventory.find('Iron chainbody')) {
            throw new Error('Failed to buy Iron chainbody from Wayne');
        }
        bot.log('EVENT', 'Bought Iron chainbody');
    }

    // Step 3: Pick a cabbage if not already owned
    if (!bot.inventory.find('Cabbage')) {
        bot.log('STATE', '--- Picking cabbage from field ---');
        await bot.walking.walkToWithPathfinding(CABBAGE_FIELD_X, CABBAGE_FIELD_Z);

        // Look for a cabbage loc nearby and pick it (op2=Pick)
        for (let attempt = 0; attempt < 5; attempt++) {
            const cabbageLoc = bot.interaction.findLoc('cabbage', 10);
            if (cabbageLoc) {
                bot.log('ACTION', `Found cabbage loc at (${cabbageLoc.x},${cabbageLoc.z})`);
                await bot.interaction.loc(cabbageLoc, 2); // op2 = Pick
                await bot.waitForTicks(5);

                const cabbage = bot.inventory.find('Cabbage');
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
            await bot.walking.walkToWithPathfinding(offset.x, offset.z);
            await bot.waitForTicks(3);
        }

        const cabbage = bot.inventory.find('Cabbage');
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
        await bot.walking.walkToWithPathfinding(FALADOR_CASTLE_ENTRANCE_X, FALADOR_CASTLE_ENTRANCE_Z);
        bot.log('STATE', `At castle entrance: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

        // Walk inside toward the stairwell on the west side
        await bot.walking.walkToWithPathfinding(2960, 3339);
        bot.log('STATE', `Near castle stairs: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

        // Climb up from level 0 to level 1 (loc_1738 at (2954,3338))
        await bot.interaction.climbStairs('loc_1738', 1); // op1=Climb-up
        await bot.waitForTicks(3);

        if ((bot.player.level as number) !== 1) {
            throw new Error(`Failed to climb to level 1 in White Knights' Castle: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
        }
        bot.log('STATE', `On level 1: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }

    if ((bot.player.level as number) === 1) {
        // Find the staircase on level 1 to climb to level 2
        const l1Locs = bot.interaction.findAllLocs(20);
        const l1Stairs = l1Locs.filter(l => l.displayName === 'Staircase');
        bot.log('STATE', `Level 1 staircases: ${l1Stairs.map(s => `${s.debugname}@(${s.x},${s.z})`).join(', ') || 'NONE'}`);

        // Try loc_1739 (mid-level, op2=Climb-up), then any staircase with Climb-up
        let stairsUp = bot.interaction.findLoc('loc_1739', 20);
        if (!stairsUp) stairsUp = bot.interaction.findLoc('loc_1738', 20);
        if (!stairsUp) stairsUp = bot.interaction.findLoc('loc_1742', 20);
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
        await bot.interaction.climbStairs(stairDebugName, climbUpOp);
        await bot.waitForTicks(3);

        if ((bot.player.level as number) !== 2) {
            throw new Error(`Failed to climb to level 2 in White Knights' Castle: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
        }
        bot.log('STATE', `On level 2: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }

    // Walk to Sir Amik Varze's area (use walkTo on upper floors — no pathfinding data)
    await bot.walking.walkTo(SIR_AMIK_X, SIR_AMIK_Z);
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
        const l2Locs = bot.interaction.findAllLocs(20);
        const l2Stairs = l2Locs.filter(l => l.displayName === 'Staircase');
        bot.log('STATE', `Level 2 staircases: ${l2Stairs.map(s => `${s.debugname}@(${s.x},${s.z})`).join(', ') || 'NONE'}`);

        // loc_1739 has op3=Climb-down; loc_1740/loc_1736 have op1=Climb-down
        let downStairs = bot.interaction.findLoc('loc_1739', 20);
        if (downStairs) {
            await bot.interaction.climbStairs('loc_1739', 3); // op3=Climb-down
        } else {
            downStairs = bot.interaction.findLoc('loc_1740', 20) ?? bot.interaction.findLoc('loc_1736', 20);
            if (!downStairs) {
                throw new Error(`No Climb-down staircase on level 2 near (${bot.player.x},${bot.player.z})`);
            }
            await bot.interaction.loc(downStairs, 1); // op1=Climb-down
        }
        await bot.waitForTicks(5);

        if ((bot.player.level as number) !== 1) {
            throw new Error(`Failed to climb down to level 1: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
        }
        bot.log('STATE', `On level 1: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }

    // Climb down from level 1 to level 0
    if ((bot.player.level as number) === 1) {
        const l1Locs = bot.interaction.findAllLocs(20);
        const l1Stairs = l1Locs.filter(l => l.displayName === 'Staircase');
        bot.log('STATE', `Level 1 staircases: ${l1Stairs.map(s => `${s.debugname}@(${s.x},${s.z})`).join(', ') || 'NONE'}`);

        let downStairs = bot.interaction.findLoc('loc_1740', 20) ?? bot.interaction.findLoc('loc_1736', 20) ?? bot.interaction.findLoc('loc_1733', 20) ?? bot.interaction.findLoc('loc_1723', 20);
        if (downStairs) {
            await bot.interaction.loc(downStairs, 1); // op1=Climb-down
        } else {
            // Try loc_1739 with op3=Climb-down
            downStairs = bot.interaction.findLoc('loc_1739', 20);
            if (!downStairs) {
                throw new Error(`No Climb-down staircase on level 1 near (${bot.player.x},${bot.player.z}). Staircases: ${l1Stairs.map(s => `${s.debugname}@(${s.x},${s.z})`).join(', ')}`);
            }
            await bot.interaction.climbStairs('loc_1739', 3);
        }
        await bot.waitForTicks(5);

        if ((bot.player.level as number) !== 0) {
            throw new Error(`Failed to climb down to level 0: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
        }
    }

    // Walk out of the castle
    await bot.walking.walkToWithPathfinding(FALADOR_CASTLE_ENTRANCE_X, FALADOR_CASTLE_ENTRANCE_Z);
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

    await bot.interaction.talkToNpc('Sir Amik Varze');

    // chatnpc "I am the leader of the White Knights..."
    await bot.dialog.waitFor(15);
    await bot.dialog.continue();

    // p_choice2: "I seek a quest!" (1), "I don't..." (2)
    await bot.dialog.waitFor(10);
    await bot.dialog.selectOption(1); // "I seek a quest!"

    // chatplayer "I seek a quest."
    await bot.dialog.waitFor(10);
    await bot.dialog.continue();

    // chatnpc "Well, I need some spy work doing..."
    await bot.dialog.waitFor(10);
    await bot.dialog.continue();

    // p_choice2: "I laugh in the face of danger!" (1), "I go and cower..." (2)
    await bot.dialog.waitFor(10);
    await bot.dialog.selectOption(1); // "I laugh in the face of danger!"

    // chatplayer "I laugh in the face of danger."
    await bot.dialog.waitFor(10);
    await bot.dialog.continue();

    // chatnpc "Well that's good. Don't get too overconfident though."
    await bot.dialog.waitFor(10);
    await bot.dialog.continue();

    // @black_knights_fortress_sir_amik_come_along_at_the_right_time
    // chatnpc "You've come along just right actually..."
    await bot.dialog.waitFor(10);
    await bot.dialog.continue();

    // chatnpc "Subtlety isn't exactly our strong point."
    await bot.dialog.waitFor(10);
    await bot.dialog.continue();

    // chatplayer "So what needs doing?"
    await bot.dialog.waitFor(10);
    await bot.dialog.continue();

    // chatnpc "Well the Black Knights have started making strange threats..."
    await bot.dialog.waitFor(10);
    await bot.dialog.continue();

    // chatnpc "Now normally this wouldn't be a problem."
    await bot.dialog.waitFor(10);
    await bot.dialog.continue();

    // chatnpc "But they claim to have a powerful new secret weapon."
    await bot.dialog.waitFor(10);
    await bot.dialog.continue();

    // chatnpc "What I want you to do is get inside their fortress..."
    await bot.dialog.waitFor(10);
    await bot.dialog.continue();

    // chatplayer "Ok, I'll give it a try." -> varp set to 1
    await bot.dialog.waitFor(10);
    await bot.dialog.continue();

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
    const lobster = bot.inventory.find('Lobster');
    if (!lobster) return;
    bot.log('ACTION', `Eating Lobster (HP=${health.current}/${health.max})`);
    await bot.interaction.useItemOp1('Lobster');
    await bot.waitForTicks(2);
}

/**
 * Navigate through the Black Knights' Fortress to the grate,
 * listen to the witch's conversation, then sabotage the potion.
 *
 * Fortress layout (RS2 dev comments: 3025 3508 0=Grate L0, 3031 3508 1=Hole L1):
 * - bkfortressdoor1: main entrance (north wall ~z=3513), disguise required
 * - bkfortressdoor2: banquet-hall north-wing door — guard dialog before entry
 * - loc_1750@(3022,3518,L1): ladder up to L1 (in banquet hall)
 * - bkfortressdoor3@L1: going west triggers guard aggro; has "ladder down to grill" nearby
 * - witchgrill@(3025,3507,L0): WALLDECOR_STRAIGHT_OFFSET angle=EAST — approach from (3026,3507)
 *   Accessible from L0 via the ladder down near door3.
 * - bksecretdoor@(~3030,3510,L1): secret wall → hole room
 * - blackknighthole@(3031,3507,L1): use cabbage here (varp 2→3)
 *
 * Route:
 * 1. Equip disguise, walk to fortress (z=3514 area)
 * 2. Ghost-path through door1 → west corridor (L0)
 * 3. Walk back north → find door2 → guard dialog → banquet hall (L0)
 * 4. Climb loc_1750 → L1
 * 5. Open door3 (guard aggro)
 * 6. Descend ladder → L0 kitchen; PHASE 1: listen at witchgrill (varp 1→2)
 * 7. Ascend back to L1
 * 8. Push bksecretdoor; PHASE 2: use cabbage on hole (varp 2→3)
 */
async function infiltrateFortress(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Infiltrating Black Knights\' Fortress ===');

    // Equip the disguise (needed for bkfortressdoor1)
    const helmBefore = bot.inventory.find('Bronze med helm');
    const chainBefore = bot.inventory.find('Iron chainbody');
    bot.log('STATE', `Pre-equip: helm=${helmBefore ? `slot${helmBefore.slot}` : 'NOT FOUND'} chain=${chainBefore ? `slot${chainBefore.slot}` : 'NOT FOUND'} protect=${bot.player.protect} delayed=${bot.player.delayed} defence=${bot.player.baseLevels[1]}`);
    if (helmBefore) await bot.interaction.equipItem('Bronze med helm');
    if (chainBefore) await bot.interaction.equipItem('Iron chainbody');
    await bot.waitForTicks(2);
    const helmAfter = bot.inventory.find('Bronze med helm');
    const chainAfter = bot.inventory.find('Iron chainbody');
    // Dump all player inventory states for diagnosis
    {
        const invMap = (bot.player as any).invs as Map<number, any>;
        let invDump = '';
        for (const [key, inv] of invMap.entries()) {
            const items: string[] = [];
            for (let s = 0; s < inv.capacity; s++) {
                if (inv.items[s]) items.push(`s${s}:id${inv.items[s].id}`);
            }
            if (items.length > 0) invDump += `inv${key}[${items.join(',')}] `;
        }
        bot.log('STATE', `Inv dump: ${invDump || '(empty)'}`);
    }
    bot.log('STATE', `Post-equip: helm=${helmAfter ? `still_in_inv_slot${helmAfter.slot}` : 'EQUIPPED'} chain=${chainAfter ? `still_in_inv_slot${chainAfter.slot}` : 'EQUIPPED'}`);

    // Walk to the fortress entrance exterior
    await walkRoute(bot, FALADOR_TO_FORTRESS);
    bot.log('STATE', `At fortress entrance exterior: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    await eatLobster(bot);

    // ---- Diagnose door1 reach ----
    {
        const d = bot.interaction.findLoc('bkfortressdoor1', 5);
        if (d) {
            bot.log('STATE', `door1 at (${d.x},${d.z},L${d.level}) shape=${d.shape} angle=${d.angle} type=${d.type}`);
            bot.debugLocReach(d);
        } else {
            bot.log('STATE', 'door1 NOT FOUND near fortress entrance');
        }
    }
    // ---- Enter fortress via door1 and reach staircase to L1 ----
    // bkfortressdoor1 at (3016,3514). The staircase (loc_1750) to L1 is at (3015,3519).
    // Approach is from south (3015,3518) which must be entered from east (3016,3518).
    // Walk to (3016,3518) inside the corridor; interactLoc will route west to (3015,3518).
    bot.log('STATE', `Before fortress entry: pos=(${bot.player.x},${bot.player.z},L${bot.player.level})`);
    await bot.walking.walkToWithPathfinding(3016, 3518);
    bot.log('STATE', `Inside fortress near staircase: pos=(${bot.player.x},${bot.player.z},L${bot.player.level})`);
    if ((bot.player.z as number) < 3515) {
        throw new Error(`Failed to enter fortress: pos=(${bot.player.x},${bot.player.z})`);
    }
    await eatLobster(bot);

    // ---- Climb loc_1750@(3015,3519) to L1 ----
    {
        const ladder = bot.interaction.findLoc('loc_1750', 10);
        if (ladder) {
            bot.log('STATE', `loc_1750 at (${ladder.x},${ladder.z},L${ladder.level}) shape=${ladder.shape} angle=${ladder.angle} fa=${ladder.type}`);
            bot.debugLocReach(ladder);
        } else {
            bot.log('STATE', `loc_1750 NOT FOUND near (${bot.player.x},${bot.player.z})`);
        }
    }
    await bot.interaction.climbStairs('loc_1750', 1);
    if ((bot.player.level as number) !== 1) {
        throw new Error(`Failed to reach L1 via loc_1750: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    bot.log('STATE', `On L1: pos=(${bot.player.x},${bot.player.z})`);

    await eatLobster(bot);

    // ---- Navigate to and open bkfortressdoor3 on L1 ----
    let door3 = bot.interaction.findLoc('bkfortressdoor3', 15);
    if (!door3) {
        bot.player.queueWaypoint(3028, 3517);
        for (let i = 0; i < 20; i++) {
            await bot.waitForTick();
            if (Math.abs(bot.player.x - 3028) <= 2) break;
        }
        door3 = bot.interaction.findLoc('bkfortressdoor3', 10);
    }
    if (!door3) {
        const allL1 = bot.interaction.findAllLocs(15);
        throw new Error(`bkfortressdoor3 not found. L1 locs: ${allL1.map(l => `${l.debugname}@(${l.x},${l.z})`).join(', ')}`);
    }
    bot.log('STATE', `Found bkfortressdoor3 at (${door3.x},${door3.z})`);
    await bot.interaction.loc(door3, 1);
    await bot.waitForTicks(5);
    await bot.dialog.clearPendingState();
    bot.log('STATE', `After bkfortressdoor3: pos=(${bot.player.x},${bot.player.z},L${bot.player.level})`);

    await eatLobster(bot);

    // ---- Descend ladder to L0 kitchen (near bkfortressdoor3) ----
    // The RS2 dev comment on door3 says "ladder down to the grill" is nearby.
    // Try standard ladder-down loc types (loc_1749, loc_1746).
    let ladderDown = bot.interaction.findLoc('loc_1749', 12) ?? bot.interaction.findLoc('loc_1746', 12);
    if (!ladderDown) {
        // Walk toward grill area on L1 and search again
        bot.player.queueWaypoint(3028, 3511);
        for (let i = 0; i < 15; i++) {
            await bot.waitForTick();
            if (Math.abs(bot.player.z - 3511) <= 2) break;
        }
        ladderDown = bot.interaction.findLoc('loc_1749', 10) ?? bot.interaction.findLoc('loc_1746', 10);
    }
    if (!ladderDown) {
        const allLocs = bot.interaction.findAllLocs(15).map(l => `${l.debugname}@(${l.x},${l.z})`).join(', ');
        throw new Error(`Ladder down to grill not found near (${bot.player.x},${bot.player.z},L1) after door3. Nearby locs: ${allLocs}`);
    }
    bot.log('STATE', `Found ladder down: type=${ladderDown.type} shape=${ladderDown.shape} at (${ladderDown.x},${ladderDown.z})`);
    await bot.interaction.loc(ladderDown, 1);
    await bot.waitForTicks(3);
    if ((bot.player.level as number) !== 0) {
        // Some ladders use op2 for Climb-down
        await bot.interaction.loc(ladderDown, 2);
        await bot.waitForTicks(3);
    }
    if ((bot.player.level as number) !== 0) {
        throw new Error(`Failed to descend to L0 from ladder: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    bot.log('STATE', `Descended to L0 kitchen: pos=(${bot.player.x},${bot.player.z})`);

    await eatLobster(bot);

    // ---- PHASE 1: Listen at witchgrill ----
    // witchgrill at (3025,3507), shape=5 WALLDECOR_STRAIGHT_OFFSET, angle=EAST=2.
    // Approach from east: (3026,3507) — accessible from the L0 kitchen.
    const grill = bot.interaction.findLoc('witchgrill', 10);
    if (!grill) {
        const allLocs = bot.interaction.findAllLocs(15).map(l => `${l.debugname}@(${l.x},${l.z})`).join(', ');
        throw new Error(`witchgrill not found near (${bot.player.x},${bot.player.z},L0). Nearby locs: ${allLocs}`);
    }
    bot.log('STATE', `witchgrill: shape=${grill.shape} angle=${grill.angle} at (${grill.x},${grill.z})`);

    await bot.interaction.loc(grill, 1);
    // Handle 9 chatnpc_specific dialogs (witch's conversation about the secret weapon)
    for (let j = 0; j < 15; j++) {
        const hasDialog = await bot.dialog.waitFor(5);
        if (!hasDialog) break;
        if (bot.dialog.isMultiChoiceOpen()) break;
        await bot.dialog.continue();
    }
    await bot.waitForTicks(3);
    bot.dialog.dismissModals();
    bot.log('STATE', `After grill: pos=(${bot.player.x},${bot.player.z}), varp=${bot.getQuestProgress(BKF_VARP)}`);

    const varpAfterGrill = bot.getQuestProgress(BKF_VARP);
    if (varpAfterGrill !== STAGE_LISTENED) {
        throw new Error(`Quest varp after grill is ${varpAfterGrill}, expected ${STAGE_LISTENED}. Bot at (${bot.player.x},${bot.player.z},L${bot.player.level})`);
    }
    bot.log('EVENT', `Listened at grate: varp=${varpAfterGrill}`);

    // ---- Ascend back to L1 ----
    // The same ladder (or a nearby one) takes the bot back to L1.
    const ladderUp2 = bot.interaction.findLoc('loc_1749', 10) ?? bot.interaction.findLoc('loc_1746', 10) ?? bot.interaction.findLoc('loc_1750', 10);
    if (!ladderUp2) {
        const allLocs = bot.interaction.findAllLocs(12).map(l => `${l.debugname}@(${l.x},${l.z})`).join(', ');
        throw new Error(`Ladder up not found near (${bot.player.x},${bot.player.z},L0) after grill. Nearby: ${allLocs}`);
    }
    bot.log('STATE', `Found ladder up: type=${ladderUp2.type} shape=${ladderUp2.shape} at (${ladderUp2.x},${ladderUp2.z})`);
    await bot.interaction.loc(ladderUp2, 1);
    await bot.waitForTicks(3);
    if ((bot.player.level as number) !== 1) {
        await bot.interaction.loc(ladderUp2, 2);
        await bot.waitForTicks(3);
    }
    if ((bot.player.level as number) !== 1) {
        throw new Error(`Failed to ascend to L1 after grill: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    bot.log('STATE', `Back on L1: pos=(${bot.player.x},${bot.player.z})`);

    await eatLobster(bot);

    // ---- PHASE 2: Push bksecretdoor → hole ----
    bot.player.queueWaypoint(3030, 3511);
    for (let i = 0; i < 20; i++) {
        await bot.waitForTick();
        if (Math.abs(bot.player.x - 3030) <= 2 && Math.abs(bot.player.z - 3511) <= 2) break;
    }
    const secretWall = bot.interaction.findLoc('bksecretdoor', 4);
    if (!secretWall) throw new Error(`bksecretdoor not found near (${bot.player.x},${bot.player.z})`);
    await bot.interaction.loc(secretWall, 1);
    await bot.waitForTicks(5);
    await bot.dialog.clearPendingState();
    bot.log('STATE', `After bksecretdoor: pos=(${bot.player.x},${bot.player.z})`);

    await eatLobster(bot);

    // Walk to blackknighthole@(3031,3507,1) and use cabbage
    bot.player.queueWaypoint(HOLE_X, HOLE_Z);
    for (let i = 0; i < 20; i++) {
        await bot.waitForTick();
        if (Math.abs(bot.player.x - HOLE_X) <= 2 && Math.abs(bot.player.z - HOLE_Z) <= 2) break;
    }
    bot.log('STATE', `At hole: pos=(${bot.player.x},${bot.player.z})`);

    await bot.interaction.useItemOnLoc('Cabbage', 'blackknighthole');

    // mes × 4 (each with p_delay(2)), then chatplayer
    await bot.waitForTicks(12);
    for (let i = 0; i < 10; i++) {
        const hasDialog = await bot.dialog.waitFor(5);
        if (!hasDialog) break;
        if (bot.dialog.isMultiChoiceOpen()) break;
        await bot.dialog.continue();
    }
    await bot.waitForTicks(3);
    bot.dialog.dismissModals();

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
        const ladderDown = bot.interaction.findLoc('loc_1746', 16) ?? bot.interaction.findLoc('loc_1749', 16);
        if (ladderDown) {
            await bot.interaction.loc(ladderDown, 1);
            await bot.waitForTicks(3);
        }
    }

    // Walk out of the fortress and back to Falador via west side of Ice Mountain
    bot.log('STATE', `Leaving fortress: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    // Route notes:
    // - Going west from (3016,3514) to (3006,3514) is blocked by the fortress north-face wall.
    // - Going (2998,3507)->(3008,3475)->(2985,3430) fails: (3008,3475)->(2985,3430) cuts
    //   through Ice Mountain terrain southbound (even though the northbound reverse works).
    // - Stay on the west side of Ice Mountain (x<3000) when going south.
    await bot.walking.walkToWithPathfinding(2998, 3507);  // West of cliff (proven from 3016,3514)
    await bot.walking.walkToWithPathfinding(2990, 3475);  // South-west, west of Ice Mountain
    await bot.walking.walkToWithPathfinding(2985, 3430);  // South to Falador road
    await bot.walking.walkToWithPathfinding(2970, 3370);  // Falador
    await bot.walking.walkToWithPathfinding(FALADOR_CASTLE_ENTRANCE_X, FALADOR_CASTLE_ENTRANCE_Z);

    // Navigate to Sir Amik Varze on level 2
    await walkToSirAmik(bot);

    // Talk to Sir Amik to turn in the quest
    await bot.interaction.talkToNpc('Sir Amik Varze');

    // chatplayer "I have ruined the Black Knight's invincibility potion..."
    await bot.dialog.waitFor(15);
    await bot.dialog.continue();

    // chatnpc "Yes we have just received a message from the Black Knights..."
    await bot.dialog.waitFor(10);
    await bot.dialog.continue();

    // chatplayer "You said you were going to pay me."
    await bot.dialog.waitFor(10);
    await bot.dialog.continue();

    // chatnpc "Yes, that's right."
    // -> varp becomes 4 (complete)
    // -> queue(black_knights_fortress_quest_complete)
    await bot.dialog.waitFor(10);
    await bot.dialog.continue();

    // Wait for the queued script to fire (gives 2500gp + quest complete)
    await bot.waitForTicks(5);

    // Dismiss quest complete interface
    bot.dialog.dismissModals();

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
    questFn: (bot: BotAPI) => Promise<void>,
    entrySnapshot?: StateEntry
): BotState {
    return {
        name,
        entrySnapshot,
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
            prerequisiteState('prereq/cooks-assistant', bot, cooksAssistantMeta, cooksAssistant, {
                position: { x: 3222, z: 3218, level: 0 },
                varps: { 101: 0, [BKF_VARP]: 0 },
                items: ['Bronze pickaxe'],
            }),
            prerequisiteState('prereq/sheep-shearer', bot, sheepShearerMeta, sheepShearer, {
                position: { x: 3208, z: 3211, level: 0 },
                varps: { 101: 1, [BKF_VARP]: 0 },
                items: [{ name: 'Bronze pickaxe', count: 2 }, { name: 'Coins', count: 9 }],
                skills: { COOKING: 4 },
            }),
            prerequisiteState('prereq/romeo-and-juliet', bot, romeoMeta, romeoAndJuliet, {
                position: { x: 3191, z: 3277, level: 0 },
                varps: { 101: 2, [BKF_VARP]: 0 },
                items: [{ name: 'Bronze pickaxe', count: 3 }, { name: 'Coins', count: 68 }, 'Shears'],
                skills: { COOKING: 4, CRAFTING: 3 },
            }),
            prerequisiteState('prereq/rune-mysteries', bot, runeMystMeta, runeMysteries, {
                position: { x: 3212, z: 3425, level: 0 },
                varps: { 101: 7, [BKF_VARP]: 0 },
                items: [{ name: 'Bronze pickaxe', count: 4 }, { name: 'Coins', count: 68 }, 'Shears'],
                skills: { COOKING: 4, CRAFTING: 3 },
            }),
            prerequisiteState('prereq/imp-catcher', bot, impCatcherMeta, impCatcher, {
                position: { x: 3102, z: 9569, level: 0 },
                varps: { 101: 8, [BKF_VARP]: 0 },
                items: [{ name: 'Bronze pickaxe', count: 5 }, { name: 'Coins', count: 68 }, 'Shears', 'Air talisman'],
                skills: { COOKING: 4, CRAFTING: 3 },
            }),
            prerequisiteState('prereq/prince-ali-rescue', bot, princeAliMeta, princeAliRescue, {
                position: { x: 3107, z: 3162, level: 2 },
                varps: { 101: 9, [BKF_VARP]: 0 },
                items: [
                    'Amulet of accuracy',
                    { name: 'Bronze pickaxe', count: 4 },
                    { name: 'Coins', count: 68 },
                    'Shears',
                    'Air talisman',
                ],
                skills: { ATTACK: 20, HITPOINTS: 15, MAGIC: 8, COOKING: 4, CRAFTING: 3 },
            }),
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
                    return bot.inventory.find('Bronze med helm') !== null &&
                           bot.inventory.find('Iron chainbody') !== null &&
                           bot.inventory.find('Cabbage') !== null;
                },
                stuckThreshold: 3000,
                entrySnapshot: {
                    position: { x: 3302, z: 3160, level: 0 },
                    varps: { 101: 12, [BKF_VARP]: STAGE_NOT_STARTED },
                    skills: { ATTACK: 20, HITPOINTS: 15, MAGIC: 8, COOKING: 4, CRAFTING: 3, THIEVING: 3 },
                    items: [
                        'Amulet of accuracy',
                        { name: 'Bronze pickaxe', count: 2 },
                        { name: 'Coins', count: 762 },
                        'Shears',
                        'Air talisman',
                        'Tinderbox',
                        'Bronze axe',
                    ],
                },
                run: async () => {
                    await acquireEquipment(bot);
                }
            },
            {
                name: 'start-quest',
                isComplete: () => bot.getQuestProgress(BKF_VARP) >= STAGE_STARTED,
                entrySnapshot: {
                    position: { x: 3054, z: 3287, level: 0 },
                    varps: { 101: 12, [BKF_VARP]: STAGE_NOT_STARTED },
                    skills: { ATTACK: 20, HITPOINTS: 15, MAGIC: 8, COOKING: 4, CRAFTING: 3, THIEVING: 3 },
                    items: [
                        'Amulet of accuracy',
                        { name: 'Bronze pickaxe', count: 2 },
                        { name: 'Coins', count: 528 },
                        'Shears',
                        'Air talisman',
                        'Bronze med helm',
                        'Iron chainbody',
                        'Cabbage',
                        'Tinderbox',
                        'Bronze axe',
                    ],
                },
                run: async () => {
                    await walkToSirAmik(bot);
                    await startQuest(bot);
                }
            },
            {
                name: 'infiltrate-and-sabotage',
                isComplete: () => bot.getQuestProgress(BKF_VARP) >= STAGE_SABOTAGED,
                stuckThreshold: 3000,
                entrySnapshot: {
                    position: { x: 2963, z: 3338, level: 2 },
                    varps: { 101: 12, [BKF_VARP]: STAGE_STARTED },
                    skills: { ATTACK: 20, DEFENCE: 1, STRENGTH: 1, MAGIC: 8, HITPOINTS: 15, COOKING: 4, CRAFTING: 3, THIEVING: 3 },
                    items: [
                        { name: 'Amulet of accuracy', count: 1 },
                        { name: 'Bronze pickaxe', count: 1 },
                        { name: 'Coins', count: 528 },
                        { name: 'Shears', count: 1 },
                        { name: 'Air talisman', count: 1 },
                        { name: 'Bronze med helm', count: 1 },
                        { name: 'Iron chainbody', count: 1 },
                        { name: 'Cabbage', count: 1 },
                        { name: 'Lobster', count: 5 },
                        { name: 'Tinderbox', count: 1 },
                        { name: 'Bronze axe', count: 1 },
                    ],
                },
                run: async () => {
                    // On retry, bot might be stuck on upper floors inside the fortress.
                    // The leaveWhiteKnightsCastle function is only for White Knights' Castle.
                    // If inside the fortress (upper floor), try to climb down first.
                    if ((bot.player.level as number) > 0) {
                        bot.log('STATE', `On level ${bot.player.level} at (${bot.player.x},${bot.player.z}), trying to descend`);
                        // Look for any climb-down ladder
                        const downLadder = bot.interaction.findLoc('loc_1749', 16) ?? bot.interaction.findLoc('loc_1746', 16) ?? bot.interaction.findLoc('loc_1740', 16);
                        if (downLadder) {
                            await bot.interaction.loc(downLadder, 1);
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
                entrySnapshot: {
                    position: { x: 3016, z: 3514, level: 0 },
                    varps: { 101: 12, [BKF_VARP]: STAGE_SABOTAGED },
                    skills: { ATTACK: 20, HITPOINTS: 15, MAGIC: 8, COOKING: 4, CRAFTING: 3, THIEVING: 3 },
                    items: [
                        'Amulet of accuracy',
                        { name: 'Bronze pickaxe', count: 1 },
                        { name: 'Coins', count: 528 },
                        'Shears',
                        'Air talisman',
                        'Bronze med helm',
                        'Iron chainbody',
                        { name: 'Lobster', count: 3 },
                        'Tinderbox',
                        'Bronze axe',
                    ],
                },
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
    await runStateMachine(bot, { root, varpIds: [BKF_VARP, QP_VARP] });
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
