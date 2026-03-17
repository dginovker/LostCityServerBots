import path from 'path';
import { BotAPI } from '../../runtime/api.js';
import { skipTutorial } from '../skip-tutorial.js';
import { type BotState, runStateMachine } from '../../runtime/state-machine.js';
import type { ScriptMeta } from '../../runtime/script-meta.js';

// Varp ID for Witch's Potion quest progress (from content/pack/varp.pack: 67=hetty)
const HETTY_VARP = 67;

// Quest stages (from content/scripts/quests/quest_hetty/configs/quest_hetty.constant
// and content/scripts/general/configs/quest.constant)
const STAGE_NOT_STARTED = 0;
const STAGE_STARTED = 1;
const STAGE_OBJECTS_GIVEN = 2;
const STAGE_COMPLETE = 3;

// ---- Key locations ----

// Rimmington — Hetty's house area. Approach from east (Port Sarim side).
// Rimmington is west of Port Sarim. Walk through Draynor, then west.
const RIMMINGTON_X = 2968;
const RIMMINGTON_Z = 3210;

// Port Sarim — Betty's magic shop (spawns at 3012,3259 per map data n47_50)
const BETTY_SHOP_X = 3012;
const BETTY_SHOP_Z = 3259;

// Port Sarim — Wydin's food store
const WYDIN_STORE_X = 3014;
const WYDIN_STORE_Z = 3204;

// Onion field south of Fred's farm / east of Lumbridge
// (from prince-ali-rescue.ts)
const ONION_GATE_X = 3185;
const ONION_GATE_Z = 3268;

// ---- Waypoints ----

// Route from Lumbridge to Rimmington area (via Draynor road)
// Uses road waypoints to avoid forested areas that block pathfinding
const LUMBRIDGE_TO_RIMMINGTON = [
    { x: 3110, z: 3260 },   // Draynor Village (proven route from prince-ali-rescue)
    { x: 3047, z: 3237 },   // Port Sarim area
    { x: RIMMINGTON_X, z: RIMMINGTON_Z },
];

// Route from Lumbridge to Port Sarim
const LUMBRIDGE_TO_PORT_SARIM = [
    { x: 3110, z: 3260 },   // Draynor Village
    { x: 3047, z: 3237 },   // Port Sarim area
];

/**
 * Walk from current position to Rimmington using proven waypoints.
 */
async function walkToRimmington(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Walking to Rimmington ===');
    // If near Lumbridge (east of Draynor route), walk to Lumbridge spawn first
    if (bot.player.x > 3150 && bot.player.z < 3250) {
        await bot.walkToWithPathfinding(3222, 3218);
    }
    for (const wp of LUMBRIDGE_TO_RIMMINGTON) {
        await bot.walkToWithPathfinding(wp.x, wp.z);
    }
    bot.log('STATE', `Arrived in Rimmington: pos=(${bot.player.x},${bot.player.z})`);
}

/**
 * Walk from current position to Port Sarim area.
 */
async function walkToPortSarim(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Walking to Port Sarim ===');
    // If already near Port Sarim area (broad check covering Betty's shop at z=3259)
    if (Math.abs(bot.player.x - 3030) < 40 && Math.abs(bot.player.z - 3245) < 30) {
        return;
    }
    // If near Rimmington, just walk east/north
    if (bot.player.x < 3000) {
        await bot.walkToWithPathfinding(3047, 3237);
        return;
    }
    for (const wp of LUMBRIDGE_TO_PORT_SARIM) {
        await bot.walkToWithPathfinding(wp.x, wp.z);
    }
    bot.log('STATE', `Arrived in Port Sarim: pos=(${bot.player.x},${bot.player.z})`);
}

/**
 * Talk to Hetty to start the quest.
 * Dialog flow (from hetty.rs2):
 *   1. chatnpc "What could you want..." → continue
 *   2. p_choice2 → select "I am in search of a quest." (1)
 *   3. chatplayer "I am in search of a quest." → continue
 *   4. chatnpc "Hmmm... Maybe I can think of something for you." → continue
 *   5. chatnpc "Would you like to become more proficient in the dark arts?" → continue
 *   6. p_choice3 → select "Yes help me become one with my darker side." (1)
 *   7. chatplayer "Yes help me become one with my darker side." → continue
 *   8. @hetty_darker_self: chatnpc "Ok I'm going to make a potion..." → continue
 *   9. chatnpc "You will need certain ingredients." → continue
 *  10. chatplayer "What do I need?" → continue
 *  11. → varp set to 1 (started)
 *  12. chatnpc "You need an eye of newt, a rat's tail..." → continue
 *  13. chatplayer "Great, I'll go and get them." → continue
 */
async function startQuest(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Starting Witch\'s Potion quest ===');

    await walkToRimmington(bot);

    // Walk close to Hetty's house — walkToWithPathfinding auto-opens doors
    await bot.walkToWithPathfinding(2968, 3205);

    const hetty = bot.findNearbyNpc('Hetty', 10);
    if (!hetty) {
        throw new Error(`Hetty not found near (${bot.player.x},${bot.player.z})`);
    }

    bot.log('STATE', `Found Hetty at (${hetty.x},${hetty.z})`);
    await bot.interactNpc(hetty, 1);

    const dialogOpened = await bot.waitForDialog(30);
    if (!dialogOpened) {
        throw new Error(`No dialog opened after talking to Hetty. Bot at (${bot.player.x},${bot.player.z}), Hetty at (${hetty.x},${hetty.z})`);
    }

    // 1. chatnpc "What could you want with an old woman like me?"
    await bot.continueDialog();

    // 2. p_choice2: "I am in search of a quest." (1), "I've heard that you are a witch." (2)
    const choice1 = await bot.waitForDialog(10);
    if (!choice1) throw new Error('No dialog: expected p_choice2');
    await bot.selectDialogOption(1);

    // 3. chatplayer "I am in search of a quest."
    const d3 = await bot.waitForDialog(10);
    if (!d3) throw new Error('No dialog: expected chatplayer');
    await bot.continueDialog();

    // 4. chatnpc "Hmmm... Maybe I can think of something for you."
    const d4 = await bot.waitForDialog(10);
    if (!d4) throw new Error('No dialog: expected chatnpc "Hmmm..."');
    await bot.continueDialog();

    // 5. chatnpc "Would you like to become more proficient in the dark arts?"
    const d5 = await bot.waitForDialog(10);
    if (!d5) throw new Error('No dialog: expected chatnpc about dark arts');
    await bot.continueDialog();

    // 6. p_choice3: "Yes help me become one with my darker side." (1)
    const choice2 = await bot.waitForDialog(10);
    if (!choice2) throw new Error('No dialog: expected p_choice3');
    await bot.selectDialogOption(1);

    // 7. chatplayer "Yes help me become one with my darker side."
    const d7 = await bot.waitForDialog(10);
    if (!d7) throw new Error('No dialog: expected chatplayer darker side');
    await bot.continueDialog();

    // 8. chatnpc "Ok I'm going to make a potion to help bring out your darker self."
    const d8 = await bot.waitForDialog(10);
    if (!d8) throw new Error('No dialog: expected chatnpc about potion');
    await bot.continueDialog();

    // 9. chatnpc "You will need certain ingredients."
    const d9 = await bot.waitForDialog(10);
    if (!d9) throw new Error('No dialog: expected chatnpc ingredients');
    await bot.continueDialog();

    // 10. chatplayer "What do I need?"
    const d10 = await bot.waitForDialog(10);
    if (!d10) throw new Error('No dialog: expected chatplayer what do i need');
    await bot.continueDialog();

    // 11. varp is set to 1 here, then:
    // quest progress sent, then:
    // chatnpc "You need an eye of newt, a rat's tail, an onion... Oh and a piece of burnt meat."
    const d11 = await bot.waitForDialog(10);
    if (!d11) throw new Error('No dialog: expected chatnpc ingredient list');
    await bot.continueDialog();

    // 12. chatplayer "Great, I'll go and get them."
    const d12 = await bot.waitForDialog(10);
    if (d12) {
        await bot.continueDialog();
    }

    // Continue any remaining dialogs
    await bot.continueRemainingDialogs(5);

    await bot.waitForTicks(2);

    const varp = bot.getQuestProgress(HETTY_VARP);
    if (varp !== STAGE_STARTED) {
        throw new Error(`Quest varp after starting is ${varp}, expected ${STAGE_STARTED}`);
    }
    bot.log('EVENT', `Witch's Potion quest started! varp=${varp}`);
}

/**
 * Buy eye of newt from Betty's magic shop in Port Sarim.
 * Betty has op3=Trade which opens the shop directly.
 */
async function buyEyeOfNewt(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Buying Eye of newt from Betty ===');

    await walkToPortSarim(bot);
    // Walk to Betty's shop — walkToWithPathfinding auto-opens doors
    await bot.walkToWithPathfinding(BETTY_SHOP_X, BETTY_SHOP_Z);

    const betty = bot.findNearbyNpc('Betty', 20);
    if (!betty) {
        throw new Error(`Betty not found near (${bot.player.x},${bot.player.z})`);
    }

    bot.log('STATE', `Found Betty at (${betty.x},${betty.z})`);
    await bot.interactNpc(betty, 3); // op3 = Trade
    await bot.waitForTicks(3);

    await bot.buyFromShop('Eye of newt', 1);
    await bot.waitForTicks(1);

    bot.dismissModals();

    const eyeOfNewt = bot.findItem('Eye of newt');
    if (!eyeOfNewt) {
        throw new Error('Failed to buy Eye of newt -- not in inventory after purchase');
    }
    bot.log('EVENT', `Purchased Eye of newt (id=${eyeOfNewt.id})`);
}

/**
 * Buy raw beef from Wydin's food store in Port Sarim.
 * Wydin has op3=Trade which opens the shop directly.
 */
async function buyRawBeef(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Buying Raw beef from Wydin ===');

    await walkToPortSarim(bot);
    await bot.walkToWithPathfinding(WYDIN_STORE_X, WYDIN_STORE_Z);

    const wydin = bot.findNearbyNpc('Wydin', 20);
    if (!wydin) {
        throw new Error(`Wydin not found near (${bot.player.x},${bot.player.z})`);
    }

    bot.log('STATE', `Found Wydin at (${wydin.x},${wydin.z})`);
    await bot.interactNpc(wydin, 3); // op3 = Trade
    await bot.waitForTicks(3);

    await bot.buyFromShop('Raw beef', 1);
    await bot.waitForTicks(1);

    bot.dismissModals();

    const rawBeef = bot.findItem('Raw beef');
    if (!rawBeef) {
        throw new Error('Failed to buy Raw beef -- not in inventory after purchase');
    }
    bot.log('EVENT', `Purchased Raw beef (id=${rawBeef.id})`);

    // Exit Wydin's store — open the door to get out
    const door = bot.findNearbyLoc('wydindoor', 5);
    if (door) {
        await bot.interactLoc(door, 1); // op1=Open
        await bot.waitForTicks(2);
    }
    await bot.walkToWithPathfinding(3016, 3215); // Walk to road outside store
}

/**
 * Cook raw beef on the Lumbridge kitchen range to get burnt meat.
 * At cooking level 1, raw beef will almost certainly burn.
 * If it doesn't burn (cooked_meat obtained), try again.
 */
async function cookBurntMeat(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Cooking raw beef to get burnt meat ===');

    // Walk to Rimmington and use the range at (2970,3209) near Hetty's house.
    // Can't use cooksquestrange (blocks if Cook's quest not done).
    await walkToRimmington(bot);
    // Walk inside Hetty's house area — walkToWithPathfinding auto-opens doors
    await bot.walkToWithPathfinding(2968, 3205);

    const range = bot.findNearbyLoc('loc_2728', 10);
    if (!range) {
        throw new Error(`No cooking range (loc_2728) found near (${bot.player.x},${bot.player.z})`);
    }

    bot.log('STATE', `Found range at (${range.x},${range.z})`);

    // Cook raw beef — at level 1, ~75% chance of burning.
    // Retry if it cooks successfully (drop cooked meat and try again).
    await bot.useItemOnLoc('Raw beef', 'loc_2728');
    await bot.waitForTicks(8);
    bot.dismissModals();

    if (bot.findItem('Burnt meat')) {
        bot.log('EVENT', 'Got burnt meat!');
        return;
    }
    if (bot.findItem('Cooked meat')) {
        bot.log('STATE', 'Cooked meat instead of burnt — dropping and will retry');
        await bot.dropItem('Cooked meat');
        await bot.waitForTicks(1);
    }
    if (bot.findItem('Raw beef')) {
        throw new Error('Raw beef still in inventory — cooking did not trigger');
    }
    // Need to buy more raw beef and try again
    throw new Error('Cooked meat instead of burning — need to retry with more raw beef');
}

/**
 * Pick an onion from the onion field south of Fred's farm.
 */
async function pickOnion(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Picking onion ===');

    // Walk to onion field gate area
    await bot.walkToWithPathfinding(ONION_GATE_X, ONION_GATE_Z);
    await bot.openGate(5);
    await bot.waitForTicks(2);

    // Walk into the onion field
    await bot.walkToWithPathfinding(3187, 3261);

    // Find and pick an onion loc (op2=Pick)
    const onionLoc = bot.findNearbyLoc('onion', 10);
    if (!onionLoc) {
        throw new Error(`No onion loc found near (${bot.player.x},${bot.player.z})`);
    }

    bot.log('STATE', `Found onion at (${onionLoc.x},${onionLoc.z})`);
    const onionsBefore = bot.getInventory().filter(i => i.name === 'Onion').length;
    await bot.interactLoc(onionLoc, 2); // op2=Pick
    await bot.waitForCondition(() => {
        return bot.getInventory().filter(i => i.name === 'Onion').length > onionsBefore;
    }, 20);
    bot.dismissModals();

    const onion = bot.findItem('Onion');
    if (!onion) {
        throw new Error('Failed to pick onion');
    }
    bot.log('EVENT', `Picked onion (id=${onion.id})`);
}

/**
 * Find and kill a rat to get a rat's tail.
 * Rats tail only drops when quest is started (%hetty = 1 or 2).
 * Regular rats (type 47) are 1 HP and die in one hit.
 * Search near Lumbridge (rats in castle basement/kitchen area),
 * or walk to Port Sarim area where rats spawn.
 */
async function killRatForTail(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Killing rat for rat\'s tail ===');

    // Rat cluster south of Lumbridge castle (id=47, 2HP, spawns at 3205-3207,3202-3209)
    await bot.walkToWithPathfinding(3206, 3204);
    bot.log('STATE', `At rat area: pos=(${bot.player.x},${bot.player.z})`);

    for (let attempt = 0; attempt < 10; attempt++) {
        const rat = bot.findNearbyNpc('Rat', 20);
        if (!rat) {
            bot.log('STATE', 'No rat found, waiting for respawn...');
            await bot.waitForTicks(10);
            continue;
        }

        bot.log('STATE', `Found rat at (${rat.x},${rat.z}), attacking...`);
        await bot.attackNpcUntilDead('Rat', { maxTicks: 300 });
        await bot.waitForTicks(5);

        // Look for rat's tail on the ground
        const tailGround = bot.findNearbyGroundItem('Rats tail', 15);
        if (tailGround) {
            bot.log('EVENT', `Found rat's tail on ground at (${tailGround.x},${tailGround.z})`);
            await bot.takeGroundItem('Rats tail', tailGround.x, tailGround.z);
            await bot.waitForTicks(3);
        }

        if (bot.findItem('Rats tail')) {
            bot.log('EVENT', 'Got rat\'s tail!');
            return;
        }

        bot.log('STATE', `No tail dropped (attempt ${attempt + 1}), trying another rat...`);
        await bot.waitForTicks(5);
    }

    throw new Error('Failed to get rat tail after 10 kills');
}

/**
 * Deliver all 4 quest items to Hetty.
 * Dialog flow (from hetty.rs2 case ^hetty_started with all items):
 *   1. chatnpc "So have you found the things for the potion?"
 *   2. chatplayer "Yes I have everything!"
 *   3. chatnpc "Excellent, can I have them then?"
 *   4. mesbox about passing ingredients
 *   5. chatplayer "Well, is it ready?"
 *   6. → items deleted, varp set to 2
 *   7. chatnpc "Ok, now drink from the cauldron."
 */
async function deliverItems(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Delivering items to Hetty ===');

    await walkToRimmington(bot);

    // Walk close to Hetty's house — walkToWithPathfinding auto-opens doors
    await bot.walkToWithPathfinding(2968, 3205);

    const hetty = bot.findNearbyNpc('Hetty', 10);
    if (!hetty) {
        throw new Error(`Hetty not found near (${bot.player.x},${bot.player.z})`);
    }

    bot.log('STATE', `Found Hetty at (${hetty.x},${hetty.z})`);
    await bot.interactNpc(hetty, 1);

    const d1 = await bot.waitForDialog(30);
    if (!d1) throw new Error('No dialog opened after talking to Hetty for delivery');

    // Continue through all dialog pages until quest progresses
    for (let i = 0; i < 15; i++) {
        if (bot.isDialogOpen()) {
            if (bot.isMultiChoiceOpen()) {
                bot.log('STATE', 'Unexpected multi-choice during delivery');
                break;
            }
            await bot.continueDialog();
        }
        const hasMore = await bot.waitForDialog(5);
        if (!hasMore) break;
    }

    await bot.waitForTicks(5);
    bot.dismissModals();

    const varp = bot.getQuestProgress(HETTY_VARP);
    if (varp !== STAGE_OBJECTS_GIVEN) {
        throw new Error(`Quest varp after delivery is ${varp}, expected ${STAGE_OBJECTS_GIVEN}`);
    }
    bot.log('EVENT', `Items delivered! varp=${varp}`);
}

/**
 * Drink from Hetty's cauldron to complete the quest.
 * oploc1 on hettycauldron → mesbox → queue(hetty_quest_complete) → varp=3, magic XP
 */
async function drinkFromCauldron(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Drinking from cauldron ===');

    // Walk inside Hetty's house — walkToWithPathfinding auto-opens doors
    await bot.walkToWithPathfinding(2968, 3205);

    const cauldron = bot.findNearbyLoc('hettycauldron', 10);
    if (!cauldron) {
        throw new Error(`Cauldron not found near (${bot.player.x},${bot.player.z})`);
    }

    bot.log('STATE', `Found cauldron at (${cauldron.x},${cauldron.z})`);
    await bot.interactLoc(cauldron, 1); // op1=Drink From

    // mesbox "You drink from the cauldron..."
    const d1 = await bot.waitForDialog(10);
    if (d1) {
        await bot.continueDialog();
    }

    // Wait for queued script to fire
    await bot.waitForTicks(5);
    bot.dismissModals();

    // Continue any remaining dialogs (quest complete interface)
    await bot.continueRemainingDialogs(5);
    await bot.waitForTicks(5);
    bot.dismissModals();
}

/**
 * Build the Witch's Potion state machine.
 */
export function buildWitchsPotionStates(bot: BotAPI): BotState {
    return {
        name: 'witchs-potion',
        isComplete: () => bot.getQuestProgress(HETTY_VARP) === STAGE_COMPLETE,
        run: async () => { throw new Error('Composite state should not be called directly'); },
        children: [
            {
                name: 'earn-coins',
                stuckThreshold: 3000,
                isComplete: () => {
                    const coins = bot.findItem('Coins');
                    return coins !== null && coins.count >= 10;
                },
                run: async () => {
                    await bot.earnCoinsViaPickpocket(10);
                }
            },
            {
                name: 'start-quest',
                isComplete: () => bot.getQuestProgress(HETTY_VARP) >= STAGE_STARTED,
                run: async () => {
                    await startQuest(bot);
                }
            },
            {
                name: 'get-eye-of-newt',
                isComplete: () => bot.findItem('Eye of newt') !== null,
                run: async () => {
                    await buyEyeOfNewt(bot);
                }
            },
            {
                name: 'get-burnt-meat',
                maxRetries: 10,
                isComplete: () => bot.findItem('Burnt meat') !== null,
                run: async () => {
                    // Buy raw beef if we don't have it
                    if (!bot.findItem('Raw beef')) {
                        await buyRawBeef(bot);
                    }
                    await cookBurntMeat(bot);
                }
            },
            {
                name: 'get-onion',
                isComplete: () => bot.findItem('Onion') !== null,
                run: async () => {
                    await pickOnion(bot);
                }
            },
            {
                name: 'kill-rat',
                isComplete: () => bot.findItem('Rats tail') !== null,
                run: async () => {
                    await killRatForTail(bot);
                }
            },
            {
                name: 'deliver-items',
                isComplete: () => bot.getQuestProgress(HETTY_VARP) >= STAGE_OBJECTS_GIVEN,
                run: async () => {
                    // Verify all 4 items before delivering
                    const eyeOfNewt = bot.findItem('Eye of newt');
                    const ratsTail = bot.findItem('Rats tail');
                    const burntMeat = bot.findItem('Burnt meat');
                    const onion = bot.findItem('Onion');
                    if (!eyeOfNewt) throw new Error('Missing Eye of newt before delivery');
                    if (!ratsTail) throw new Error('Missing Rats tail before delivery');
                    if (!burntMeat) throw new Error('Missing Burnt meat before delivery');
                    if (!onion) throw new Error('Missing Onion before delivery');
                    bot.log('EVENT', 'All 4 quest items collected!');

                    await deliverItems(bot);
                }
            },
            {
                name: 'drink-cauldron',
                isComplete: () => bot.getQuestProgress(HETTY_VARP) === STAGE_COMPLETE,
                run: async () => {
                    await drinkFromCauldron(bot);

                    const finalVarp = bot.getQuestProgress(HETTY_VARP);
                    const magicSkill = bot.getSkill('Magic');

                    if (finalVarp !== STAGE_COMPLETE) {
                        throw new Error(`Quest not complete: varp is ${finalVarp}, expected ${STAGE_COMPLETE}`);
                    }
                    if (magicSkill.exp <= 0) {
                        throw new Error('No magic XP gained during quest');
                    }

                    bot.log('SUCCESS', `Witch's Potion quest complete! varp=${finalVarp}, magic_xp=${magicSkill.exp}`);
                }
            }
        ]
    };
}

export async function witchsPotion(bot: BotAPI): Promise<void> {
    await skipTutorial(bot);
    await bot.waitForTicks(2);

    bot.log('STATE', `Starting Witch's Potion quest at (${bot.player.x},${bot.player.z},${bot.player.level})`);

    const initialVarp = bot.getQuestProgress(HETTY_VARP);
    if (initialVarp !== STAGE_NOT_STARTED) {
        throw new Error(`Quest varp is ${initialVarp}, expected ${STAGE_NOT_STARTED} (not started)`);
    }

    const root = buildWitchsPotionStates(bot);
    const snapshotDir = path.resolve(import.meta.dir, '..', 'test', 'snapshots');
    await runStateMachine(bot, { root, varpIds: [HETTY_VARP], captureSnapshots: true, snapshotDir });
}

export const metadata: ScriptMeta = {
    name: 'witchspotion',
    type: 'quest',
    varpId: HETTY_VARP,
    varpComplete: STAGE_COMPLETE,
    maxTicks: 20000,
    run: witchsPotion,
    buildStates: buildWitchsPotionStates,
};
