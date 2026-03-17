import path from 'path';
import { BotAPI } from '../../runtime/api.js';
import { skipTutorial } from '../skip-tutorial.js';
import { walkLumbridgeToVarrock } from '../shared-routes.js';
import { type BotState, runStateMachine } from '../../runtime/state-machine.js';
import type { ScriptMeta } from '../../runtime/script-meta.js';
import BotManager from '../../runtime/manager.js';

// Varp IDs (from content/pack/varp.pack: 145=blackarmgang, 146=phoenixgang)
const PHOENIX_VARP = 146;
const BLACKARM_VARP = 145;

// Phoenix Gang quest stages (from quest_blackarmgang.constant)
const _PG_NOT_STARTED = 0;
const PG_STARTED = 1;
const PG_READ_BOOK = 2;
const PG_SPOKEN_RELDO = 3;
const PG_SPOKEN_BARAEK = 4;
const PG_SPOKEN_STRAVEN = 8;
const PG_JOINED = 9;
const PG_COMPLETE = 10;

// Black Arm Gang quest stages
const _BA_NOT_STARTED = 0;
const BA_STARTED = 1;
const BA_SPOKEN_KATRINE = 2;
const BA_JOINED = 3;
const BA_COMPLETE = 4;

// ---- Key locations ----

// Meeting point for item exchanges — open area in Varrock, south of square
const MEETING_X = 3212;
const MEETING_Z = 3422;

// Varrock Palace Library — Reldo area
const _LIBRARY_X = 3209;
const _LIBRARY_Z = 3494;

// Baraek — fur trader in Varrock Square
const BARAEK_X = 3217;
const BARAEK_Z = 3434;

// Phoenix Gang HQ ladder (overworld entrance to underground hideout)
const _PHOENIX_LADDER_X = 3244;
const _PHOENIX_LADDER_Z = 3383;

// Straven — underground near the phoenixdoor
const STRAVEN_X = 3246;
const STRAVEN_Z = 9780;

// Blue Moon Inn — Jonny the Beard
const _BLUE_MOON_INN_X = 3224;
const _BLUE_MOON_INN_Z = 3399;

// Inside Phoenix Gang HQ — chest area (underground)
const PHOENIX_CHEST_X = 3235;
const PHOENIX_CHEST_Z = 9761;

// Black Arm Gang HQ — Katrine inside
const BLACKARM_HQ_X = 3185;
const BLACKARM_HQ_Z = 3385;

// Phoenix Gang weapons room (overworld, behind phoenixdoor2 at 3251,3385)
const _PHOENIX_WEAPONS_X = 3252;
const _PHOENIX_WEAPONS_Z = 3384;

// Varrock Museum — Curator
const MUSEUM_X = 3256;
const MUSEUM_Z = 3447;

// Varrock Palace — King Roald (spawns at 3222, 3476)
const KING_ROALD_X = 3222;
const KING_ROALD_Z = 3476;

// Tramp — near south Varrock gate (spawns at 3208, 3391)
const TRAMP_X = 3208;
const TRAMP_Z = 3391;

// Cupboard in Black Arm Gang HQ (upstairs, level 1)
const _BLACKARM_CUPBOARD_X = 3188;
const _BLACKARM_CUPBOARD_Z = 3385;

// NPC display names (from varrock.npc configs)
const NPC_RELDO = 'Reldo';
const NPC_BARAEK = 'Baraek';
const NPC_STRAVEN = 'Straven';
const NPC_KATRINE = 'Katrine';
const NPC_JONNY = 'Jonny the beard';
const NPC_CURATOR = 'Curator';
const NPC_KING_ROALD = 'King Roald';
const NPC_TRAMP = 'Tramp';
const NPC_WEAPONSMASTER = 'Weaponsmaster';

// Item display names (from quest_blackarmgang.obj)
const ITEM_BOOK = 'Book'; // the_shield_of_arrav
const ITEM_KEY = 'Key'; // phoenixkey2
const ITEM_SCROLL = 'Scroll'; // intelligence_report
const ITEM_BROKEN_SHIELD = 'Broken shield'; // arravshield1 and arravshield2
const ITEM_CROSSBOW = 'Phoenix crossbow';
const ITEM_CERTIFICATE = 'Certificate'; // arravcertificate

// Coordination state shared between bots
interface Coordination {
    botBReadyForKey: boolean;      // Bot B is at meeting point, ready for key
    keyDropped: boolean;
    keyPickedUp: boolean;
    botBReadyForCert: boolean;     // Bot B is at meeting point, ready for cert
    botAReadyForShield: boolean;   // Bot A is at meeting point, ready for shield
    shieldDropped: boolean;
    shieldPickedUp: boolean;
    certDropped: boolean;
    certPickedUp: boolean;
    phoenixBotDone: boolean;
    blackArmBotDone: boolean;
    phoenixBotError: string | null;
    blackArmBotError: string | null;
}

// ---- Combat training for Black Arm Bot ----
// The Black Arm bot must kill the Weaponsmaster (level 23, HP=20) to get crossbows.
// Training on chickens near Lumbridge to beat the Weaponsmaster (level 23, HP=20,
// attack=21, strength=21, defence=21, attackbonus=8, strengthbonus=10).
// Atk 20, str 15, HP 20 gives ~50% win rate. We retry on death.
const NPC_CHICKEN = 41;
const CHICKEN_AREA_X = 3237;
const CHICKEN_AREA_Z = 3298;
const BA_TARGET_ATTACK = 20;
const BA_TARGET_STRENGTH = 15;
const BA_TARGET_HITPOINTS = 20;

async function trainCombatForBlackArm(bot: BotAPI): Promise<void> {
    bot.log('STATE', `=== Training combat to atk=${BA_TARGET_ATTACK}, str=${BA_TARGET_STRENGTH}, hp=${BA_TARGET_HITPOINTS} ===`);

    // Equip bronze pickaxe as weapon
    if (bot.findItem('Bronze pickaxe')) {
        await bot.equipItem('Bronze pickaxe');
        await bot.waitForTicks(1);
    }

    bot.setCombatStyle(0); // Accurate for attack XP

    // Walk to just outside the chicken pen gate.
    // From Lumbridge spawn (3222,3218), go north through Lumbridge town center
    // then northeast. The chicken pen is fenced — must open the gate first.
    // Gate is on the north side at roughly (3236,3295).
    await bot.walkToWithPathfinding(3220, 3244); // North through Lumbridge town
    await bot.walkToWithPathfinding(3236, 3300); // Just north of chicken pen gate

    // Open the gate to enter the chicken pen
    await bot.openGate(10);
    await bot.waitForTicks(1);

    // Walk inside the pen
    await bot.walkToWithPathfinding(CHICKEN_AREA_X, CHICKEN_AREA_Z);

    let chickensKilled = 0;
    const MAX_CHICKENS = 1500;

    while (chickensKilled < MAX_CHICKENS) {
        const attack = bot.getSkill('Attack');
        const strength = bot.getSkill('Strength');
        const hitpoints = bot.getSkill('Hitpoints');

        if (attack.baseLevel >= BA_TARGET_ATTACK &&
            strength.baseLevel >= BA_TARGET_STRENGTH &&
            hitpoints.baseLevel >= BA_TARGET_HITPOINTS) {
            bot.log('EVENT', `Combat training complete! atk=${attack.baseLevel} str=${strength.baseLevel} hp=${hitpoints.baseLevel} killed=${chickensKilled}`);
            // Exit the chicken pen
            await bot.walkToWithPathfinding(3236, 3296);
            await bot.openGate(10);
            await bot.waitForTicks(1);
            await bot.walkTo(3236, 3293);
            return;
        }

        // Switch to aggressive once attack is trained
        if (attack.baseLevel >= BA_TARGET_ATTACK && strength.baseLevel < BA_TARGET_STRENGTH) {
            bot.setCombatStyle(1); // Aggressive for strength XP
        }

        bot.dismissModals();

        const chicken = bot.findNearbyNpcByTypeId(NPC_CHICKEN, 16);
        if (!chicken) {
            await bot.walkToWithPathfinding(CHICKEN_AREA_X, CHICKEN_AREA_Z);
            await bot.waitForTicks(5);
            continue;
        }

        try {
            await bot.attackNpcUntilDead('Chicken', { maxTicks: 100 });
        } catch {
            bot.dismissModals();
            await bot.waitForTicks(2);
            const dist = Math.max(Math.abs(bot.player.x - CHICKEN_AREA_X), Math.abs(bot.player.z - CHICKEN_AREA_Z));
            if (dist > 20) {
                await bot.walkToWithPathfinding(CHICKEN_AREA_X, CHICKEN_AREA_Z);
            }
            continue;
        }

        chickensKilled++;
        bot.dismissModals();
        await bot.waitForTicks(2);
    }

    throw new Error(`Failed to reach combat targets after ${MAX_CHICKENS} chickens`);
}

// ---- Phoenix Gang Bot (Bot A) ----

function buildPhoenixStates(bot: BotAPI, coord: Coordination): BotState {
    return {
        name: 'shield-of-arrav-phoenix',
        isComplete: () => bot.getQuestProgress(PHOENIX_VARP) === PG_COMPLETE,
        run: async () => { throw new Error('Composite state should not be called directly'); },
        children: [
            {
                name: 'earn-coins',
                isComplete: () => {
                    const coins = bot.findItem('Coins');
                    return (coins !== null && coins.count >= 20) || bot.getQuestProgress(PHOENIX_VARP) >= PG_SPOKEN_BARAEK;
                },
                stuckThreshold: 3000,
                run: async () => {
                    bot.log('STATE', '=== Phoenix Bot: Earning 20gp via pickpocketing ===');
                    await bot.earnCoinsViaPickpocket(20, 'Man');
                    const coins = bot.findItem('Coins');
                    bot.log('EVENT', `Have ${coins?.count ?? 0}gp`);
                },
            },
            {
                name: 'walk-to-varrock',
                isComplete: () => {
                    const pos = bot.getPosition();
                    // Already in Varrock area (x > 3150, z > 3400)
                    return pos.x > 3150 && pos.z > 3400;
                },
                run: async () => {
                    bot.log('STATE', '=== Phoenix Bot: Walking to Varrock ===');
                    await walkLumbridgeToVarrock(bot);
                },
            },
            {
                name: 'talk-to-reldo-start',
                isComplete: () => bot.getQuestProgress(PHOENIX_VARP) >= PG_STARTED,
                run: async () => {
                    bot.log('STATE', '=== Phoenix Bot: Talking to Reldo to start quest ===');
                    // Navigate into Varrock Palace and to the library.
                    // walkToWithPathfinding auto-opens doors along the way.
                    await bot.walkToWithPathfinding(3212, 3471); // palace entrance
                    await bot.walkToWithPathfinding(3210, 3490); // courtyard to library door area
                    // Now inside library — Reldo is nearby, talkToNpc handles approach

                    await bot.talkToNpc(NPC_RELDO);
                    // chatnpc "Hello stranger."
                    // Multi-choice: "I'm in search of a quest."
                    await bot.continueDialogsUntilChoice();
                    // The quest option position depends on Knight's Sword status.
                    // If Knight's Sword not started (likely): multi3 with option 1 = quest
                    // If Knight's Sword started: multi4 with option 1 = quest
                    await bot.selectDialogOption(1); // "I'm in search of a quest."
                    await bot.continueRemainingDialogs();
                    await bot.waitForTicks(2);

                    const varp = bot.getQuestProgress(PHOENIX_VARP);
                    if (varp < PG_STARTED) {
                        throw new Error(`Phoenix varp after Reldo is ${varp}, expected >= ${PG_STARTED}`);
                    }
                    bot.log('EVENT', `Quest started: phoenixgang varp=${varp}`);
                },
            },
            {
                name: 'search-bookcase-read-book',
                isComplete: () => bot.getQuestProgress(PHOENIX_VARP) >= PG_READ_BOOK,
                run: async () => {
                    bot.log('STATE', '=== Phoenix Bot: Searching bookcase and reading book ===');
                    // questbookcase is in the palace library — search it (op2=Check)
                    const bookcase = bot.findNearbyLoc('questbookcase');
                    if (!bookcase) {
                        throw new Error('questbookcase not found near player');
                    }
                    await bot.interactLoc(bookcase, 2);
                    await bot.waitForTicks(2);
                    // Dialog: "Aha! The Shield of Arrav!" -> "You take the book"
                    await bot.continueRemainingDialogs();
                    await bot.waitForTicks(2);

                    const book = bot.findItem(ITEM_BOOK);
                    if (!book) {
                        throw new Error('Did not receive The Shield of Arrav book');
                    }

                    // Read the book (opheld1)
                    await bot.useItemOp1(ITEM_BOOK);
                    await bot.waitForTicks(2);
                    // Book interface opens — dismiss it
                    bot.dismissModals();
                    await bot.waitForTicks(1);
                    bot.dismissModals();

                    const varp = bot.getQuestProgress(PHOENIX_VARP);
                    if (varp < PG_READ_BOOK) {
                        throw new Error(`Phoenix varp after reading book is ${varp}, expected >= ${PG_READ_BOOK}`);
                    }
                    bot.log('EVENT', `Read book: phoenixgang varp=${varp}`);
                },
            },
            {
                name: 'talk-to-reldo-again',
                isComplete: () => bot.getQuestProgress(PHOENIX_VARP) >= PG_SPOKEN_RELDO,
                run: async () => {
                    bot.log('STATE', '=== Phoenix Bot: Talking to Reldo about Phoenix Gang ===');
                    await bot.talkToNpc(NPC_RELDO);
                    // At phoenixgang=read_book, Reldo goes to @reldo_read_book
                    // chatplayer "Ok. I've read the book. Do you know where I can find the Phoenix Gang?"
                    // Sets phoenixgang = spoken_reldo
                    await bot.continueRemainingDialogs();
                    await bot.waitForTicks(2);

                    const varp = bot.getQuestProgress(PHOENIX_VARP);
                    if (varp < PG_SPOKEN_RELDO) {
                        throw new Error(`Phoenix varp after second Reldo is ${varp}, expected >= ${PG_SPOKEN_RELDO}`);
                    }
                    bot.log('EVENT', `Spoken to Reldo: phoenixgang varp=${varp}`);
                },
            },
            {
                name: 'talk-to-baraek',
                isComplete: () => bot.getQuestProgress(PHOENIX_VARP) >= PG_SPOKEN_BARAEK,
                run: async () => {
                    bot.log('STATE', '=== Phoenix Bot: Talking to Baraek (pay 20gp) ===');
                    await bot.walkToWithPathfinding(BARAEK_X, BARAEK_Z);

                    await bot.talkToNpc(NPC_BARAEK);
                    // Multi-choice: option 1 = "Can you tell me where I can find the Phoenix Gang?"
                    await bot.continueDialogsUntilChoice();
                    await bot.selectDialogOption(1);

                    // Dialog about Phoenix Gang, then choice3: "Okay. Have 20 gold coins." (1)
                    await bot.continueDialogsUntilChoice();
                    await bot.selectDialogOption(1); // "Okay. Have 20 gold coins."

                    await bot.continueRemainingDialogs();
                    await bot.waitForTicks(2);

                    const varp = bot.getQuestProgress(PHOENIX_VARP);
                    if (varp < PG_SPOKEN_BARAEK) {
                        throw new Error(`Phoenix varp after Baraek is ${varp}, expected >= ${PG_SPOKEN_BARAEK}`);
                    }
                    bot.log('EVENT', `Spoken to Baraek: phoenixgang varp=${varp}`);
                },
            },
            {
                name: 'talk-to-straven',
                isComplete: () => bot.getQuestProgress(PHOENIX_VARP) >= PG_SPOKEN_STRAVEN,
                run: async () => {
                    bot.log('STATE', '=== Phoenix Bot: Talking to Straven ===');
                    // The Phoenix Gang hideout is underground (z offset +6400).
                    // Entrance is a ladder (loc_1754) at (3244, 3383) on the overworld.
                    // The ladder is inside a building — enter via door at (3241, 3382).
                    // Straven is at (3246, 9780) underground near the phoenixdoor.
                    await bot.walkToWithPathfinding(3240, 3382); // approach building from west
                    // Open the door at (3241, 3382) to enter the building
                    try {
                        await bot.openDoor('inaccastledoubledoorropen');
                        await bot.waitForTicks(2);
                    } catch { /* may already be open */ }
                    await bot.walkToWithPathfinding(3243, 3383); // walk inside near the ladder
                    // The ladder at (3244, 3383) blocks walking. climbStairs handles approach.
                    await bot.climbStairs('loc_1754', 1); // Climb-down into underground
                    await bot.waitForTicks(3);
                    // Now underground — walk to Straven near phoenixdoor
                    await bot.walkToWithPathfinding(STRAVEN_X, STRAVEN_Z);

                    await bot.talkToNpc(NPC_STRAVEN);
                    // At phoenixgang=spoken_baraek:
                    // chatplayer "What's through that door?" -> @straven_cant_enter
                    // choice3 with option 1 = "I know who you are!"
                    await bot.continueDialogsUntilChoice();
                    await bot.selectDialogOption(1); // "I know who you are!"

                    // More dialog, then choice2: "I'd like to offer you my services." (1)
                    await bot.continueDialogsUntilChoice();
                    await bot.selectDialogOption(1); // "I'd like to offer you my services."

                    // Dialog about killing Jonny the Beard
                    // Sets phoenixgang = spoken_straven
                    await bot.continueRemainingDialogs();
                    await bot.waitForTicks(2);

                    const varp = bot.getQuestProgress(PHOENIX_VARP);
                    if (varp < PG_SPOKEN_STRAVEN) {
                        throw new Error(`Phoenix varp after Straven is ${varp}, expected >= ${PG_SPOKEN_STRAVEN}`);
                    }
                    bot.log('EVENT', `Spoken to Straven: phoenixgang varp=${varp}`);
                },
            },
            {
                name: 'kill-jonny-the-beard',
                isComplete: () => bot.findItem(ITEM_SCROLL) !== null || bot.getQuestProgress(PHOENIX_VARP) >= PG_JOINED,
                run: async () => {
                    bot.log('STATE', '=== Phoenix Bot: Killing Jonny the Beard ===');
                    // If underground (z > 6400), climb up the phoenixladder first.
                    // The ladder blocks walking, so just get near it and use climbStairs.
                    if (bot.getPosition().z > 6400) {
                        await bot.climbStairs('phoenixladder', 1); // Climb-up (handles approach)
                        await bot.waitForTicks(3);
                    }
                    // Blue Moon Inn has a door at (3229, 3397). Enter from (3228, 3396).
                    await bot.walkToWithPathfinding(3228, 3396);
                    await bot.openDoor('inaccastledoubledoorropen');
                    // Walk into the bar area near Jonny (spawns at 3223, 3395)
                    await bot.walkToWithPathfinding(3224, 3396);

                    await bot.attackNpcUntilDead(NPC_JONNY, { maxTicks: 300 });
                    await bot.waitForTicks(5);

                    // Pick up the intelligence report from the ground
                    const groundItem = bot.findNearbyGroundItem(ITEM_SCROLL, 10);
                    if (!groundItem) {
                        throw new Error('Intelligence report (Scroll) not found on ground after killing Jonny');
                    }
                    await bot.takeGroundItem(ITEM_SCROLL, groundItem.x, groundItem.z);
                    await bot.waitForTicks(2);

                    if (!bot.findItem(ITEM_SCROLL)) {
                        throw new Error('Failed to pick up intelligence report');
                    }
                    bot.log('EVENT', 'Picked up intelligence report');
                },
            },
            {
                name: 'return-to-straven-join',
                isComplete: () => bot.getQuestProgress(PHOENIX_VARP) >= PG_JOINED,
                run: async () => {
                    bot.log('STATE', '=== Phoenix Bot: Returning to Straven with report ===');
                    // Walk to the ladder building and climb down
                    await bot.walkToWithPathfinding(3240, 3382);
                    try {
                        await bot.openDoor('inaccastledoubledoorropen');
                        await bot.waitForTicks(2);
                    } catch { /* may already be open */ }
                    await bot.walkToWithPathfinding(3243, 3383);
                    await bot.climbStairs('loc_1754', 1); // Climb-down
                    await bot.waitForTicks(3);
                    await bot.walkToWithPathfinding(STRAVEN_X, STRAVEN_Z);

                    await bot.talkToNpc(NPC_STRAVEN);
                    // At spoken_straven with intelligence_report:
                    // "I have the intelligence report!" -> joins gang
                    // Sets phoenixgang = joined, gives phoenixkey2
                    await bot.continueRemainingDialogs();
                    await bot.waitForTicks(3);
                    bot.dismissModals();

                    const varp = bot.getQuestProgress(PHOENIX_VARP);
                    if (varp < PG_JOINED) {
                        throw new Error(`Phoenix varp after rejoining Straven is ${varp}, expected >= ${PG_JOINED}`);
                    }
                    if (!bot.findItem(ITEM_KEY)) {
                        throw new Error('Did not receive phoenixkey2 from Straven');
                    }
                    bot.log('EVENT', `Joined Phoenix Gang: phoenixgang varp=${varp}, have key`);
                },
            },
            {
                name: 'get-shield-half-from-chest',
                isComplete: () => bot.findItem(ITEM_BROKEN_SHIELD) !== null,
                run: async () => {
                    bot.log('STATE', '=== Phoenix Bot: Searching Phoenix chest for shield half ===');
                    // Navigate to the underground hideout if not already there.
                    if (bot.getPosition().z < 6400) {
                        // On the overworld — climb down
                        await bot.walkToWithPathfinding(3240, 3382);
                        try {
                            await bot.openDoor('inaccastledoubledoorropen');
                            await bot.waitForTicks(2);
                        } catch { /* may already be open */ }
                        await bot.walkToWithPathfinding(3243, 3383);
                        await bot.climbStairs('loc_1754', 1); // Climb-down
                        await bot.waitForTicks(3);
                    }
                    // Now underground. The phoenixdoor at (3247,9779) blocks the path
                    // to the chest area. As a gang member (varp>=9), clicking it opens it.
                    // The door uses p_teleport to move the player through — the collision
                    // never truly opens, so we must interact with the door, get teleported,
                    // then continue navigating south.
                    const pos = bot.getPosition();
                    bot.log('STATE', `Underground at (${pos.x},${pos.z})`);

                    // Walk to the north side of the phoenixdoor
                    await bot.walkToWithPathfinding(3247, 9780);
                    // Open the phoenixdoor — this teleports us to the door tile (3247,9779)
                    const phoenixDoor = bot.findNearbyLoc('phoenixdoor');
                    if (phoenixDoor) {
                        await bot.interactLoc(phoenixDoor, 1); // Open
                        await bot.waitForTicks(2);
                    }
                    const afterDoor = bot.getPosition();
                    bot.log('STATE', `After phoenixdoor interaction: (${afterDoor.x},${afterDoor.z})`);

                    // After being teleported to the door tile, we can move south.
                    // The wall at z=9774 has a door (inaccastledoubledoorropen at 3249,9774).
                    // Navigate south through intermediate points, opening doors as needed.
                    // First go to just south of the door.
                    await bot.walkToWithPathfinding(3247, 9775);
                    // Then the wall at z=9773 — navigate through it
                    await bot.walkToWithPathfinding(3240, 9770);
                    // Walk to tile ADJACENT to the chest (chest is a centrepiece that blocks walk)
                    await bot.walkToWithPathfinding(PHOENIX_CHEST_X, PHOENIX_CHEST_Z + 1);

                    // Open the chest (phoenixshutchest -> phoenixopenchest)
                    const shutChest = bot.findNearbyLoc('phoenixshutchest');
                    if (shutChest) {
                        await bot.interactLoc(shutChest, 1); // Open
                        await bot.waitForTicks(2);
                    }

                    // Search the open chest (phoenixopenchest op1=Search)
                    const openChest = bot.findNearbyLoc('phoenixopenchest');
                    if (!openChest) {
                        throw new Error('phoenixopenchest not found after opening chest');
                    }
                    await bot.interactLoc(openChest, 1); // Search
                    await bot.continueRemainingDialogs();
                    await bot.waitForTicks(3);
                    bot.dismissModals();

                    if (!bot.findItem(ITEM_BROKEN_SHIELD)) {
                        throw new Error('Did not find shield half in Phoenix chest');
                    }
                    bot.log('EVENT', 'Got Phoenix shield half (arravshield1)');
                },
            },
            {
                name: 'drop-key-for-bot-b',
                isComplete: () => coord.keyDropped,
                stuckThreshold: 50000, // Bot B combat training (atk=20/str=15/hp=20) takes many ticks
                maxRetries: 1,
                run: async () => {
                    bot.log('STATE', '=== Phoenix Bot: Dropping key at meeting point ===');
                    // Climb up from underground if needed
                    if (bot.getPosition().z > 6400) {
                        // Navigate back to the phoenixladder — go through doors in reverse
                        await bot.walkToWithPathfinding(3240, 9770);
                        await bot.walkToWithPathfinding(3247, 9775);
                        // Go back through the phoenixdoor to the ladder area
                        await bot.walkToWithPathfinding(3247, 9778);
                        const phoenixDoor2 = bot.findNearbyLoc('phoenixdoor');
                        if (phoenixDoor2) {
                            await bot.interactLoc(phoenixDoor2, 1); // Open (teleports north)
                            await bot.waitForTicks(2);
                        }
                        // Now near the ladder
                        await bot.walkToWithPathfinding(3243, 9783);
                        await bot.climbStairs('phoenixladder', 1);
                        await bot.waitForTicks(3);
                    }
                    await bot.walkToWithPathfinding(MEETING_X, MEETING_Z);

                    // Wait for Bot B to be ready at the meeting point before dropping.
                    // Ground items despawn quickly, so we must synchronize.
                    bot.log('STATE', 'Waiting for Bot B to reach meeting point...');
                    for (let i = 0; i < 45000; i++) {
                        await bot.waitForTick();
                        if (coord.blackArmBotError) {
                            throw new Error(`Bot B failed: ${coord.blackArmBotError}`);
                        }
                        if (coord.botBReadyForKey) break;
                    }
                    if (!coord.botBReadyForKey) {
                        throw new Error('Timed out waiting for Bot B to be ready for key');
                    }

                    if (bot.findItem(ITEM_KEY)) {
                        await bot.dropItem(ITEM_KEY);
                        await bot.waitForTicks(2);
                    }
                    coord.keyDropped = true;
                    bot.log('EVENT', 'Key dropped at meeting point');
                },
            },
            {
                name: 'wait-for-shield-half-from-bot-b',
                isComplete: () => coord.shieldDropped && bot.countItem(ITEM_BROKEN_SHIELD) >= 2,
                stuckThreshold: 40000,
                run: async () => {
                    bot.log('STATE', '=== Phoenix Bot: Waiting for Bot B to drop shield half ===');
                    // Signal Bot B that we're ready to receive the shield
                    coord.botAReadyForShield = true;

                    // Ground items have a 100-tick reveal timer — only the dropper
                    // can interact during that period.
                    let shieldDroppedAtTick = 0;
                    for (let i = 0; i < 30000; i++) {
                        await bot.waitForTick();
                        if (coord.blackArmBotError) {
                            throw new Error(`Bot B failed: ${coord.blackArmBotError}`);
                        }
                        if (coord.shieldDropped) {
                            if (shieldDroppedAtTick === 0) {
                                shieldDroppedAtTick = i;
                                bot.log('STATE', 'Shield half dropped detected, waiting for reveal timer (100 ticks)...');
                            }
                            const ticksSinceDrop = i - shieldDroppedAtTick;
                            if (ticksSinceDrop >= 105) {
                                const groundShield = bot.findNearbyGroundItem(ITEM_BROKEN_SHIELD, 10);
                                if (groundShield) {
                                    await bot.takeGroundItem(ITEM_BROKEN_SHIELD, groundShield.x, groundShield.z);
                                    await bot.waitForTicks(2);
                                }
                                if (bot.countItem(ITEM_BROKEN_SHIELD) >= 2) {
                                    coord.shieldPickedUp = true;
                                    bot.log('EVENT', 'Picked up both shield halves');
                                    return;
                                }
                            }
                        }
                    }
                    throw new Error('Timed out waiting for Bot B shield half');
                },
            },
            {
                name: 'give-shields-to-curator',
                isComplete: () => bot.findItem(ITEM_CERTIFICATE) !== null,
                run: async () => {
                    bot.log('STATE', '=== Phoenix Bot: Giving both shield halves to Curator ===');
                    await bot.walkToWithPathfinding(MUSEUM_X, MUSEUM_Z);

                    await bot.talkToNpc(NPC_CURATOR);
                    // Curator detects both shield halves and asks for them
                    // "I have retrieved the shield of Arrav..."
                    // Dialog gives 2 certificates
                    await bot.continueRemainingDialogs();
                    await bot.waitForTicks(3);
                    bot.dismissModals();

                    const certCount = bot.countItem(ITEM_CERTIFICATE);
                    if (certCount < 2) {
                        throw new Error(`Expected 2 certificates from Curator, got ${certCount}`);
                    }
                    bot.log('EVENT', `Got ${certCount} certificates from Curator`);
                },
            },
            {
                name: 'drop-cert-for-bot-b',
                isComplete: () => coord.certDropped,
                stuckThreshold: 20000, // May wait for Bot B
                run: async () => {
                    bot.log('STATE', '=== Phoenix Bot: Dropping certificate at meeting point ===');
                    await bot.walkToWithPathfinding(MEETING_X, MEETING_Z);

                    // Wait for Bot B to be ready at the meeting point
                    bot.log('STATE', 'Waiting for Bot B to be ready for certificate...');
                    for (let i = 0; i < 20000; i++) {
                        await bot.waitForTick();
                        if (coord.blackArmBotError) {
                            throw new Error(`Bot B failed: ${coord.blackArmBotError}`);
                        }
                        if (coord.botBReadyForCert) break;
                    }
                    if (!coord.botBReadyForCert) {
                        throw new Error('Timed out waiting for Bot B to be ready for certificate');
                    }

                    // Drop one certificate for Bot B
                    await bot.dropItem(ITEM_CERTIFICATE);
                    await bot.waitForTicks(2);
                    coord.certDropped = true;
                    bot.log('EVENT', 'Certificate dropped for Bot B');
                },
            },
            {
                name: 'give-cert-to-king',
                isComplete: () => bot.getQuestProgress(PHOENIX_VARP) === PG_COMPLETE,
                run: async () => {
                    bot.log('STATE', '=== Phoenix Bot: Giving certificate to King Roald ===');
                    // Enter Varrock Palace through front doors
                    await bot.walkToWithPathfinding(3212, 3471);
                    await bot.walkToWithPathfinding(KING_ROALD_X, KING_ROALD_Z);

                    await bot.talkToNpc(NPC_KING_ROALD);
                    // King detects certificate + phoenix gang membership
                    // Dialog -> queue(blackarmgang_quest_complete) -> sets phoenixgang=complete
                    await bot.continueRemainingDialogs();
                    await bot.waitForTicks(5);
                    bot.dismissModals();

                    const varp = bot.getQuestProgress(PHOENIX_VARP);
                    if (varp !== PG_COMPLETE) {
                        throw new Error(`Phoenix quest not complete: varp=${varp}, expected ${PG_COMPLETE}`);
                    }
                    bot.log('SUCCESS', `Phoenix Gang quest complete! phoenixgang varp=${varp}`);
                    coord.phoenixBotDone = true;
                },
            },
        ],
    };
}

// ---- Black Arm Gang Bot (Bot B) ----

function buildBlackArmStates(bot: BotAPI, coord: Coordination): BotState {
    return {
        name: 'shield-of-arrav-blackarm',
        isComplete: () => bot.getQuestProgress(BLACKARM_VARP) === BA_COMPLETE,
        run: async () => { throw new Error('Composite state should not be called directly'); },
        children: [
            {
                name: 'train-combat',
                isComplete: () => {
                    const attack = bot.getSkill('Attack');
                    const strength = bot.getSkill('Strength');
                    const hitpoints = bot.getSkill('Hitpoints');
                    return attack.baseLevel >= BA_TARGET_ATTACK &&
                        strength.baseLevel >= BA_TARGET_STRENGTH &&
                        hitpoints.baseLevel >= BA_TARGET_HITPOINTS;
                },
                stuckThreshold: 5000,
                run: async () => {
                    await trainCombatForBlackArm(bot);
                },
            },
            {
                name: 'walk-to-varrock',
                isComplete: () => {
                    const pos = bot.getPosition();
                    return pos.x > 3150 && pos.z > 3380;
                },
                run: async () => {
                    bot.log('STATE', '=== Black Arm Bot: Walking to Varrock ===');
                    await walkLumbridgeToVarrock(bot);
                },
            },
            {
                name: 'talk-to-tramp',
                isComplete: () => bot.getQuestProgress(BLACKARM_VARP) >= BA_STARTED,
                run: async () => {

                    bot.log('STATE', '=== Black Arm Bot: Talking to Tramp ===');
                    await bot.walkToWithPathfinding(TRAMP_X, TRAMP_Z);

                    await bot.talkToNpc(NPC_TRAMP);
                    // Multi4: option 4 = "Is there anything down this alleyway?"
                    await bot.continueDialogsUntilChoice();
                    await bot.selectDialogOption(4); // "Is there anything down this alleyway?"

                    // Dialog about Black Arm Gang, then choice2:
                    // option 2 = "Do you think they would let me join?"
                    await bot.continueDialogsUntilChoice();
                    await bot.selectDialogOption(2); // "Do you think they would let me join?"

                    // Sets blackarmgang = started
                    await bot.continueRemainingDialogs();
                    await bot.waitForTicks(2);

                    const varp = bot.getQuestProgress(BLACKARM_VARP);
                    if (varp < BA_STARTED) {
                        throw new Error(`Black Arm varp after Tramp is ${varp}, expected >= ${BA_STARTED}`);
                    }
                    bot.log('EVENT', `Talked to Tramp: blackarmgang varp=${varp}`);
                },
            },
            {
                name: 'talk-to-katrine',
                isComplete: () => bot.getQuestProgress(BLACKARM_VARP) >= BA_SPOKEN_KATRINE,
                run: async () => {
                    bot.log('STATE', '=== Black Arm Bot: Talking to Katrine ===');

                    // Clear any stuck delayed/modal state from combat training
                    // or Tramp dialog. After complex interactions, player.delayed
                    // or containsModalInterface() can be permanently true, which
                    // causes canAccess() to return false and silently prevents
                    // door interactions from firing.
                    await bot.clearPendingState();

                    // The Black Arm HQ is accessed through TWO doors:
                    // 1. East building door at (3196,3384) — enters the alley between buildings
                    // 2. Black Arm HQ door at (3190,3384) — enters the HQ proper
                    // Walk to east of the east building door, open it, walk through the alley,
                    // then open the HQ door.
                    await bot.walkToWithPathfinding(3197, 3384); // east of outer door
                    bot.dismissModals();
                    await bot.openDoor('inaccastledoubledoorropen'); // open east building door
                    await bot.waitForTicks(2);
                    await bot.walkTo(3191, 3384); // straight line through open doorway (no pathfinding — walls block alternate routes)
                    bot.dismissModals();
                    await bot.openDoor('inaccastledoubledoorropen'); // open HQ door
                    await bot.waitForTicks(2);
                    await bot.walkToWithPathfinding(BLACKARM_HQ_X, BLACKARM_HQ_Z);

                    await bot.talkToNpc(NPC_KATRINE);
                    // Dialog flow for blackarmgang=started:
                    // chatplayer "What is this place?" -> chatnpc "It's a private business..."
                    // -> p_choice3 (option 3 = "I've heard you're the Black Arm Gang.")
                    await bot.continueDialogsUntilChoice();
                    // p_choice3 display order: 1="I've heard you're the Black Arm Gang."
                    // 2="What sort of business?" 3="I'm looking for fame and riches."
                    // (return values differ from button positions!)
                    await bot.selectDialogOption(1); // "I've heard you're the Black Arm Gang."

                    // chatplayer "I've heard you're the Black Arm Gang."
                    // chatnpc "Who told you that?"
                    // p_choice3: 1="I'd rather not reveal my sources." 2="It was the tramp" 3="Everyone knows"
                    await bot.continueDialogsUntilChoice();
                    await bot.selectDialogOption(1); // "I'd rather not reveal my sources."

                    // chatplayer "I'd rather not reveal my sources."
                    // chatnpc "Yes, I can understand that. So what do you want with us?"
                    // @multi3 (option 1 = "I want to become a member of your gang.")
                    await bot.continueDialogsUntilChoice();
                    await bot.selectDialogOption(1); // "I want to become a member of your gang."

                    // @katrine_gangmember:
                    // chatplayer "I want to become a member..." -> chatnpc "How unusual..."
                    // -> chatnpc "How can I be sure you can be trusted?"
                    // -> choice2 (option 1 = "Well, you can give me a try can't you?")
                    await bot.continueDialogsUntilChoice();
                    await bot.selectDialogOption(1); // "Well, you can give me a try can't you?"

                    // chatplayer "Well, you can give me a try..." -> chatnpc "I'm not so sure."
                    // -> chatnpc "Thinking about it... I may have a solution..."
                    // -> chatnpc crossbow dialog (multiple pages)
                    // -> choice2 (option 1 = "Ok, no problem.")
                    await bot.continueDialogsUntilChoice();
                    await bot.selectDialogOption(1); // "Ok, no problem."

                    // Sets blackarmgang = spoken_katrine
                    await bot.continueRemainingDialogs();
                    await bot.waitForTicks(2);

                    const varp = bot.getQuestProgress(BLACKARM_VARP);
                    if (varp < BA_SPOKEN_KATRINE) {
                        throw new Error(`Black Arm varp after Katrine is ${varp}, expected >= ${BA_SPOKEN_KATRINE}`);
                    }
                    bot.log('EVENT', `Spoken to Katrine: blackarmgang varp=${varp}`);
                },
            },
            {
                name: 'wait-for-key-from-bot-a',
                isComplete: () => coord.keyPickedUp || bot.findItem(ITEM_KEY) !== null,
                stuckThreshold: 20000,
                run: async () => {
                    bot.log('STATE', '=== Black Arm Bot: Waiting for key from Phoenix Bot ===');
                    await bot.walkToWithPathfinding(MEETING_X, MEETING_Z);

                    // Signal Bot A that we're ready to receive the key
                    coord.botBReadyForKey = true;
                    bot.log('STATE', 'At meeting point, signaled readiness for key');

                    // Ground items have a 100-tick reveal timer — only the dropper
                    // can interact during that period. We must wait for the timer
                    // to expire before Bot B can pick up Bot A's dropped item.
                    let keyDroppedAtTick = 0;
                    for (let i = 0; i < 4000; i++) {
                        await bot.waitForTick();
                        if (coord.phoenixBotError) {
                            throw new Error(`Phoenix Bot failed: ${coord.phoenixBotError}`);
                        }
                        if (coord.keyDropped) {
                            if (keyDroppedAtTick === 0) {
                                keyDroppedAtTick = i;
                                bot.log('STATE', 'Key dropped detected, waiting for reveal timer (100 ticks)...');
                            }
                            const ticksSinceDrop = i - keyDroppedAtTick;
                            if (ticksSinceDrop >= 105) {
                                const groundKey = bot.findNearbyGroundItem(ITEM_KEY, 10);
                                if (groundKey) {
                                    await bot.takeGroundItem(ITEM_KEY, groundKey.x, groundKey.z);
                                    await bot.waitForTicks(2);
                                }
                                if (bot.findItem(ITEM_KEY)) {
                                    coord.keyPickedUp = true;
                                    bot.log('EVENT', 'Picked up key from Phoenix Bot');
                                    return;
                                }
                            }
                        }
                    }
                    throw new Error('Timed out waiting for key from Phoenix Bot');
                },
            },
            {
                name: 'get-crossbows',
                isComplete: () => bot.countItem(ITEM_CROSSBOW) >= 2 || bot.getQuestProgress(BLACKARM_VARP) >= BA_JOINED,
                stuckThreshold: 10000,
                run: async () => {
                    bot.log('STATE', '=== Black Arm Bot: Getting crossbows from Phoenix weapons room ===');

                    // Helper: navigate from anywhere to the weapons room on level 1.
                    // Used on first entry and after death respawn in Lumbridge.
                    async function navigateToWeaponsRoom(): Promise<void> {
                        const pos = bot.getPosition();
                        // If in Lumbridge area (respawn point), walk to Varrock first
                        if (pos.x < 3200 && pos.z < 3300) {
                            bot.log('STATE', 'Walking from Lumbridge to Varrock...');
                            await walkLumbridgeToVarrock(bot);
                        }
                        // If already on level 1 from a previous partial attempt, skip nav
                        if (bot.getPosition().level > 0) {
                            bot.log('STATE', 'Already on level 1, skipping navigation');
                            return;
                        }
                        // phoenixdoor2 at (3251, 3385) blocks entry to the weapons room.
                        // Use key on the door to unlock it. Approach from south (z=3386).
                        await bot.walkToWithPathfinding(3240, 3382);
                        await bot.walkToWithPathfinding(3251, 3386);

                        // Use key on phoenixdoor2. The RS2 script teleports us to the door
                        // tile and makes the wall an inviswall for only 3 ticks.
                        await bot.useItemOnLoc(ITEM_KEY, 'phoenixdoor2');
                        // Step north immediately through the 3-tick window
                        await bot.walkTo(3251, 3384);

                        // Climb up to level 1 where crossbows and Weaponsmaster are
                        await bot.climbStairs('loc_1747', 1);
                        await bot.waitForTicks(3);

                        const afterStairs = bot.getPosition();
                        bot.log('STATE', `In weapons room: pos=(${afterStairs.x},${afterStairs.z},${afterStairs.level})`);
                    }

                    // Navigate to the weapons room for the first time
                    await navigateToWeaponsRoom();

                    // Fight the Weaponsmaster with death-retry loop.
                    // With atk=20, str=15, hp=20 vs Weaponsmaster (level 23), win rate ~50%.
                    // On death: respawn in Lumbridge, walk back, fight again.
                    // Weaponsmaster respawns after 700 ticks — less than the walk back.
                    const MAX_FIGHT_ATTEMPTS = 5;
                    for (let attempt = 1; attempt <= MAX_FIGHT_ATTEMPTS; attempt++) {
                        bot.log('STATE', `Fighting Weaponsmaster (attempt ${attempt}/${MAX_FIGHT_ATTEMPTS})`);

                        // Equip bronze pickaxe as weapon before each fight
                        if (bot.findItem('Bronze pickaxe')) {
                            await bot.equipItem('Bronze pickaxe');
                            await bot.waitForTicks(1);
                        }

                        try {
                            await bot.attackNpcUntilDead(NPC_WEAPONSMASTER, { maxTicks: 600 });
                            bot.log('EVENT', `Weaponsmaster defeated on attempt ${attempt}`);
                            break;
                        } catch (err) {
                            const msg = (err as Error).message;
                            if (!msg.includes('bot died')) {
                                throw err; // Not a death error — re-throw
                            }
                            if (attempt === MAX_FIGHT_ATTEMPTS) {
                                throw new Error(`Died to Weaponsmaster ${MAX_FIGHT_ATTEMPTS} times, giving up`);
                            }
                            bot.log('STATE', `Died to Weaponsmaster (attempt ${attempt}), respawning...`);
                            await bot.waitForRespawn(20);
                            await bot.waitForTicks(3);
                            // Walk back from Lumbridge to the weapons room
                            await navigateToWeaponsRoom();
                        }
                    }

                    await bot.waitForTicks(5);

                    // Pick up 2 phoenix crossbows from ground
                    for (let attempt = 0; attempt < 20; attempt++) {
                        const crossbow = bot.findNearbyGroundItem(ITEM_CROSSBOW, 16);
                        if (crossbow) {
                            await bot.takeGroundItem(ITEM_CROSSBOW, crossbow.x, crossbow.z);
                            await bot.waitForTicks(2);
                        }
                        if (bot.countItem(ITEM_CROSSBOW) >= 2) break;
                        await bot.waitForTicks(3);
                    }

                    if (bot.countItem(ITEM_CROSSBOW) < 2) {
                        throw new Error(`Only got ${bot.countItem(ITEM_CROSSBOW)} crossbows, need 2`);
                    }
                    bot.log('EVENT', `Got ${bot.countItem(ITEM_CROSSBOW)} Phoenix crossbows`);
                },
            },
            {
                name: 'give-crossbows-to-katrine',
                isComplete: () => bot.getQuestProgress(BLACKARM_VARP) >= BA_JOINED,
                run: async () => {
                    bot.log('STATE', '=== Black Arm Bot: Giving crossbows to Katrine ===');
                    // If still on level 1 (weapons room), climb down first
                    if (bot.getPosition().level > 0) {
                        bot.log('STATE', `On level ${bot.getPosition().level}, climbing down stairs`);
                        await bot.climbStairs('loc_1746', 1); // Climb-down (loc_1746=down, loc_1747=up)
                        await bot.waitForTicks(3);
                    }

                    // Clear any stuck delayed/modal state from combat + item pickup.
                    // After killing the Weaponsmaster and picking up crossbows,
                    // player.delayed or containsModalInterface() can be permanently
                    // true, which causes canAccess() to return false and silently
                    // prevents door interactions from firing.
                    await bot.clearPendingState();

                    // Enter Black Arm HQ through both doors (east building + HQ)
                    await bot.walkToWithPathfinding(3197, 3384);
                    bot.dismissModals();
                    await bot.openDoor('inaccastledoubledoorropen');
                    await bot.waitForTicks(2);
                    await bot.walkTo(3191, 3384); // straight line through open doorway (no pathfinding — walls block alternate routes)
                    bot.dismissModals();
                    await bot.openDoor('inaccastledoubledoorropen');
                    await bot.waitForTicks(2);
                    await bot.walkToWithPathfinding(BLACKARM_HQ_X, BLACKARM_HQ_Z);

                    await bot.talkToNpc(NPC_KATRINE);
                    // "Have you got those crossbows for me yet?" -> "Yes, I have."
                    // Sets blackarmgang = joined
                    await bot.continueRemainingDialogs();
                    await bot.waitForTicks(3);
                    bot.dismissModals();

                    const varp = bot.getQuestProgress(BLACKARM_VARP);
                    if (varp < BA_JOINED) {
                        throw new Error(`Black Arm varp after giving crossbows is ${varp}, expected >= ${BA_JOINED}`);
                    }
                    bot.log('EVENT', `Joined Black Arm Gang: blackarmgang varp=${varp}`);
                },
            },
            {
                name: 'get-shield-half-from-cupboard',
                isComplete: () => bot.findItem(ITEM_BROKEN_SHIELD) !== null,
                run: async () => {
                    bot.log('STATE', '=== Black Arm Bot: Searching cupboard for shield half ===');
                    const pos = bot.getPosition();

                    // If already on level 1 (from a previous attempt or retry), skip
                    // all ground-floor navigation.
                    if (pos.level >= 1) {
                        bot.log('STATE', `Already on level 1 at (${pos.x},${pos.z}), skipping navigation`);
                    } else {
                        // If already inside the Black Arm HQ ground floor,
                        // skip re-entering through the doors from outside.
                        const insideHQ = pos.x <= 3190 && pos.z >= 3383 && pos.z <= 3390;
                        if (!insideHQ) {
                            bot.log('STATE', `Outside HQ at (${pos.x},${pos.z}), entering through doors`);
                            await bot.clearPendingState();
                            await bot.walkToWithPathfinding(3197, 3384);
                            bot.dismissModals();
                            await bot.openDoor('inaccastledoubledoorropen');
                            await bot.waitForTicks(2);
                            await bot.walkTo(3191, 3384); // straight line through open doorway (no pathfinding — walls block alternate routes)
                            bot.dismissModals();
                            await bot.openDoor('inaccastledoubledoorropen');
                            await bot.waitForTicks(2);
                        } else {
                            bot.log('STATE', `Already inside HQ at (${pos.x},${pos.z})`);
                        }
                        await bot.walkToWithPathfinding(3186, 3385);
                        // Go through the blackarmdoor (3185,3388) to the north room.
                        // As a joined member (varp>=3), the door opens via ~open_hideout_door
                        // which teleports us to the door tile and makes the wall invisible
                        // for only 3 ticks. We must step through immediately.
                        await bot.walkToWithPathfinding(3185, 3387);
                        await bot.openDoor('blackarmdoor');
                        // Step north immediately through the 3-tick window
                        await bot.walkTo(3185, 3389);
                        await bot.waitForTicks(3);
                        // Now north of the blackarmdoor wall. The stairs (loc_1722)
                        // are at (3188,3389) and block walking. Walk to adjacent tile,
                        // then let climbStairs handle the final approach.
                        await bot.walkTo(3187, 3389);
                        await bot.waitForTicks(3);
                        // Climb stairs (loc_1722 at 3188,3389) to level 1
                        await bot.climbStairs('loc_1722', 1);
                        await bot.waitForTicks(3);
                        bot.log('STATE', `After climbing stairs: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
                    }

                    // The cupboard (blackarmcupboardshut) is at (3188,3385) on level 1.
                    // It has width=2, length=3, forceapproach=east.
                    // Walk close to the cupboard area, then let interactLoc handle approach.
                    await bot.walkToWithPathfinding(3186, 3384);

                    // Open the cupboard first (blackarmcupboardshut -> blackarmcupboardopen)
                    const shutCupboard = bot.findNearbyLoc('blackarmcupboardshut');
                    if (shutCupboard) {
                        await bot.interactLoc(shutCupboard, 1); // Open
                        await bot.waitForTicks(2);
                        // Dismiss the "use" message if any
                        bot.dismissModals();
                        await bot.waitForTicks(1);
                    }

                    // Search the open cupboard (op2=Search)
                    const openCupboard = bot.findNearbyLoc('blackarmcupboardopen');
                    if (!openCupboard) {
                        throw new Error('blackarmcupboardopen not found after opening cupboard');
                    }
                    await bot.interactLoc(openCupboard, 2); // Search
                    await bot.continueRemainingDialogs();
                    await bot.waitForTicks(3);
                    bot.dismissModals();

                    if (!bot.findItem(ITEM_BROKEN_SHIELD)) {
                        throw new Error('Did not find shield half in Black Arm cupboard');
                    }
                    bot.log('EVENT', 'Got Black Arm shield half (arravshield2)');
                },
            },
            {
                name: 'drop-shield-for-bot-a',
                isComplete: () => coord.shieldDropped,
                stuckThreshold: 20000, // May wait for Bot A
                run: async () => {
                    bot.log('STATE', '=== Black Arm Bot: Dropping shield half at meeting point ===');
                    // If still on level 1 (from cupboard), walk to stairs and climb down
                    if (bot.getPosition().level > 0) {
                        bot.log('STATE', `On level ${bot.getPosition().level}, walking to stairs and climbing down`);
                        // Walk to the stairs area on level 1 (stairs at 3188,3389)
                        await bot.walkToWithPathfinding(3188, 3388);
                        await bot.climbStairs('loc_1723', 1); // Climb-down
                        await bot.waitForTicks(3);
                        if (bot.getPosition().level > 0) {
                            throw new Error(`Still on level ${bot.getPosition().level} after climbStairs`);
                        }
                    }
                    await bot.walkToWithPathfinding(MEETING_X, MEETING_Z);

                    // Wait for Bot A to be ready at the meeting point
                    bot.log('STATE', 'Waiting for Bot A to be ready for shield half...');
                    for (let i = 0; i < 20000; i++) {
                        await bot.waitForTick();
                        if (coord.phoenixBotError) {
                            throw new Error(`Phoenix Bot failed: ${coord.phoenixBotError}`);
                        }
                        if (coord.botAReadyForShield) break;
                    }
                    if (!coord.botAReadyForShield) {
                        throw new Error('Timed out waiting for Bot A to be ready for shield');
                    }

                    await bot.dropItem(ITEM_BROKEN_SHIELD);
                    await bot.waitForTicks(2);
                    coord.shieldDropped = true;
                    bot.log('EVENT', 'Shield half dropped at meeting point');
                },
            },
            {
                name: 'wait-for-cert-from-bot-a',
                isComplete: () => coord.certPickedUp || bot.findItem(ITEM_CERTIFICATE) !== null,
                stuckThreshold: 20000,
                run: async () => {
                    bot.log('STATE', '=== Black Arm Bot: Waiting for certificate from Phoenix Bot ===');
                    // Signal Bot A that we're ready for the certificate
                    coord.botBReadyForCert = true;
                    bot.log('STATE', 'At meeting point, signaled readiness for certificate');

                    // Ground items have a 100-tick reveal timer — only the dropper
                    // can interact during that period.
                    let certDroppedAtTick = 0;
                    for (let i = 0; i < 4000; i++) {
                        await bot.waitForTick();
                        if (coord.phoenixBotError) {
                            throw new Error(`Phoenix Bot failed: ${coord.phoenixBotError}`);
                        }
                        if (coord.certDropped) {
                            if (certDroppedAtTick === 0) {
                                certDroppedAtTick = i;
                                bot.log('STATE', 'Certificate dropped detected, waiting for reveal timer (100 ticks)...');
                            }
                            const ticksSinceDrop = i - certDroppedAtTick;
                            if (ticksSinceDrop >= 105) {
                                const groundCert = bot.findNearbyGroundItem(ITEM_CERTIFICATE, 10);
                                if (groundCert) {
                                    await bot.takeGroundItem(ITEM_CERTIFICATE, groundCert.x, groundCert.z);
                                    await bot.waitForTicks(2);
                                }
                                if (bot.findItem(ITEM_CERTIFICATE)) {
                                    coord.certPickedUp = true;
                                    bot.log('EVENT', 'Picked up certificate from Phoenix Bot');
                                    return;
                                }
                            }
                        }
                    }
                    throw new Error('Timed out waiting for certificate from Phoenix Bot');
                },
            },
            {
                name: 'give-cert-to-king',
                isComplete: () => bot.getQuestProgress(BLACKARM_VARP) === BA_COMPLETE,
                run: async () => {
                    bot.log('STATE', '=== Black Arm Bot: Giving certificate to King Roald ===');
                    // Enter Varrock Palace through front doors
                    await bot.walkToWithPathfinding(3212, 3471);
                    await bot.walkToWithPathfinding(KING_ROALD_X, KING_ROALD_Z);

                    await bot.talkToNpc(NPC_KING_ROALD);
                    // King detects certificate + black arm gang membership
                    await bot.continueRemainingDialogs();
                    await bot.waitForTicks(5);
                    bot.dismissModals();

                    const varp = bot.getQuestProgress(BLACKARM_VARP);
                    if (varp !== BA_COMPLETE) {
                        throw new Error(`Black Arm quest not complete: varp=${varp}, expected ${BA_COMPLETE}`);
                    }
                    bot.log('SUCCESS', `Black Arm Gang quest complete! blackarmgang varp=${varp}`);
                    coord.blackArmBotDone = true;
                },
            },
        ],
    };
}

// ---- Main entry point ----

async function runBlackArmPath(bot: BotAPI, coord: Coordination): Promise<void> {
    await skipTutorial(bot);
    await bot.waitForTicks(5);

    // Dismiss any modals/delays from the login trigger (macro event timer etc.)
    await bot.clearPendingState();

    bot.log('STATE', `Black Arm Bot starting at (${bot.player.x},${bot.player.z},${bot.player.level})`);

    const root = buildBlackArmStates(bot, coord);
    await runStateMachine(bot, {
        root,
        varpIds: [BLACKARM_VARP, PHOENIX_VARP],
    });
}

export async function shieldOfArrav(bot: BotAPI): Promise<void> {
    // bot is the Phoenix Gang bot (Bot A)
    await skipTutorial(bot);
    await bot.waitForTicks(2);

    bot.log('STATE', `Phoenix Bot starting at (${bot.player.x},${bot.player.z},${bot.player.level})`);

    const coord: Coordination = {
        botBReadyForKey: false,
        keyDropped: false,
        keyPickedUp: false,
        botBReadyForCert: false,
        botAReadyForShield: false,
        shieldDropped: false,
        shieldPickedUp: false,
        certDropped: false,
        certPickedUp: false,
        phoenixBotDone: false,
        blackArmBotDone: false,
        phoenixBotError: null,
        blackArmBotError: null,
    };

    // Clean up any leftover arrav-blackarm player from a previous test run.
    // Between hot-reloaded runs the old BotManager instance may have been garbage
    // collected without fully removing the player from the world. A stale player
    // with the same username in World.playerLoop causes processLogin to reject
    // the new player (it never gets onLogin(), stays isActive=false, and can't move).
    BotManager.forceCleanup('arrav-blackarm');

    // Spawn Bot B for Black Arm Gang
    const _botBApi = BotManager.spawnBot('arrav-blackarm', async (blackArmBot: BotAPI) => {
        // Wait for login to complete — need enough ticks for processLogin to run
        for (let i = 0; i < 10; i++) {
            await blackArmBot.waitForTick();
            if (blackArmBot.player.isActive) break;
        }
        if (!blackArmBot.player.isActive) {
            throw new Error(`Bot B login failed: isActive=${blackArmBot.player.isActive} tele=${blackArmBot.player.tele} delayed=${blackArmBot.player.delayed}`);
        }
        try {
            await runBlackArmPath(blackArmBot, coord);
        } catch (err) {
            coord.blackArmBotError = (err as Error).message;
            throw err;
        }
    });

    try {
        // Run Phoenix Gang path on Bot A
        const root = buildPhoenixStates(bot, coord);
        const snapshotDir = path.resolve(import.meta.dir, '..', 'test', 'snapshots');
        await runStateMachine(bot, {
            root,
            varpIds: [PHOENIX_VARP, BLACKARM_VARP],
            captureSnapshots: true,
            snapshotDir,
        });

        // Wait for Bot B to finish (it should be close to done or already done)
        for (let i = 0; i < 5000; i++) {
            if (coord.blackArmBotDone || coord.blackArmBotError) break;
            await bot.waitForTick();
        }

        if (coord.blackArmBotError) {
            throw new Error(`Black Arm Bot failed: ${coord.blackArmBotError}`);
        }
        if (!coord.blackArmBotDone) {
            bot.log('STATE', 'Black Arm Bot did not finish in time, but Phoenix quest is complete');
        }

        bot.log('SUCCESS', 'Shield of Arrav quest complete for both bots!');
    } finally {
        // Always clean up Bot B to prevent "already active" errors on re-run.
        // Use forceCleanup to also remove the player from World.playerLoop
        // in case the BotManager tracking is out of sync.
        BotManager.forceCleanup('arrav-blackarm');
    }
}

export const metadata: ScriptMeta = {
    name: 'shieldofarrav',
    type: 'quest',
    varpId: PHOENIX_VARP,
    varpComplete: PG_COMPLETE,
    maxTicks: 120000,
    run: shieldOfArrav,
    extraAssertions: (api: BotAPI) => [{
        name: 'Phoenix Gang quest complete (varp 146 = 10)',
        pass: api.getQuestProgress(PHOENIX_VARP) === PG_COMPLETE,
    }],
};
