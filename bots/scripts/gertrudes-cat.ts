import path from 'path';
import { BotAPI } from '../runtime/api.js';
import { skipTutorial } from './skip-tutorial.js';
import { type BotState, runStateMachine } from '../runtime/state-machine.js';
import type { ScriptMeta } from '../runtime/script-meta.js';
import { CoordGrid } from '../../src/engine/CoordGrid.js';

// Quest varp IDs (from content/pack/varp.pack: 180=fluffs, 181=fluffs_crate)
const FLUFFS_VARP = 180;
const FLUFFS_CRATE_VARP = 181;

// Quest stages (from content/scripts/quests/quest_fluffs/configs/quest_fluffs.constant
// and content/scripts/general/configs/quest.constant)
const STAGE_NOT_STARTED = 0;
const STAGE_STARTED = 1;
const STAGE_PAID_BOY = 2;
const STAGE_GAVE_MILK = 3;
const STAGE_GAVE_SARDINE = 4;
const STAGE_RESCUED = 5;
const STAGE_COMPLETE = 6;

// ---- Key locations ----

// Lumbridge general store (from cooks-assistant.ts)
const LUMBRIDGE_STORE_X = 3212;
const LUMBRIDGE_STORE_Z = 3247;

// Cow field north-east of Lumbridge (from cooks-assistant.ts)
const COW_FIELD_X = 3253;
const COW_FIELD_Z = 3270;

// Port Sarim fishing shop - Gerrant's Fishy Business
// Near the docks in Port Sarim (west side of the main street)
const PORT_SARIM_FISHING_X = 3014;
const PORT_SARIM_FISHING_Z = 3226;

// Gertrude's house - interior interaction point (west of her wander area)
// Her spawn is ~(3149,3413) but the interior south section at z≈3408-3410 is where
// she wanders; (3151,3410) is a reachable interior tile with open approach from the west.
const GERTRUDE_INTERIOR_X = 3151;
const GERTRUDE_INTERIOR_Z = 3410;

// Doogle leaves ground spawn - south of Gertrude's house (decoded from o49_53 binary)
// Multiple spawns: (3151,3399), (3152,3399), (3152,3401), (3156,3401), (3157,3400)
const DOOGLE_LEAVES_AREA_X = 3154;
const DOOGLE_LEAVES_AREA_Z = 3400;

// Varrock square - where Shilop and Wilough hang out
const VARROCK_SQUARE_X = 3228;
const VARROCK_SQUARE_Z = 3428;

// Lumber yard fence (gertrudefence) - south wall of lumber yard
// Binary map decode: gertrudefence id=2618 at (3305, 3493) in l51_54
const LUMBER_YARD_FENCE_X = 3305;
const LUMBER_YARD_FENCE_Z = 3493;

// Inside lumber yard - central area (crates are at z=3499-3514)
const LUMBER_YARD_CENTER_X = 3305;
const LUMBER_YARD_CENTER_Z = 3505;

/**
 * Buy the bucket from Lumbridge general store.
 * The general store stocks bucket_empty ("Bucket").
 * Requires the shop to be open (interact with shopkeeper op3=Trade first).
 */
async function buyBucket(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Buying Bucket from Lumbridge general store ===');

    await bot.walkToWithPathfinding(LUMBRIDGE_STORE_X, LUMBRIDGE_STORE_Z);

    await bot.openDoor('poordooropen');

    const shopkeeper = bot.findNearbyNpc('Shop keeper', 10);
    if (!shopkeeper) {
        throw new Error(`Shop keeper not found near (${bot.player.x},${bot.player.z})`);
    }

    await bot.interactNpc(shopkeeper, 3); // op3 = Trade
    await bot.waitForTicks(3);

    await bot.buyFromShop('Bucket', 1);
    await bot.waitForTicks(1);

    bot.dismissModals();

    const bucket = bot.findItem('Bucket');
    if (!bucket) {
        throw new Error('Failed to buy Bucket from Lumbridge general store');
    }
    bot.log('EVENT', `Bought Bucket (id=${bucket.id})`);
}

/**
 * Milk a cow near Lumbridge using an empty bucket.
 * The cow field is north-east of Lumbridge, fenced with gates.
 * Mirrors the pattern from cooks-assistant.ts.
 */
async function getMilk(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Getting Bucket of milk from cow near Lumbridge ===');

    if (!bot.findItem('Bucket')) {
        throw new Error('No Bucket in inventory to milk cow');
    }

    await bot.walkToWithPathfinding(COW_FIELD_X, COW_FIELD_Z - 5);

    await bot.openGate(10);
    await bot.waitForTicks(2);

    try {
        await bot.walkToWithPathfinding(COW_FIELD_X, COW_FIELD_Z);
    } catch {
        bot.log('STATE', `Cannot enter cow field from (${bot.player.x},${bot.player.z}), trying alternate entry`);
        await bot.walkToWithPathfinding(COW_FIELD_X + 5, COW_FIELD_Z - 5);
        await bot.openGate(10);
        await bot.waitForTicks(2);
        await bot.walkToWithPathfinding(COW_FIELD_X, COW_FIELD_Z);
    }

    bot.log('STATE', `In cow field: pos=(${bot.player.x},${bot.player.z})`);

    let cow = bot.findNearbyNpc('Cow', 15);
    if (!cow) {
        await bot.waitForTicks(5);
        cow = bot.findNearbyNpc('Cow', 15);
        if (!cow) {
            throw new Error(`No Cow found near (${bot.player.x},${bot.player.z})`);
        }
    }

    bot.log('EVENT', `Found Cow at (${cow.x},${cow.z})`);
    await bot.useItemOnNpcDirect('Bucket', cow);
    await bot.waitForTicks(5);

    const milk = bot.findItem('Bucket of milk');
    if (!milk) {
        throw new Error('Failed to milk cow — no Bucket of milk in inventory');
    }
    bot.log('EVENT', `Got Bucket of milk (id=${milk.id})`);
}

/**
 * Walk to Port Sarim and buy a Raw sardine from Gerrant's Fishy Business.
 * The fishing shop stocks raw_sardine ("Raw sardine") at 1gp each.
 */
async function getSardine(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Buying Raw sardine from Gerrant in Port Sarim ===');

    // Walk south-west to Port Sarim using proven waypoints (same as witchs-potion.ts)
    await bot.walkToWithPathfinding(3110, 3260); // Draynor Village
    await bot.walkToWithPathfinding(3047, 3237); // Port Sarim area (proven reachable)
    await bot.walkToWithPathfinding(PORT_SARIM_FISHING_X, PORT_SARIM_FISHING_Z);

    bot.log('STATE', `Near Port Sarim fishing shop: pos=(${bot.player.x},${bot.player.z})`);

    const gerrant = bot.findNearbyNpc('Gerrant', 15);
    if (!gerrant) {
        throw new Error(`Gerrant not found near (${bot.player.x},${bot.player.z})`);
    }

    bot.log('EVENT', `Found Gerrant at (${gerrant.x},${gerrant.z})`);
    await bot.interactNpc(gerrant, 3); // op3 = Trade
    await bot.waitForTicks(3);

    await bot.buyFromShop('Raw sardine', 1);
    await bot.waitForTicks(1);

    bot.dismissModals();

    const sardine = bot.findItem('Raw sardine');
    if (!sardine) {
        throw new Error('Failed to buy Raw sardine from Gerrant');
    }
    bot.log('EVENT', `Bought Raw sardine (id=${sardine.id})`);
}

/**
 * Walk to Gertrude's area west of Varrock and pick up Doogle leaves
 * from the ground spawn in her garden / woods out back.
 */
async function getDoogleLeaves(bot: BotAPI): Promise<void> {
    bot.log('STATE', "=== Getting Doogle leaves from Gertrude's garden ===");

    // Walk north from Port Sarim to the road near Gertrude's house, then approach garden from north
    await bot.walkToWithPathfinding(3047, 3237); // Port Sarim road
    await bot.walkToWithPathfinding(3110, 3260); // Draynor Village
    await bot.walkToWithPathfinding(3082, 3336); // North waypoint
    await bot.walkToWithPathfinding(3080, 3400); // Toward Gertrude's road
    await bot.walkToWithPathfinding(3160, 3413); // East of Gertrude's house (north side)
    await bot.walkToWithPathfinding(DOOGLE_LEAVES_AREA_X, DOOGLE_LEAVES_AREA_Z);

    bot.log('STATE', `Near Gertrude's garden: pos=(${bot.player.x},${bot.player.z})`);

    for (let attempt = 0; attempt < 60; attempt++) {
        const leaves = bot.findNearbyGroundItem('Doogle leaves', 20);
        if (leaves) {
            bot.log('EVENT', `Found Doogle leaves at (${leaves.x},${leaves.z})`);
            await bot.walkToWithPathfinding(leaves.x, leaves.z);
            await bot.takeGroundItem('Doogle leaves', leaves.x, leaves.z);
            await bot.waitForTicks(2);

            if (bot.findItem('Doogle leaves')) {
                bot.log('EVENT', 'Picked up Doogle leaves');
                return;
            }
        }

        if (attempt % 10 === 0) {
            bot.log('STATE', `Waiting for Doogle leaves spawn (attempt ${attempt + 1}/60) at (${bot.player.x},${bot.player.z})`);
        }
        await bot.waitForTicks(10);
    }

    throw new Error('Failed to find Doogle leaves ground spawn after 60 attempts');
}

/**
 * Talk to Gertrude to start Gertrude's Cat quest.
 *
 * Dialog flow (from gertrude.rs2, case ^fluffs_not_started):
 *   chatplayer/chatnpc exchanges (about Fluffs and the kids)
 *   → p_choice3: (1) "Well, I suppose I could." (2) "What's in it for me?" (3) "Sorry, too busy"
 *   → select option 1 → %fluffs = 1
 *   → chatnpc about Shilop/Wilough at the market
 */
async function startQuestWithGertrude(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Talking to Gertrude to start quest ===');

    // Walk into Gertrude's house interior. Her spawn is ~(3149,3413) but the north
    // section has wall flags blocking approach from outside. Her wander area south of
    // the interior wall is accessible at z≈3408-3410. Walking to GERTRUDE_INTERIOR
    // puts the bot inside the house near her wander range; walkToWithPathfinding opens the door.
    await bot.walkToWithPathfinding(GERTRUDE_INTERIOR_X, GERTRUDE_INTERIOR_Z);

    // Gertrude wanders — retry until she moves adjacent and dialog opens.
    let dialogOpened = false;
    for (let attempt = 0; attempt < 30 && !dialogOpened; attempt++) {
        const g = bot.findNearbyNpc('Gertrude', 15);
        if (!g) {
            await bot.waitForTicks(2);
            continue;
        }

        await bot.interactNpc(g, 1); // op1 = Talk-to
        await bot.waitForTick();
        if (bot.isDialogOpen()) {
            dialogOpened = true;
            break;
        }
        await bot.waitForTick();
        if (bot.isDialogOpen()) {
            dialogOpened = true;
            break;
        }
    }

    if (!dialogOpened) {
        throw new Error('No dialog from Gertrude after 30 attempts');
    }

    // Drain initial chatplayer/chatnpc exchanges until the p_choice3 appears
    const gotChoice = await bot.continueDialogsUntilChoice(15);
    if (!gotChoice) {
        throw new Error('No choice dialog from Gertrude during quest start');
    }

    // p_choice3: (1) "Well, I suppose I could." starts quest
    await bot.selectDialogOption(1);

    // Drain remaining dialogs (Gertrude thanks player, mentions boys at market)
    await bot.continueRemainingDialogs(10);
    await bot.waitForTicks(3);
    bot.dismissModals();

    const varp = bot.getQuestProgress(FLUFFS_VARP);
    if (varp !== STAGE_STARTED) {
        throw new Error(`Quest varp after talking to Gertrude is ${varp}, expected ${STAGE_STARTED}`);
    }
    bot.log('EVENT', `Quest started! varp=${varp}`);
}

/**
 * Find Shilop or Wilough in Varrock square and pay 100 coins to learn
 * where Fluffs was last seen (the lumber yard).
 *
 * Dialog flow (from quest_fluffs.rs2, case ^fluffs_started):
 *   chatplayer/chatnpc exchanges → p_choice3: select option 2 "What will make you tell me?"
 *   → chatplayer/chatnpc about payment → p_choice2: select option 2 "Okay then, I'll pay."
 *   → pays 100 coins → %fluffs = 2
 */
async function talkToBoysAndPay(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Finding Shilop/Wilough in Varrock square and paying 100 coins ===');

    // Walk to Varrock via proven waypoints, then to the square
    await bot.walkToWithPathfinding(3175, 3427); // Varrock west gate area
    await bot.walkToWithPathfinding(VARROCK_SQUARE_X, VARROCK_SQUARE_Z);

    bot.log('STATE', `In Varrock square: pos=(${bot.player.x},${bot.player.z})`);

    // Try Shilop first, then Wilough
    let boy = bot.findNearbyNpc('Shilop', 20);
    if (!boy) boy = bot.findNearbyNpc('Wilough', 20);
    if (!boy) {
        throw new Error(`Neither Shilop nor Wilough found near (${bot.player.x},${bot.player.z})`);
    }

    bot.log('EVENT', `Found ${boy.type} at (${boy.x},${boy.z})`);
    await bot.interactNpc(boy, 1); // op1 = Talk-to

    if (!await bot.waitForDialog(30)) {
        throw new Error('No dialog from boy');
    }

    // Drain initial chatplayer/chatnpc until first choice
    const gotChoice1 = await bot.continueDialogsUntilChoice(15);
    if (!gotChoice1) {
        throw new Error('No first choice dialog from boy');
    }

    // p_choice3: (1) threaten (2) "What will make you tell me?" (3) give up
    await bot.selectDialogOption(2); // "What will make you tell me?"

    // Drain dialog until payment choice appears
    const gotChoice2 = await bot.continueDialogsUntilChoice(15);
    if (!gotChoice2) {
        throw new Error('No payment choice dialog from boy');
    }

    // p_choice2: (1) "I'm not paying" (2) "Okay then, I'll pay."
    await bot.selectDialogOption(2); // "Okay then, I'll pay."

    // Drain remaining dialogs (boy explains lumber yard location, fence)
    await bot.continueRemainingDialogs(10);
    await bot.waitForTicks(3);
    bot.dismissModals();

    const varp = bot.getQuestProgress(FLUFFS_VARP);
    if (varp !== STAGE_PAID_BOY) {
        throw new Error(`Quest varp after paying boy is ${varp}, expected ${STAGE_PAID_BOY}`);
    }
    bot.log('EVENT', `Paid boy 100 coins, varp=${varp}`);
}

/**
 * Enter the lumber yard by climbing over the gertrudefence (broken fence).
 * The fence is on the south wall. Approach from the south (z < fence z) to enter.
 * The RS2 script uses agility_exactmove to animate the player over the fence.
 */
async function enterLumberYard(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Entering lumber yard via gertrudefence ===');

    // Walk north-east from Varrock toward the lumber yard
    // Approach the gertrudefence at (3305,3493) from the south
    await bot.walkToWithPathfinding(3257, 3444);
    await bot.walkToWithPathfinding(LUMBER_YARD_FENCE_X, LUMBER_YARD_FENCE_Z - 1); // approach from south

    bot.log('STATE', `Near lumber yard fence: pos=(${bot.player.x},${bot.player.z})`);

    const fence = bot.findNearbyLoc('gertrudefence', 10);
    if (!fence) {
        throw new Error(`gertrudefence not found near (${bot.player.x},${bot.player.z})`);
    }

    bot.log('EVENT', `Found gertrudefence at (${fence.x},${fence.z})`);
    await bot.interactLoc(fence, 1); // op1 = Climb-over
    await bot.waitForTicks(6); // agility_exactmove takes a couple ticks

    bot.dismissModals();

    bot.log('STATE', `After fence: pos=(${bot.player.x},${bot.player.z})`);
}

/**
 * Use a Bucket of milk on Gertrudes cat in the lumber yard.
 * Requires varp = STAGE_PAID_BOY (2).
 * Sets varp to STAGE_GAVE_MILK (3).
 * Caller must already be at level=1 near the cat.
 */
async function useMilkOnCat(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Using Bucket of milk on Gertrudes cat ===');

    if (!bot.findItem('Bucket of milk')) {
        throw new Error('No Bucket of milk in inventory');
    }

    const cat = bot.findNearbyNpc('Gertrudes cat', 30);
    if (!cat) {
        throw new Error(`Gertrudes cat not found in lumber yard near (${bot.player.x},${bot.player.z},level=${bot.player.level})`);
    }

    bot.log('EVENT', `Found Gertrudes cat at (${cat.x},${cat.z},level=${cat.level})`);
    await bot.useItemOnNpcDirect('Bucket of milk', cat);
    await bot.waitForTicks(8);

    bot.dismissModals();

    const varp = bot.getQuestProgress(FLUFFS_VARP);
    if (varp !== STAGE_GAVE_MILK) {
        throw new Error(`Quest varp after milk is ${varp}, expected ${STAGE_GAVE_MILK}`);
    }
    bot.log('EVENT', `Used Bucket of milk on cat, varp=${varp}`);
}

/**
 * Combine Doogle leaves with Raw sardine to make a Seasoned sardine,
 * then use it on Gertrudes cat.
 * This also sets the fluffs_crate varp (181) to a random crate location.
 * Sets varp to STAGE_GAVE_SARDINE (4).
 */
async function useSeasonedSardineOnCat(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Making Seasoned sardine and using on Gertrudes cat ===');

    if (!bot.findItem('Doogle leaves')) {
        throw new Error('No Doogle leaves in inventory');
    }
    if (!bot.findItem('Raw sardine')) {
        throw new Error('No Raw sardine in inventory');
    }

    // Combine: use Doogle leaves on Raw sardine (or Raw sardine on Doogle leaves — both work)
    // Note: the opheldu script shows a ~mesbox (p_pausebutton) before the inv_del/inv_add.
    // useItemOnItem now handles this by calling dismissModals() internally.
    await bot.useItemOnItem('Doogle leaves', 'Raw sardine');
    await bot.waitForTicks(3);

    const sardine = bot.findItem('Seasoned sardine');
    if (!sardine) {
        throw new Error('Failed to make Seasoned sardine from Doogle leaves + Raw sardine');
    }
    bot.log('EVENT', `Made Seasoned sardine (id=${sardine.id})`);

    // Find cat again (may have wandered slightly; caller must be at level=1)
    const cat = bot.findNearbyNpc('Gertrudes cat', 30);
    if (!cat) {
        throw new Error(`Gertrudes cat not found when trying to use sardine near (${bot.player.x},${bot.player.z},level=${bot.player.level})`);
    }

    await bot.useItemOnNpcDirect('Seasoned sardine', cat);
    await bot.waitForTicks(8);

    bot.dismissModals();

    const varp = bot.getQuestProgress(FLUFFS_VARP);
    if (varp !== STAGE_GAVE_SARDINE) {
        throw new Error(`Quest varp after sardine is ${varp}, expected ${STAGE_GAVE_SARDINE}`);
    }
    bot.log('EVENT', `Used Seasoned sardine on cat, varp=${varp}`);
}

/**
 * Decode the fluffs_crate varp (181) to find which crate contains Fluffs' kitten,
 * walk to that crate, search it to receive Fluffs' kitten.
 *
 * The kittens_mew NPC has name="Crate" and moverestrict=nomove.
 * The RS2 script gives the kitten only if npc_coord matches %fluffs_crate.
 *
 * Possible crate locations (0_51_54_*_*):
 *   0_51_54_41_44 → (3305,3500)
 *   0_51_54_46_43 → (3310,3499)
 *   0_51_54_43_51 → (3307,3507)
 *   0_51_54_39_50 → (3303,3506)
 *   0_51_54_34_58 → (3298,3514)
 *   0_51_54_47_55 → (3311,3511)
 */
async function findKittenInCrate(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Finding kitten in crate (kittens_mew NPC) ===');

    // Read and decode the fluffs_crate varp (181)
    const crateVarpValue = bot.getVarp(FLUFFS_CRATE_VARP);
    bot.log('STATE', `DEBUG: fluffs_crate varp=${crateVarpValue} (fluffs_varp=${bot.getQuestProgress(FLUFFS_VARP)})`);
    if (crateVarpValue <= 0) {
        throw new Error(`fluffs_crate varp is ${crateVarpValue} — sardine was not used on cat yet (or varp not set)`);
    }

    const crateCoord = CoordGrid.unpackCoord(crateVarpValue);
    bot.log('STATE', `DEBUG: decoded crate coord: (${crateCoord.x},${crateCoord.z},level=${crateCoord.level})`);

    // kittens_mew NPC type ID = 767 (from content/pack/npc.pack: 767=kittens_mew)
    const KITTENS_MEW_TYPE_ID = 767;

    // Walk to the lumber yard center (clearly reachable) so all 6 possible crates
    // are within search range (max Chebyshev distance from center is ~9 tiles).
    // We do NOT walk directly to crateCoord because the NPC blocks its own tile
    // and walkToWithPathfinding would time out trying to reach the exact tile.
    await bot.walkToWithPathfinding(LUMBER_YARD_CENTER_X, LUMBER_YARD_CENTER_Z);

    // Find the specific kittens_mew NPC whose world coords match the decoded varp.
    // There are 6 kittens_mew NPCs; we need the one at crateCoord.
    const allCrates = bot.findAllNearbyNpcsByTypeId(KITTENS_MEW_TYPE_ID, 15);
    bot.log('STATE', `DEBUG: found ${allCrates.length} kittens_mew NPCs nearby`);
    const crate = allCrates.find(n => n.x === crateCoord.x && n.z === crateCoord.z);
    if (!crate) {
        const positions = allCrates.map(n => `(${n.x},${n.z})`).join(', ');
        throw new Error(`kittens_mew NPC at (${crateCoord.x},${crateCoord.z}) not found. Nearby: [${positions}]`);
    }

    bot.log('EVENT', `Found Crate at (${crate.x},${crate.z}), searching for kitten...`);

    await bot.interactNpc(crate, 1); // op1 = Search
    await bot.waitForTicks(8); // 4-tick search delay + buffer

    bot.dismissModals();

    const kitten = bot.findItem("Fluffs' kitten");
    if (!kitten) {
        throw new Error("No Fluffs' kitten after searching crate at decoded fluffs_crate coords");
    }
    bot.log('EVENT', `Found Fluffs' kitten (id=${kitten.id})`);
}

/**
 * Use Fluffs' kitten (gertrudekittens) on Gertrudes cat.
 * This reunites the kitten with the cat. The cat and kitten then run home.
 * Sets varp to STAGE_RESCUED (5).
 * Caller must already be at level=1 near the cat.
 */
async function useKittenOnCat(bot: BotAPI): Promise<void> {
    bot.log('STATE', "=== Using Fluffs' kitten on Gertrudes cat ===");

    if (!bot.findItem("Fluffs' kitten")) {
        throw new Error("No Fluffs' kitten in inventory");
    }

    // The bot is already on level=1 after climbing back up. The cat stays at level=1
    // (it doesn't move after the sardine interaction). Search nearby with a large radius.
    // Do NOT walk to (3310,3509) — loc_1746 (stairs) blocks that tile.
    const cat = bot.findNearbyNpc('Gertrudes cat', 30);
    if (!cat) {
        throw new Error(`Gertrudes cat not found when using kitten near (${bot.player.x},${bot.player.z},level=${bot.player.level})`);
    }

    bot.log('EVENT', `Found Gertrudes cat at (${cat.x},${cat.z},level=${cat.level})`);
    await bot.useItemOnNpcDirect("Fluffs' kitten", cat);
    await bot.waitForTicks(12); // cat purrs, walks away, npc_del

    bot.dismissModals();

    const varp = bot.getQuestProgress(FLUFFS_VARP);
    if (varp !== STAGE_RESCUED) {
        throw new Error(`Quest varp after kitten is ${varp}, expected ${STAGE_RESCUED}`);
    }
    bot.log('EVENT', `Reunited kitten with Fluffs, varp=${varp}`);
}

/**
 * Exit the lumber yard by climbing back over the gertrudefence from the inside.
 */
async function exitLumberYard(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Exiting lumber yard via gertrudefence ===');

    // Walk to just inside (north of) the fence
    await bot.walkToWithPathfinding(LUMBER_YARD_FENCE_X, LUMBER_YARD_FENCE_Z + 2);

    const fence = bot.findNearbyLoc('gertrudefence', 5);
    if (!fence) {
        throw new Error(`gertrudefence not found when trying to exit at (${bot.player.x},${bot.player.z})`);
    }

    bot.log('EVENT', `Found gertrudefence at (${fence.x},${fence.z}), exiting...`);
    await bot.interactLoc(fence, 1); // op1 = Climb-over
    await bot.waitForTicks(6);

    bot.dismissModals();

    bot.log('STATE', `After exiting fence: pos=(${bot.player.x},${bot.player.z})`);
}

/**
 * Return to Gertrude and complete the quest.
 *
 * Dialog flow (from gertrude.rs2, case ^fluffs_rescued):
 *   chatplayer "Hello Gertrude. Fluffs ran off with her kitten."
 *   chatnpc × 2 (thanks + info about kitten)
 *   chatplayer × 2
 *   chatnpc × 2 (about the kitten)
 *   mesbox "Gertrude gives you a hug."
 *   mesbox "Gertrude gives you a kitten."
 *   if_close → server sets %fluffs = 6, queue(fluffs_complete)
 */
async function completeWithGertrude(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Completing quest with Gertrude ===');

    // Walk back to Gertrude's house west of Varrock — enter interior as in startQuestWithGertrude
    await bot.walkToWithPathfinding(3175, 3427); // Varrock west gate area
    await bot.walkToWithPathfinding(GERTRUDE_INTERIOR_X, GERTRUDE_INTERIOR_Z);

    // Gertrude wanders — retry until dialog opens
    let dialogOpened = false;
    for (let attempt = 0; attempt < 30 && !dialogOpened; attempt++) {
        const g = bot.findNearbyNpc('Gertrude', 15);
        if (!g) {
            await bot.waitForTicks(2);
            continue;
        }

        bot.log('EVENT', `Found Gertrude at (${g.x},${g.z})`);
        await bot.interactNpc(g, 1); // op1 = Talk-to
        await bot.waitForTick();
        if (bot.isDialogOpen()) {
            dialogOpened = true;
            break;
        }
        await bot.waitForTick();
        if (bot.isDialogOpen()) {
            dialogOpened = true;
            break;
        }
    }

    if (!dialogOpened) {
        throw new Error('No dialog from Gertrude after 30 attempts (complete)');
    }

    // Drain all dialog pages (chatplayer, chatnpc, mesboxes)
    // The quest completion fires after if_close (server-side after dialogs end)
    await bot.continueRemainingDialogs(20);

    // Wait for queue(fluffs_complete) to fire (grants XP and quest points)
    await bot.waitForTicks(10);
    bot.dismissModals();

    const varp = bot.getQuestProgress(FLUFFS_VARP);
    if (varp !== STAGE_COMPLETE) {
        throw new Error(`Quest varp after Gertrude completion is ${varp}, expected ${STAGE_COMPLETE}`);
    }
    bot.log('SUCCESS', `Gertrude's Cat quest complete! varp=${varp}`);
}

/**
 * Build the Gertrude's Cat state machine.
 */
export function buildGertruesCatStates(bot: BotAPI): BotState {
    return {
        name: 'gertrudes-cat',
        isComplete: () => bot.getQuestProgress(FLUFFS_VARP) === STAGE_COMPLETE,
        run: async () => { throw new Error('Composite state should not be called directly'); },
        children: [
            {
                name: 'earn-coins',
                stuckThreshold: 3000,
                isComplete: () => {
                    const coins = bot.findItem('Coins');
                    return coins !== null && coins.count >= 115;
                },
                run: async () => {
                    // Need: ~100 for boys + ~2 for bucket + ~1 for sardine + buffer
                    await bot.earnCoinsViaPickpocket(115);
                }
            },
            {
                name: 'get-bucket',
                isComplete: () => bot.findItem('Bucket') !== null || bot.findItem('Bucket of milk') !== null,
                run: async () => {
                    await buyBucket(bot);
                }
            },
            {
                name: 'get-milk',
                isComplete: () => bot.findItem('Bucket of milk') !== null,
                run: async () => {
                    await getMilk(bot);
                }
            },
            {
                name: 'get-sardine',
                stuckThreshold: 2000,
                progressThreshold: 10000,
                isComplete: () => bot.findItem('Raw sardine') !== null || bot.findItem('Seasoned sardine') !== null,
                run: async () => {
                    await getSardine(bot);
                }
            },
            {
                name: 'get-doogle-leaves',
                stuckThreshold: 4000,
                progressThreshold: 6000,
                isComplete: () => bot.findItem('Doogle leaves') !== null || bot.findItem('Seasoned sardine') !== null,
                run: async () => {
                    await getDoogleLeaves(bot);
                }
            },
            {
                name: 'start-quest',
                isComplete: () => bot.getQuestProgress(FLUFFS_VARP) >= STAGE_STARTED,
                run: async () => {
                    await startQuestWithGertrude(bot);
                }
            },
            {
                name: 'find-boys',
                isComplete: () => bot.getQuestProgress(FLUFFS_VARP) >= STAGE_PAID_BOY,
                run: async () => {
                    await talkToBoysAndPay(bot);
                }
            },
            {
                name: 'find-fluffs',
                stuckThreshold: 5000,
                progressThreshold: 8000,
                isComplete: () => bot.getQuestProgress(FLUFFS_VARP) >= STAGE_RESCUED,
                run: async () => {
                    // Normalize: on retry, descend from level=1 first
                    if (bot.player.level === 1) {
                        bot.log('STATE', 'On retry at level=1, descending to level=0 first');
                        await bot.climbStairs('loc_1746', 1); // Climb-down
                    }

                    // Enter the lumber yard if not already inside
                    if (bot.player.z <= LUMBER_YARD_FENCE_Z) {
                        await enterLumberYard(bot);
                    } else {
                        bot.log('STATE', `Already inside lumber yard at (${bot.player.x},${bot.player.z}), skipping entry`);
                    }

                    // Climb up to level=1 where Gertrudes cat lives
                    // loc_1747 = Climb-up stairs at (3310,3509,level=0)
                    await bot.climbStairs('loc_1747', 1);
                    bot.log('STATE', `After climbing up: pos=(${bot.player.x},${bot.player.z},level=${bot.player.level})`);

                    if (bot.player.level !== 1) {
                        throw new Error(`Expected to be at level=1 after climbing stairs, got level=${bot.player.level}`);
                    }

                    // Use milk on cat at level=1 (requires varp=2 → sets varp=3)
                    // Skip if already done (e.g. on retry after milk was consumed)
                    if (bot.getQuestProgress(FLUFFS_VARP) < STAGE_GAVE_MILK) {
                        await useMilkOnCat(bot);
                    } else {
                        bot.log('STATE', `Skipping milk step (varp=${bot.getQuestProgress(FLUFFS_VARP)} >= ${STAGE_GAVE_MILK})`);
                    }

                    // Combine doogle leaves + sardine, use on cat at level=1
                    // After this, the cat starts walking toward stairs at (3310,3509)
                    // Skip if already done (e.g. on retry after sardine was consumed)
                    if (bot.getQuestProgress(FLUFFS_VARP) < STAGE_GAVE_SARDINE) {
                        await useSeasonedSardineOnCat(bot);
                    } else {
                        bot.log('STATE', `Skipping sardine step (varp=${bot.getQuestProgress(FLUFFS_VARP)} >= ${STAGE_GAVE_SARDINE})`);
                    }

                    // Descend to level=0 to search the crate
                    // loc_1746 = Climb-down stairs at (3310,3509,level=1)
                    await bot.climbStairs('loc_1746', 1);
                    bot.log('STATE', `After descending: pos=(${bot.player.x},${bot.player.z},level=${bot.player.level})`);

                    if (bot.player.level !== 0) {
                        throw new Error(`Expected to be at level=0 after descending stairs, got level=${bot.player.level}`);
                    }

                    // Decode fluffs_crate varp and search correct crate for kitten
                    await findKittenInCrate(bot);

                    // Climb back up to level=1 to use kitten on cat
                    // Cat is walking toward stairs area at (3310,3509,level=1)
                    await bot.climbStairs('loc_1747', 1);
                    bot.log('STATE', `After climbing up again: pos=(${bot.player.x},${bot.player.z},level=${bot.player.level})`);

                    if (bot.player.level !== 1) {
                        throw new Error(`Expected to be at level=1 after re-climbing stairs, got level=${bot.player.level}`);
                    }

                    // Use kitten on cat to reunite them (cat may be near stairs now)
                    await useKittenOnCat(bot);

                    // Descend back to level=0
                    await bot.climbStairs('loc_1746', 1);
                    bot.log('STATE', `After final descent: pos=(${bot.player.x},${bot.player.z},level=${bot.player.level})`);

                    // Walk to yard center before leaving. After descending stairs, the bot
                    // lands adjacent to the staircase at ~(3309,3509). kittens_mew NPCs
                    // (blockwalk=all) in the yard create a maze around that position that
                    // exitLumberYard can't navigate. Walking to LUMBER_YARD_CENTER here
                    // uses the same path that worked for findKittenInCrate.
                    await bot.walkToWithPathfinding(LUMBER_YARD_CENTER_X, LUMBER_YARD_CENTER_Z);
                }
            },
            {
                name: 'complete-quest',
                stuckThreshold: 4000,
                progressThreshold: 6000,
                isComplete: () => bot.getQuestProgress(FLUFFS_VARP) === STAGE_COMPLETE,
                run: async () => {
                    // Exit lumber yard and return to Gertrude
                    await exitLumberYard(bot);
                    await completeWithGertrude(bot);

                    const cookingSkill = bot.getSkill('Cooking');
                    if (cookingSkill.exp <= 0) {
                        throw new Error('No Cooking XP gained during quest');
                    }
                    bot.log('SUCCESS', `Gertrude's Cat complete! cooking_xp=${cookingSkill.exp}`);
                }
            }
        ]
    };
}

export async function gertrudesCat(bot: BotAPI): Promise<void> {
    await skipTutorial(bot);
    await bot.waitForTicks(2);

    bot.log('STATE', `Starting Gertrude's Cat quest at (${bot.player.x},${bot.player.z},${bot.player.level})`);

    const initialVarp = bot.getQuestProgress(FLUFFS_VARP);
    if (initialVarp !== STAGE_NOT_STARTED) {
        throw new Error(`Quest varp is ${initialVarp}, expected ${STAGE_NOT_STARTED} (not started)`);
    }

    const root = buildGertruesCatStates(bot);
    const snapshotDir = path.resolve(import.meta.dir, '..', 'test', 'snapshots');
    await runStateMachine(bot, { root, varpIds: [FLUFFS_VARP, FLUFFS_CRATE_VARP], captureSnapshots: true, snapshotDir });
}

export const metadata: ScriptMeta = {
    name: 'gertrudescat',
    type: 'quest',
    varpId: FLUFFS_VARP,
    varpComplete: STAGE_COMPLETE,
    maxTicks: 30000,
    run: gertrudesCat,
    buildStates: buildGertruesCatStates,
};
