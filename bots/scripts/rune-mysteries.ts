import { BotAPI } from '../runtime/api.ts';
import { skipTutorial } from './skip-tutorial.ts';


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

export async function runeMysteries(bot: BotAPI): Promise<void> {
    // === Setup: skip tutorial, start in Lumbridge ===
    await skipTutorial(bot);
    await bot.waitForTicks(2);

    bot.log('STATE', `Starting Rune Mysteries quest at (${bot.player.x},${bot.player.z},${bot.player.level})`);

    const initialVarp = bot.getQuestProgress(RUNE_MYSTERIES_VARP);
    if (initialVarp !== STAGE_NOT_STARTED) {
        throw new Error(`Quest varp is ${initialVarp}, expected ${STAGE_NOT_STARTED} (not started)`);
    }

    // ================================================================
    // Step 1: Duke Horacio (Lumbridge Castle, 1st floor)
    // ================================================================
    bot.log('STATE', '=== Step 1: Duke Horacio ===');

    // Navigate from Lumbridge spawn (3222, 3218) through castle doors to the stairwell.
    //
    // Castle layout (level 0):
    //   - Castle entrance double doors at x=3217: openbankdoor_l (3217,3218) + openthickpoordoor (3217,3219)
    //   - Interior door at (3215,3211): poordooropen (separates main hall from south corridor)
    //   - Stairwell room accessible from east via the south corridor
    //   - Staircase loc_1738 at (3204,3207), 2x2

    // Step 1: Walk to the castle entrance doors and open them.
    await bot.walkToWithPathfinding(3218, 3218);
    bot.log('STATE', `At castle entrance: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    await bot.openDoor('openbankdoor_l');

    // Step 2: Walk through into the castle hall.
    await bot.walkToWithPathfinding(3215, 3215);
    bot.log('STATE', `Inside castle hall: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Step 3: Open the interior door leading south to the stairwell corridor.
    await bot.openDoor('poordooropen');

    // Step 4: Walk south through the door into the south corridor, then west to the stairwell.
    await bot.walkToWithPathfinding(3206, 3210);
    bot.log('STATE', `Near stairwell: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Climb the ground floor staircase up to level 1.
    // loc_1738: op1=Climb-up. Player lands at (3205, 3209, level 1).
    await bot.climbStairs('loc_1738', 1);
    await bot.waitForTicks(2);

    if (bot.player.level !== 1) {
        throw new Error(`Failed to climb to level 1: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    bot.log('STATE', `On Duke's floor: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Level 1 has a north-south wall at x=3207 with doors:
    //   - poordooropen at (3207, 3214) angle=2 (east wall)
    //   - poordooropen at (3207, 3222) angle=2 (east wall)
    // We need to open one to reach the Duke's room (east side).
    // Walk north to the door at (3207, 3222), open it, then go east.
    await bot.walkToWithPathfinding(3207, 3222);
    await bot.openDoor('poordooropen');

    // Walk east through the door to near the Duke.
    await bot.walkToWithPathfinding(3210, 3220);

    const duke = bot.findNearbyNpc('Duke Horacio', 16);
    if (!duke) {
        throw new Error(`Duke Horacio not found near (${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    bot.log('STATE', `Found Duke Horacio at (${duke.x},${duke.z})`);
    await bot.interactNpc(duke, 1);

    // Dialog: greeting → choice "Have you any quests for me?"
    await bot.continueDialogsUntilChoice();
    await bot.selectDialogOption(1); // "Have you any quests for me?"

    // Continue through dialog until choice "Sure, no problem."
    await bot.continueDialogsUntilChoice();
    await bot.selectDialogOption(1); // "Sure, no problem."

    // Continue through remaining dialog (varp set, talisman given)
    await bot.continueRemainingDialogs();

    // Verify: air_talisman received
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

    // ================================================================
    // Step 2: Sedridor (Wizards' Tower basement)
    // ================================================================
    bot.log('STATE', '=== Step 2: Sedridor ===');

    // Walk back to the south stairwell on level 1 (near 3205, 3209).
    // The south loc_1739 is at (3204, 3207); the north one is at (3204, 3229).
    // We must walk close to the south one so findNearbyLoc picks the right stairs.
    //
    // Level 1 has a wall at x=3207. The Duke's room is on the east side.
    // There are doors at (3207, 3214) and (3207, 3222) (angle=2, east wall).
    // We already opened the door at (3207, 3222). We can walk through there to go west.
    // Then walk south from the west corridor to the stairwell.
    await bot.walkToWithPathfinding(3206, 3218);
    await bot.walkToWithPathfinding(3206, 3210);

    // Climb the south staircase back down from level 1 to ground floor.
    // loc_1739 on level 1: op3=Climb-down. Player lands at (3205, 3209, level 0).
    await bot.climbStairs('loc_1739', 3);
    await bot.waitForTicks(2);

    if (bot.player.level !== 0) {
        throw new Error(`Failed to climb down to level 0: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    bot.log('STATE', `Back on ground floor: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Walk out of the stairwell room through the castle interior.
    // From (3205, 3209, 0) walk east/north through the south corridor,
    // then through the doors to exit the castle.
    await bot.walkToWithPathfinding(3215, 3210);
    await bot.openDoor('poordooropen');
    await bot.walkToWithPathfinding(3215, 3215);
    await bot.walkToWithPathfinding(3217, 3218);
    await bot.openDoor('openbankdoor_l');
    await bot.walkToWithPathfinding(LUMBRIDGE_SPAWN_X, LUMBRIDGE_SPAWN_Z);
    await bot.walkToWithPathfinding(WIZARD_TOWER_ENTRANCE_X, WIZARD_TOWER_ENTRANCE_Z);

    // Enter the tower and climb ladder down to basement
    await enterWizardTowerBasement(bot);

    // The basement has a circular layout:
    //   - Ladder drops at (3104, 9576) in the NE alcove
    //   - Inner room (Sedridor's area) is ~(3097-3107, 9569-9574)
    //   - A wall at x=3108 separates the inner room from the outer ring
    //   - Door: inaccastledoubledoorropen at (3108, 9570), shape=0 angle=0 (west wall)
    //   - Route: east to outer ring → south to door → open door → west into inner room
    await bot.walkToWithPathfinding(3108, 9575);
    await bot.walkToWithPathfinding(3108, 9571);
    bot.log('STATE', `Near basement door: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Open the inner room door
    await bot.openDoor('inaccastledoubledoorropen');

    // Walk west through the door into the inner room
    await bot.walkToWithPathfinding(3103, 9571);
    bot.log('STATE', `In inner room: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Talk to Sedridor (NPC name is "Sedridor")
    await bot.talkToNpc('Sedridor');

    // Welcome message → continue through to 3-option choice
    await bot.continueDialogsUntilChoice();
    // Multi3: "Nothing thanks..." (1), "What are you doing down here?" (2), "I'm looking for the head wizard." (3)
    await bot.selectDialogOption(3);

    // Continue through dialog until 2-option choice: "Ok, here you are." / "No..."
    await bot.continueDialogsUntilChoice();
    await bot.selectDialogOption(1);

    // Continue through mesbox + @head_wizard_incredible dialog until choice
    // "Yes, certainly." / "No, I'm busy."
    await bot.continueDialogsUntilChoice();
    await bot.selectDialogOption(1);

    // Continue through dialogs until Research package appears in inventory
    for (let i = 0; i < 30; i++) {
        const hasDialog = await bot.waitForDialog(10);
        if (!hasDialog) break;
        if (bot.isMultiChoiceOpen()) break;
        await bot.continueDialog();
        if (bot.findItem('Research package')) break;
    }

    // Continue remaining dialog pages (e.g. "Best of luck with your quest...")
    await bot.continueRemainingDialogs();

    // Verify
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

    // ================================================================
    // Step 3: Aubury (Varrock rune shop)
    // ================================================================
    bot.log('STATE', '=== Step 3: Aubury ===');

    // Climb the ladder back up from the basement to the surface
    await exitWizardTowerBasement(bot);

    // Walk north-east to Varrock (Aubury's rune shop).
    // The full route is ~230 tiles through Draynor Village, past Barbarian Village,
    // then east to Varrock. We use intermediate waypoints because fences, gates,
    // and rivers can block the pathfinder when aiming at a distant point directly.
    await bot.walkToWithPathfinding(3105, 3250); // North past Draynor Village
    await bot.walkToWithPathfinding(3082, 3336); // North-west to Barbarian Village area
    await bot.walkToWithPathfinding(3080, 3400); // North along west side of Varrock wall
    await bot.walkToWithPathfinding(3175, 3427); // East to Varrock west gate area
    await bot.walkToWithPathfinding(AUBURY_AREA_X, AUBURY_AREA_Z); // East to Aubury's rune shop

    // Talk to Aubury — first conversation to deliver the package
    await bot.talkToNpc('Aubury');

    // Continue through greeting to 3-option choice
    await bot.continueDialogsUntilChoice();
    // Multi3: "Yes please!" (1), "Oh, it's a rune shop..." (2), "I have been sent here with a package for you." (3)
    await bot.selectDialogOption(3);

    // Continue through remaining dialog (package delivery, mesbox, etc.)
    await bot.continueRemainingDialogs();
    await bot.waitForTicks(3);

    // Verify package was removed
    if (bot.findItem('Research package') !== null) {
        throw new Error('Research package should have been removed after delivery to Aubury');
    }
    const varpAfterAubury1 = bot.getQuestProgress(RUNE_MYSTERIES_VARP);
    if (varpAfterAubury1 !== STAGE_GIVEN_PACKAGE) {
        throw new Error(`Quest varp after Aubury delivery is ${varpAfterAubury1}, expected ${STAGE_GIVEN_PACKAGE}`);
    }
    bot.log('EVENT', `Delivered package to Aubury, varp=${varpAfterAubury1}`);

    // Second talk to Aubury to get research notes (varp=4 → given_package)
    await bot.talkToNpc('Aubury');

    // Continue through all dialog pages until done
    await bot.continueRemainingDialogs();

    // Verify
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

    // ================================================================
    // Step 4: Return to Sedridor (Wizards' Tower basement)
    // ================================================================
    bot.log('STATE', '=== Step 4: Return to Sedridor ===');

    // Walk south-west back to Wizards' Tower entrance (reverse of the route above)
    await bot.walkToWithPathfinding(3175, 3427); // West to Varrock west gate area
    await bot.walkToWithPathfinding(3080, 3400); // West past Varrock wall
    await bot.walkToWithPathfinding(3082, 3336); // South to Barbarian Village area
    await bot.walkToWithPathfinding(3105, 3250); // South past Draynor Village
    await bot.walkToWithPathfinding(WIZARD_TOWER_ENTRANCE_X, WIZARD_TOWER_ENTRANCE_Z);

    // Enter the tower and climb ladder down to basement (same as Step 2)
    await enterWizardTowerBasement(bot);

    // Navigate to Sedridor's inner room (same route as Step 2)
    await bot.walkToWithPathfinding(3108, 9575);
    await bot.walkToWithPathfinding(3108, 9571);
    await bot.openDoor('inaccastledoubledoorropen');
    await bot.walkToWithPathfinding(3103, 9571);
    bot.log('STATE', `In inner room: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Talk to Sedridor — hand over research notes, long lore dialog
    await bot.talkToNpc('Sedridor');

    // Continue through all dialog pages (welcome, lore explanation, mesbox handover)
    // This is a very long dialog (20+ pages), so use generous limits
    for (let i = 0; i < 50; i++) {
        const hasDialog = await bot.waitForDialog(10);
        if (!hasDialog) break;
        if (bot.isMultiChoiceOpen()) break;
        await bot.continueDialog();
    }

    // quest complete: inv_del research_notes, inv_add air_talisman, queue(rune_mysteries_complete)

    // Wait for the queued script to set varp to 6
    await bot.waitForTicks(5);

    // Dismiss any quest complete interface that might be open
    bot.dismissModals();

    // Verify quest completion
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
