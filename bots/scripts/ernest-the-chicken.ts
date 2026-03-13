import path from 'path';
import LocType from '../../src/cache/config/LocType.js';
import { BotAPI } from '../runtime/api.js';
import { skipTutorial } from './skip-tutorial.js';
import type _Loc from '../../src/engine/entity/Loc.js';
import { type BotState, runStateMachine } from '../runtime/state-machine.js';
import type { ScriptMeta } from '../runtime/script-meta.js';

// Varp IDs (from content/pack/varp.pack)
export const HAUNTED_VARP = 32;
const ERNESTLEVER_VARP = 33;

// Quest stages (from content/scripts/quests/quest_haunted/configs/quest_haunted.constant
// and content/scripts/general/configs/quest.constant)
const STAGE_NOT_STARTED = 0;
const STAGE_STARTED = 1;
const STAGE_SPOKEN_TO_ODDENSTEIN = 2;
const STAGE_COMPLETE = 3;

// ---- Key locations ----

const VERONICA_AREA_X = 3109;
const VERONICA_AREA_Z = 3327;
const MANOR_ENTRANCE_X = 3108;
const MANOR_ENTRANCE_Z = 3331;

// ---- Utility functions ----

/**
 * Walk from Lumbridge to Draynor Manor area (near Veronica).
 */
async function walkToManorArea(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Walking from Lumbridge to Draynor Manor ===');
    await bot.walkToWithPathfinding(3190, 3220);
    await bot.walkToWithPathfinding(3150, 3230);
    await bot.walkToWithPathfinding(3105, 3250);
    await bot.walkToWithPathfinding(3110, 3290);
    await bot.walkToWithPathfinding(VERONICA_AREA_X, VERONICA_AREA_Z);
    bot.log('STATE', `Arrived near Draynor Manor: pos=(${bot.player.x},${bot.player.z})`);
}

/**
 * Talk to Veronica to start the quest.
 * Dialog from content/scripts/areas/area_draynor/scripts/veronica.rs2
 */
async function talkToVeronicaStart(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Talking to Veronica ===');
    await bot.talkToNpc('Veronica');

    // chatnpc: "Can you please help me?..."
    await bot.waitForDialog(30);
    await bot.continueDialog();

    // Multi2: "Aha, sounds like a quest. I'll help." (1)
    await bot.waitForDialog(10);
    await bot.selectDialogOption(1);

    // chatplayer: "Aha, sounds like a quest. I'll help."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc: "Yes yes, I suppose it is a quest." → continue through remaining pages
    // chatnpc: "Seeing as we were a little lost..."
    // chatnpc: "That was an hour ago..." → %haunted = 1
    // chatplayer: "Ok, I'll see what I can do."
    // chatnpc: "Thank you, thank you."
    for (let i = 0; i < 10; i++) {
        const d = await bot.waitForDialog(10);
        if (!d) break;
        if (bot.isMultiChoiceOpen()) break;
        await bot.continueDialog();
    }

    await bot.waitForTicks(2);
    const varp = bot.getQuestProgress(HAUNTED_VARP);
    if (varp !== STAGE_STARTED) {
        throw new Error(`Quest not started: varp is ${varp}, expected ${STAGE_STARTED}`);
    }
    bot.log('EVENT', `Quest started! varp=${varp}`);
}

/**
 * Enter Draynor Manor through the front double doors.
 * The doors only open from the south side (outside).
 * Handles case where bot is already inside or on upper floors.
 */
async function enterManor(bot: BotAPI): Promise<void> {
    bot.log('STATE', `=== Entering Draynor Manor (current level=${bot.player.level}, pos=${bot.player.x},${bot.player.z}) ===`);

    // If in the basement (z >= 6400), climb the puzzle ladder to exit first
    if (bot.player.z >= 6400) {
        bot.log('STATE', `In basement at z=${bot.player.z}, climbing ladder to exit`);
        await bot.walkToWithPathfinding(3116, 9754);
        await bot.climbStairs('puzzle_ladder', 1);
        await bot.waitForTicks(3);
        bot.log('STATE', `After climbing ladder: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }

    // If on upper floors, climb down first.
    // Guard with max iterations to prevent infinite loops if stairs silently fail.
    for (let attempts = 0; (bot.player.level as number) > 0; attempts++) {
        if (attempts >= 6) {
            throw new Error(`Failed to climb down after ${attempts} attempts. Still on level ${bot.player.level} at (${bot.player.x},${bot.player.z})`);
        }
        const climbed = await climbStairsInDirection(bot, 'down');
        if (!climbed) {
            throw new Error(`Cannot find stairs down on level ${bot.player.level}. pos=(${bot.player.x},${bot.player.z})`);
        }
    }

    // Check if already inside the manor (x=3090-3120, z=3332-3370)
    const px = bot.player.x;
    const pz = bot.player.z;
    if (px >= 3090 && px <= 3120 && pz >= 3332 && pz <= 3370) {
        bot.log('STATE', `Already inside manor: pos=(${px},${pz})`);
        return;
    }

    // Approach from the south (z-1) since the door blocks pathfinding at MANOR_ENTRANCE_Z
    await bot.walkToWithPathfinding(MANOR_ENTRANCE_X, MANOR_ENTRANCE_Z - 1);

    // Open the double doors from the south side
    await bot.openDoor('haunteddoorl');
    await bot.waitForTicks(1);

    // Walk through into the manor
    await bot.walkToWithPathfinding(MANOR_ENTRANCE_X, MANOR_ENTRANCE_Z + 5);
    bot.log('STATE', `Inside manor: pos=(${bot.player.x},${bot.player.z})`);
}

/**
 * Find and climb stairs in the specified direction.
 * Returns true if the level actually changed, false if no stairs found
 * or the stair interaction failed (e.g. player.delayed blocking canAccess).
 */
async function climbStairsInDirection(bot: BotAPI, direction: 'up' | 'down'): Promise<boolean> {
    // Clear any stuck state that would block interactions (player.delayed, modals)
    bot.dismissModals();
    if (bot.player.delayed) {
        await bot.waitForCondition(() => !bot.player.delayed, 20);
        if (bot.player.delayed) bot.player.delayed = false;
    }
    if (bot.player.containsModalInterface()) bot.player.closeModal();

    const levelBefore = bot.player.level as number;
    const allLocs = bot.findAllNearbyLocs(20);
    const stairsLocs = allLocs.filter(l =>
        l.displayName.toLowerCase().includes('stair')
    );

    for (const s of stairsLocs) {
        const locType = LocType.get(s.loc.type);
        if (!locType.op) continue;
        for (let i = 0; i < locType.op.length; i++) {
            if (locType.op[i]?.toLowerCase().includes(direction)) {
                bot.log('ACTION', `Climbing ${direction}: ${s.debugname} op${i + 1} at (${s.x},${s.z})`);
                await bot.climbStairs(s.debugname, i + 1);
                await bot.waitForTicks(3);

                // Verify the level actually changed
                if ((bot.player.level as number) !== levelBefore) {
                    return true;
                }
                bot.log('STATE', `Stair interaction did not change level (still ${bot.player.level}), clearing state and retrying`);
                // The interaction may have silently failed. Clear state again.
                bot.dismissModals();
                if (bot.player.delayed) bot.player.delayed = false;
                if (bot.player.containsModalInterface()) bot.player.closeModal();
                return false;
            }
        }
    }
    return false;
}

/**
 * Exit the manor building. The front doors (haunteddoorl) only open from the
 * south side, so the bot exits through the open north side of the building
 * (z >= 3370), goes east around the building exterior, then south through
 * the manor grounds to the south side.
 */
async function exitManor(bot: BotAPI): Promise<void> {
    bot.log('STATE', `=== Exiting manor from pos=(${bot.player.x},${bot.player.z}) ===`);

    // If in the basement (z >= 6400), climb the ladder to exit first.
    if (bot.player.z >= 6400) {
        bot.log('STATE', `In basement at z=${bot.player.z} pos=(${bot.player.x},${bot.player.z}), climbing ladder to exit`);
        // The puzzle_ladder is at (3117,9754) in room 7 (SE). findNearbyLoc has a
        // 16-tile default radius which may not reach from other rooms. Find it with
        // a larger radius and use interactLoc directly (which does its own approach).
        const ladder = bot.findNearbyLoc('puzzle_ladder', 50);
        if (!ladder) {
            throw new Error(`puzzle_ladder not found within 50 tiles of (${bot.player.x},${bot.player.z})`);
        }
        // Try to walk to the ladder area. The bot may be in any room, and the
        // pathfinder may not be able to route through puzzle doors. Walk to the
        // south side of the gap at (3103,9753), then east to the ladder.
        if (bot.player.z > 9758) {
            // North of the z=9758 wall — go south through gap
            await bot.walkToWithPathfinding(3103, 9753);
        }
        // Now on south side — walk to ladder
        await bot.walkToWithPathfinding(3116, 9754);
        await bot.climbStairs('puzzle_ladder', 1);
        await bot.waitForTicks(3);
    }

    // If on upper floors, climb down first.
    // Guard with max iterations to prevent infinite loops if stairs silently fail.
    for (let attempts = 0; (bot.player.level as number) > 0; attempts++) {
        if (attempts >= 6) {
            throw new Error(`Failed to climb down after ${attempts} attempts. Still on level ${bot.player.level} at (${bot.player.x},${bot.player.z})`);
        }
        const climbed = await climbStairsInDirection(bot, 'down');
        if (!climbed) {
            throw new Error(`Cannot find stairs down on level ${bot.player.level}. pos=(${bot.player.x},${bot.player.z})`);
        }
    }

    // If already outside the manor building, skip.
    // The building interior includes the main hall (x=3097-3119, z=3353-3374)
    // AND the west bookcase/ladder wing (x=3090-3096, z=3358-3365).
    const px = bot.player.x;
    const pz = bot.player.z;
    const insideMainHall = px >= 3097 && px <= 3119 && pz >= 3353 && pz <= 3374;
    const insideWestWing = px >= 3090 && px <= 3096 && pz >= 3358 && pz <= 3365;
    const insideBuilding = insideMainHall || insideWestWing;
    if (!insideBuilding) {
        bot.log('STATE', `Already outside manor building at (${px},${pz})`);
        return;
    }

    // Check if trapped in the z=3366-3368 corridor. This corridor is bounded by
    // solid walls at z=3366 (south, x=3105-3111) and z=3368 (north, x=3105-3112)
    // with a door (inaccastledoubledoorropen) at (3106,3368). The auto-door system
    // can't find this door because it's not a wall-shaped loc. Open it manually.
    {
        const cx = bot.player.x;
        const cz = bot.player.z;
        if (cx >= 3105 && cx <= 3112 && cz >= 3366 && cz <= 3368) {
            bot.log('STATE', `In z=3366-3368 corridor at (${cx},${cz}), opening interior door manually`);
            await bot.openDoor('inaccastledoubledoorropen');
            await bot.waitForTicks(3);
            bot.log('STATE', `After opening door: pos=(${bot.player.x},${bot.player.z})`);
            // The door teleports us to a room north of the corridor (~3102,3371).
            // This room may be enclosed. Walk south to the stair area and exit via
            // the south entrance. The front door (haunteddoorl) blocks pathfinding
            // at z=3331, so walk to just inside it, open it, then walk through.
            await bot.walkToWithPathfinding(MANOR_ENTRANCE_X, MANOR_ENTRANCE_Z + 2);
            await bot.openDoor('haunteddoorl');
            await bot.waitForTicks(1);
            await bot.walkToWithPathfinding(MANOR_ENTRANCE_X, MANOR_ENTRANCE_Z - 5);
            bot.log('STATE', `Exited manor: pos=(${bot.player.x},${bot.player.z})`);
            return;
        }
    }

    // Navigate out of the building.
    if (bot.player.x < 3097) {
        // West wing (bookcase room): enclosed by walls on all sides (x=3097 east,
        // z~3357 south, z~3363 north). The only exit is the hauntedleverup at
        // (3096,3357) which opens the bookcase and teleports east to (3098,3357).
        bot.log('STATE', `In west wing at (${bot.player.x},${bot.player.z}), using lever to exit`);
        const lever = bot.findNearbyLoc('hauntedleverup', 16);
        if (!lever) {
            throw new Error(`hauntedleverup not found in bookcase room. pos=(${bot.player.x},${bot.player.z})`);
        }
        await bot.interactLoc(lever, 1);
        await bot.waitForTicks(5);
        bot.log('STATE', `After lever: pos=(${bot.player.x},${bot.player.z})`);
        // Now in main hall east of bookcase (~3098,3357). Walk south to exit.
        // The front door (haunteddoorl) blocks pathfinding at z=3331, so walk
        // to just inside it, open it, then walk through.
        await bot.walkToWithPathfinding(MANOR_ENTRANCE_X, MANOR_ENTRANCE_Z + 2);
        await bot.openDoor('haunteddoorl');
        await bot.waitForTicks(1);
        await bot.walkToWithPathfinding(MANOR_ENTRANCE_X, MANOR_ENTRANCE_Z - 5);
    } else if (bot.player.z >= 3370) {
        // Already north of the z=3373 interior wall — walk north to exit the building
        // directly. Use walkTo (no pathfinding) since interior walls may block the
        // pathfinder for short 1-tile moves.
        await bot.walkTo(bot.player.x, 3378);
        await bot.waitForTicks(3);
        // Route around exterior: east then south.
        await bot.walkToWithPathfinding(3128, 3358);
        await bot.walkToWithPathfinding(3109, 3336);
    } else {
        // Main hall south of z=3373 wall. There is a solid interior wall at z=3373
        // (x=3105-3115) blocking northward routes. Exit via the south entrance.
        // The front door (haunteddoorl) blocks pathfinding at z=3331, so walk
        // to just inside it, open it, then walk through.
        bot.log('STATE', `In main hall at (${bot.player.x},${bot.player.z}), exiting via south entrance`);
        await bot.walkToWithPathfinding(MANOR_ENTRANCE_X, MANOR_ENTRANCE_Z + 2);
        await bot.openDoor('haunteddoorl');
        await bot.waitForTicks(1);
        await bot.walkToWithPathfinding(MANOR_ENTRANCE_X, MANOR_ENTRANCE_Z - 5);
    }
    bot.log('STATE', `Exited manor: pos=(${bot.player.x},${bot.player.z})`);
}

/**
 * Navigate to Professor Oddenstein on the top floor of Draynor Manor.
 */
async function goToOddenstein(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Navigating to Professor Oddenstein ===');

    // Walk to the staircase area
    await bot.walkToWithPathfinding(3108, 3360);

    // Climb up from ground floor to level 1
    if ((bot.player.level as number) === 0) {
        const climbed = await climbStairsInDirection(bot, 'up');
        if (!climbed) {
            // Walk to other potential stair positions
            await bot.walkToWithPathfinding(3109, 3364);
            const climbed2 = await climbStairsInDirection(bot, 'up');
            if (!climbed2) {
                throw new Error(`No staircase found on ground floor. pos=(${bot.player.x},${bot.player.z})`);
            }
        }
    }

    bot.log('STATE', `On level ${bot.player.level}: pos=(${bot.player.x},${bot.player.z})`);

    // Climb from level 1 to level 2
    if ((bot.player.level as number) === 1) {
        const climbed = await climbStairsInDirection(bot, 'up');
        if (!climbed) {
            throw new Error(`No staircase found on level 1. pos=(${bot.player.x},${bot.player.z})`);
        }
    }

    bot.log('STATE', `Oddenstein floor (level ${bot.player.level}): pos=(${bot.player.x},${bot.player.z})`);

    // Walk to Oddenstein's known spawn area (3110, 3367, level 2).
    // Use walkTo (direct waypoint) instead of walkToWithPathfinding because the
    // rsmod pathfinder has no collision data for upper floors (struggle #2).
    //
    // There's a wall at x=3108 (oldwall shape 0) running z=3362-3369 on level 2,
    // with an inaccastledoubledoorropen door at (3108,3364). Open it first, then
    // walk through to Oddenstein's room on the east side.
    await bot.walkTo(3108, 3364);
    await bot.openDoor('inaccastledoubledoorropen');
    await bot.waitForTicks(2);
    await bot.walkTo(3110, 3367);

    // Find Oddenstein
    const oddenstein = bot.findNearbyNpc('Professor Oddenstein', 30);
    if (!oddenstein) {
        throw new Error(`Professor Oddenstein not found. pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    bot.log('STATE', `Found Professor Oddenstein at (${oddenstein.x},${oddenstein.z})`);
}

/**
 * Go from Oddenstein's floor back to ground floor.
 */
async function goDownToGroundFloor(bot: BotAPI): Promise<void> {
    // On upper floors, walk to the stairs area first using walkTo (no pathfinding
    // on upper floors — struggle #2). The stairs are near (3105,3364).
    if ((bot.player.level as number) > 0) {
        await bot.walkTo(3105, 3364);
    }
    for (let attempts = 0; (bot.player.level as number) > 0; attempts++) {
        if (attempts >= 6) {
            throw new Error(`Failed to climb down after ${attempts} attempts. Still on level ${bot.player.level} at (${bot.player.x},${bot.player.z})`);
        }
        const climbed = await climbStairsInDirection(bot, 'down');
        if (!climbed) {
            throw new Error(`Cannot find stairs down on level ${bot.player.level}. pos=(${bot.player.x},${bot.player.z})`);
        }
    }
    bot.log('STATE', `Back on ground floor: pos=(${bot.player.x},${bot.player.z})`);
}

/**
 * Talk to Oddenstein the first time (quest stage: started).
 * Dialog from content/scripts/areas/area_draynor/scripts/professor_oddenstein.rs2
 */
async function talkToOddensteinFirstTime(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Talking to Oddenstein (first time) ===');
    await bot.talkToNpc('Professor Oddenstein');

    // The script opens with p_choice3 immediately (multi-choice: "I'm looking for Ernest" / "machine" / "house")
    const hasChoice1 = await bot.waitForDialog(15);
    if (!hasChoice1) {
        throw new Error(`No dialog opened after talking to Oddenstein. pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    // If it's already multi-choice, select directly. Otherwise continue to it.
    if (!bot.isMultiChoiceOpen()) {
        const foundChoice = await bot.continueDialogsUntilChoice();
        if (!foundChoice) {
            throw new Error('Oddenstein dialog did not reach multi-choice');
        }
    }
    await bot.selectDialogOption(1); // "I'm looking for a guy called Ernest."

    // Continue through: chatplayer, chatnpc exchanges about Ernest being a chicken
    // Until multi2: "I'm glad Veronica..." (1), "Change him back!" (2)
    const foundChoice2 = await bot.continueDialogsUntilChoice();
    if (!foundChoice2) {
        throw new Error('Oddenstein dialog did not reach second multi-choice');
    }
    await bot.selectDialogOption(2); // "Change him back this instant!"

    // Continue through: oddenstein_not_easy dialog -> %haunted = spoken_to_oddenstein
    // chatnpc: "Um, it's not so easy..."
    // chatnpc: "My machine is broken..."
    // chatplayer: "Well I can look out for them."
    // chatnpc: "That would be a help..."
    // chatnpc: "I'm missing the pressure gauge..."
    await bot.continueRemainingDialogs();
    await bot.waitForTicks(2);

    const varp = bot.getQuestProgress(HAUNTED_VARP);
    if (varp !== STAGE_SPOKEN_TO_ODDENSTEIN) {
        throw new Error(`Quest varp after Oddenstein is ${varp}, expected ${STAGE_SPOKEN_TO_ODDENSTEIN}`);
    }
    bot.log('EVENT', `Spoke to Oddenstein! varp=${varp}`);
}

/**
 * Talk to Oddenstein with all 3 items to complete the quest.
 */
async function talkToOddensteinComplete(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Talking to Oddenstein (completing quest) ===');
    await bot.talkToNpc('Professor Oddenstein');

    // chatnpc: "Have you found anything yet?"
    // chatplayer: "I have everything!"
    // chatnpc: "Give 'em here then."
    // Then: if_close → mes sequences with p_delay (no PAUSEBUTTON)
    // Then: Ernest dialog, quest complete

    // Continue through all dialog pages
    for (let i = 0; i < 20; i++) {
        const d = await bot.waitForDialog(10);
        if (!d) {
            // No dialog — wait for mes/p_delay sequences
            await bot.waitForTicks(5);
            continue;
        }
        await bot.continueDialog();
    }

    // Wait for queued quest complete script
    await bot.waitForTicks(10);
    bot.dismissModals();
    await bot.waitForTicks(3);
    bot.dismissModals();
}

/**
 * Collect fish food and poison from inside Draynor Manor.
 *
 * Known spawn locations (from m48_52.jm2):
 * - Poison: level 0, world (3097,3366) — NW room behind two locked interior doors
 * - Fish food: level 1, world (3108,3356)
 *
 * The poison room is enclosed by solid walls. To reach it, the bot must open
 * two interior doors (inaccastledoubledoorropen), each of which teleports the
 * player through via the RS2 door script.
 *
 * Route to poison:
 *   1. Walk to door at (3106,3368) — blocks north hallway
 *   2. Open door → teleported through z=3368 wall
 *   3. Walk through x=3105 gap at z=3369 to door at (3101,3371) — x=3101 wall
 *   4. Open door → teleported to west side of x=3101 wall
 *   5. Walk south through z=3368 gap at x=3099 to door at (3099,3366) — z=3366 wall
 *   6. Open door → teleported into poison room
 *   7. Pick up poison from (3098,3366)
 */
async function collectManorItems(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Collecting fish food and poison ===');

    // Collect poison on ground floor
    if (!bot.findItem('Poison')) {
        bot.log('STATE', 'Navigating to poison room through interior doors');

        // Step 1: Walk to the door at (3106,3368) that blocks the north hallway
        await bot.walkToWithPathfinding(3106, 3368);
        bot.log('STATE', `At north door: pos=(${bot.player.x},${bot.player.z})`);

        // Step 2: Open the door — the RS2 script teleports us through
        await bot.openDoor('inaccastledoubledoorropen');
        await bot.waitForTicks(3);
        bot.log('STATE', `After north door: pos=(${bot.player.x},${bot.player.z})`);

        // Step 3: Walk through x=3105 gap (z >= 3369) to the x=3101 door at (3101,3371)
        await bot.walkToWithPathfinding(3102, 3371);
        bot.log('STATE', `At x=3101 door: pos=(${bot.player.x},${bot.player.z})`);

        // Step 4: Open the x=3101 wall door — teleports to west side
        await bot.openDoor('inaccastledoubledoorropen');
        await bot.waitForTicks(3);
        bot.log('STATE', `After x=3101 door: pos=(${bot.player.x},${bot.player.z})`);

        // Step 5: Walk south through z=3368 gap at x=3099 to the z=3366 door
        await bot.walkToWithPathfinding(3099, 3367);
        bot.log('STATE', `At z=3366 door: pos=(${bot.player.x},${bot.player.z})`);

        // Step 6: Open the z=3366 door — teleports into poison room
        await bot.openDoor('inaccastledoubledoorropen');
        await bot.waitForTicks(3);
        bot.log('STATE', `In poison room: pos=(${bot.player.x},${bot.player.z})`);

        // Step 7: Pick up poison
        const poison = bot.findNearbyGroundItem('Poison', 8);
        if (poison) {
            bot.log('STATE', `Found poison at (${poison.x},${poison.z})`);
            await bot.takeGroundItem('Poison', poison.x, poison.z);
            await bot.waitForTicks(3);
        }
        if (!bot.findItem('Poison')) {
            throw new Error(`Poison not found after navigating to room. pos=(${bot.player.x},${bot.player.z})`);
        }
        bot.log('EVENT', 'Obtained poison');

        // Navigate back out through the same doors in reverse
        bot.log('STATE', 'Navigating back from poison room');

        // From poison room: open z=3366 door → teleported north
        await bot.openDoor('inaccastledoubledoorropen');
        await bot.waitForTicks(3);
        bot.log('STATE', `After z=3366 door (return): pos=(${bot.player.x},${bot.player.z})`);

        // Walk north to near x=3101 door at (3101,3371)
        await bot.walkToWithPathfinding(3100, 3371);

        // Open x=3101 door → teleported to east side
        await bot.openDoor('inaccastledoubledoorropen');
        await bot.waitForTicks(3);
        bot.log('STATE', `After x=3101 door (return): pos=(${bot.player.x},${bot.player.z})`);

        // Walk south to near z=3368 door at (3106,3368)
        await bot.walkToWithPathfinding(3106, 3369);

        // Open z=3368 door → teleported south to stair area
        await bot.openDoor('inaccastledoubledoorropen');
        await bot.waitForTicks(3);
        bot.log('STATE', `After z=3368 door (return): pos=(${bot.player.x},${bot.player.z})`);

        // Walk to stair area
        await bot.walkToWithPathfinding(3108, 3362);
        bot.log('STATE', `Back at stair area: pos=(${bot.player.x},${bot.player.z})`);
    }

    // Collect fish food on level 1 (3108, 3356)
    if (!bot.findItem('Fish food')) {
        // Navigate to stairs and climb up
        await bot.walkToWithPathfinding(3108, 3360);
        const climbed = await climbStairsInDirection(bot, 'up');
        if (!climbed) {
            throw new Error(`No stairs found to climb to level 1. pos=(${bot.player.x},${bot.player.z})`);
        }

        // Level 1 has walls at z=3365-3366 near x=3108 and at x=3106-3107 at z=3356.
        // Navigate via intermediate waypoint to avoid getting stuck.
        bot.log('STATE', `On level 1 at (${bot.player.x},${bot.player.z}). Walking to fish food.`);
        await bot.walkToWithPathfinding(3109, 3360);
        await bot.walkToWithPathfinding(3108, 3356);
        const food = bot.findNearbyGroundItem('Fish food', 5);
        if (food) {
            bot.log('STATE', `Found fish food at (${food.x},${food.z}) level ${bot.player.level}`);
            await bot.takeGroundItem('Fish food', food.x, food.z);
            await bot.waitForTicks(3);
        }
        if (!bot.findItem('Fish food')) {
            throw new Error(`Fish food not found at known spawn (3108,3356) level 1. pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
        }

        // Climb back down to ground floor
        await climbStairsInDirection(bot, 'down');
    }

    bot.log('EVENT', 'Collected fish food and poison');
}

/**
 * Obtain the pressure gauge from the fountain.
 * Combine fish food + poison → poisoned fish food.
 * Use poisoned fish food on fountain. Search fountain.
 */
async function obtainPressureGauge(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Obtaining pressure gauge ===');

    // Combine fish food + poison (skip if already combined)
    if (!bot.findItem('Poisoned fish food')) {
        if (!bot.findItem('Poison') || !bot.findItem('Fish food')) {
            throw new Error(`Missing ingredients: Poison=${!!bot.findItem('Poison')}, Fish food=${!!bot.findItem('Fish food')}, Poisoned fish food=${!!bot.findItem('Poisoned fish food')}`);
        }
        await bot.useItemOnItem('Poison', 'Fish food');
        await bot.waitForTicks(3);
        if (!bot.findItem('Poisoned fish food')) {
            throw new Error('Failed to create poisoned fish food');
        }
        bot.log('EVENT', 'Created poisoned fish food');
    } else {
        bot.log('STATE', 'Already have poisoned fish food');
    }

    // Walk to fountain area — fountain is a 2x2 loc at world (3087,3334).
    // Need to be within 16 tiles to find it.
    await bot.walkToWithPathfinding(3090, 3334);
    const fountain = bot.findNearbyLoc('hauntedfountain', 16);
    if (!fountain) {
        throw new Error(`Fountain not found near (${bot.player.x},${bot.player.z})`);
    }
    bot.log('STATE', `Found fountain at (${fountain.x},${fountain.z})`);

    // Use poisoned fish food on fountain
    await bot.useItemOnLoc('Poisoned fish food', 'hauntedfountain');
    await bot.waitForTicks(5);

    if (bot.findItem('Poisoned fish food')) {
        throw new Error('Poisoned fish food not consumed after using on fountain');
    }

    // Search fountain to get pressure gauge
    const fountain2 = bot.findNearbyLoc('hauntedfountain', 16);
    if (!fountain2) throw new Error('Fountain not found after poisoning');
    await bot.interactLoc(fountain2, 1);
    await bot.waitForTicks(5);

    // Continue any dialog
    for (let i = 0; i < 5; i++) {
        const d = await bot.waitForDialog(3);
        if (!d) break;
        await bot.continueDialog();
    }
    await bot.waitForTicks(2);

    if (!bot.findItem('Pressure gauge')) {
        throw new Error('Failed to obtain pressure gauge from fountain');
    }
    bot.log('EVENT', 'Obtained pressure gauge!');
}

/**
 * Find a spade from ground spawns near Draynor Manor.
 * Known spawn: (3120, 3359, level 0) from m48_52.jm2 offset (48, 31).
 */
async function obtainSpade(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Obtaining spade ===');

    if (bot.findItem('Spade')) {
        bot.log('STATE', 'Already have spade');
        return;
    }

    // Walk to known spade spawn at (3120, 3359) inside the manor
    await bot.walkToWithPathfinding(3120, 3359);
    const spade = bot.findNearbyGroundItem('Spade', 8);
    if (spade) {
        bot.log('STATE', `Found spade at (${spade.x},${spade.z})`);
        await bot.takeGroundItem('Spade', spade.x, spade.z);
        await bot.waitForTicks(3);
    }

    if (!bot.findItem('Spade')) {
        throw new Error(`Could not find a spade at (3120,3359). pos=(${bot.player.x},${bot.player.z})`);
    }
    bot.log('EVENT', 'Obtained spade');
}

/**
 * Dig the compost heap to obtain the closet key.
 * Compost heap is at world (3084, 3360), outside the building on the west manor grounds.
 */
async function obtainClosetKey(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Obtaining closet key ===');

    if (bot.findItem('Key')) {
        bot.log('STATE', 'Already have key');
        return;
    }

    // Walk to compost heap area — the heap is a 2x2 loc at (3084,3360),
    // walk to an adjacent tile rather than on top of it.
    await bot.walkToWithPathfinding(3086, 3361);

    const compost = bot.findNearbyLoc('hauntedcompostheap', 16);
    if (!compost) {
        throw new Error(`Compost heap not found near (${bot.player.x},${bot.player.z})`);
    }

    bot.log('STATE', `Found compost heap at (${compost.x},${compost.z})`);
    await bot.useItemOnLoc('Spade', 'hauntedcompostheap');
    await bot.waitForTicks(5);

    if (!bot.findItem('Key')) {
        throw new Error('Failed to get key from compost heap');
    }
    bot.log('EVENT', 'Obtained closet key');
}

/**
 * Obtain the rubber tube from the locked closet.
 * Closet door is at (3107, 3367, angle 2). Use key → teleported through → rubber tube at (3111, 3367).
 */
async function obtainRubberTube(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Obtaining rubber tube ===');

    // Navigate to closet door at (3107, 3367) — inside the manor
    // From the staircase area, walk through interior to closet door area
    await bot.walkToWithPathfinding(3108, 3362);
    const closetDoor = bot.findNearbyLoc('closet_door', 16);
    if (!closetDoor) {
        throw new Error(`Closet door not found near (${bot.player.x},${bot.player.z})`);
    }

    bot.log('STATE', `Found closet door at (${closetDoor.x},${closetDoor.z})`);

    // Use key on closet door — the RS2 script teleports through via open_and_close_door2
    await bot.useItemOnLoc('Key', 'closet_door');
    await bot.waitForTicks(5);

    bot.log('STATE', `After using key: pos=(${bot.player.x},${bot.player.z})`);

    // Pick up rubber tube — should be at (3111, 3367) on the other side of the door
    const tube = bot.findNearbyGroundItem('Rubber tube', 10);
    if (tube) {
        bot.log('STATE', `Found rubber tube at (${tube.x},${tube.z})`);
        await bot.takeGroundItem('Rubber tube', tube.x, tube.z);
        await bot.waitForTicks(3);
    }

    if (!bot.findItem('Rubber tube')) {
        throw new Error(`Failed to obtain rubber tube. pos=(${bot.player.x},${bot.player.z})`);
    }
    bot.log('EVENT', 'Obtained rubber tube!');

    // Exit the closet corridor (x=3108-3111, z=3367) by using key on closet_door again.
    // The corridor is sealed by walls on all sides; the closet_door at (3107,3367) is the
    // only exit. The key is not consumed, and open_and_close_door2 with check_axis will
    // teleport us back to the west side (stairs area).
    bot.log('STATE', `Exiting closet corridor from pos=(${bot.player.x},${bot.player.z})`);
    await bot.useItemOnLoc('Key', 'closet_door');
    await bot.waitForTicks(5);
    bot.log('STATE', `After exiting closet: pos=(${bot.player.x},${bot.player.z})`);
}

/**
 * Pull a lever in the basement by debugname.
 * Uses interactLoc directly — no walkToWithPathfinding to avoid auto-door
 * interference with puzzle doors. Verifies the lever state actually changed.
 */
async function pullLever(bot: BotAPI, leverDebugname: string): Promise<void> {
    const lever = bot.findNearbyLoc(leverDebugname, 50);
    if (!lever) {
        throw new Error(`Lever "${leverDebugname}" not found near (${bot.player.x},${bot.player.z})`);
    }

    const stateBefore = bot.getVarp(ERNESTLEVER_VARP);
    bot.log('ACTION', `Pulling ${leverDebugname} at (${lever.x},${lever.z}) from (${bot.player.x},${bot.player.z})`);
    await bot.interactLoc(lever, 1);
    await bot.waitForTicks(3);

    const stateAfter = bot.getVarp(ERNESTLEVER_VARP);
    if (stateAfter === stateBefore) {
        throw new Error(
            `Lever ${leverDebugname} at (${lever.x},${lever.z}) did not toggle! ` +
            `State still 0b${stateAfter.toString(2).padStart(6, '0')}. ` +
            `Bot pos: (${bot.player.x},${bot.player.z}). ` +
            'Lever may be unreachable from current room.'
        );
    }
    bot.log('STATE', `Lever state: 0b${stateAfter.toString(2).padStart(6, '0')} (${stateAfter})`);
}

/**
 * Open a haunted puzzle door and walk through it.
 * The haunted door script ([oploc1,_haunted_door]) checks lever bits and either:
 *   - opens the door (deletes loc, creates new loc, player walks through) if conditions met
 *   - says "the door won't budge" if conditions not met
 *
 * Uses interactLoc directly — no walkToWithPathfinding to avoid auto-door
 * interference with other puzzle doors.
 */
async function openHauntedDoor(bot: BotAPI, doorDebugname: string): Promise<void> {
    const door = bot.findNearbyLoc(doorDebugname, 50);
    if (!door) {
        throw new Error(`Door "${doorDebugname}" not found near (${bot.player.x},${bot.player.z})`);
    }

    bot.log('ACTION', `Opening door ${doorDebugname} at (${door.x},${door.z}) from (${bot.player.x},${bot.player.z})`);

    const beforeX = bot.player.x;
    const beforeZ = bot.player.z;

    await bot.interactLoc(door, 1);
    await bot.waitForTicks(3);

    // The haunted door script opens the door and the player walks through automatically.
    // If the door opened successfully, the player should have moved to the other side.
    // If not, the door won't budge (wrong lever state).
    if (bot.player.x === beforeX && bot.player.z === beforeZ) {
        const state = bot.getVarp(ERNESTLEVER_VARP);
        throw new Error(
            `Door ${doorDebugname} at (${door.x},${door.z}) did not open. ` +
            `Lever state: 0b${state.toString(2).padStart(6, '0')} (${state}). ` +
            `Bot pos: (${bot.player.x},${bot.player.z})`
        );
    }

    bot.log('STATE', `After door ${doorDebugname}: pos=(${bot.player.x},${bot.player.z})`);
}

/**
 * Enter the basement through the bookcase secret passage and ladder.
 */
async function enterBasement(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Entering basement ===');

    // The bookcase secret passage is in the western part of the manor.
    // bookcase end_coords decode to x≈3096, z≈3358-3359
    // Navigate via stairs area first to avoid pathfinding issues through interior walls.
    // The manor interior has walls at z=3366, z=3368, x=3105, x=3112 etc. that create
    // disconnected rooms. Always route through (3109,3367) first (reachable from any
    // closet/corridor position), then to stairs at (3108,3362), then to bookcase.
    // We should be in the south half of the manor building (entered from south).
    // Navigate to the stairs area and then west to the bookcase.
    await bot.walkToWithPathfinding(3108, 3362);
    await bot.walkToWithPathfinding(3098, 3359);

    // Try to find and interact with the bookcase
    let bookcase = bot.findNearbyLoc('hauntedbookcasel', 16);
    if (!bookcase) bookcase = bot.findNearbyLoc('hauntedbookcaser', 16);

    if (bookcase) {
        bot.log('STATE', `Found bookcase at (${bookcase.x},${bookcase.z}), searching...`);
        await bot.interactLoc(bookcase, 1);
        await bot.waitForTicks(5);
    } else {
        // Try the lever to open the bookcase
        const lever = bot.findNearbyLoc('hauntedleverup', 16);
        if (lever) {
            bot.log('STATE', `Found lever at (${lever.x},${lever.z}), pulling...`);
            await bot.interactLoc(lever, 1);
            await bot.waitForTicks(5);
        } else {
            throw new Error(`No bookcase or lever found near (${bot.player.x},${bot.player.z})`);
        }
    }

    // Find and climb down the ladder
    const ladder = bot.findNearbyLoc('puzzle_ladder_top', 20);
    if (!ladder) {
        throw new Error(`Puzzle ladder not found near (${bot.player.x},${bot.player.z})`);
    }

    bot.log('STATE', `Found ladder at (${ladder.x},${ladder.z}), climbing down...`);
    await bot.climbStairs('puzzle_ladder_top', 1);
    await bot.waitForTicks(3);

    if (bot.player.z < 6400) {
        throw new Error(`Failed to reach basement: pos=(${bot.player.x},${bot.player.z})`);
    }
    bot.log('STATE', `In basement: pos=(${bot.player.x},${bot.player.z})`);

    // Log all nearby puzzle locs for debugging
    const allLocs = bot.findAllNearbyLocs(50);
    const puzzleLocs = allLocs.filter(l =>
        l.debugname.startsWith('lever') ||
        ['1to2', '2to3', '4to5', '5to6', '8to9', '2to5', '3to6', '4to7', '5to8', 'puzzle_ladder'].includes(l.debugname)
    );
    for (const loc of puzzleLocs) {
        bot.log('DEBUG', `  ${loc.debugname} at (${loc.x},${loc.z}) dist=${loc.dist}`);
    }
}

/**
 * Obtain the oil can by solving the basement lever puzzle.
 *
 * Door conditions (from quest_haunted.rs2 [oploc1,_haunted_door]):
 *   1to2: A=off, B=off, D=on, E=on, F=on       (state & 0b111001 == 0b111000)
 *   2to3: B=off, D=on, F=on
 *   4to5: A=on, B=on, D=on
 *   5to6: D=on
 *   8to9: E=off, F=on
 *   2to5: A=off, B=off, C=on, D=on, E=off, F=on (state == 0b101100)
 *   3to6: B=off, D=on, F=off
 *   4to7: A=on, B=on, C=off, D=off, E=off, F=off (state == 0b000011)
 *   5to8: (C=off AND D=on) OR (state == 0b101100)
 *
 * Room layout (3x3 grid):
 *   Room 1 (NE): leverD. Doors: 1to2(W)
 *   Room 2 (N):  none.    Doors: 1to2(E), 2to3(W), 2to5(S)
 *   Room 3 (NW): leverE,F. Doors: 2to3(E), 3to6(S)
 *   Room 4 (E):  leverC.  Doors: 4to7(S), 4to5(W)
 *   Room 5 (C):  none.    Doors: 4to5(E), 5to6(W), 2to5(N), 5to8(S)
 *   Room 6 (W):  none.    Doors: 5to6(E), 3to6(N)
 *   Room 7 (SE): leverA,B, ladder. Doors: 4to7(N)
 *   Room 8 (S):  none.    Doors: 5to8(N), 8to9(W)
 *   Room 9 (SW): oil can.  Doors: 8to9(E)
 *
 * KEY: There is a gap at x=3103 in the z=9758 wall, allowing passage between
 * the north rooms (4/5/6) and south rooms (7/8/9) without using doors.
 * Similarly, there may be gaps at z=9765 between rooms 1/4 and 2/5.
 *
 * Solution (RS2 walkthrough adapted with explicit gap navigation):
 * 1. Pull B,A → 000011 → 4to7 opens
 * 2. Enter 4to7 → room 4
 * 3. Pull D → 001011 → 4to5, 5to6, 5to8 open
 * 4. Enter 4to5 → room 5
 * 5. Navigate through gap to room 7, pull B,A (toggle off) → 001000
 *    Now: 5to6, 3to6, 5to8 open
 * 6. Navigate back to room 5, enter 5to6 → room 6, enter 3to6 → room 3
 * 7. Pull E,F → 111000. Now: 1to2, 2to3, 5to6, 5to8 open
 * 8. Navigate through 2to3 → room 2, 1to2 → room 1
 * 9. Pull C (navigate to room 4 via gap or open passage) → 111100
 * 10. Pull E (navigate to room 3) → 101100. Now: 2to5, 5to8, 8to9 open
 * 11. Enter 2to5 → room 5, 5to8 → room 8, 8to9 → room 9
 * 12. Pick up oil can
 * 13. Exit via gap to ladder
 */
async function obtainOilCan(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Obtaining oil can ===');

    await enterBasement(bot);

    function logState(label: string): void {
        const s = bot.getVarp(ERNESTLEVER_VARP);
        bot.log('STATE', `${label}: lever=0b${s.toString(2).padStart(6, '0')} pos=(${bot.player.x},${bot.player.z})`);
    }

    // Helper: navigate from north rooms to room 7 via gap at x=3103
    async function navigateToRoom7(): Promise<void> {
        bot.log('STATE', `Navigating to room 7 via gap at x=3103 from (${bot.player.x},${bot.player.z})`);
        await bot.walkToWithPathfinding(3103, 9759);
        await bot.walkToWithPathfinding(3103, 9753);
    }

    // Helper: navigate from room 7 back to room 5 via 5to8 door.
    // The gap at x=3103 in the z=9758 wall only works north→south (due to wall
    // edge placement). Use the 5to8 door instead: room 7 → room 8 → 5to8 → room 5.
    // At step 6, state is 001000 (D on), so 5to8 is open (C=off,D=on ✓).
    async function navigateToRoom5FromSouth(): Promise<void> {
        bot.log('STATE', `Navigating back to room 5 via 5to8 from (${bot.player.x},${bot.player.z})`);
        // Walk from room 7 to room 8 area (no door between adjacent south rooms)
        await bot.walkToWithPathfinding(3104, 9753);
        // Open 5to8 door to enter room 5
        await openHauntedDoor(bot, '5to8');
    }

    logState('Initial');

    // Step 1: Pull B, A → 000011. 4to7 opens.
    await pullLever(bot, 'leverb');
    await pullLever(bot, 'levera');
    logState('After B,A');

    // Step 2: Enter 4to7 → room 4
    await openHauntedDoor(bot, '4to7');
    logState('Through 4to7');

    // Step 3: Pull D → 001011. 4to5, 5to6, 5to8 open.
    await pullLever(bot, 'leverd');
    logState('After D');

    // Step 4: Enter 4to5 → room 5
    await openHauntedDoor(bot, '4to5');
    logState('Through 4to5');

    // Step 5: Navigate to room 7 via gap, pull B and A off → 001000
    // Now: 5to6(D=on), 3to6(B=off,D=on,F=off), 5to8(C=off,D=on) all open
    await navigateToRoom7();
    await pullLever(bot, 'leverb');
    await pullLever(bot, 'levera');
    logState('After B,A toggle');

    // Step 6: Navigate back to room 5, then 5to6 → room 6, then 3to6 → room 3
    await navigateToRoom5FromSouth();
    await openHauntedDoor(bot, '5to6');
    logState('Through 5to6');
    await openHauntedDoor(bot, '3to6');
    logState('Through 3to6');

    // Step 7: Pull E, F → 111000
    // Now: 1to2(A=off,B=off,D=on,E=on,F=on ✓), 2to3(B=off,D=on,F=on ✓),
    //       5to6(D=on ✓), 5to8(C=off,D=on ✓) open
    await pullLever(bot, 'levere');
    await pullLever(bot, 'leverf');
    logState('After E,F');

    // Step 8: From room 3, go through 2to3 → room 2, then 1to2 → room 1
    await openHauntedDoor(bot, '2to3');
    logState('Through 2to3');
    await openHauntedDoor(bot, '1to2');
    logState('Through 1to2');

    // Step 9: Pull C. LeverC is at (3112,9760) in room 4.
    // From room 1, need to reach room 4. Room 1 is z>9765, room 4 is z<9765.
    // There may be an open passage at the z=9765 boundary, or we navigate via gap.
    await pullLever(bot, 'leverc');
    logState('After C');

    // Step 10: Pull E off. LeverE is at (3097,9767) in room 3.
    // From room 1/4, navigate west to room 3. Go through 1to2 → room 2, 2to3 → room 3.
    // 1to2 open? state 111100: A=off,B=off,D=on,E=on,F=on → 1to2 needs A=off,B=off,D=on,E=on,F=on ✓
    // 2to3 open? B=off,D=on,F=on → ✓
    await openHauntedDoor(bot, '1to2');
    logState('Back through 1to2');
    await openHauntedDoor(bot, '2to3');
    logState('Back through 2to3');

    // Now in room 2. From room 2, go through 2to3 → room 3... wait, we just came from 2to3.
    // Actually: after 1to2 from room 1 → room 2. After 2to3 from room 2 → room 3.
    // But the code above goes 1to2 then 2to3 which should take us room1→room2→room3.
    // Let me verify: openHauntedDoor finds the door and interacts. From room 1 position,
    // the closest 1to2 door should be the one between rooms 1 and 2.

    await pullLever(bot, 'levere');
    logState('After E toggle');

    // Step 11: Navigate to room 9 for oil can
    // State: 101100 (C,D,F on). All four doors on the path are open:
    //   2to3: B=off,D=on,F=on ✓
    //   2to5: state==101100 ✓
    //   5to8: state==101100 ✓
    //   8to9: E=off,F=on ✓
    // Route: room 3 → 2to3 → room 2 → 2to5 → room 5 → 5to8 → room 8 → 8to9 → room 9
    bot.log('STATE', `Navigating to room 9 via doors from (${bot.player.x},${bot.player.z})`);
    await openHauntedDoor(bot, '2to3');
    logState('Through 2to3 (step 11)');
    await openHauntedDoor(bot, '2to5');
    logState('Through 2to5');
    await openHauntedDoor(bot, '5to8');
    logState('Through 5to8');
    await openHauntedDoor(bot, '8to9');
    logState('Through 8to9');

    // Pick up oil can
    const oilCan = bot.findNearbyGroundItem('Oil can', 10);
    if (!oilCan) {
        throw new Error(`Oil can not found near (${bot.player.x},${bot.player.z})`);
    }
    await bot.takeGroundItem('Oil can', oilCan.x, oilCan.z);
    await bot.waitForTicks(3);

    if (!bot.findItem('Oil can')) {
        throw new Error('Failed to pick up oil can');
    }
    bot.log('EVENT', 'Obtained oil can!');

    // Exit basement: navigate to ladder via gap
    // From room 9, walk east through gap at x=3103 to room 7 area, then to ladder.
    // Walk to (3116,9754) adjacent to puzzle_ladder at (3117,9754) — the ladder tile
    // itself is blocked by the loc.
    bot.log('STATE', 'Exiting basement via gap to ladder');
    await bot.walkToWithPathfinding(3103, 9753);
    await bot.walkToWithPathfinding(3116, 9754);
    await bot.climbStairs('puzzle_ladder', 1);
    await bot.waitForTicks(3);

    if (bot.player.z > 6400) {
        throw new Error(`Failed to exit basement: pos=(${bot.player.x},${bot.player.z})`);
    }
    bot.log('STATE', `Exited basement: pos=(${bot.player.x},${bot.player.z})`);
}

// ---- State machine ----

/**
 * Build the Ernest the Chicken state machine.
 */
export function buildErnestTheChickenStates(bot: BotAPI): BotState {
    return {
        name: 'ernest-the-chicken',
        isComplete: () => bot.getQuestProgress(HAUNTED_VARP) === STAGE_COMPLETE,
        run: async () => { throw new Error('Composite state should not be called directly'); },
        children: [
            {
                name: 'talk-to-veronica',
                isComplete: () => bot.getQuestProgress(HAUNTED_VARP) >= STAGE_STARTED,
                run: async () => {
                    await walkToManorArea(bot);
                    await talkToVeronicaStart(bot);
                }
            },
            {
                name: 'talk-to-oddenstein',
                isComplete: () => bot.getQuestProgress(HAUNTED_VARP) >= STAGE_SPOKEN_TO_ODDENSTEIN,
                run: async () => {
                    await enterManor(bot);
                    await goToOddenstein(bot);
                    await talkToOddensteinFirstTime(bot);
                    await goDownToGroundFloor(bot);
                }
            },
            {
                name: 'get-pressure-gauge',
                isComplete: () => bot.findItem('Pressure gauge') !== null,
                run: async () => {
                    // Skip manor item collection if we already have what we need
                    const hasPoisonedFood = bot.findItem('Poisoned fish food') !== null;
                    const hasIngredients = bot.findItem('Poison') !== null && bot.findItem('Fish food') !== null;

                    if (!hasPoisonedFood && !hasIngredients) {
                        // Collect fish food + poison from inside manor (needed for fountain)
                        await enterManor(bot);
                        await collectManorItems(bot);
                        // Exit manor: the front doors only open from outside (z <= door z).
                        // The wall at z=3353 prevents walking south. Exit through the north
                        // side of the building (open at z=3370+), go around east through the
                        // manor grounds, then south to the fountain.
                        bot.log('STATE', `Exiting manor from pos=(${bot.player.x},${bot.player.z})`);
                        await exitManor(bot);
                    }

                    await obtainPressureGauge(bot);
                }
            },
            {
                name: 'get-rubber-tube',
                isComplete: () => bot.findItem('Rubber tube') !== null,
                run: async () => {
                    // Step 1: Get spade from east wing of manor
                    if (!bot.findItem('Spade')) {
                        await enterManor(bot);
                        await obtainSpade(bot);
                    }

                    // Step 2: Get closet key from compost heap (outside manor grounds)
                    if (!bot.findItem('Key')) {
                        // Navigate to the compost heap from wherever we are.
                        // If in east wing (spade room x>3119), go east then around.
                        // Otherwise navigate normally through grounds.
                        bot.log('STATE', `Going to compost from pos=(${bot.player.x},${bot.player.z})`);
                        if (bot.player.x > 3119 && bot.player.z >= 3353) {
                            // In east wing — go east through exterior, then around
                            await bot.walkToWithPathfinding(3128, 3358);
                            await bot.walkToWithPathfinding(3109, 3336);
                        } else {
                            // Navigate to grounds area
                            await exitManor(bot);
                        }
                        await obtainClosetKey(bot);
                    }

                    // Step 3: Enter manor from south and use key on closet door
                    await enterManor(bot);
                    await obtainRubberTube(bot);
                }
            },
            {
                name: 'get-oil-can',
                isComplete: () => bot.findItem('Oil can') !== null,
                run: async () => {
                    // Exit and re-enter manor from the south to ensure we start at
                    // a known good position. Interior walls at z=3366, z=3368 with
                    // non-wall-shaped doors (inaccastledoubledoorropen) can't be
                    // auto-opened by walkToWithPathfinding. Re-entering from the
                    // south places us in the bookcase/stairs area directly.
                    await exitManor(bot);
                    await enterManor(bot);
                    await obtainOilCan(bot);
                }
            },
            {
                name: 'complete-quest',
                isComplete: () => bot.getQuestProgress(HAUNTED_VARP) === STAGE_COMPLETE,
                run: async () => {
                    if (!bot.findItem('Pressure gauge')) throw new Error('Missing pressure gauge');
                    if (!bot.findItem('Rubber tube')) throw new Error('Missing rubber tube');
                    if (!bot.findItem('Oil can')) throw new Error('Missing oil can');
                    bot.log('EVENT', 'Have all 3 items');

                    // Exit and re-enter manor from the south to ensure we're
                    // in the east half (staircase side), not stuck behind the
                    // x=3105 wall in the bookcase area.
                    await exitManor(bot);
                    await enterManor(bot);
                    await goToOddenstein(bot);
                    await talkToOddensteinComplete(bot);

                    await bot.waitForTicks(5);
                    bot.dismissModals();

                    const finalVarp = bot.getQuestProgress(HAUNTED_VARP);
                    if (finalVarp !== STAGE_COMPLETE) {
                        throw new Error(`Quest not complete: varp is ${finalVarp}, expected ${STAGE_COMPLETE}`);
                    }

                    const coins = bot.findItem('Coins');
                    bot.log('SUCCESS', `Ernest the Chicken complete! varp=${finalVarp}, coins=${coins ? coins.count : 0}`);
                }
            }
        ]
    };
}

export async function ernestTheChicken(bot: BotAPI): Promise<void> {
    // === Setup ===
    await skipTutorial(bot);
    await bot.waitForTicks(2);

    bot.log('STATE', `Starting Ernest the Chicken at (${bot.player.x},${bot.player.z},${bot.player.level})`);

    const initialVarp = bot.getQuestProgress(HAUNTED_VARP);
    if (initialVarp !== STAGE_NOT_STARTED) {
        throw new Error(`Quest varp is ${initialVarp}, expected ${STAGE_NOT_STARTED}`);
    }

    const root = buildErnestTheChickenStates(bot);
    const snapshotDir = path.resolve(import.meta.dir, '..', 'test', 'snapshots');
    await runStateMachine(bot, { root, varpIds: [HAUNTED_VARP], captureSnapshots: true, snapshotDir });
}

export const metadata: ScriptMeta = {
    name: 'ernestthechicken',
    type: 'quest',
    varpId: HAUNTED_VARP,
    varpComplete: STAGE_COMPLETE,
    maxTicks: 30000,
    run: ernestTheChicken,
    buildStates: buildErnestTheChickenStates,
};
