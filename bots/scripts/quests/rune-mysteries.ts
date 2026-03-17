import path from 'path';
import { BotAPI } from '../../runtime/api.js';
import { skipTutorial } from '../skip-tutorial.js';
import { type BotState, runStateMachine } from '../../runtime/state-machine.js';
import type { ScriptMeta } from '../../runtime/script-meta.js';


// Varp ID for Rune Mysteries quest progress (from content/pack/varp.pack: 63=runemysteries)
const RUNE_MYSTERIES_VARP = 63;

// Quest stages (from content/scripts/quests/quest_runemysteries/configs/quest_runemysteries.constant)
const STAGE_NOT_STARTED = 0;
const STAGE_STARTED = 1;
const _STAGE_GIVEN_TALISMAN = 2;
const STAGE_RECEIVED_PACKAGE = 3;
const STAGE_GIVEN_PACKAGE = 4;
const STAGE_RECEIVED_NOTES = 5;
const STAGE_COMPLETE = 6;

// ---- Key locations ----

// Lumbridge Castle stairs (south side, 2x2 loc)
// loc_1738 on level 0 at (3204, 3207): op1=Climb-up → player lands at (3205, 3209, level 1)
// loc_1739 on level 1 at (3204, 3207): op2=Climb-up, op3=Climb-down → player lands at (3205, 3209, level 0)

// Wizards' Tower (south-west of Lumbridge)
// Walk across the bridge to the tower entrance, then to the ladder inside.
const WIZARD_TOWER_ENTRANCE_X = 3109;
const WIZARD_TOWER_ENTRANCE_Z = 3167;
// wizards_tower_laddertop at (3104, 3162, level 0): op1=Climb-down → basement (3104, 9576)
// wizards_tower_ladder at (3103, 9576, level 0): op1=Climb-up → surface (3105, 3162)

// Varrock rune shop (Aubury)
const AUBURY_AREA_X = 3253;
const AUBURY_AREA_Z = 3401;

// Lumbridge spawn point (after tutorial)
const LUMBRIDGE_SPAWN_X = 3222;
const LUMBRIDGE_SPAWN_Z = 3218;

/**
 * Walk from the Wizard Tower entrance area into the tower and climb
 * the ladder down to the basement where Sedridor is.
 */
async function enterWizardTowerBasement(bot: BotAPI): Promise<void> {
    // The Wizard Tower has:
    //   - Entrance door: poordooropen at (3109, 3166) angle=1 (north wall)
    //   - Inner diagonal door: poordooropen at (3107, 3162) shape=9 angle=3
    //   - Ladder: wizards_tower_laddertop at (3104, 3162)
    //
    // Route: bridge -> open entrance door -> walk into outer ring ->
    //         open inner door -> use climbStairs to approach and descend.

    // Open the tower entrance door from the bridge side.
    await bot.walkToWithPathfinding(3109, 3167);
    await bot.openDoor('poordooropen');

    // Walk through the entrance into the outer ring, heading toward the inner door.
    // The inner diagonal door is at (3107, 3162). Walk close to it so we pick it
    // instead of another poordooropen on the far side of the tower.
    await bot.walkToWithPathfinding(3108, 3163);
    bot.log('STATE', `Inside tower outer ring: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Open the inner diagonal door to access the central room.
    await bot.openDoor('poordooropen');

    // Walk closer to the ladder area, then let climbStairs handle the approach.
    await bot.walkToWithPathfinding(3106, 3161);
    bot.log('STATE', `Near Wizard Tower ladder: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Climb the ladder down to the basement
    await bot.climbStairs('wizards_tower_laddertop', 1);
    await bot.waitForTicks(2);

    if (bot.player.z < 6400) {
        throw new Error(`Failed to reach Wizard Tower basement: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    bot.log('STATE', `In Wizard Tower basement: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
}

/**
 * Climb the ladder up from the Wizard Tower basement back to the surface.
 * Must navigate from the inner room back through the door to the ladder alcove.
 */
async function exitWizardTowerBasement(bot: BotAPI): Promise<void> {
    // Navigate from the inner room back to the outer ring via the door at (3108, 9570).
    // The door may still be open from our earlier entry (500-tick timer), but open it again
    // just in case.
    await bot.walkToWithPathfinding(3107, 9571);
    await bot.openDoor('inaccastledoubledoorropen');
    await bot.walkToWithPathfinding(3108, 9575);

    // Now in the outer ring near the ladder. The ladder is at (3103, 9576).
    await bot.climbStairs('wizards_tower_ladder', 1);
    await bot.waitForTicks(2);

    if (bot.player.z > 6400) {
        throw new Error(`Failed to exit Wizard Tower basement: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    bot.log('STATE', `Back on surface from basement: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
}

/**
 * Navigate from Lumbridge Castle level 1 (Duke's floor) back down to ground floor
 * and exit through the castle doors.
 */
async function exitCastleFromLevel1(bot: BotAPI): Promise<void> {
    await bot.walkToWithPathfinding(3206, 3218);
    await bot.walkToWithPathfinding(3206, 3210);

    await bot.climbStairs('loc_1739', 3);
    await bot.waitForTicks(2);

    if (bot.player.level as number !== 0) {
        throw new Error(`Failed to climb down to level 0: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    bot.log('STATE', `Back on ground floor: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    await bot.walkToWithPathfinding(3215, 3210);
    await bot.openDoor('poordooropen');
    await bot.walkToWithPathfinding(3215, 3215);
    await bot.walkToWithPathfinding(3217, 3218);
    await bot.openDoor('openbankdoor_l');
    await bot.walkToWithPathfinding(LUMBRIDGE_SPAWN_X, LUMBRIDGE_SPAWN_Z);
}

/**
 * Navigate to Sedridor's inner room in the Wizard Tower basement.
 * Assumes the bot is at the tower entrance or has just descended.
 */
async function navigateToSedridor(bot: BotAPI): Promise<void> {
    await bot.walkToWithPathfinding(3108, 9575);
    await bot.walkToWithPathfinding(3108, 9571);
    bot.log('STATE', `Near basement door: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    await bot.openDoor('inaccastledoubledoorropen');

    await bot.walkToWithPathfinding(3103, 9571);
    bot.log('STATE', `In inner room: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
}

/**
 * Build the Rune Mysteries state machine.
 * States: talk-to-duke, visit-sedridor, visit-aubury, return-to-sedridor
 */
export function buildRuneMysteriesStates(bot: BotAPI): BotState {
    return {
        name: 'rune-mysteries',
        isComplete: () => bot.getQuestProgress(RUNE_MYSTERIES_VARP) === STAGE_COMPLETE,
        run: async () => { throw new Error('Composite state should not be called directly'); },
        children: [
            {
                name: 'talk-to-duke',
                isComplete: () => bot.getQuestProgress(RUNE_MYSTERIES_VARP) >= STAGE_STARTED,
                run: async () => {
                    // Navigate from Lumbridge spawn through castle doors to the stairwell.
                    await bot.walkToWithPathfinding(3218, 3218);
                    bot.log('STATE', `At castle entrance: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
                    await bot.openDoor('openbankdoor_l');

                    await bot.walkToWithPathfinding(3215, 3215);
                    bot.log('STATE', `Inside castle hall: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

                    await bot.openDoor('poordooropen');

                    await bot.walkToWithPathfinding(3206, 3210);
                    bot.log('STATE', `Near stairwell: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

                    await bot.climbStairs('loc_1738', 1);
                    await bot.waitForTicks(2);

                    if (bot.player.level !== 1) {
                        throw new Error(`Failed to climb to level 1: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
                    }
                    bot.log('STATE', `On Duke's floor: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

                    await bot.walkToWithPathfinding(3207, 3222);
                    await bot.openDoor('poordooropen');

                    await bot.walkToWithPathfinding(3210, 3220);

                    const duke = bot.findNearbyNpc('Duke Horacio', 16);
                    if (!duke) {
                        throw new Error(`Duke Horacio not found near (${bot.player.x},${bot.player.z},${bot.player.level})`);
                    }
                    bot.log('STATE', `Found Duke Horacio at (${duke.x},${duke.z})`);
                    await bot.interactNpc(duke, 1);

                    await bot.continueDialogsUntilChoice();
                    await bot.selectDialogOption(1); // "Have you any quests for me?"

                    await bot.continueDialogsUntilChoice();
                    await bot.selectDialogOption(1); // "Sure, no problem."

                    await bot.continueRemainingDialogs();

                    await bot.waitForTicks(2);
                    const talisman = bot.findItem('Air talisman');
                    if (!talisman) {
                        throw new Error('Did not receive Air talisman from Duke Horacio');
                    }
                    const varpAfterDuke = bot.getQuestProgress(RUNE_MYSTERIES_VARP);
                    if (varpAfterDuke !== STAGE_STARTED) {
                        throw new Error(`Quest varp after Duke is ${varpAfterDuke}, expected ${STAGE_STARTED}`);
                    }
                    bot.log('EVENT', `Step 1 complete: received Air talisman, varp=${varpAfterDuke}`);
                }
            },
            {
                name: 'visit-sedridor',
                isComplete: () => bot.getQuestProgress(RUNE_MYSTERIES_VARP) >= STAGE_RECEIVED_PACKAGE,
                run: async () => {
                    // Navigate down from Duke's floor and out of castle
                    await exitCastleFromLevel1(bot);

                    await bot.walkToWithPathfinding(WIZARD_TOWER_ENTRANCE_X, WIZARD_TOWER_ENTRANCE_Z);

                    await enterWizardTowerBasement(bot);

                    await navigateToSedridor(bot);

                    await bot.talkToNpc('Sedridor');

                    // Welcome message -> 3-option choice
                    await bot.continueDialogsUntilChoice();
                    await bot.selectDialogOption(3); // "I'm looking for the head wizard."

                    await bot.continueDialogsUntilChoice();
                    await bot.selectDialogOption(1); // "Ok, here you are."

                    await bot.continueDialogsUntilChoice();
                    await bot.selectDialogOption(1); // "Yes, certainly."

                    // Continue through dialogs until Research package appears
                    for (let i = 0; i < 30; i++) {
                        const hasDialog = await bot.waitForDialog(10);
                        if (!hasDialog) break;
                        if (bot.isMultiChoiceOpen()) break;
                        await bot.continueDialog();
                        if (bot.findItem('Research package')) break;
                    }

                    await bot.continueRemainingDialogs();

                    await bot.waitForTicks(2);
                    const researchPackage = bot.findItem('Research package');
                    if (!researchPackage) {
                        throw new Error('Did not receive Research package from Sedridor');
                    }
                    const varpAfterSedridor1 = bot.getQuestProgress(RUNE_MYSTERIES_VARP);
                    if (varpAfterSedridor1 !== STAGE_RECEIVED_PACKAGE) {
                        throw new Error(`Quest varp after Sedridor is ${varpAfterSedridor1}, expected ${STAGE_RECEIVED_PACKAGE}`);
                    }
                    bot.log('EVENT', `Step 2 complete: received Research package, varp=${varpAfterSedridor1}`);
                }
            },
            {
                name: 'visit-aubury',
                isComplete: () => bot.getQuestProgress(RUNE_MYSTERIES_VARP) >= STAGE_RECEIVED_NOTES,
                run: async () => {
                    // Climb the ladder back up from the basement to the surface
                    await exitWizardTowerBasement(bot);

                    // Walk north-east to Varrock (Aubury's rune shop)
                    await bot.walkToWithPathfinding(3105, 3250);
                    await bot.walkToWithPathfinding(3082, 3336);
                    await bot.walkToWithPathfinding(3080, 3400);
                    await bot.walkToWithPathfinding(3175, 3427);
                    await bot.walkToWithPathfinding(AUBURY_AREA_X, AUBURY_AREA_Z);

                    // Talk to Aubury — deliver the package
                    await bot.talkToNpc('Aubury');

                    await bot.continueDialogsUntilChoice();
                    await bot.selectDialogOption(3); // "I have been sent here with a package for you."

                    await bot.continueRemainingDialogs();
                    await bot.waitForTicks(3);

                    if (bot.findItem('Research package') !== null) {
                        throw new Error('Research package should have been removed after delivery to Aubury');
                    }
                    const varpAfterAubury1 = bot.getQuestProgress(RUNE_MYSTERIES_VARP);
                    if (varpAfterAubury1 !== STAGE_GIVEN_PACKAGE) {
                        throw new Error(`Quest varp after Aubury delivery is ${varpAfterAubury1}, expected ${STAGE_GIVEN_PACKAGE}`);
                    }
                    bot.log('EVENT', `Delivered package to Aubury, varp=${varpAfterAubury1}`);

                    // Second talk to Aubury to get research notes
                    await bot.talkToNpc('Aubury');

                    await bot.continueRemainingDialogs();

                    await bot.waitForTicks(2);
                    const researchNotes = bot.findItem('Notes');
                    if (!researchNotes) {
                        throw new Error('Did not receive Notes from Aubury');
                    }
                    const varpAfterAubury2 = bot.getQuestProgress(RUNE_MYSTERIES_VARP);
                    if (varpAfterAubury2 !== STAGE_RECEIVED_NOTES) {
                        throw new Error(`Quest varp after Aubury research notes is ${varpAfterAubury2}, expected ${STAGE_RECEIVED_NOTES}`);
                    }
                    bot.log('EVENT', `Step 3 complete: received Notes, varp=${varpAfterAubury2}`);
                }
            },
            {
                name: 'return-to-sedridor',
                isComplete: () => bot.getQuestProgress(RUNE_MYSTERIES_VARP) === STAGE_COMPLETE,
                run: async () => {
                    // Walk south-west back to Wizards' Tower entrance
                    await bot.walkToWithPathfinding(3175, 3427);
                    await bot.walkToWithPathfinding(3080, 3400);
                    await bot.walkToWithPathfinding(3082, 3336);
                    await bot.walkToWithPathfinding(3105, 3250);
                    await bot.walkToWithPathfinding(WIZARD_TOWER_ENTRANCE_X, WIZARD_TOWER_ENTRANCE_Z);

                    await enterWizardTowerBasement(bot);

                    await navigateToSedridor(bot);

                    await bot.talkToNpc('Sedridor');

                    // Continue through all dialog pages (long lore dialog)
                    for (let i = 0; i < 50; i++) {
                        const hasDialog = await bot.waitForDialog(10);
                        if (!hasDialog) break;
                        if (bot.isMultiChoiceOpen()) break;
                        await bot.continueDialog();
                    }

                    await bot.waitForTicks(5);

                    bot.dismissModals();

                    const finalVarp = bot.getQuestProgress(RUNE_MYSTERIES_VARP);
                    const finalTalisman = bot.findItem('Air talisman');

                    if (finalVarp !== STAGE_COMPLETE) {
                        throw new Error(`Quest not complete: varp is ${finalVarp}, expected ${STAGE_COMPLETE}`);
                    }
                    if (!finalTalisman) {
                        throw new Error('Air talisman not in inventory after quest completion');
                    }

                    bot.log('SUCCESS', `Rune Mysteries quest complete! varp=${finalVarp}, Air talisman in inventory`);
                }
            }
        ]
    };
}

export async function runeMysteries(bot: BotAPI): Promise<void> {
    // === Setup: skip tutorial, start in Lumbridge ===
    await skipTutorial(bot);
    await bot.waitForTicks(2);

    bot.log('STATE', `Starting Rune Mysteries quest at (${bot.player.x},${bot.player.z},${bot.player.level})`);

    const initialVarp = bot.getQuestProgress(RUNE_MYSTERIES_VARP);
    if (initialVarp !== STAGE_NOT_STARTED) {
        throw new Error(`Quest varp is ${initialVarp}, expected ${STAGE_NOT_STARTED} (not started)`);
    }

    const root = buildRuneMysteriesStates(bot);
    const snapshotDir = path.resolve(import.meta.dir, '..', 'test', 'snapshots');
    await runStateMachine(bot, { root, varpIds: [RUNE_MYSTERIES_VARP], captureSnapshots: true, snapshotDir });
}

export const metadata: ScriptMeta = {
    name: 'runemysteries',
    type: 'quest',
    varpId: RUNE_MYSTERIES_VARP,
    varpComplete: STAGE_COMPLETE,
    maxTicks: 25000,
    run: runeMysteries,
    buildStates: buildRuneMysteriesStates,
    extraAssertions: (api: BotAPI) => [{
        name: 'Air talisman in inventory',
        pass: api.findItem('Air talisman') !== null,
    }],
};
