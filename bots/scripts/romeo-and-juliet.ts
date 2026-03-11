import { BotAPI } from '../runtime/api.js';
import { skipTutorial } from './skip-tutorial.js';

// Varp ID for Romeo & Juliet quest progress (from content/pack/varp.pack: 144=rjquest)
const RJQUEST_VARP = 144;

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

// ---- Varrock route waypoints (from Lumbridge) ----
// Proven route from rune-mysteries.ts: Lumbridge -> Draynor -> Barbarian Village -> Varrock
const VARROCK_ROUTE = [
    { x: 3105, z: 3250, name: 'North past Draynor Village' },
    { x: 3082, z: 3336, name: 'North-west to Barbarian Village area' },
    { x: 3080, z: 3400, name: 'North along west side of Varrock wall' },
    { x: 3175, z: 3427, name: 'East to Varrock west gate area' },
];

/**
 * Walk from Lumbridge to the Varrock area using intermediate waypoints.
 * Fences, gates, and rivers can block the pathfinder when aiming directly.
 */
async function walkLumbridgeToVarrock(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Walking from Lumbridge to Varrock ===');
    for (const wp of VARROCK_ROUTE) {
        bot.log('STATE', `Walking to ${wp.name} (${wp.x},${wp.z})`);
        await bot.walkToWithPathfinding(wp.x, wp.z);
    }
    bot.log('STATE', `Arrived in Varrock: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
}

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

export async function romeoAndJuliet(bot: BotAPI): Promise<void> {
    // === Setup: skip tutorial, start in Lumbridge ===
    await skipTutorial(bot);
    await bot.waitForTicks(2);

    bot.log('STATE', `Starting Romeo & Juliet quest at (${bot.player.x},${bot.player.z},${bot.player.level})`);

    const initialVarp = bot.getQuestProgress(RJQUEST_VARP);
    if (initialVarp !== STAGE_NOT_STARTED) {
        throw new Error(`Quest varp is ${initialVarp}, expected ${STAGE_NOT_STARTED} (not started)`);
    }

    // ================================================================
    // Step 1: Walk from Lumbridge to Varrock and talk to Romeo
    // ================================================================
    bot.log('STATE', '=== Step 1: Talk to Romeo ===');

    await walkLumbridgeToVarrock(bot);

    // Walk to Romeo in Varrock square
    await bot.walkToWithPathfinding(ROMEO_AREA_X, ROMEO_AREA_Z);

    // Talk to Romeo
    await bot.talkToNpc('Romeo');

    // Dialog flow (from content/scripts/areas/area_varrock/scripts/romeo.rs2):
    // chatnpc "Juliet, Juliet, Juliet! Wherefore Art thou?" -> continue
    await bot.waitForDialog(15);
    await bot.continueDialog();

    // chatnpc "Kind friend, have you seen Juliet?" -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "She's disappeared and I can't find her anywhere." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // multi3: "Yes, I have seen her." (1), "No, but that's girls for you." (2), "Can I help find her for you?" (3)
    await bot.waitForDialog(10);
    await bot.selectDialogOption(3); // "Can I help find her for you?"

    // chatplayer "Can I help find her for you?" -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Oh would you? That would be wonderful!" -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Please tell her I long to be with her." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // Goes to @romeo_tell_her (no choice needed with option 3)
    // chatplayer "Yes, I will tell her how you feel." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "You are the saviour of my heart, thank you." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatplayer "Err, yes. Ok. Thats.... Nice." -> continue
    // varp set to 10 (spoken_romeo) here
    await bot.waitForDialog(10);
    await bot.continueDialog();

    await bot.waitForTicks(2);

    // Verify
    const varpAfterRomeo = bot.getQuestProgress(RJQUEST_VARP);
    if (varpAfterRomeo !== STAGE_SPOKEN_ROMEO) {
        throw new Error(`Quest varp after Romeo is ${varpAfterRomeo}, expected ${STAGE_SPOKEN_ROMEO}`);
    }
    bot.log('EVENT', `Step 1 complete: spoken to Romeo, varp=${varpAfterRomeo}`);

    // ================================================================
    // Step 2: Talk to Juliet (upstairs in house west of Varrock)
    // ================================================================
    bot.log('STATE', '=== Step 2: Talk to Juliet ===');

    // Juliet's house is west of Varrock, surrounded by buildings on all sides.
    // Approach from the north-east: go north past the fencing (gap at x>=3216),
    // then west past the buildings, south to the door on the north side.
    await bot.walkToWithPathfinding(3218, 3450); // north past garden fencing gap
    await bot.walkToWithPathfinding(3165, 3445); // west past eastern buildings
    await bot.walkToWithPathfinding(3165, 3440); // south to door level

    // Climb stairs to reach Juliet on level 1
    await climbToJuliet(bot);

    // Talk to Juliet
    await bot.talkToNpc('Juliet');

    // Dialog flow for varp=spoken_romeo (from juliet.rs2 @juliet_from_romeo):
    // chatplayer "Juliet, I come from Romeo." -> continue
    await bot.waitForDialog(15);
    await bot.continueDialog();

    // chatplayer "He begs I tell you he cares still." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Please, take this message to him." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // Goes to @juliet_agree_message:
    // chatplayer "Certainly, I will deliver your message straight away." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "It may be our only hope." -> continue
    // inv_add julietmessage, varp set to 20 (spoken_juliet) here
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // mesbox "Juliet gives you a message." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    await bot.waitForTicks(2);

    // Verify
    const message = bot.findItem('Message');
    if (!message) {
        throw new Error('Did not receive Message from Juliet');
    }
    const varpAfterJuliet = bot.getQuestProgress(RJQUEST_VARP);
    if (varpAfterJuliet !== STAGE_SPOKEN_JULIET) {
        throw new Error(`Quest varp after Juliet is ${varpAfterJuliet}, expected ${STAGE_SPOKEN_JULIET}`);
    }
    bot.log('EVENT', `Step 2 complete: received Message from Juliet, varp=${varpAfterJuliet}`);

    // ================================================================
    // Step 3: Deliver message to Romeo (back to Varrock square)
    // ================================================================
    bot.log('STATE', '=== Step 3: Deliver message to Romeo ===');

    // Climb back down from Juliet's room
    await climbDownFromJuliet(bot);

    // Walk back east to Romeo in Varrock square
    await bot.walkToWithPathfinding(ROMEO_AREA_X, ROMEO_AREA_Z);

    // Talk to Romeo
    await bot.talkToNpc('Romeo');

    // Dialog flow for varp=spoken_juliet (from romeo.rs2 @romeo_messagefrom):
    // chatplayer "Romeo, I have a message from Juliet." -> continue
    await bot.waitForDialog(15);
    await bot.continueDialog();

    // mesbox "You pass Juliet's message to Romeo." -> continue
    // inv_del julietmessage, varp set to 30 (passed_message) here
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Tragic news. Her father is opposing our marriage." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "If her father sees me, he will kill me." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "I dare not go near his lands." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "She says Father Lawrence can help us." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Please find him for me. Tell him of our plight." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    await bot.waitForTicks(2);

    // Verify
    if (bot.findItem('Message') !== null) {
        throw new Error('Message should have been removed after delivery to Romeo');
    }
    const varpAfterMessage = bot.getQuestProgress(RJQUEST_VARP);
    if (varpAfterMessage !== STAGE_PASSED_MESSAGE) {
        throw new Error(`Quest varp after message delivery is ${varpAfterMessage}, expected ${STAGE_PASSED_MESSAGE}`);
    }
    bot.log('EVENT', `Step 3 complete: delivered message, varp=${varpAfterMessage}`);

    // ================================================================
    // Step 4: Talk to Father Lawrence (NE Varrock church)
    // ================================================================
    bot.log('STATE', '=== Step 4: Talk to Father Lawrence ===');

    // Walk north-east to Father Lawrence's church
    await bot.walkToWithPathfinding(FATHER_LAWRENCE_AREA_X, FATHER_LAWRENCE_AREA_Z);

    // Talk to Father Lawrence
    await bot.talkToNpc('Father Lawrence');

    // Dialog flow for varp=passed_message (from father_lawrence.rs2 @father_lawrence_help):
    // chatplayer "Romeo sent me. He says you can help." -> continue
    await bot.waitForDialog(15);
    await bot.continueDialog();

    // chatnpc "Ah Romeo, yes. A fine lad, but a little bit confused." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatplayer "Juliet must be rescued from her father's control." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "I know just the thing. A potion to make her appear dead." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Then Romeo can collect her from the crypt." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Go to the Apothecary, tell him I sent you." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "You will need a Cadaver potion." -> continue
    // varp set to 40 (spoken_father) here
    await bot.waitForDialog(10);
    await bot.continueDialog();

    await bot.waitForTicks(2);

    // Verify
    const varpAfterFather = bot.getQuestProgress(RJQUEST_VARP);
    if (varpAfterFather !== STAGE_SPOKEN_FATHER) {
        throw new Error(`Quest varp after Father Lawrence is ${varpAfterFather}, expected ${STAGE_SPOKEN_FATHER}`);
    }
    bot.log('EVENT', `Step 4 complete: spoken to Father Lawrence, varp=${varpAfterFather}`);

    // ================================================================
    // Step 5: Talk to the Apothecary (SW Varrock)
    // ================================================================
    bot.log('STATE', '=== Step 5: Talk to the Apothecary ===');

    // Walk south-west to the Apothecary's shop
    await bot.walkToWithPathfinding(APOTHECARY_AREA_X, APOTHECARY_AREA_Z);

    // Talk to the Apothecary
    await bot.talkToNpc('Apothecary');

    // Dialog flow for varp=spoken_father (from apothecary.rs2 @apothecary_lawrence_sent):
    // chatplayer "Apothecary. Father Lawrence sent me." -> continue
    await bot.waitForDialog(15);
    await bot.continueDialog();

    // chatplayer "I need a Cadaver potion to help Romeo and Juliet." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Cadaver potion. It's pretty nasty. And hard to make." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Wing of rat, tail of frog. Ear of snake and horn of dog." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "I have all of that, but I need some Cadaver berries." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "You will have to find them while I get the rest ready." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Bring them here when you have them. But be careful. They are nasty." -> continue
    // varp set to 50 (spoken_apothecary) here
    await bot.waitForDialog(10);
    await bot.continueDialog();

    await bot.waitForTicks(2);

    // Verify
    const varpAfterApothecary = bot.getQuestProgress(RJQUEST_VARP);
    if (varpAfterApothecary !== STAGE_SPOKEN_APOTHECARY) {
        throw new Error(`Quest varp after Apothecary is ${varpAfterApothecary}, expected ${STAGE_SPOKEN_APOTHECARY}`);
    }
    bot.log('EVENT', `Step 5 complete: spoken to Apothecary, varp=${varpAfterApothecary}`);

    // ================================================================
    // Step 6: Pick up cadava berries (SE of Varrock)
    // ================================================================
    bot.log('STATE', '=== Step 6: Pick up cadava berries ===');

    // Walk south-east to the cadava berry spawn area
    // Cadava berries are ground spawns SE of Varrock at (3266,3361), (3273,3375), (3277,3370)
    await bot.walkToWithPathfinding(CADAVA_BERRY_AREA_X, CADAVA_BERRY_AREA_Z);
    bot.log('STATE', `At cadava berry area: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Try to pick up cadava berries from any of the three spawn points
    const berrySpawns = [
        { x: 3273, z: 3375 },
        { x: 3266, z: 3361 },
        { x: 3277, z: 3370 },
    ];

    let berriesFound = false;
    for (const spawn of berrySpawns) {
        // Check for ground item near this spawn
        const groundItem = bot.findNearbyGroundItem('Cadaver berries', 16);
        if (groundItem) {
            bot.log('EVENT', `Found Cadaver berries on ground at (${groundItem.x},${groundItem.z})`);
            await bot.takeGroundItem('Cadaver berries', groundItem.x, groundItem.z);
            await bot.waitForTicks(2);

            if (bot.findItem('Cadaver berries')) {
                berriesFound = true;
                break;
            }
        }

        // Walk to the spawn point and check again
        await bot.walkToWithPathfinding(spawn.x, spawn.z);
        await bot.waitForTicks(2);

        const nearItem = bot.findNearbyGroundItem('Cadaver berries', 5);
        if (nearItem) {
            bot.log('EVENT', `Found Cadaver berries at (${nearItem.x},${nearItem.z})`);
            await bot.takeGroundItem('Cadaver berries', nearItem.x, nearItem.z);
            await bot.waitForTicks(2);

            if (bot.findItem('Cadaver berries')) {
                berriesFound = true;
                break;
            }
        }
    }

    if (!berriesFound) {
        throw new Error(`Failed to find Cadaver berries at any spawn point. Player at (${bot.player.x},${bot.player.z})`);
    }
    bot.log('EVENT', 'Step 6 complete: picked up Cadaver berries');

    // ================================================================
    // Step 7: Return to the Apothecary with berries to get the potion
    // ================================================================
    bot.log('STATE', '=== Step 7: Return to Apothecary with berries ===');

    // Walk back to the Apothecary
    await bot.walkToWithPathfinding(APOTHECARY_AREA_X, APOTHECARY_AREA_Z);

    // Talk to the Apothecary with berries in inventory
    await bot.talkToNpc('Apothecary');

    // Dialog flow for varp=spoken_apothecary WITH cadavaberries in inventory
    // (from apothecary.rs2 @apothecary_make_cadaver):
    // chatnpc "Well done. You have the berries." -> continue
    await bot.waitForDialog(15);
    await bot.continueDialog();

    // mesbox "You hand over the berries, which the Apothecary shakes up in a vial of strange liquid." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Here is what you need." -> continue
    // inv_del cadavaberries, inv_add cadava here
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // mesbox "The Apothecary gives you a Cadaver potion." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    await bot.waitForTicks(2);

    // Verify
    if (bot.findItem('Cadaver berries') !== null) {
        throw new Error('Cadaver berries should have been removed after giving to Apothecary');
    }
    const potion = bot.findItem('Cadaver');
    if (!potion) {
        throw new Error('Did not receive Cadaver potion from Apothecary');
    }
    bot.log('EVENT', 'Step 7 complete: received Cadaver potion');

    // ================================================================
    // Step 8: Deliver potion to Juliet (back to her house, upstairs)
    // ================================================================
    bot.log('STATE', '=== Step 8: Deliver potion to Juliet ===');

    // Walk to Juliet's house — approach from the north-east, same path as Step 2
    await bot.walkToWithPathfinding(3218, 3450); // north past garden fencing gap
    await bot.walkToWithPathfinding(3165, 3445); // west past eastern buildings
    await bot.walkToWithPathfinding(3165, 3440); // south to door level

    // Climb stairs to Juliet
    await climbToJuliet(bot);

    // Talk to Juliet with the Cadaver potion in inventory
    await bot.talkToNpc('Juliet');

    // Dialog flow for varp=spoken_apothecary WITH cadava in inventory
    // (from juliet.rs2 @juliet_potion_made, second branch):
    // chatplayer "I have a Cadaver potion from Father Lawrence." -> continue
    await bot.waitForDialog(15);
    await bot.continueDialog();

    // chatplayer "It should make you seem dead, and get you away from this place." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // mesbox "You pass the potion to Juliet." -> continue
    // inv_del cadava, varp set to 60 (juliet_crypt) here
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Wonderful. I just hope Romeo can remember to get me from the crypt." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Many thanks kind friend." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Please go to Romeo, make sure he understands." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "He can be a bit dense sometimes." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    await bot.waitForTicks(2);

    // Verify
    if (bot.findItem('Cadaver') !== null) {
        throw new Error('Cadaver potion should have been removed after giving to Juliet');
    }
    const varpAfterPotion = bot.getQuestProgress(RJQUEST_VARP);
    if (varpAfterPotion !== STAGE_JULIET_CRYPT) {
        throw new Error(`Quest varp after potion delivery is ${varpAfterPotion}, expected ${STAGE_JULIET_CRYPT}`);
    }
    bot.log('EVENT', `Step 8 complete: gave potion to Juliet, varp=${varpAfterPotion}`);

    // ================================================================
    // Step 9: Tell Romeo about the plan (back to Varrock square)
    // ================================================================
    bot.log('STATE', '=== Step 9: Tell Romeo the plan ===');

    // Climb back down from Juliet's room
    await climbDownFromJuliet(bot);

    // Walk east to Romeo in Varrock square
    await bot.walkToWithPathfinding(ROMEO_AREA_X, ROMEO_AREA_Z);

    // Talk to Romeo
    await bot.talkToNpc('Romeo');

    // Dialog flow for varp=juliet_crypt (from romeo.rs2 @romeo_allset):
    // chatplayer "Romeo, it's all set. Juliet has the potion." -> continue
    await bot.waitForDialog(15);
    await bot.continueDialog();

    // chatnpc "Ah right." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "What potion would that be then?" -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatplayer "The one to get her to the crypt." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Ah right." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "So she is dead then. Aww that's a shame." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Thanks for your help anyway." -> continue
    // queue(romeo_and_juliet_complete) fires here
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // Wait for the queued script to set varp to 100 (complete)
    await bot.waitForTicks(5);

    // Dismiss any quest complete interface
    bot.dismissModals();

    // ================================================================
    // Step 10: Verify quest completion
    // ================================================================
    const finalVarp = bot.getQuestProgress(RJQUEST_VARP);

    if (finalVarp !== STAGE_COMPLETE) {
        throw new Error(`Quest not complete: varp is ${finalVarp}, expected ${STAGE_COMPLETE}`);
    }

    bot.log('SUCCESS', `Romeo & Juliet quest complete! varp=${finalVarp}`);
}
