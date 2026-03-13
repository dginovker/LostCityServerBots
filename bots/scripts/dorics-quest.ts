import path from 'path';
import { BotAPI } from '../runtime/api.js';
import { skipTutorial } from './skip-tutorial.js';
import { type BotState, runStateMachine } from '../runtime/state-machine.js';
import type { ScriptMeta } from '../runtime/script-meta.js';

// Varp ID for Doric's Quest progress (from content/pack/varp.pack: 31=doricquest)
const DORICS_QUEST_VARP = 31;

// Quest stages (from content/scripts/quests/quest_doric/scripts/quest_doric.rs2)
const STAGE_NOT_STARTED = 0;
const STAGE_STARTED = 10;
const STAGE_COMPLETE = 100;

// Items required for the quest
const CLAY_NEEDED = 6;
const COPPER_ORE_NEEDED = 4;
const IRON_ORE_NEEDED = 2;

// ---- Key locations ----

// Doric's house — north of Falador, on the road to Taverley
// Doric has moverestrict=indoors so he stays inside.
// We target outside the house (wall at z≈3449), then open door to enter.
const DORIC_AREA_X = 2951;
const DORIC_AREA_Z = 3448;

// Rimmington mine — has clay, copper, tin, iron rocks
// Located south-west of Falador at roughly (2970-2990, 3230-3240)
const RIMMINGTON_MINE_X = 2978;
const RIMMINGTON_MINE_Z = 3235;

// Route waypoints: Lumbridge → Falador (west) → Rimmington (south-west)
// and Rimmington → Falador → north to Doric
const ROUTE_LUMBRIDGE_TO_DRAYNOR = { x: 3105, z: 3250 };
const ROUTE_DRAYNOR_TO_RIMM = { x: 2970, z: 3240 };
const ROUTE_RIMM_TO_FALADOR_SOUTH = { x: 2965, z: 3370 };
// Enter Falador via south gate, then go through town to north exit
const ROUTE_FALADOR_SOUTH_GATE = { x: 2965, z: 3394 };
const ROUTE_FALADOR_NORTH = { x: 2945, z: 3400 };
// Waypoint inside Falador park area, on the way to Doric
const ROUTE_FALADOR_PARK = { x: 2960, z: 3430 };


/**
 * Mine a specific type of ore until we have the required amount.
 * @param rockNames - debugnames to search for (e.g. ['clayrock1', 'clayrock2'])
 * @param oreName - display name of the ore (e.g. 'Clay')
 * @param needed - total number of this ore needed
 */
async function mineOre(bot: BotAPI, rockNames: string[], oreName: string, needed: number): Promise<void> {
    let mineAttempts = 0;
    const MAX_MINE_ATTEMPTS = 200;

    while (bot.countItem(oreName) < needed && mineAttempts < MAX_MINE_ATTEMPTS) {
        await bot.clearPendingState();

        // Find a rock of the right type
        let rock = null;
        for (const name of rockNames) {
            rock = bot.findNearbyLoc(name);
            if (rock) break;
        }

        if (!rock) {
            // All rocks depleted, wait for respawn
            await bot.waitForTicks(15);
            mineAttempts++;
            if (mineAttempts % 20 === 0) {
                bot.log('STATE', `Waiting for ${oreName} rocks to respawn... (attempt ${mineAttempts})`);
            }
            continue;
        }

        const countBefore = bot.countItem(oreName);
        await bot.interactLoc(rock, 1);

        // Wait for ore to appear (up to 30 ticks)
        for (let i = 0; i < 30; i++) {
            await bot.waitForTick();
            if (bot.countItem(oreName) > countBefore) break;
        }

        await bot.waitForTicks(1);
        bot.dismissModals();
        mineAttempts = 0; // Reset on successful interaction

        const current = bot.countItem(oreName);
        if (current > countBefore) {
            bot.log('EVENT', `Mined ${oreName}: ${current}/${needed}`);
        }
    }

    const finalCount = bot.countItem(oreName);
    if (finalCount < needed) {
        throw new Error(`Failed to mine enough ${oreName}: got ${finalCount}, needed ${needed} after ${MAX_MINE_ATTEMPTS} attempts`);
    }
}

/**
 * Walk from Rimmington mine to Doric's house north of Falador.
 */
async function walkFromMineToDoric(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Walking from mine to Doric ===');
    // East detour around the wall at z=3340 (same as forward route, reversed)
    await bot.walkToWithPathfinding(3020, 3240);
    await bot.walkToWithPathfinding(3020, 3300);
    await bot.walkToWithPathfinding(3020, 3370);
    await bot.walkToWithPathfinding(ROUTE_RIMM_TO_FALADOR_SOUTH.x, ROUTE_RIMM_TO_FALADOR_SOUTH.z);
    await bot.walkToWithPathfinding(ROUTE_FALADOR_SOUTH_GATE.x, ROUTE_FALADOR_SOUTH_GATE.z);
    await bot.walkToWithPathfinding(ROUTE_FALADOR_NORTH.x, ROUTE_FALADOR_NORTH.z);
    await bot.walkToWithPathfinding(ROUTE_FALADOR_PARK.x, ROUTE_FALADOR_PARK.z);
    await bot.walkToWithPathfinding(DORIC_AREA_X, DORIC_AREA_Z);
    bot.log('STATE', `Near Doric's house: pos=(${bot.player.x},${bot.player.z})`);
}

/**
 * Walk from Lumbridge to Doric's house north of Falador.
 */
async function walkFromLumbridgeToDoric(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Walking from Lumbridge to Doric ===');
    await bot.walkToWithPathfinding(ROUTE_LUMBRIDGE_TO_DRAYNOR.x, ROUTE_LUMBRIDGE_TO_DRAYNOR.z);
    await bot.walkToWithPathfinding(ROUTE_DRAYNOR_TO_RIMM.x, ROUTE_DRAYNOR_TO_RIMM.z);
    await bot.walkToWithPathfinding(ROUTE_RIMM_TO_FALADOR_SOUTH.x, ROUTE_RIMM_TO_FALADOR_SOUTH.z);
    await bot.walkToWithPathfinding(ROUTE_FALADOR_SOUTH_GATE.x, ROUTE_FALADOR_SOUTH_GATE.z);
    await bot.walkToWithPathfinding(ROUTE_FALADOR_NORTH.x, ROUTE_FALADOR_NORTH.z);
    await bot.walkToWithPathfinding(ROUTE_FALADOR_PARK.x, ROUTE_FALADOR_PARK.z);
    await bot.walkToWithPathfinding(DORIC_AREA_X, DORIC_AREA_Z);
    bot.log('STATE', `Near Doric's house: pos=(${bot.player.x},${bot.player.z})`);
}

/**
 * Build the Doric's Quest state machine.
 * States: start-quest, gather-materials, deliver-to-doric
 */
export function buildDoricsQuestStates(bot: BotAPI): BotState {
    return {
        name: 'dorics-quest',
        isComplete: () => bot.getQuestProgress(DORICS_QUEST_VARP) === STAGE_COMPLETE,
        run: async () => { throw new Error('Composite state should not be called directly'); },
        children: [
            {
                name: 'start-quest',
                isComplete: () => bot.getQuestProgress(DORICS_QUEST_VARP) >= STAGE_STARTED,
                run: async () => {
                    await walkFromLumbridgeToDoric(bot);

                    // Open Doric's house door and walk inside
                    await bot.openDoor('inaccastledoubledoorropen');
                    await bot.waitForTicks(2);

                    // Clear any stuck state before interacting
                    await bot.clearPendingState();

                    // Find Doric and walk to his position so we're definitely adjacent
                    let doric = bot.findNearbyNpc('Doric');
                    if (!doric) {
                        throw new Error(`Doric not found near (${bot.player.x},${bot.player.z},${bot.player.level})`);
                    }
                    bot.log('STATE', `Found Doric at (${doric.x},${doric.z}), walking to him...`);
                    await bot.walkToWithPathfinding(doric.x, doric.z);
                    await bot.waitForTicks(1);

                    // Re-find Doric (he may have wandered)
                    doric = bot.findNearbyNpc('Doric');
                    if (!doric) {
                        throw new Error(`Doric not found after walking to house at (${bot.player.x},${bot.player.z})`);
                    }
                    bot.log('STATE', `Talking to Doric at (${doric.x},${doric.z}), bot at (${bot.player.x},${bot.player.z})`);
                    await bot.interactNpc(doric, 1);

                    // Wait for dialog to open with generous timeout
                    const dialogOpened = await bot.waitForDialog(30);
                    if (!dialogOpened) {
                        throw new Error(`No dialog opened after talking to Doric. pos=(${bot.player.x},${bot.player.z}), Doric at (${doric.x},${doric.z})`);
                    }

                    // 1. chatnpc: "Hello traveller, what brings you to my humble smithy?" -> continue
                    await bot.continueDialog();

                    // 2. p_choice4: pick option 1 "I wanted to use your anvils."
                    const hasChoice1 = await bot.waitForDialog(10);
                    if (!hasChoice1) throw new Error('No dialog: expected p_choice4 for Doric');
                    await bot.selectDialogOption(1);

                    // 3. chatplayer "I wanted to use your anvils." -> continue
                    const hasDialog3 = await bot.waitForDialog(10);
                    if (!hasDialog3) throw new Error('No dialog: expected chatplayer "I wanted to use your anvils."');
                    await bot.continueDialog();

                    // 4. chatnpc "My anvils get enough work with my own use..." -> continue
                    const hasDialog4 = await bot.waitForDialog(10);
                    if (!hasDialog4) throw new Error('No dialog: expected chatnpc about anvils');
                    await bot.continueDialog();

                    // 5. p_choice2: "Yes, I will get you materials." (1)
                    const hasChoice2 = await bot.waitForDialog(10);
                    if (!hasChoice2) throw new Error('No dialog: expected p_choice2 for quest accept');
                    await bot.selectDialogOption(1);

                    // 6. chatplayer "Yes, I will get you materials." -> varp set to 10
                    const hasDialog6 = await bot.waitForDialog(10);
                    if (!hasDialog6) throw new Error('No dialog: expected chatplayer "Yes, I will get you materials."');
                    await bot.continueDialog();

                    // 7. chatnpc "Well, clay is what I use more than anything..." -> continue
                    const hasDialog7 = await bot.waitForDialog(10);
                    if (!hasDialog7) throw new Error('No dialog: expected chatnpc about clay');
                    await bot.continueDialog();

                    // 8. chatplayer "Certainly, I will get them for you. Goodbye." -> continue
                    const hasDialog8 = await bot.waitForDialog(10);
                    if (hasDialog8) {
                        await bot.continueDialog();
                    }

                    // Drain any remaining dialog
                    await bot.continueRemainingDialogs();
                    await bot.waitForTicks(2);

                    const varpAfterStart = bot.getQuestProgress(DORICS_QUEST_VARP);
                    if (varpAfterStart !== STAGE_STARTED) {
                        throw new Error(`Quest varp after starting is ${varpAfterStart}, expected ${STAGE_STARTED}`);
                    }
                    bot.log('EVENT', `Quest started! varp=${varpAfterStart}`);
                }
            },
            {
                name: 'gather-materials',
                isComplete: () => {
                    return bot.countItem('Clay') >= CLAY_NEEDED &&
                           bot.countItem('Copper ore') >= COPPER_ORE_NEEDED &&
                           bot.countItem('Iron ore') >= IRON_ORE_NEEDED;
                },
                stuckThreshold: 3000,
                run: async () => {
                    // Walk from Doric south to Rimmington mine
                    await bot.openDoor('inaccastledoubledoorropen');
                    await bot.waitForTicks(1);
                    await bot.walkToWithPathfinding(ROUTE_FALADOR_PARK.x, ROUTE_FALADOR_PARK.z);
                    await bot.walkToWithPathfinding(ROUTE_FALADOR_NORTH.x, ROUTE_FALADOR_NORTH.z);
                    await bot.walkToWithPathfinding(ROUTE_FALADOR_SOUTH_GATE.x, ROUTE_FALADOR_SOUTH_GATE.z);
                    await bot.walkToWithPathfinding(ROUTE_RIMM_TO_FALADOR_SOUTH.x, ROUTE_RIMM_TO_FALADOR_SOUTH.z);
                    await bot.walkToWithPathfinding(3020, 3370);
                    await bot.walkToWithPathfinding(3020, 3300);
                    await bot.walkToWithPathfinding(3020, 3240);
                    await bot.walkToWithPathfinding(RIMMINGTON_MINE_X, RIMMINGTON_MINE_Z);
                    bot.log('STATE', `At Rimmington mine: pos=(${bot.player.x},${bot.player.z})`);

                    // Mine clay (6 needed)
                    bot.log('STATE', '--- Mining clay ---');
                    await mineOre(bot, ['clayrock1', 'clayrock2'], 'Clay', CLAY_NEEDED);
                    bot.log('EVENT', `Clay mined: ${bot.countItem('Clay')}/${CLAY_NEEDED}`);

                    // Mine copper ore (4 needed)
                    bot.log('STATE', '--- Mining copper ore ---');
                    await mineOre(bot, ['copperrock1', 'copperrock2'], 'Copper ore', COPPER_ORE_NEEDED);
                    bot.log('EVENT', `Copper ore mined: ${bot.countItem('Copper ore')}/${COPPER_ORE_NEEDED}`);

                    // Train mining to level 15 for iron if needed
                    const miningLevel = bot.getSkill('Mining').baseLevel;
                    if (miningLevel < 15) {
                        bot.log('STATE', `Mining level is ${miningLevel}, need 15 for iron. Training...`);
                        await trainMiningToLevel(bot, 15);
                    }

                    // Drop excess ores to make room for iron
                    while (bot.freeSlots() < 3) {
                        if (bot.countItem('Copper ore') > COPPER_ORE_NEEDED) {
                            await bot.dropItem('Copper ore');
                        } else if (bot.countItem('Clay') > CLAY_NEEDED) {
                            await bot.dropItem('Clay');
                        } else {
                            break;
                        }
                        await bot.waitForTicks(1);
                    }

                    bot.log('STATE', `--- Mining iron ore (free slots: ${bot.freeSlots()}) ---`);
                    await mineOre(bot, ['ironrock1', 'ironrock2'], 'Iron ore', IRON_ORE_NEEDED);
                    bot.log('EVENT', `Iron ore mined: ${bot.countItem('Iron ore')}/${IRON_ORE_NEEDED}`);

                    // Verify all materials
                    const clay = bot.countItem('Clay');
                    const copper = bot.countItem('Copper ore');
                    const iron = bot.countItem('Iron ore');
                    if (clay < CLAY_NEEDED || copper < COPPER_ORE_NEEDED || iron < IRON_ORE_NEEDED) {
                        throw new Error(`Not enough materials: clay=${clay}/${CLAY_NEEDED}, copper=${copper}/${COPPER_ORE_NEEDED}, iron=${iron}/${IRON_ORE_NEEDED}`);
                    }
                    bot.log('EVENT', `All materials gathered: clay=${clay}, copper=${copper}, iron=${iron}`);
                }
            },
            {
                name: 'deliver-to-doric',
                isComplete: () => bot.getQuestProgress(DORICS_QUEST_VARP) === STAGE_COMPLETE,
                run: async () => {
                    await walkFromMineToDoric(bot);

                    // Open door and enter Doric's house
                    await bot.openDoor('inaccastledoubledoorropen');
                    await bot.waitForTicks(2);

                    // Clear any stuck state before interacting
                    await bot.clearPendingState();

                    // Find Doric and walk to his position so we're definitely adjacent
                    let doric = bot.findNearbyNpc('Doric');
                    if (!doric) {
                        throw new Error(`Doric not found near (${bot.player.x},${bot.player.z},${bot.player.level})`);
                    }
                    bot.log('STATE', `Found Doric at (${doric.x},${doric.z}), walking to him...`);
                    await bot.walkToWithPathfinding(doric.x, doric.z);
                    await bot.waitForTicks(1);

                    // Re-find Doric (he may have wandered)
                    doric = bot.findNearbyNpc('Doric');
                    if (!doric) {
                        throw new Error(`Doric not found after walking to house at (${bot.player.x},${bot.player.z})`);
                    }
                    bot.log('STATE', `Talking to Doric at (${doric.x},${doric.z}) for delivery, bot at (${bot.player.x},${bot.player.z})`);
                    await bot.interactNpc(doric, 1);

                    // Wait for dialog to open with generous timeout
                    const dialogOpened = await bot.waitForDialog(30);
                    if (!dialogOpened) {
                        throw new Error(`No dialog opened after talking to Doric for delivery. pos=(${bot.player.x},${bot.player.z}), Doric at (${doric.x},${doric.z})`);
                    }

                    // Dialog flow for doric_materials (quest stage 10 with all materials):
                    // 1. chatnpc: "Have you got my materials yet, traveller?"
                    await bot.continueDialog();

                    // 2. chatplayer: "I have everything you need!"
                    const hasDialog2 = await bot.waitForDialog(10);
                    if (!hasDialog2) throw new Error('No dialog: expected chatplayer "I have everything you need!"');
                    await bot.continueDialog();

                    // 3. chatnpc: "Many thanks, pass them here please."
                    const hasDialog3 = await bot.waitForDialog(10);
                    if (!hasDialog3) throw new Error('No dialog: expected chatnpc "Many thanks"');
                    await bot.continueDialog();

                    // 4. chatnpc: "I can spare you some coins for your trouble."
                    const hasDialog4 = await bot.waitForDialog(10);
                    if (!hasDialog4) throw new Error('No dialog: expected chatnpc about coins');
                    await bot.continueDialog();

                    // 5. chatnpc: "Please use my anvils any time you want."
                    const hasDialog5 = await bot.waitForDialog(10);
                    if (!hasDialog5) throw new Error('No dialog: expected chatnpc about anvils');
                    await bot.continueDialog();

                    // Drain any remaining dialog
                    await bot.continueRemainingDialogs();

                    // Wait for the queued script (doric_quest_complete) to fire
                    await bot.waitForTicks(5);

                    // Dismiss quest complete interface
                    bot.dismissModals();

                    await bot.waitForTicks(3);
                    bot.dismissModals();

                    const finalVarp = bot.getQuestProgress(DORICS_QUEST_VARP);
                    const miningSkill = bot.getSkill('Mining');
                    const coins = bot.findItem('Coins');

                    if (finalVarp !== STAGE_COMPLETE) {
                        throw new Error(`Quest not complete: varp is ${finalVarp}, expected ${STAGE_COMPLETE}`);
                    }

                    if (coins === null || coins.count < 180) {
                        throw new Error(`Expected at least 180 coins, got ${coins ? coins.count : 0}`);
                    }

                    bot.log('SUCCESS', `Doric's Quest complete! varp=${finalVarp}, mining_xp=${miningSkill.exp}, coins=${coins.count}`);
                }
            }
        ]
    };
}

export async function doricsQuest(bot: BotAPI): Promise<void> {
    // === Setup: skip tutorial, start in Lumbridge ===
    await skipTutorial(bot);
    await bot.waitForTicks(2);

    bot.log('STATE', `Starting Doric's Quest at (${bot.player.x},${bot.player.z},${bot.player.level})`);

    const initialVarp = bot.getQuestProgress(DORICS_QUEST_VARP);
    if (initialVarp !== STAGE_NOT_STARTED) {
        throw new Error(`Quest varp is ${initialVarp}, expected ${STAGE_NOT_STARTED} (not started)`);
    }

    const root = buildDoricsQuestStates(bot);
    const snapshotDir = path.resolve(import.meta.dir, '..', 'test', 'snapshots');
    await runStateMachine(bot, { root, varpIds: [DORICS_QUEST_VARP], captureSnapshots: true, snapshotDir });
}

/**
 * Train mining by mining copper and tin at the current location until we reach
 * the target level. Drops excess ores to keep inventory space.
 */
async function trainMiningToLevel(bot: BotAPI, targetLevel: number): Promise<void> {
    bot.log('STATE', `Training Mining to level ${targetLevel} (currently ${bot.getSkill('Mining').baseLevel})...`);

    while (bot.getSkill('Mining').baseLevel < targetLevel) {
        await bot.clearPendingState();

        // Drop excess ores to keep inventory space (keep quest items)
        if (bot.freeSlots() < 1) {
            // Drop tin ore first (not needed for quest), then excess copper/clay
            const tin = bot.findItem('Tin ore');
            if (tin) { await bot.dropItem('Tin ore'); await bot.waitForTicks(1); continue; }
            const excessCopper = bot.countItem('Copper ore') > COPPER_ORE_NEEDED ? bot.findItem('Copper ore') : null;
            if (excessCopper) { await bot.dropItem('Copper ore'); await bot.waitForTicks(1); continue; }
            const excessClay = bot.countItem('Clay') > CLAY_NEEDED ? bot.findItem('Clay') : null;
            if (excessClay) { await bot.dropItem('Clay'); await bot.waitForTicks(1); continue; }
            // If nothing droppable, something is wrong
            throw new Error('Inventory full during mining training but no excess ores to drop');
        }

        // Find a copper or tin rock to mine
        const rock = bot.findNearbyLoc('copperrock1') ?? bot.findNearbyLoc('tinrock1')
            ?? bot.findNearbyLoc('copperrock2') ?? bot.findNearbyLoc('tinrock2');
        if (!rock) {
            // Rocks depleted, wait for respawn
            await bot.waitForTicks(15);
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

        if (bot.getSkill('Mining').baseLevel % 3 === 0 || bot.getSkill('Mining').baseLevel >= targetLevel) {
            bot.log('STATE', `Mining level: ${bot.getSkill('Mining').baseLevel}, XP: ${bot.getSkill('Mining').exp}`);
        }
    }

    bot.log('EVENT', `Mining trained to level ${bot.getSkill('Mining').baseLevel}!`);
}

export const metadata: ScriptMeta = {
    name: 'doricsquest',
    type: 'quest',
    varpId: DORICS_QUEST_VARP,
    varpComplete: STAGE_COMPLETE,
    maxTicks: 20000,
    run: doricsQuest,
    buildStates: buildDoricsQuestStates,
};
