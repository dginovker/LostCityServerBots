import path from 'path';
import { BotAPI } from '../../runtime/api.js';
import { skipTutorial } from '../skip-tutorial.js';
import { type BotState, runStateMachine } from '../../runtime/state-machine.js';
import type { ScriptMeta } from '../../runtime/script-meta.js';

// Varp ID for Cook's Assistant quest progress (from content/pack/varp.pack: 29=cookquest)
const COOK_QUEST_VARP = 29;

// Quest stages (from content/scripts/general/configs/quest.constant)
const STAGE_NOT_STARTED = 0;
const STAGE_STARTED = 1;
const STAGE_COMPLETE = 2;

// Varp IDs for stun/delay (same as thieving-men.ts)
const VARP_ACTION_DELAY = 58;
const VARP_STUNNED = 103;

// ---- Key locations ----

// Lumbridge spawn point (after tutorial)
const LUMBRIDGE_SPAWN_X = 3222;
const LUMBRIDGE_SPAWN_Z = 3218;

// Lumbridge General Store
const GENERAL_STORE_X = 3212;
const GENERAL_STORE_Z = 3247;

// Lumbridge Castle kitchen (Cook is here) — ground floor
const _KITCHEN_X = 3209;
const _KITCHEN_Z = 3215;

// Chicken area east of river (egg ground spawn)
const _CHICKEN_AREA_X = 3231;
const _CHICKEN_AREA_Z = 3298;

// Cow field (north-east of Lumbridge)
const _COW_FIELD_X = 3253;
const _COW_FIELD_Z = 3270;

// Wheat field (north of Lumbridge, near windmill)
const _WHEAT_FIELD_X = 3162;
const _WHEAT_FIELD_Z = 3292;

// Windmill ground floor entrance (flour bin is here)
const _WINDMILL_GROUND_X = 3166;
const _WINDMILL_GROUND_Z = 3306;

/**
 * Pickpocket men in Lumbridge to earn coins.
 */
async function earnCoins(bot: BotAPI, targetGp: number): Promise<void> {
    bot.log('STATE', `=== Earning ${targetGp}gp by pickpocketing men ===`);

    let attempts = 0;
    const MAX_ATTEMPTS = 200;

    while (attempts < MAX_ATTEMPTS) {
        const coins = bot.findItem('Coins');
        const currentGp = coins ? coins.count : 0;
        if (currentGp >= targetGp) {
            bot.log('EVENT', `Earned ${currentGp}gp (target: ${targetGp}gp) in ${attempts} pickpocket attempts`);
            return;
        }

        bot.dismissModals();

        const stunnedUntil = bot.getVarp(VARP_STUNNED);
        const actionDelayUntil = bot.getVarp(VARP_ACTION_DELAY);
        const currentTick = bot.getCurrentTick();

        if (stunnedUntil > currentTick || actionDelayUntil > currentTick) {
            const waitUntil = Math.max(stunnedUntil, actionDelayUntil);
            const ticksToWait = waitUntil - currentTick + 1;
            bot.log('STATE', `Stunned/delayed, waiting ${ticksToWait} ticks`);
            await bot.waitForTicks(ticksToWait);
        }

        if (bot.player.delayed) {
            await bot.waitForCondition(() => !bot.player.delayed, 20);
        }

        let man = bot.findNearbyNpc('Man');
        if (!man) {
            bot.log('STATE', 'No Man found nearby, walking to Lumbridge center');
            await bot.walkTo(LUMBRIDGE_SPAWN_X, LUMBRIDGE_SPAWN_Z);
            await bot.waitForTicks(2);
            man = bot.findNearbyNpc('Man');
            if (!man) {
                throw new Error(`No Man NPC found near (${LUMBRIDGE_SPAWN_X},${LUMBRIDGE_SPAWN_Z})`);
            }
        }

        attempts++;
        await bot.interactNpc(man, 3); // op3 = Pickpocket
        await bot.waitForTicks(5);

        await bot.waitForTicks(1);
        bot.dismissModals();
    }

    const finalCoins = bot.findItem('Coins');
    throw new Error(`Failed to earn ${targetGp}gp after ${MAX_ATTEMPTS} attempts. Current gp: ${finalCoins ? finalCoins.count : 0}`);
}

/**
 * Buy items from the Lumbridge General Store.
 */
async function buyFromGeneralStore(bot: BotAPI, items: Array<{ name: string; qty: number }>): Promise<void> {
    bot.log('STATE', `=== Buying from General Store: ${items.map(i => `${i.name}x${i.qty}`).join(', ')} ===`);

    await bot.walkToWithPathfinding(GENERAL_STORE_X, GENERAL_STORE_Z);
    bot.log('STATE', `At General Store area: pos=(${bot.player.x},${bot.player.z})`);

    await bot.openDoor('poordooropen');

    const shopkeeper = bot.findNearbyNpc('Shop keeper');
    if (!shopkeeper) {
        throw new Error(`Shop keeper not found near (${bot.player.x},${bot.player.z})`);
    }

    await bot.interactNpc(shopkeeper, 3); // op3 = Trade
    await bot.waitForTicks(3);

    for (const item of items) {
        await bot.buyFromShop(item.name, item.qty);
        await bot.waitForTicks(1);
    }

    bot.dismissModals();

    // Verify purchases
    for (const item of items) {
        const found = bot.findItem(item.name);
        if (!found) {
            throw new Error(`Failed to buy ${item.name} -- not in inventory after purchase`);
        }
        bot.log('EVENT', `Purchased ${item.name} (id=${found.id})`);
    }
}

/**
 * Walk to the chicken area east of the river and pick up an egg from the ground.
 * The chicken area has fences with gates. Eggs spawn on ground inside the coop.
 * We approach from outside, open the gate, and then search for eggs.
 */
async function getEgg(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Getting egg from chicken area ===');

    // Walk near the chicken area.
    // The chicken coop is fenced. We approach from the south/east, find a gate, and enter.
    // First walk to the road east of the river, near the chicken area.
    await bot.walkToWithPathfinding(3237, 3300);
    bot.log('STATE', `Near chicken area road: pos=(${bot.player.x},${bot.player.z})`);

    // Open the gate to the chicken area
    await bot.openGate(10);
    await bot.waitForTicks(2);

    // Try to walk into the chicken area
    try {
        await bot.walkToWithPathfinding(3233, 3300);
    } catch {
        bot.log('STATE', `Cannot path into chicken area from (${bot.player.x},${bot.player.z}), trying different entry`);
        // Try opening gate from slightly different positions
        await bot.walkToWithPathfinding(3237, 3296);
        await bot.openGate(10);
        await bot.waitForTicks(2);
        await bot.walkToWithPathfinding(3233, 3296);
    }

    bot.log('STATE', `In chicken area: pos=(${bot.player.x},${bot.player.z})`);

    // Search for egg ground item nearby
    for (let attempt = 0; attempt < 100; attempt++) {
        const eggGround = bot.findNearbyGroundItem('Egg', 25);
        if (eggGround) {
            bot.log('EVENT', `Found egg on ground at (${eggGround.x},${eggGround.z})`);

            // Walk to the egg position first
            try {
                await bot.walkToWithPathfinding(eggGround.x, eggGround.z);
            } catch {
                // Egg might be behind a fence; try opening a gate nearby
                bot.log('STATE', `Cannot path to egg at (${eggGround.x},${eggGround.z}), trying to open gate`);
                await bot.openGate(10);
                await bot.waitForTicks(2);
                try {
                    await bot.walkToWithPathfinding(eggGround.x, eggGround.z);
                } catch {
                    bot.log('STATE', 'Still cannot reach egg, moving on');
                    await bot.waitForTicks(10);
                    continue;
                }
            }

            await bot.takeGroundItem('Egg', eggGround.x, eggGround.z);
            await bot.waitForTicks(3);

            const egg = bot.findItem('Egg');
            if (egg) {
                bot.log('EVENT', `Picked up egg (id=${egg.id})`);
                return;
            }
            bot.log('STATE', 'Egg pickup may have failed, retrying...');
        }

        // No egg found, wait for respawn
        if (attempt % 20 === 0) {
            bot.log('STATE', `Waiting for egg spawn (attempt ${attempt + 1}/100) at pos=(${bot.player.x},${bot.player.z})`);
        }
        await bot.waitForTicks(5);
    }

    throw new Error('Failed to find or pick up an egg after 100 attempts');
}

/**
 * Milk a cow by using an empty bucket on it.
 * The cow milking script (cow_milking.rs2) uses [opnpcu,cow] with bucket_empty.
 * The cow field north of Lumbridge is fenced with gates.
 */
async function getMilk(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Getting bucket of milk ===');

    // Walk to near the cow field. The cow field is north-east of Lumbridge.
    // The cow field is fenced. We need to find a gate to enter.
    // First, walk to an area near the cow field and log nearby locs to find gates.
    await bot.walkToWithPathfinding(3252, 3266);
    bot.log('STATE', `Near cow field: pos=(${bot.player.x},${bot.player.z})`);

    // Log nearby locs to find gates
    const nearbyLocs = bot.findAllNearbyLocs(10);
    const gates = nearbyLocs.filter(l => l.displayName === 'Gate');
    bot.log('STATE', `Gates near cow field: ${gates.map(g => `${g.debugname}@(${g.x},${g.z})`).join(', ')}`);

    // Open the gate to the cow field
    await bot.openGate(10);
    await bot.waitForTicks(2);

    // Try to enter the cow field from the south side
    try {
        await bot.walkToWithPathfinding(3254, 3270);
    } catch {
        bot.log('STATE', `First try failed from (${bot.player.x},${bot.player.z}), trying different approach`);
        // Try walking south a bit and then approaching from a different angle
        await bot.walkToWithPathfinding(3258, 3266);
        await bot.openGate(10);
        await bot.waitForTicks(2);
        try {
            await bot.walkToWithPathfinding(3258, 3270);
        } catch {
            // Log all nearby locs for debugging
            const locs2 = bot.findAllNearbyLocs(10);
            bot.log('STATE', `All locs near (${bot.player.x},${bot.player.z}): ${locs2.map(l => `${l.debugname}=${l.displayName}@(${l.x},${l.z})`).join(', ')}`);
            throw new Error(`Cannot enter cow field from (${bot.player.x},${bot.player.z})`);
        }
    }
    bot.log('STATE', `In cow field: pos=(${bot.player.x},${bot.player.z})`);

    // Find a cow nearby. NPC names are "Cow" (id 81=cow, 397=cow2, 955=cow_beef).
    // All three types respond to [opnpcu,cow/cow2/cow_beef] with bucket_empty.
    let cow = bot.findNearbyNpc('Cow');
    if (!cow) {
        await bot.waitForTicks(5);
        cow = bot.findNearbyNpc('Cow');
        if (!cow) {
            throw new Error(`No cow found near (${bot.player.x},${bot.player.z})`);
        }
    }

    bot.log('EVENT', `Found cow at (${cow.x},${cow.z})`);

    // Use bucket on cow
    await bot.useItemOnNpcDirect('Bucket', cow);
    await bot.waitForTicks(5);

    // Verify we got bucket of milk
    const milk = bot.findItem('Bucket of milk');
    if (!milk) {
        throw new Error('Failed to milk cow -- no Bucket of milk in inventory');
    }
    bot.log('EVENT', `Got bucket of milk (id=${milk.id})`);
}

/**
 * Pick grain from the wheat field near the windmill.
 * Wheat loc has op2=Pick (from pickables.rs2).
 * The wheat field is fenced with a gate.
 */
async function getGrain(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Picking grain from wheat field ===');

    // Walk near the wheat field (outside the fence)
    await bot.walkToWithPathfinding(3160, 3290);
    bot.log('STATE', `Near wheat field: pos=(${bot.player.x},${bot.player.z})`);

    // Log nearby locs to find gate
    const nearbyLocs = bot.findAllNearbyLocs(10);
    const gates = nearbyLocs.filter(l => l.displayName === 'Gate');
    bot.log('STATE', `Gates near wheat field: ${gates.map(g => `${g.debugname}@(${g.x},${g.z})`).join(', ')}`);

    // Open gate to enter wheat field
    await bot.openGate(10);
    await bot.waitForTicks(2);

    // Walk into the wheat field
    try {
        await bot.walkToWithPathfinding(3163, 3292);
    } catch {
        bot.log('STATE', `Cannot enter wheat field from (${bot.player.x},${bot.player.z}), trying another direction`);
        // Try from a different approach
        await bot.walkToWithPathfinding(3160, 3295);
        await bot.openGate(10);
        await bot.waitForTicks(2);
        await bot.walkToWithPathfinding(3163, 3295);
    }
    bot.log('STATE', `In wheat field: pos=(${bot.player.x},${bot.player.z})`);

    // Find wheat loc nearby
    const wheat = bot.findNearbyLoc('wheat', 20);
    if (!wheat) {
        throw new Error(`No wheat found near (${bot.player.x},${bot.player.z})`);
    }

    bot.log('EVENT', `Found wheat at (${wheat.x},${wheat.z})`);

    // Pick wheat (op2)
    await bot.interactLoc(wheat, 2);
    await bot.waitForTicks(5);

    // Verify we got grain
    const grain = bot.findItem('Grain');
    if (!grain) {
        throw new Error('Failed to pick grain -- no Grain in inventory');
    }
    bot.log('EVENT', `Got grain (id=${grain.id})`);
}

/**
 * Mill grain into flour at the windmill.
 * Steps:
 * 1. Go to windmill level 2 (hopper floor)
 * 2. Use grain on hopper
 * 3. Operate hopper controls
 * 4. Go down to level 0 (flour bin floor)
 * 5. Take flour from flour bin (with pot in inventory)
 */
async function millFlour(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Milling grain into flour ===');

    // Walk to the windmill entrance. The windmill has double doors at (3166-3167, 3302).
    await bot.walkToWithPathfinding(3168, 3302);
    bot.log('STATE', `Near windmill: pos=(${bot.player.x},${bot.player.z})`);

    // Open the double doors (openbankdoor_l at east side)
    await bot.openDoor('openbankdoor_l');
    await bot.waitForTicks(1);

    // Walk through the door into the windmill
    await bot.walkToWithPathfinding(3166, 3305);
    bot.log('STATE', `At windmill: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // The windmill has ladders connecting floors:
    // Ground (level 0) -> Level 1 -> Level 2 (hopper floor)
    // Need to climb up two levels

    // Climb from level 0 to level 1
    await climbWindmillLadder(bot, 'up');
    if (bot.player.level !== 1) {
        throw new Error(`Failed to climb to level 1: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    bot.log('STATE', `On windmill level 1: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Climb from level 1 to level 2
    await climbWindmillLadder(bot, 'up');
    if (bot.player.level as number !== 2) {
        throw new Error(`Failed to climb to level 2: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    bot.log('STATE', `On windmill level 2: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Use grain on hopper. The hopper loc is hopper_lumbridge (or hopper_full if already filled).
    let hopper = bot.findNearbyLoc('hopper_lumbridge', 10);
    if (!hopper) {
        hopper = bot.findNearbyLoc('hopper_full', 10);
    }
    if (!hopper) {
        throw new Error(`No hopper found near (${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    bot.log('EVENT', `Found hopper at (${hopper.x},${hopper.z})`);

    await bot.useItemOnLoc('Grain', 'hopper_lumbridge');
    await bot.waitForTicks(5);

    // Verify grain was used (should be gone from inventory)
    if (bot.findItem('Grain')) {
        // Try hopper_full instead
        bot.log('STATE', 'Grain still in inventory, trying hopper_full...');
        await bot.useItemOnLoc('Grain', 'hopper_full');
        await bot.waitForTicks(5);
    }

    if (bot.findItem('Grain')) {
        throw new Error('Failed to put grain in hopper -- Grain still in inventory');
    }
    bot.log('EVENT', 'Grain placed in hopper');

    // Operate hopper controls
    const controls = bot.findNearbyLoc('hoppercontrol_lumbridge', 10);
    if (!controls) {
        throw new Error(`No hopper controls found near (${bot.player.x},${bot.player.z},${bot.player.level})`);
    }

    await bot.interactLoc(controls, 1); // op1=Operate
    await bot.waitForTicks(5);
    bot.log('EVENT', 'Operated hopper controls');

    // Climb down to level 1
    await climbWindmillLadder(bot, 'down');
    if (bot.player.level as number !== 1) {
        throw new Error(`Failed to climb down to level 1: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }

    // Climb down to level 0
    await climbWindmillLadder(bot, 'down');
    if (bot.player.level as number !== 0) {
        throw new Error(`Failed to climb down to level 0: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    bot.log('STATE', `Back on windmill ground floor: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Take flour from the flour bin. The bin loc is millbase_flour (when it has flour) or millbase (empty).
    // op1 = Empty. With pot_empty in inventory, it converts pot_empty -> pot_flour.
    let flourBin = bot.findNearbyLoc('millbase_flour', 10);
    if (!flourBin) {
        flourBin = bot.findNearbyLoc('millbase', 10);
    }
    if (!flourBin) {
        throw new Error(`No flour bin found near (${bot.player.x},${bot.player.z},${bot.player.level})`);
    }

    bot.log('EVENT', `Found flour bin at (${flourBin.x},${flourBin.z})`);
    await bot.interactLoc(flourBin, 1); // op1=Empty
    await bot.waitForTicks(5);

    // Verify we got pot of flour
    const potFlour = bot.findItem('Pot of flour');
    if (!potFlour) {
        throw new Error('Failed to get pot of flour -- no Pot of flour in inventory');
    }
    bot.log('EVENT', `Got pot of flour (id=${potFlour.id})`);
}

/**
 * Climb a ladder in the windmill up or down one level.
 * The windmill uses generic ladder locs:
 * - loc_1747: Climb-up (op1) - bottom ladder
 * - loc_1746: Climb-down (op1) - top ladder
 * - loc_1748: both directions (op2=Climb-up, op3=Climb-down)
 * - loc_1750: Climb-up (op1, forceapproach=north)
 * - loc_1749: Climb-down (op1, forceapproach=north)
 *
 * We search for any nearby ladder and use the appropriate op.
 */
async function climbWindmillLadder(bot: BotAPI, direction: 'up' | 'down'): Promise<void> {
    const startLevel = bot.player.level;

    // Search for ladder locs by display name
    const allLocs = bot.findAllNearbyLocs(10);
    const ladders = allLocs.filter(l => l.displayName === 'Ladder');

    if (ladders.length === 0) {
        throw new Error(`No ladder found near (${bot.player.x},${bot.player.z},${bot.player.level})`);
    }

    bot.log('STATE', `Found ${ladders.length} ladders: ${ladders.map(l => `${l.debugname}@(${l.x},${l.z})`).join(', ')}`);

    // Try each ladder, looking for one that supports the requested direction
    for (const ladderInfo of ladders) {
        const _loc = ladderInfo.loc;
        const debugname = ladderInfo.debugname;

        if (direction === 'up') {
            // loc_1747 (Climb-up, op1), loc_1748 (op2=Climb-up), loc_1750 (Climb-up, op1)
            if (debugname === 'loc_1747' || debugname === 'loc_1750') {
                await bot.climbStairs(debugname, 1);
                await bot.waitForTicks(2);
                if (bot.player.level === startLevel + 1) return;
            } else if (debugname === 'loc_1748') {
                await bot.climbStairs(debugname, 2); // op2=Climb-up
                await bot.waitForTicks(2);
                if (bot.player.level === startLevel + 1) return;
            }
        } else {
            // loc_1746 (Climb-down, op1), loc_1748 (op3=Climb-down), loc_1749 (Climb-down, op1)
            if (debugname === 'loc_1746' || debugname === 'loc_1749') {
                await bot.climbStairs(debugname, 1);
                await bot.waitForTicks(2);
                if (bot.player.level === startLevel - 1) return;
            } else if (debugname === 'loc_1748') {
                await bot.climbStairs(debugname, 3); // op3=Climb-down
                await bot.waitForTicks(2);
                if (bot.player.level === startLevel - 1) return;
            }
        }
    }

    throw new Error(`Failed to climb ${direction} from level ${startLevel} at (${bot.player.x},${bot.player.z}). Ladders tried: ${ladders.map(l => l.debugname).join(', ')}`);
}

/**
 * Talk to the Cook in Lumbridge Castle kitchen to start the quest.
 * Dialog flow (from cook.rs2 and quest_cook.rs2):
 *   1. chatnpc "What am I to do?" -> @cooks_assistant_start
 *   2. p_choice4: pick option 1 "What's wrong?"
 *   3. @cooks_assistant_whats_wrong: chatplayer "What's wrong?"
 *   4. chatnpc about cake ingredients (multiple pages)
 *   5. p_choice2: pick option 1 "Yes, I'll help you."
 *   6. Sets %cookquest = 1
 */
async function startQuest(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Starting Cook\'s Assistant quest ===');

    await walkToKitchen(bot);

    // Talk to Cook
    const cook = bot.findNearbyNpc('Cook', 10);
    if (!cook) {
        throw new Error(`Cook not found near (${bot.player.x},${bot.player.z})`);
    }

    bot.log('STATE', `Found Cook at (${cook.x},${cook.z})`);
    await bot.interactNpc(cook, 1); // op1 = Talk-to

    const dialogOpened = await bot.waitForDialog(30);
    if (!dialogOpened) {
        throw new Error('No dialog opened after talking to Cook');
    }

    // 1. chatnpc "What am I to do?" -> continue
    await bot.continueDialog();

    // 2. p_choice4: "What's wrong?" (1), "money" (2), "not happy" (3), "Nice hat!" (4)
    const hasChoice1 = await bot.waitForDialog(10);
    if (!hasChoice1) throw new Error('No dialog: expected p_choice4');
    await bot.selectDialogOption(1); // "What's wrong?"

    // 3. chatplayer "What's wrong?" -> continue
    const hasDialog3 = await bot.waitForDialog(10);
    if (!hasDialog3) throw new Error('No dialog: expected chatplayer "What\'s wrong?"');
    await bot.continueDialog();

    // 4. chatnpc about cake ingredients - continue through multiple pages
    // "Ooh dear, I'm in a terrible mess!..." then "Unfortunately, I've forgotten..."
    const hasDialog4a = await bot.waitForDialog(10);
    if (!hasDialog4a) throw new Error('No dialog: expected chatnpc about cake');
    await bot.continueDialog();

    const hasDialog4b = await bot.waitForDialog(10);
    if (!hasDialog4b) throw new Error('No dialog: expected chatnpc about ingredients');
    await bot.continueDialog();

    // 5. p_choice2: "Yes, I'll help you." (1), "No..." (2)
    const hasChoice2 = await bot.waitForDialog(10);
    if (!hasChoice2) throw new Error('No dialog: expected p_choice2');
    await bot.selectDialogOption(1); // "Yes, I'll help you."

    // 6. chatplayer "Yes, I'll help you." -> continue
    const hasDialog6 = await bot.waitForDialog(10);
    if (!hasDialog6) throw new Error('No dialog: expected chatplayer "Yes, I\'ll help you."');
    await bot.continueDialog();

    // 7. chatnpc "Oh thank you..." -> continue
    const hasDialog7 = await bot.waitForDialog(10);
    if (hasDialog7) {
        await bot.continueDialog();
    }

    // Continue any remaining dialogs
    await bot.continueRemainingDialogs(5);

    await bot.waitForTicks(2);

    const varp = bot.getQuestProgress(COOK_QUEST_VARP);
    if (varp !== STAGE_STARTED) {
        throw new Error(`Quest varp after starting is ${varp}, expected ${STAGE_STARTED}`);
    }
    bot.log('EVENT', `Quest started! varp=${varp}`);
}

/**
 * Talk to the Cook to complete the quest (with all 3 items in inventory).
 * Dialog flow (from quest_cook.rs2):
 *   1. @cooks_assistant_inprogress: chatnpc "How are you getting on..."
 *   2. Since all 3 items in inv -> @cooks_assistant_completion
 *   3. chatplayer "I now have everything..."
 *   4. chatplayer "Milk, flour, and an egg!"
 *   5. chatnpc "I am saved, thank you!"
 *   6. mesbox "You give some milk, an egg and some flour to the cook."
 *   7. Items deleted, queue(cooks_quest_complete) -> reward
 */
async function completeQuest(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Completing Cook\'s Assistant quest ===');

    await walkToKitchen(bot);

    // Talk to Cook
    const cook = bot.findNearbyNpc('Cook', 10);
    if (!cook) {
        throw new Error(`Cook not found near (${bot.player.x},${bot.player.z})`);
    }

    bot.log('STATE', `Found Cook at (${cook.x},${cook.z})`);
    await bot.interactNpc(cook, 1);

    const dialogOpened = await bot.waitForDialog(30);
    if (!dialogOpened) {
        throw new Error('No dialog opened after talking to Cook for completion');
    }

    // Continue through all dialog pages. The quest script checks inventory and
    // goes to @cooks_assistant_completion if all 3 items are present.
    // Just keep continuing until dialog ends.
    for (let i = 0; i < 15; i++) {
        if (bot.isDialogOpen()) {
            if (bot.isMultiChoiceOpen()) {
                // Should not happen during completion, but handle just in case
                bot.log('STATE', 'Unexpected multi-choice during completion');
                break;
            }
            await bot.continueDialog();
        }
        const hasMore = await bot.waitForDialog(5);
        if (!hasMore) break;
    }

    // Wait for queued scripts to fire (cooks_quest_complete)
    await bot.waitForTicks(10);
    bot.dismissModals();
}

/**
 * Walk to the Lumbridge Castle kitchen where the Cook is.
 * The kitchen is on the ground floor of Lumbridge Castle.
 *
 * Castle layout (level 0):
 *   - Castle entrance double doors at x=3217: openbankdoor_l
 *   - Interior door at (3215,3211): poordooropen
 *   - South corridor leads west to stairwell at (3206,3210)
 *   - Kitchen is west of the interior, accessible from the south corridor
 *
 * The kitchen is surrounded by walls. The Cook wanders in the kitchen area.
 * We enter through the castle entrance and navigate through the interior.
 */
export async function walkToKitchen(bot: BotAPI): Promise<void> {
    if (bot.player.level !== 0) {
        throw new Error(`Cannot walk to kitchen from level ${bot.player.level} -- must be on ground floor`);
    }

    // Check if already in the kitchen area
    if (bot.player.x >= 3205 && bot.player.x <= 3212 && bot.player.z >= 3212 && bot.player.z <= 3217) {
        bot.log('STATE', `Already in kitchen area: pos=(${bot.player.x},${bot.player.z})`);
        return;
    }

    // Walk to the castle entrance and open the door
    await bot.walkToWithPathfinding(3218, 3218);
    await bot.openDoor('openbankdoor_l');

    // Walk into the castle hall
    await bot.walkToWithPathfinding(3215, 3215);

    // Open the interior door leading south
    await bot.openDoor('poordooropen');

    // Walk south through the interior door toward the stairwell corridor.
    // There's a wall at z=3211/3212 separating the corridor from the kitchen.
    // The door between corridor and kitchen is at (3208, 3211).
    // Walk to just south of the wall, near the door.
    await bot.walkToWithPathfinding(3208, 3211);

    // Open the door between the corridor and the kitchen.
    await bot.openDoor('inaccastledoubledoorropen');
    await bot.waitForTicks(1);

    // Walk through the door into the kitchen (north)
    await bot.walkToWithPathfinding(3209, 3214);
    bot.log('STATE', `At kitchen: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
}

/**
 * Build the Cook's Assistant state machine.
 * States: earn-coins, buy-supplies, start-quest, get-egg, get-milk, get-flour, deliver-to-cook
 */
export function buildCooksAssistantStates(bot: BotAPI): BotState {
    return {
        name: 'cooks-assistant',
        isComplete: () => bot.getQuestProgress(COOK_QUEST_VARP) === STAGE_COMPLETE,
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
                    await earnCoins(bot, 10);
                }
            },
            {
                name: 'buy-supplies',
                isComplete: () => bot.findItem('Pot') !== null && bot.findItem('Bucket') !== null,
                run: async () => {
                    await buyFromGeneralStore(bot, [
                        { name: 'Pot', qty: 1 },
                        { name: 'Bucket', qty: 1 }
                    ]);
                }
            },
            {
                name: 'start-quest',
                isComplete: () => bot.getQuestProgress(COOK_QUEST_VARP) >= STAGE_STARTED,
                run: async () => {
                    await startQuest(bot);
                }
            },
            {
                name: 'get-egg',
                isComplete: () => bot.findItem('Egg') !== null,
                run: async () => {
                    await getEgg(bot);
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
                name: 'get-flour',
                isComplete: () => bot.findItem('Pot of flour') !== null,
                run: async () => {
                    await getGrain(bot);
                    await millFlour(bot);
                }
            },
            {
                name: 'deliver-to-cook',
                isComplete: () => bot.getQuestProgress(COOK_QUEST_VARP) === STAGE_COMPLETE,
                run: async () => {
                    // Verify we have all 3 items
                    const egg = bot.findItem('Egg');
                    const milk = bot.findItem('Bucket of milk');
                    const flour = bot.findItem('Pot of flour');
                    if (!egg) throw new Error('Missing egg before quest completion');
                    if (!milk) throw new Error('Missing bucket of milk before quest completion');
                    if (!flour) throw new Error('Missing pot of flour before quest completion');
                    bot.log('EVENT', 'All 3 quest items collected!');

                    await completeQuest(bot);

                    await bot.waitForTicks(5);
                    bot.dismissModals();

                    const finalVarp = bot.getQuestProgress(COOK_QUEST_VARP);
                    const cookingSkill = bot.getSkill('Cooking');

                    if (finalVarp !== STAGE_COMPLETE) {
                        throw new Error(`Quest not complete: varp is ${finalVarp}, expected ${STAGE_COMPLETE}`);
                    }
                    if (cookingSkill.exp <= 0) {
                        throw new Error('No cooking XP gained during quest');
                    }

                    bot.log('SUCCESS', `Cook's Assistant quest complete! varp=${finalVarp}, cooking_xp=${cookingSkill.exp}`);
                }
            }
        ]
    };
}

export async function cooksAssistant(bot: BotAPI): Promise<void> {
    // === Setup: skip tutorial, start in Lumbridge ===
    await skipTutorial(bot);
    await bot.waitForTicks(2);

    bot.log('STATE', `Starting Cook's Assistant quest at (${bot.player.x},${bot.player.z},${bot.player.level})`);

    const initialVarp = bot.getQuestProgress(COOK_QUEST_VARP);
    if (initialVarp !== STAGE_NOT_STARTED) {
        throw new Error(`Quest varp is ${initialVarp}, expected ${STAGE_NOT_STARTED} (not started)`);
    }

    const root = buildCooksAssistantStates(bot);
    const snapshotDir = path.resolve(import.meta.dir, '..', 'test', 'snapshots');
    await runStateMachine(bot, { root, varpIds: [COOK_QUEST_VARP], captureSnapshots: true, snapshotDir });
}

export const metadata: ScriptMeta = {
    name: 'cooksassistant',
    type: 'quest',
    varpId: COOK_QUEST_VARP,
    varpComplete: STAGE_COMPLETE,
    maxTicks: 15000,
    run: cooksAssistant,
    buildStates: buildCooksAssistantStates,
};
