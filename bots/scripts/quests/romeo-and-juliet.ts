import path from 'path';
import { BotAPI } from '../../runtime/api.js';
import { skipTutorial } from '../skip-tutorial.js';
import { walkLumbridgeToVarrock } from '../shared-routes.js';
import { type BotState, runStateMachine } from '../../runtime/state-machine.js';
import type { ScriptMeta } from '../../runtime/script-meta.js';

// Varp ID for Romeo & Juliet quest progress (from content/pack/varp.pack: 144=rjquest)
export const RJQUEST_VARP = 144;

// Quest stages (from content/scripts/quests/quest_romeojuliet/configs/quest_romeojuliet.constant
// and content/scripts/general/configs/quest.constant)
const STAGE_NOT_STARTED = 0;
const STAGE_SPOKEN_ROMEO = 10;
const STAGE_SPOKEN_JULIET = 20;
const STAGE_PASSED_MESSAGE = 30;
const STAGE_SPOKEN_FATHER = 40;
const STAGE_SPOKEN_APOTHECARY = 50;
const STAGE_JULIET_CRYPT = 60;
const STAGE_COMPLETE = 100;

// ---- Key locations ----

// Romeo: Varrock square (from map m50_53 NPC spawn: 0 11 33: 639)
// Absolute: (3200+11, 3392+33) = (3211, 3425)
const ROMEO_AREA_X = 3211;
const ROMEO_AREA_Z = 3425;

// Father Lawrence: NE Varrock church (from map m50_54 NPC spawn: 0 54 19: 640)
// Absolute: (3200+54, 3456+19) = (3254, 3475)
const FATHER_LAWRENCE_AREA_X = 3254;
const FATHER_LAWRENCE_AREA_Z = 3475;

// Apothecary: SW Varrock (from map m49_53 NPC spawn: 0 59 12: 638)
// Absolute: (3136+59, 3392+12) = (3195, 3404)
const APOTHECARY_AREA_X = 3195;
const APOTHECARY_AREA_Z = 3404;

// Cadava berry ground spawns (from map m51_52 OBJ section: obj 753)
// Three spawns: (3266,3361), (3273,3375), (3277,3370)
// Using the middle one as our target — SE of Varrock, near the mining area
const CADAVA_BERRY_AREA_X = 3273;
const CADAVA_BERRY_AREA_Z = 3375;

/**
 * Navigate into Juliet's house and climb stairs to level 1.
 * Juliet is upstairs in a house west of Varrock.
 *
 * The house has a desertdoorclosed door that must be opened,
 * then stairs (loc_1722, op1=Climb-up) at (3156, 3435) lead to level 1.
 */
async function climbToJuliet(bot: BotAPI): Promise<void> {
    // The compound has a door (desertdoorclosed) on the north side near (3160, 3440).
    // Walk to just outside the north wall, then open the nearest door.
    await bot.walkToWithPathfinding(3160, 3441);
    bot.log('STATE', `Near Juliet's house north side: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Open the door (desertdoorclosed) — nearest one should be at (3160, 3440)
    await bot.openDoor('desertdoorclosed');

    // Walk inside the compound toward the stairs area.
    // The staircase (loc_1722, forceapproach=south) is near (3156, 3435).
    // Walk to the approach area south of the stairs first.
    await bot.walkToWithPathfinding(3158, 3433);

    // Climb the staircase up to level 1
    // loc_1722 at (3156, 3435): op1=Climb-up -> telejumps to (3155, 3435, level 1)
    // climbStairs will use interactLoc which handles forceapproach pathing
    await bot.climbStairs('loc_1722', 1);
    await bot.waitForTicks(2);

    if (bot.player.level !== 1) {
        throw new Error(`Failed to climb to level 1 at Juliet's house: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    bot.log('STATE', `On level 1 at Juliet's house: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // On level 1, there's a partition wall at z=3431 with a door at x=3156
    // (inaccastledoubledoorropen) and a south wall at z=3427 with a door
    // at x=3159 (desertdoorclosed). Navigate through both.

    // Walk to the first door (partition wall at z=3431)
    await bot.walkToWithPathfinding(3156, 3432);
    await bot.openDoor('inaccastledoubledoorropen');

    // Walk through the first door south to approach the second door
    await bot.walkToWithPathfinding(3156, 3428);

    // Walk east to the door at (3159, 3428)
    await bot.walkToWithPathfinding(3159, 3428);

    // Open the door to Juliet's room (desertdoorclosed at (3159, 3427) on level 1)
    await bot.openDoor('desertdoorclosed');

    // Walk south into Juliet's room
    await bot.walkToWithPathfinding(3158, 3426);
}

/**
 * Climb back down from Juliet's room to ground floor.
 * loc_1723 at (3156, 3435, level 1): op1=Climb-down -> telejumps to (3159, 3435, level 0)
 */
async function climbDownFromJuliet(bot: BotAPI): Promise<void> {
    // Navigate back through Juliet's room to the stairs on level 1.
    // Walk north to the door between Juliet's room and the corridor
    await bot.walkToWithPathfinding(3159, 3426);

    // Open the south wall door at (3159, 3427) if it closed
    await bot.openDoor('desertdoorclosed');

    // Walk north through to the partition wall
    await bot.walkToWithPathfinding(3156, 3430);

    // Open the partition door at (3156, 3431) if it closed
    await bot.openDoor('inaccastledoubledoorropen');

    // Walk to near the stairs, then climb down
    // loc_1723 at (3156, 3435, level 1): op1=Climb-down -> telejumps to (3159, 3435, level 0)
    await bot.climbStairs('loc_1723', 1);
    await bot.waitForTicks(2);

    if (bot.player.level !== 0) {
        throw new Error(`Failed to climb down from Juliet's house: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    bot.log('STATE', `Back on ground floor: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
}

/**
 * Build the Romeo & Juliet state machine.
 */
export function buildRomeoAndJulietStates(bot: BotAPI): BotState {
    return {
        name: 'romeo-and-juliet',
        isComplete: () => bot.getQuestProgress(RJQUEST_VARP) === STAGE_COMPLETE,
        run: async () => { throw new Error('Composite state should not be called directly'); },
        children: [
            {
                name: 'talk-to-romeo',
                isComplete: () => bot.getQuestProgress(RJQUEST_VARP) >= STAGE_SPOKEN_ROMEO,
                run: async () => {
                    await walkLumbridgeToVarrock(bot);
                    await bot.walkToWithPathfinding(ROMEO_AREA_X, ROMEO_AREA_Z);

                    await bot.talkToNpc('Romeo');

                    await bot.waitForDialog(15);
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
                    await bot.continueDialog();
                    await bot.waitForDialog(10);
                    await bot.continueDialog();
                    await bot.waitForDialog(10);
                    await bot.continueDialog();

                    await bot.waitForTicks(2);

                    const varp = bot.getQuestProgress(RJQUEST_VARP);
                    if (varp !== STAGE_SPOKEN_ROMEO) {
                        throw new Error(`Quest varp after Romeo is ${varp}, expected ${STAGE_SPOKEN_ROMEO}`);
                    }
                    bot.log('EVENT', `Spoken to Romeo, varp=${varp}`);
                }
            },
            {
                name: 'talk-to-juliet',
                isComplete: () => bot.getQuestProgress(RJQUEST_VARP) >= STAGE_SPOKEN_JULIET,
                run: async () => {
                    await bot.walkToWithPathfinding(3218, 3450);
                    await bot.walkToWithPathfinding(3165, 3445);
                    await bot.walkToWithPathfinding(3165, 3440);
                    await climbToJuliet(bot);

                    await bot.talkToNpc('Juliet');
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

                    await bot.waitForTicks(2);

                    const message = bot.findItem('Message');
                    if (!message) {
                        throw new Error('Did not receive Message from Juliet');
                    }
                    const varp = bot.getQuestProgress(RJQUEST_VARP);
                    if (varp !== STAGE_SPOKEN_JULIET) {
                        throw new Error(`Quest varp after Juliet is ${varp}, expected ${STAGE_SPOKEN_JULIET}`);
                    }
                    bot.log('EVENT', `Received Message from Juliet, varp=${varp}`);
                }
            },
            {
                name: 'deliver-message',
                isComplete: () => bot.getQuestProgress(RJQUEST_VARP) >= STAGE_PASSED_MESSAGE,
                run: async () => {
                    await climbDownFromJuliet(bot);
                    await bot.walkToWithPathfinding(ROMEO_AREA_X, ROMEO_AREA_Z);

                    await bot.talkToNpc('Romeo');
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

                    await bot.waitForTicks(2);

                    if (bot.findItem('Message') !== null) {
                        throw new Error('Message should have been removed after delivery to Romeo');
                    }
                    const varp = bot.getQuestProgress(RJQUEST_VARP);
                    if (varp !== STAGE_PASSED_MESSAGE) {
                        throw new Error(`Quest varp after message delivery is ${varp}, expected ${STAGE_PASSED_MESSAGE}`);
                    }
                    bot.log('EVENT', `Delivered message, varp=${varp}`);
                }
            },
            {
                name: 'talk-to-father-lawrence',
                isComplete: () => bot.getQuestProgress(RJQUEST_VARP) >= STAGE_SPOKEN_FATHER,
                run: async () => {
                    await bot.walkToWithPathfinding(FATHER_LAWRENCE_AREA_X, FATHER_LAWRENCE_AREA_Z);

                    await bot.talkToNpc('Father Lawrence');
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

                    await bot.waitForTicks(2);

                    const varp = bot.getQuestProgress(RJQUEST_VARP);
                    if (varp !== STAGE_SPOKEN_FATHER) {
                        throw new Error(`Quest varp after Father Lawrence is ${varp}, expected ${STAGE_SPOKEN_FATHER}`);
                    }
                    bot.log('EVENT', `Spoken to Father Lawrence, varp=${varp}`);
                }
            },
            {
                name: 'talk-to-apothecary',
                isComplete: () => bot.getQuestProgress(RJQUEST_VARP) >= STAGE_SPOKEN_APOTHECARY,
                run: async () => {
                    await bot.walkToWithPathfinding(APOTHECARY_AREA_X, APOTHECARY_AREA_Z);

                    await bot.talkToNpc('Apothecary');
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

                    await bot.waitForTicks(2);

                    const varp = bot.getQuestProgress(RJQUEST_VARP);
                    if (varp !== STAGE_SPOKEN_APOTHECARY) {
                        throw new Error(`Quest varp after Apothecary is ${varp}, expected ${STAGE_SPOKEN_APOTHECARY}`);
                    }
                    bot.log('EVENT', `Spoken to Apothecary, varp=${varp}`);
                }
            },
            {
                name: 'farm-cadava-berries',
                isComplete: () => bot.findItem('Cadava berries') !== null || bot.findItem('Cadava potion') !== null || bot.getQuestProgress(RJQUEST_VARP) >= STAGE_JULIET_CRYPT,
                maxRetries: 5,
                run: async () => {
                    // Cadava berries have ground spawns SE of Varrock near the mining area.
                    // Walk to the cadava berry spawn area and pick them up.
                    // Three known spawns: (3266,3361), (3273,3375), (3277,3370)
                    const berrySpawns = [
                        { x: 3266, z: 3361 },
                        { x: 3273, z: 3375 },
                        { x: 3277, z: 3370 },
                    ];

                    // Walk to the berry spawn area (SE Varrock)
                    await bot.walkToWithPathfinding(CADAVA_BERRY_AREA_X, CADAVA_BERRY_AREA_Z);

                    // Try each spawn point until we find berries
                    for (const spawn of berrySpawns) {
                        if (bot.findItem('Cadava berries')) break;

                        await bot.walkToWithPathfinding(spawn.x, spawn.z);
                        await bot.waitForTicks(2);

                        const berries = bot.findNearbyGroundItem('Cadava berries', 5);
                        if (berries) {
                            bot.log('EVENT', `Found Cadava berries at (${berries.x},${berries.z})`);
                            await bot.takeGroundItem('Cadava berries', berries.x, berries.z);
                            await bot.waitForTicks(2);
                        }
                    }

                    // If no ground spawns found, wait and retry (spawns respawn periodically)
                    if (!bot.findItem('Cadava berries')) {
                        bot.log('STATE', 'No Cadava berries found at spawn points, waiting for respawn...');
                        await bot.waitForTicks(30);
                        for (const spawn of berrySpawns) {
                            if (bot.findItem('Cadava berries')) break;

                            await bot.walkToWithPathfinding(spawn.x, spawn.z);
                            await bot.waitForTicks(2);

                            const berries = bot.findNearbyGroundItem('Cadava berries', 5);
                            if (berries) {
                                bot.log('EVENT', `Found Cadava berries at (${berries.x},${berries.z})`);
                                await bot.takeGroundItem('Cadava berries', berries.x, berries.z);
                                await bot.waitForTicks(2);
                            }
                        }
                    }

                    if (!bot.findItem('Cadava berries')) {
                        throw new Error('Failed to find Cadava berries at any spawn point');
                    }
                    bot.log('EVENT', 'Got Cadava berries from ground spawn');
                }
            },
            {
                name: 'deliver-potion',
                isComplete: () => bot.getQuestProgress(RJQUEST_VARP) === STAGE_COMPLETE,
                run: async () => {
                    // Get potion from Apothecary (bot is already near Varrock from cadava berry area)
                    await bot.walkToWithPathfinding(APOTHECARY_AREA_X, APOTHECARY_AREA_Z);

                    await bot.talkToNpc('Apothecary');
                    await bot.waitForDialog(15);
                    await bot.continueDialog();
                    await bot.waitForDialog(10);
                    await bot.continueDialog();
                    await bot.waitForDialog(10);
                    await bot.continueDialog();
                    await bot.waitForDialog(10);
                    await bot.continueDialog();

                    await bot.waitForTicks(2);

                    if (!bot.findItem('Cadava potion')) {
                        throw new Error('Did not receive Cadava potion from Apothecary');
                    }
                    bot.log('EVENT', 'Received Cadava potion');

                    // Deliver to Juliet
                    await bot.walkToWithPathfinding(3218, 3450);
                    await bot.walkToWithPathfinding(3165, 3445);
                    await bot.walkToWithPathfinding(3165, 3440);
                    await climbToJuliet(bot);

                    await bot.talkToNpc('Juliet');
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

                    await bot.waitForTicks(2);

                    const varpAfterPotion = bot.getQuestProgress(RJQUEST_VARP);
                    if (varpAfterPotion !== STAGE_JULIET_CRYPT) {
                        throw new Error(`Quest varp after potion delivery is ${varpAfterPotion}, expected ${STAGE_JULIET_CRYPT}`);
                    }
                    bot.log('EVENT', `Gave potion to Juliet, varp=${varpAfterPotion}`);

                    // Tell Romeo the plan
                    await climbDownFromJuliet(bot);
                    await bot.walkToWithPathfinding(ROMEO_AREA_X, ROMEO_AREA_Z);

                    await bot.talkToNpc('Romeo');
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

                    await bot.waitForTicks(5);
                    bot.dismissModals();

                    const finalVarp = bot.getQuestProgress(RJQUEST_VARP);
                    if (finalVarp !== STAGE_COMPLETE) {
                        throw new Error(`Quest not complete: varp is ${finalVarp}, expected ${STAGE_COMPLETE}`);
                    }
                    bot.log('SUCCESS', `Romeo & Juliet quest complete! varp=${finalVarp}`);
                }
            }
        ]
    };
}

export async function romeoAndJuliet(bot: BotAPI): Promise<void> {
    // === Setup: skip tutorial, start in Lumbridge ===
    await skipTutorial(bot);
    await bot.waitForTicks(2);

    bot.log('STATE', `Starting Romeo & Juliet quest at (${bot.player.x},${bot.player.z},${bot.player.level})`);

    const initialVarp = bot.getQuestProgress(RJQUEST_VARP);
    if (initialVarp !== STAGE_NOT_STARTED) {
        throw new Error(`Quest varp is ${initialVarp}, expected ${STAGE_NOT_STARTED} (not started)`);
    }

    const root = buildRomeoAndJulietStates(bot);
    const snapshotDir = path.resolve(import.meta.dir, '..', 'test', 'snapshots');
    await runStateMachine(bot, { root, varpIds: [RJQUEST_VARP], captureSnapshots: true, snapshotDir });
}

export const metadata: ScriptMeta = {
    name: 'romeojuliet',
    type: 'quest',
    varpId: RJQUEST_VARP,
    varpComplete: STAGE_COMPLETE,
    maxTicks: 25000,
    run: romeoAndJuliet,
    buildStates: buildRomeoAndJulietStates,
};
