import path from 'path';
import { BotAPI } from '../runtime/api.js';
import { skipTutorial } from './skip-tutorial.js';
import { type BotState, runStateMachine } from '../runtime/state-machine.js';
import type { ScriptMeta } from '../runtime/script-meta.js';

// Varp ID for The Restless Ghost quest progress (from content/pack/varp.pack: 107=prieststart)
const RESTLESS_GHOST_VARP = 107;

// Quest stages (from content/scripts/quests/quest_priest/configs/quest_priest.constant)
const STAGE_NOT_STARTED = 0;
const STAGE_STARTED = 1;
const STAGE_SPOKEN_URHNEY = 2;
const STAGE_SPOKEN_GHOST = 3;
const STAGE_OBTAINED_SKULL = 4;
const STAGE_COMPLETE = 5;

// ---- Key locations ----

// Lumbridge Church — Father Aereck is inside
const _CHURCH_X = 3243;
const _CHURCH_Z = 3210;

// Father Urhney's shack in Lumbridge Swamp (NPC 458 spawns at 3235, 3153)
// Access: go south-east from Lumbridge, through the swamp.
const URHNEY_SHACK_X = 3235;
const URHNEY_SHACK_Z = 3153;

// Lumbridge graveyard — coffin and ghost are here, south of the church
const GRAVEYARD_X = 3249;
const GRAVEYARD_Z = 3194;

// Wizard Tower entrance (ground level)
const WIZARD_TOWER_ENTRANCE_X = 3109;
const WIZARD_TOWER_ENTRANCE_Z = 3167;

// Ghost skull location in Wizard Tower basement (0_48_149_48_29)
// x = 48*64+48 = 3120, z = 149*64+29 = 9565
const _SKULL_AREA_X = 3120;
const _SKULL_AREA_Z = 9565;

/**
 * Walk to Lumbridge Church and enter it.
 * The church is east of Lumbridge Castle, with a door on the west side.
 */
async function walkToChurch(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Walking to Lumbridge Church ===');
    // The church entrance is on the west side — a 'desertdoorclosed' door at (3238, 3210).
    // Walk to just west of the door, open it, then walk inside.
    await bot.walkToWithPathfinding(3237, 3210); // west of church entrance
    bot.log('STATE', `Outside church west entrance: pos=(${bot.player.x},${bot.player.z})`);
    await bot.openDoor('desertdoorclosed');
    await bot.waitForTicks(1);
    // Walk just inside the church door — interactNpc will auto-walk to Aereck
    await bot.walkToWithPathfinding(3240, 3210);
    bot.log('STATE', `Inside church: pos=(${bot.player.x},${bot.player.z})`);
}

/**
 * Talk to Father Aereck to start the quest.
 *
 * Dialog flow (from content/scripts/areas/area_lumbridge/scripts/father_aereck.rs2):
 * 1. chatnpc "Welcome to the church of holy Saradomin."
 * 2. multi3: "Who's Saradomin?" (1), "Nice place you've got here." (2), "I'm looking for a quest!" (3)
 * 3. chatplayer "I'm looking for a quest."
 * 4. chatnpc "That's lucky, I need someone to do a quest for me."
 *    %prieststart = ^priest_started (varp set here)
 * 5. chatplayer "Ok, let me help then."
 * 6. chatnpc "Thank you. The problem is, there is a ghost..."
 * 7. chatnpc "If you need any help, my friend Father Urhney..."
 * 8. chatnpc "I believe he is currently living as a hermit..."
 * 9. chatnpc "My name is Father Aereck by the way. Pleased to meet you."
 * 10. chatplayer "Likewise."
 * 11. chatnpc "Take care travelling through the swamps..."
 * 12. chatplayer "I will, thanks."
 */
async function startQuestWithAereck(bot: BotAPI): Promise<void> {
    const aereck = bot.findNearbyNpc('Father Aereck', 20);
    if (!aereck) {
        throw new Error(`Father Aereck not found near (${bot.player.x},${bot.player.z})`);
    }
    bot.log('STATE', `Found Father Aereck at (${aereck.x},${aereck.z})`);

    await bot.interactNpc(aereck, 1); // op1 = Talk-to
    const dialogOpened = await bot.waitForDialog(30);
    if (!dialogOpened) {
        throw new Error(`No dialog opened when talking to Father Aereck at (${aereck.x},${aereck.z})`);
    }

    // 1. chatnpc "Welcome to the church of holy Saradomin." -> multi3
    await bot.continueDialog();

    // 2. multi3: select "I'm looking for a quest!" (option 3)
    await bot.waitForDialog(10);
    await bot.selectDialogOption(3);

    // 3. chatplayer "I'm looking for a quest." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 4. chatnpc "That's lucky, I need someone to do a quest for me." -> continue
    // varp is set to 1 here
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 5. chatplayer "Ok, let me help then." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 6. chatnpc "Thank you. The problem is, there is a ghost..." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 7. chatnpc "If you need any help, my friend Father Urhney..." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 8. chatnpc "I believe he is currently living as a hermit..." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 9. chatnpc "My name is Father Aereck by the way." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 10. chatplayer "Likewise." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 11. chatnpc "Take care travelling through the swamps..." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 12. chatplayer "I will, thanks." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    await bot.waitForTicks(2);
}

/**
 * Walk to Father Urhney's shack in the Lumbridge Swamp.
 * Route: from Lumbridge, go south past the castle, through the swamp.
 */
async function walkToUrhney(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Walking to Father Urhney ===');

    // Exit church (west door may have auto-closed)
    await bot.openDoor('desertdoorclosed');
    await bot.waitForTicks(1);
    await bot.walkToWithPathfinding(3237, 3210); // west of church, outside
    await bot.walkToWithPathfinding(3222, 3218); // Lumbridge spawn
    // Go south past the castle (east side is clear), then west, then south to swamp
    await bot.walkToWithPathfinding(3222, 3200); // south past castle on east side
    await bot.walkToWithPathfinding(3205, 3200); // west, south of castle walls
    await bot.walkToWithPathfinding(3205, 3175); // south into the swamp
    await bot.walkToWithPathfinding(3220, 3160); // southeast through swamp
    // Target outside the shack (south wall is at ~z=3151), not inside where Urhney stands
    await bot.walkToWithPathfinding(URHNEY_SHACK_X, URHNEY_SHACK_Z - 3);

    bot.log('STATE', `At Urhney's shack: pos=(${bot.player.x},${bot.player.z})`);
}

/**
 * Talk to Father Urhney to get the Amulet of Ghostspeak.
 *
 * Dialog flow (from content/scripts/areas/area_lumbridge/scripts/father_urhney.rs2):
 * 1. chatnpc "Go away! I'm meditating!"
 * 2. multi3 (when varp=1): "Well, that's friendly." (1),
 *    "Father Aereck sent me to talk to you." (2),
 *    "I've come to repossess your house." (3)
 * 3. chatplayer "Father Aereck sent me to talk to you."
 * 4. chatnpc "I suppose I'd better talk to you then..."
 * 5. multi2: "He's got a ghost haunting his graveyard." (1),
 *    "You mean he gets himself into lots of problems?" (2)
 * 6. chatplayer "He's got a ghost haunting his graveyard."
 * 7. chatnpc "Oh, the silly fool."
 * 8. chatnpc "I leave town for just five months..."
 * 9. chatnpc "(sigh)"
 * 10. chatnpc "Well, I can't go back and exorcise it..."
 * 11. chatnpc "Tell you what I can do though; take this amulet."
 *     %prieststart = ^priest_spoken_urhney (varp set here)
 *     inv_add(inv, amulet_of_ghostspeak, 1)
 * 12. mesbox "Father Urhney hands you an amulet."
 * 13. chatnpc "It is an Amulet of Ghostspeak."
 * 14. chatnpc "So called, because when you wear it..."
 * 15. chatnpc "Maybe if you know what this task is..."
 * 16. chatplayer "Thank you. I'll give it a try!"
 */
async function talkToUrhney(bot: BotAPI): Promise<void> {
    // Debug: find doors near Urhney's shack
    const nearbyLocs = bot.findAllNearbyLocs(15);
    const doorLocs = nearbyLocs.filter(l => l.debugname.toLowerCase().includes('door'));
    bot.log('STATE', `Nearby door locs: ${JSON.stringify(doorLocs.map(l => ({ name: l.debugname, x: l.x, z: l.z })))}`);

    // Open the door to Urhney's shack — try common door types
    for (const dl of doorLocs) {
        await bot.openDoor(dl.debugname);
    }
    await bot.waitForTicks(1);

    const urhney = bot.findNearbyNpc('Father Urhney', 20);
    if (!urhney) {
        throw new Error(`Father Urhney not found near (${bot.player.x},${bot.player.z})`);
    }
    bot.log('STATE', `Found Father Urhney at (${urhney.x},${urhney.z})`);

    await bot.interactNpc(urhney, 1); // op1 = Talk-to
    const dialogOpened = await bot.waitForDialog(30);
    if (!dialogOpened) {
        throw new Error(`No dialog opened when talking to Father Urhney at (${urhney.x},${urhney.z})`);
    }

    // 1. chatnpc "Go away! I'm meditating!" -> multi3
    await bot.continueDialog();

    // 2. multi3: select "Father Aereck sent me to talk to you." (option 2)
    await bot.waitForDialog(10);
    await bot.selectDialogOption(2);

    // 3. chatplayer "Father Aereck sent me to talk to you." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 4. chatnpc "I suppose I'd better talk to you then..." -> multi2
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 5. multi2: select "He's got a ghost haunting his graveyard." (option 1)
    await bot.waitForDialog(10);
    await bot.selectDialogOption(1);

    // 6. chatplayer "He's got a ghost haunting his graveyard." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 7. chatnpc "Oh, the silly fool." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 8. chatnpc "I leave town for just five months..." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 9. chatnpc "(sigh)" -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 10. chatnpc "Well, I can't go back and exorcise it..." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 11. chatnpc "Tell you what I can do though; take this amulet." -> continue
    // varp set to 2, amulet added to inventory
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 12. mesbox "Father Urhney hands you an amulet." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 13. chatnpc "It is an Amulet of Ghostspeak." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 14. chatnpc "So called, because when you wear it..." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 15. chatnpc "Maybe if you know what this task is..." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 16. chatplayer "Thank you. I'll give it a try!" -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    await bot.waitForTicks(2);
}

/**
 * Walk to the Lumbridge graveyard and interact with the ghost's coffin.
 * The graveyard is south of the Lumbridge church.
 */
async function walkToGraveyard(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Walking to Lumbridge graveyard ===');
    // Walk to just north of the graveyard gate at (3247,3193)
    await bot.walkToWithPathfinding(3247, 3196);
    // Open the graveyard gate (inaccastledoubledoorropen at (3247,3193))
    await bot.openDoor('inaccastledoubledoorropen');
    await bot.waitForTicks(1);
    // Walk into the graveyard
    await bot.walkToWithPathfinding(GRAVEYARD_X, GRAVEYARD_Z);
    bot.log('STATE', `At graveyard: pos=(${bot.player.x},${bot.player.z})`);
}

/**
 * Open the coffin to spawn the ghost, then talk to the ghost.
 *
 * Ghost dialog flow (from content/scripts/quests/quest_priest/scripts/restless_ghost.rs2):
 * When varp = priest_spoken_urhney (2) and wearing amulet:
 * 1. chatplayer "Hello ghost, how are you?"
 * 2. chatnpc "Not very good actually."
 * 3. chatplayer "What's the problem then?"
 * 4. chatnpc "Did you just understand what I said???"
 * 5. multi3: "Yep, now tell me what the problem is." (1),
 *    "No, you sound like..." (2), "Wow, this amulet works!" (3)
 * 6. chatplayer "Yep, now tell me what the problem is."
 * 7. chatnpc "WOW! This is INCREDIBLE!..."
 * 8. chatplayer "Ok, Ok, I can understand you!"
 * 9. chatplayer "But have you any idea WHY you're doomed to be a ghost?"
 * 10. chatnpc "Well, to be honest... I'm not sure."
 * 11. -> @priest_ghost_certain_task:
 *     chatplayer "I've been told a certain task may need to be completed..."
 * 12. chatnpc "I should think it is probably because a warlock has come along and stolen my skull..."
 * 13. chatplayer "Do you know where this warlock might be now?"
 * 14. chatnpc "I think it was one of the warlocks who lives in the big tower..."
 * 15. chatplayer "Ok. I will try and get the skull back for you..."
 * 16. chatnpc "Ooh, thank you. That would be such a great relief!"
 *     %prieststart = ^priest_spoken_ghost (varp set to 3 here)
 * 17. chatnpc "It is so dull being a ghost..."
 */
async function openCoffinAndTalkToGhost(bot: BotAPI): Promise<void> {
    // Find and open the coffin
    const coffin = bot.findNearbyLoc('shutghostcoffin', 20);
    if (!coffin) {
        throw new Error(`Coffin (shutghostcoffin) not found near (${bot.player.x},${bot.player.z})`);
    }
    bot.log('STATE', `Found coffin at (${coffin.x},${coffin.z})`);

    // Open the coffin (op1 = Open) — this spawns the ghost
    await bot.interactLoc(coffin, 1);
    await bot.waitForTicks(3);

    // Find and talk to the Restless Ghost
    const ghost = bot.findNearbyNpc('Restless ghost', 20);
    if (!ghost) {
        throw new Error(`Restless ghost not found near (${bot.player.x},${bot.player.z}) after opening coffin`);
    }
    bot.log('STATE', `Found Restless ghost at (${ghost.x},${ghost.z})`);

    await bot.interactNpc(ghost, 1); // op1 = Talk-to
    const dialogOpened = await bot.waitForDialog(30);
    if (!dialogOpened) {
        throw new Error(`No dialog opened when talking to Restless ghost at (${ghost.x},${ghost.z})`);
    }

    // 1. chatplayer "Hello ghost, how are you?" -> continue
    await bot.continueDialog();

    // 2. chatnpc "Not very good actually." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 3. chatplayer "What's the problem then?" -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 4. chatnpc "Did you just understand what I said???" -> multi3
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 5. multi3: select "Yep, now tell me what the problem is." (option 1)
    await bot.waitForDialog(10);
    await bot.selectDialogOption(1);

    // 6. chatplayer "Yep, now tell me what the problem is." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 7. chatnpc "WOW! This is INCREDIBLE!..." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 8. chatplayer "Ok, Ok, I can understand you!" -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 9. chatplayer "But have you any idea WHY you're doomed to be a ghost?" -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 10. chatnpc "Well, to be honest... I'm not sure." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 11. chatplayer "I've been told a certain task may need to be completed..." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 12. chatnpc "I should think it is probably because a warlock has come along..." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 13. chatplayer "Do you know where this warlock might be now?" -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 14. chatnpc "I think it was one of the warlocks who lives in the big tower..." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 15. chatplayer "Ok. I will try and get the skull back for you..." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 16. chatnpc "Ooh, thank you. That would be such a great relief!" -> continue
    // varp set to 3 here
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 17. chatnpc "It is so dull being a ghost..." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    await bot.waitForTicks(2);
}

/**
 * Navigate into the Wizard Tower and down to the basement where the skull is.
 *
 * The Wizard Tower:
 * - Ground floor entrance doors
 * - Ladder down: loc wizards_tower_laddertop at approximately (3104, 3162) on level 0
 *   -> teleports to basement at (3104, 9576)
 */
async function enterWizardTowerBasement(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Entering Wizard Tower basement ===');

    // Walk to the tower entrance area
    await bot.walkToWithPathfinding(WIZARD_TOWER_ENTRANCE_X, WIZARD_TOWER_ENTRANCE_Z);
    bot.log('STATE', `At Wizard Tower entrance: pos=(${bot.player.x},${bot.player.z})`);

    // Open the entrance door
    await bot.openDoor('poordooropen');

    // Walk into the outer ring, toward the inner door
    await bot.walkToWithPathfinding(3108, 3163);

    // Open the inner door
    await bot.openDoor('poordooropen');

    // Walk to the ladder area
    await bot.walkToWithPathfinding(3104, 3161);
    bot.log('STATE', `Near basement ladder: pos=(${bot.player.x},${bot.player.z})`);

    // Use the ladder down (wizards_tower_laddertop, op1 = Climb-down)
    // climbStairs handles waiting for the teleport to the basement
    await bot.climbStairs('wizards_tower_laddertop', 1);
    await bot.waitForTicks(2);

    // Verify we're in the basement (z should be ~9576, level should still be 0)
    if (bot.player.z < 9000) {
        throw new Error(`Failed to descend to Wizard Tower basement: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    bot.log('STATE', `In Wizard Tower basement: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
}

/**
 * Find and pick up the ghost skull in the Wizard Tower basement.
 * Picking it up triggers a skeleton spawn. The skeleton is level 13 but we
 * don't need to fight it — we can just pick up the skull and leave.
 * The skull pickup is handled by the [opobj3,ghostskull] trigger which:
 * 1. Sets %prieststart = ^priest_obtained_skull (4)
 * 2. Spawns a skeleton
 * 3. Calls @pickup_obj to add the skull to inventory
 */
async function getGhostSkull(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Getting ghost skull ===');

    // Debug: find doors/walls in the basement to navigate properly
    const nearbyLocs = bot.findAllNearbyLocs(25);
    const doorLocs = nearbyLocs.filter(l =>
        l.debugname.toLowerCase().includes('door') ||
        l.debugname.toLowerCase().includes('gate')
    );
    bot.log('STATE', `Basement doors: ${JSON.stringify(doorLocs.map(l => ({ name: l.debugname, x: l.x, z: l.z })))}`);

    // Basement layout: two doors on a N-S wall at x≈3111
    // Door 1 at (3108,9570) — opens passage from ladder area
    // Door 2 at (3111,9559) — opens passage to skull room (east side)
    await bot.walkToWithPathfinding(3108, 9571); // near door 1
    await bot.openDoor('inaccastledoubledoorropen'); // open door 1
    await bot.waitForTicks(1);
    await bot.walkToWithPathfinding(3110, 9560); // south along west side of wall
    await bot.openDoor('inaccastledoubledoorropen'); // open door 2 at (3111,9559)
    await bot.waitForTicks(1);
    await bot.walkToWithPathfinding(3115, 9560); // through door 2, east side
    // Stay WEST of x=3120 to avoid getting trapped by the skeleton that spawns at (3120,9565)
    await bot.walkToWithPathfinding(3118, 9565);
    bot.log('STATE', `Near skull area: pos=(${bot.player.x},${bot.player.z})`);

    // Disable auto-retaliate before skull pickup — skeleton spawns and attacks on pickup,
    // and auto-retaliate would override our movement waypoints
    await bot.pressButton('controls:com_3'); // auto-retaliate OFF

    // Find the skull on the ground
    const skull = bot.findNearbyGroundItem('Skull', 16);
    if (!skull) {
        throw new Error(`Ghost skull not found on ground near (${bot.player.x},${bot.player.z})`);
    }
    bot.log('STATE', `Found skull on ground at (${skull.x},${skull.z})`);

    // Pick up the skull — this triggers skeleton spawn + varp change
    await bot.takeGroundItem('Skull', skull.x, skull.z);
    await bot.waitForTicks(3);

    // Verify we got the skull
    const skullInInv = bot.findItem('Skull');
    if (!skullInInv) {
        throw new Error('Skull not in inventory after pickup');
    }
    bot.log('EVENT', `Picked up ghost skull (id=${skullInInv.id})`);
}

/**
 * Climb back up from the Wizard Tower basement to ground floor and exit.
 */
async function exitWizardTowerBasement(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Exiting Wizard Tower basement ===');

    // After skull pickup, skeleton spawns at (3120,9565) and doors may have auto-closed.
    // Use walkTo (direct waypoint, NO pathfinder) to avoid the sealed-room boundary escape.
    // The engine walks step-by-step with canTravel; the skeleton won't block diagonal movement.
    bot.log('STATE', `After skull pickup: pos=(${bot.player.x},${bot.player.z})`);

    // Step 1: Walk to east side of door 2 at z=9559 (same room, no walls)
    await bot.walkTo(3112, 9559);
    bot.log('STATE', `Near door 2 (east): pos=(${bot.player.x},${bot.player.z})`);

    // Step 2: Open door 2 (door script teleports player through) then walk west
    await bot.openDoor('inaccastledoubledoorropen');
    await bot.waitForTicks(1);
    bot.log('STATE', `After door 2 open: pos=(${bot.player.x},${bot.player.z})`);

    // Step 3: Navigate west side to door 1 using pathfinding (west side is connected)
    await bot.walkToWithPathfinding(3108, 9571);
    bot.log('STATE', `Near door 1 (south): pos=(${bot.player.x},${bot.player.z})`);

    // Step 4: Open door 1 (door script teleports player through)
    await bot.openDoor('inaccastledoubledoorropen');
    await bot.waitForTicks(1);
    bot.log('STATE', `After door 1 open: pos=(${bot.player.x},${bot.player.z})`);

    // Step 5: Walk to the ladder (north side, pathfinding)
    await bot.walkToWithPathfinding(3104, 9576);

    // Use the ladder up (wizards_tower_ladder, op1 = Climb-up)
    await bot.climbStairs('wizards_tower_ladder', 1);
    await bot.waitForTicks(2);

    // Verify we're back on the ground floor
    if (bot.player.z > 9000) {
        throw new Error(`Failed to climb out of Wizard Tower basement: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    bot.log('STATE', `Back on ground floor: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Walk out through the doors
    await bot.walkToWithPathfinding(3108, 3163);
    await bot.openDoor('poordooropen');
    await bot.walkToWithPathfinding(3109, 3167);
    await bot.openDoor('poordooropen');
    await bot.walkToWithPathfinding(3109, 3169);
    bot.log('STATE', `Exited Wizard Tower: pos=(${bot.player.x},${bot.player.z})`);
}

/**
 * Return to the graveyard, open the coffin, and use the skull on it
 * to complete the quest.
 *
 * From quest_priest.rs2 [oplocu,restless_ghost_altar]:
 * - Uses skull on the open coffin (restless_ghost_altar)
 * - Removes skull from inventory
 * - Deletes the ghost NPC
 * - Queues priest_quest_complete which sets varp to 5
 * - mesbox "You put the skull in the coffin."
 * - mesbox "The ghost vanishes."
 * - mesbox "You think you hear a faint voice on the wind..."
 */
async function returnSkullToCoffin(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Returning skull to coffin ===');

    // Walk back to Lumbridge first
    await bot.walkToWithPathfinding(3222, 3218);

    // Walk to the graveyard
    await walkToGraveyard(bot);

    // The coffin might be closed (shutghostcoffin) — need to open it first
    const closedCoffin = bot.findNearbyLoc('shutghostcoffin', 20);
    if (closedCoffin) {
        bot.log('STATE', `Opening coffin at (${closedCoffin.x},${closedCoffin.z})`);
        await bot.interactLoc(closedCoffin, 1); // op1 = Open
        await bot.waitForTicks(3);
    }

    // Now use the skull on the open coffin (restless_ghost_altar)
    // useItemOnLoc finds the loc by debugname and uses the item on it
    await bot.useItemOnLoc('Skull', 'restless_ghost_altar');
    await bot.waitForTicks(3);

    // Continue through the mesbox dialogs:
    // 1. mesbox "You put the skull in the coffin."
    // 2. mesbox "The ghost vanishes."
    // 3. mesbox "You think you hear a faint voice on the wind..."
    for (let i = 0; i < 5; i++) {
        const hasDialog = await bot.waitForDialog(10);
        if (!hasDialog) break;
        await bot.continueDialog();
    }

    // Wait for the queued priest_quest_complete to fire
    await bot.waitForTicks(5);
    bot.dismissModals();
}

/**
 * Build the Restless Ghost state machine.
 * States: talk-to-aereck, get-ghostspeak-amulet, talk-to-ghost, find-skull, return-skull
 */
export function buildRestlessGhostStates(bot: BotAPI): BotState {
    return {
        name: 'restless-ghost',
        isComplete: () => bot.getQuestProgress(RESTLESS_GHOST_VARP) === STAGE_COMPLETE,
        run: async () => { throw new Error('Composite state should not be called directly'); },
        children: [
            {
                name: 'talk-to-aereck',
                isComplete: () => bot.getQuestProgress(RESTLESS_GHOST_VARP) >= STAGE_STARTED,
                run: async () => {
                    await walkToChurch(bot);
                    await startQuestWithAereck(bot);

                    const varpAfterStart = bot.getQuestProgress(RESTLESS_GHOST_VARP);
                    if (varpAfterStart !== STAGE_STARTED) {
                        throw new Error(`Quest varp after starting is ${varpAfterStart}, expected ${STAGE_STARTED}`);
                    }
                    bot.log('EVENT', `Quest started! varp=${varpAfterStart}`);
                }
            },
            {
                name: 'get-ghostspeak-amulet',
                isComplete: () => bot.getQuestProgress(RESTLESS_GHOST_VARP) >= STAGE_SPOKEN_URHNEY,
                run: async () => {
                    await walkToUrhney(bot);
                    await talkToUrhney(bot);

                    const varpAfterUrhney = bot.getQuestProgress(RESTLESS_GHOST_VARP);
                    if (varpAfterUrhney !== STAGE_SPOKEN_URHNEY) {
                        throw new Error(`Quest varp after Urhney is ${varpAfterUrhney}, expected ${STAGE_SPOKEN_URHNEY}`);
                    }

                    const amulet = bot.findItem('Ghostspeak amulet');
                    if (!amulet) {
                        throw new Error('Ghostspeak amulet not in inventory after talking to Father Urhney');
                    }
                    bot.log('EVENT', `Got Ghostspeak amulet! varp=${varpAfterUrhney}`);
                }
            },
            {
                name: 'talk-to-ghost',
                isComplete: () => bot.getQuestProgress(RESTLESS_GHOST_VARP) >= STAGE_SPOKEN_GHOST,
                run: async () => {
                    // Equip the Ghostspeak amulet
                    await bot.equipItem('Ghostspeak amulet');
                    await bot.waitForTicks(1);
                    bot.log('EVENT', 'Ghostspeak amulet equipped');

                    // Walk back to Lumbridge from the swamp
                    await bot.walkToWithPathfinding(3220, 3160);
                    await bot.walkToWithPathfinding(3205, 3175);
                    await bot.walkToWithPathfinding(3205, 3200);
                    await bot.walkToWithPathfinding(3222, 3200);
                    await bot.walkToWithPathfinding(3222, 3218);
                    await walkToGraveyard(bot);

                    // Open the coffin and talk to the ghost
                    await openCoffinAndTalkToGhost(bot);

                    const varpAfterGhost = bot.getQuestProgress(RESTLESS_GHOST_VARP);
                    if (varpAfterGhost !== STAGE_SPOKEN_GHOST) {
                        throw new Error(`Quest varp after ghost is ${varpAfterGhost}, expected ${STAGE_SPOKEN_GHOST}`);
                    }
                    bot.log('EVENT', `Spoke to ghost! varp=${varpAfterGhost}`);
                }
            },
            {
                name: 'find-skull',
                isComplete: () => bot.getQuestProgress(RESTLESS_GHOST_VARP) >= STAGE_OBTAINED_SKULL,
                run: async () => {
                    // Walk to Lumbridge first for reliable pathfinding
                    await bot.walkToWithPathfinding(3222, 3218);

                    // Enter the Wizard Tower and go to the basement
                    await enterWizardTowerBasement(bot);

                    // Pick up the skull
                    await getGhostSkull(bot);

                    const varpAfterSkull = bot.getQuestProgress(RESTLESS_GHOST_VARP);
                    if (varpAfterSkull !== STAGE_OBTAINED_SKULL) {
                        throw new Error(`Quest varp after skull is ${varpAfterSkull}, expected ${STAGE_OBTAINED_SKULL}`);
                    }
                    bot.log('EVENT', `Got ghost skull! varp=${varpAfterSkull}`);
                }
            },
            {
                name: 'return-skull',
                isComplete: () => bot.getQuestProgress(RESTLESS_GHOST_VARP) === STAGE_COMPLETE,
                run: async () => {
                    // Exit the Wizard Tower basement
                    await exitWizardTowerBasement(bot);

                    // Return to the graveyard and use skull on coffin
                    await returnSkullToCoffin(bot);

                    await bot.waitForTicks(5);
                    bot.dismissModals();

                    const finalVarp = bot.getQuestProgress(RESTLESS_GHOST_VARP);
                    const prayerSkill = bot.getSkill('Prayer');

                    if (finalVarp !== STAGE_COMPLETE) {
                        throw new Error(`Quest not complete: varp is ${finalVarp}, expected ${STAGE_COMPLETE}`);
                    }
                    if (prayerSkill.exp <= 0) {
                        throw new Error('No prayer XP gained during quest');
                    }

                    bot.log('SUCCESS', `The Restless Ghost quest complete! varp=${finalVarp}, prayer_xp=${prayerSkill.exp}`);
                }
            }
        ]
    };
}

export async function restlessGhost(bot: BotAPI): Promise<void> {
    // === Setup: skip tutorial, start in Lumbridge ===
    await skipTutorial(bot);
    await bot.waitForTicks(2);

    bot.log('STATE', `Starting The Restless Ghost quest at (${bot.player.x},${bot.player.z},${bot.player.level})`);

    const initialVarp = bot.getQuestProgress(RESTLESS_GHOST_VARP);
    if (initialVarp !== STAGE_NOT_STARTED) {
        throw new Error(`Quest varp is ${initialVarp}, expected ${STAGE_NOT_STARTED} (not started)`);
    }

    const root = buildRestlessGhostStates(bot);
    const snapshotDir = path.resolve(import.meta.dir, '..', 'test', 'snapshots');
    await runStateMachine(bot, { root, varpIds: [RESTLESS_GHOST_VARP], captureSnapshots: true, snapshotDir });
}

export const metadata: ScriptMeta = {
    name: 'restlessghost',
    type: 'quest',
    varpId: RESTLESS_GHOST_VARP,
    varpComplete: STAGE_COMPLETE,
    maxTicks: 20000,
    run: restlessGhost,
    buildStates: buildRestlessGhostStates,
};
