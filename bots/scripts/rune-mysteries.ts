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

    // Dialog: "Greetings. Welcome to my castle." → continue
    await bot.waitForDialog(15);
    await bot.continueDialog();

    // Multi2: "Have you any quests for me?" (option 1), "Where can I find money?" (option 2)
    await bot.waitForDialog(10);
    await bot.selectDialogOption(1); // "Have you any quests for me?"

    // chatplayer "Have you any quests for me?" → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Well, it's not really a quest..." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "It seems to be mystical..." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "the Wizards' Tower for me?..." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // Multi2: "Sure, no problem." (option 1), "Not right now." (option 2)
    await bot.waitForDialog(10);
    await bot.selectDialogOption(1); // "Sure, no problem."

    // chatplayer "Sure, no problem." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // varp 0→1 happens here

    // chatnpc "Thank you very much..." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // mesbox "The Duke hands you an air talisman." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

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

    // chatnpc "Welcome adventurer, to the world renowned Wizards' Tower..." → continue
    await bot.waitForDialog(30);
    await bot.continueDialog();

    // Since varp=1 (started), goes to @rune_mysteries label
    // Multi3: "Nothing thanks..." (1), "What are you doing down here?" (2), "I'm looking for the head wizard." (3)
    await bot.waitForDialog(10);
    await bot.selectDialogOption(3); // "I'm looking for the head wizard."

    // chatplayer "I'm looking for the head wizard." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Oh you are, are you?..." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatplayer "The Duke of Lumbridge sent me..." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Did he now? HmmmMMMMMmmmmm..." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // Multi2: "Ok, here you are." (1), "No, I'll only give it to the head wizard." (2)
    await bot.waitForDialog(10);
    await bot.selectDialogOption(1); // "Ok, here you are."

    // chatplayer "Ok, here you are." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // inv_del air_talisman, varp → 2
    // mesbox "You hand the Talisman to the wizard." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // @head_wizard_incredible: many chatnpc pages
    // chatnpc "Wow! This is... incredible!" → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Th-this talisman you brought me...!" → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "I need time to study this..." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "is located North East of here..." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "require somebody to take them..." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "and if my suspicions are correct..." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "original Wizards' Tower... I cannot believe the answer..." → continue
    // (lines 118 in RS2: pipe-separated text, single chatnpc call)
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Do this thing for me..." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // Multi2: "Yes, certainly." (1), "No, I'm busy." (2)
    await bot.waitForDialog(10);
    await bot.selectDialogOption(1); // "Yes, certainly."

    // chatplayer "Yes, certainly." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Take this package..." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Once in Varrock..." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "as Varrock can be a confusing place..." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // mesbox "The head wizard gives you a package." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // varp → 3, research_package added

    // chatnpc "Best of luck with your quest..." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

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

    // chatnpc "Do you want to buy some runes?" → continue
    await bot.waitForDialog(15);
    await bot.continueDialog();

    // Multi3: "Yes please!" (1), "Oh, it's a rune shop..." (2), "I have been sent here with a package for you." (3)
    await bot.waitForDialog(10);
    await bot.selectDialogOption(3); // "I have been sent here with a package for you."

    // chatplayer "I have been sent here with a package for you..." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Really? But... surely..." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // mesbox "You hand Aubury the research package." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // inv_del research_package, varp → 4

    // chatnpc "This... is incredible..." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // Script ends. Now we need to talk again to get research_notes.
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

    // chatnpc × 3 pages: "My gratitude to you adventurer..." → continue each
    await bot.waitForDialog(15);
    await bot.continueDialog();

    await bot.waitForDialog(10);
    await bot.continueDialog();

    await bot.waitForDialog(10);
    await bot.continueDialog();

    // varp → 5, research_notes added

    // mesbox "Aubury gives you his research notes." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

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

    // Talk to Sedridor
    await bot.talkToNpc('Sedridor');

    // chatnpc "Welcome adventurer..." greeting → continue
    await bot.waitForDialog(15);
    await bot.continueDialog();

    // varp=5 (received_notes) → goes to @head_wizard_notes
    // chatnpc "Ah, <name>. How goes your quest?..." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatplayer "Yes, I have. He gave me some research notes..." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "May I have his notes then?" → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatplayer "Sure. I have them here." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // Long series of chatnpc pages explaining the lore
    // chatnpc "Well, before you hand them over to me..." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Now as you may or may not know..." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "When this Tower was burnt down..." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "I came upon a scroll..." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "This rock was called the 'Rune Essence'..." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "elemental altars that were scattered..." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "or these elemental altars... Aubury discovered in a standard delivery..." → continue
    // (RS2 line 160: pipe-separated text, single chatnpc call)
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "teleportation spell that he had never come across..." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "As I'm sure you have now guessed..." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "for if we could but find the elemental altars..." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatplayer "I'm still not sure how I fit into..." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "You haven't guessed? This talisman..." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "the entrance to the long forgotten Air Altar!..." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "And this is not all!..." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "just as our ancestors did!..." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "I will keep the teleport skill..." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "This means that if any evil power..." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "tragedy befalling this world. I know not where the temples..." → continue
    // (RS2 line 171: pipe-separated text, single chatnpc call)
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "return your Air Talisman to you..." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "you wish to visit the Rune Essence..." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatplayer "So only you and Aubury know..." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "No... there are others..." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Use the Air Talisman to locate..." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // mesbox "You hand the head wizard the research notes. He hands you back the Air Talisman." → continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

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
