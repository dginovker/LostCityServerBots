import path from 'path';
import { BotAPI } from '../../runtime/api.js';
import { skipTutorial } from '../skip-tutorial.js';
import { type BotState, runStateMachine } from '../../runtime/state-machine.js';
import type { ScriptMeta } from '../../runtime/script-meta.js';

// Varp IDs (from content/pack/varp.pack)
const HUNT_VARP = 71;
const HUNT_STORE_EMPLOYED_VARP = 72;
const CRATE_BANANAS_VARP = 73;
const CRATE_RUM_VARP = 74;

// Quest stages (from content/scripts/general/configs/quest.constant + quest_hunt.constant)
const STAGE_NOT_STARTED = 0;
const STAGE_FETCH_RUM = 1;
const STAGE_RECEIVED_KEY = 2;
const STAGE_READ_NOTE = 3;
const STAGE_COMPLETE = 4;

// Stun/delay varps (same as other bot scripts)
const VARP_ACTION_DELAY = 58;
const VARP_STUNNED = 103;

// ---- Key locations ----

// Lumbridge spawn
const LUMBRIDGE_SPAWN_X = 3222;
const LUMBRIDGE_SPAWN_Z = 3218;

// Varrock Thessalia's clothes shop (sells white apron)
const THESSALIA_X = 3206;
const THESSALIA_Z = 3417;

// Port Sarim - Redbeard Frank area (docks, south-west)
const REDBEARD_FRANK_X = 3053;
const REDBEARD_FRANK_Z = 3251;

// Port Sarim docks - sailors are on the ship at the southern dock
const PORT_SARIM_DOCK_X = 3029;
const PORT_SARIM_DOCK_Z = 3217;

// Wydin's Food Store (Port Sarim)
const WYDIN_X = 3014;
const WYDIN_Z = 3204;

// Varrock Blue Moon Inn
const BLUE_MOON_DOOR_X = 3228;
const BLUE_MOON_DOOR_Z = 3396;
const BLUE_MOON_X = 3226;
const BLUE_MOON_Z = 3399;

// Falador Park dig spot: coord 0_46_52_55_55 = (2999, 3383) level 0
const DIG_X = 2999;
const DIG_Z = 3383;

// Spade ground spawn — on level 1 of the Blue Moon Inn at (3218,3412).
// Other F2P spawns at (2981,3369) and (3120,3359) are behind fences.
const SPADE_SPAWN_X = 3218;
const SPADE_SPAWN_Z = 3412;

// ---- Karamja locations (level 0 after crossing gangplank) ----
// Zambo's bar is near Musa Point docks (actual spawn: 2925,3143)
const ZAMBO_X = 2925;
const ZAMBO_Z = 3143;

// Luthas's banana plantation (actual spawn: 2939,3154)
const LUTHAS_X = 2939;
const LUTHAS_Z = 3154;

// Banana crate near the plantation (loc at 2943,3151; walk to adjacent tile)
const BANANA_CRATE_X = 2942;
const BANANA_CRATE_Z = 3151;

/**
 * Pickpocket men in Lumbridge to earn coins.
 */
async function earnCoins(bot: BotAPI, targetGp: number): Promise<void> {
    bot.log('STATE', `=== Earning ${targetGp}gp by pickpocketing men ===`);

    let attempts = 0;
    let successes = 0;
    const MAX_ATTEMPTS = 3000;

    while (attempts < MAX_ATTEMPTS) {
        const coins = bot.findItem('Coins');
        const currentGp = coins ? coins.count : 0;
        if (currentGp >= targetGp) {
            bot.log('EVENT', `Earned ${currentGp}gp (target: ${targetGp}gp) in ${attempts} attempts (${successes} successes)`);
            return;
        }

        // Periodic status log
        if (attempts > 0 && attempts % 200 === 0) {
            bot.log('STATE', `Pickpocket progress: ${currentGp}/${targetGp}gp, ${attempts} attempts, ${successes} successes, pos=(${bot.player.x},${bot.player.z})`);
        }

        // Dismiss any open modal interface (e.g. level-up dialog).
        bot.dismissModals();

        // Wait until stun and action_delay varps have expired.
        const stunnedUntil = bot.getVarp(VARP_STUNNED);
        const actionDelayUntil = bot.getVarp(VARP_ACTION_DELAY);
        const currentTick = bot.getCurrentTick();

        if (stunnedUntil > currentTick || actionDelayUntil > currentTick) {
            const waitUntil = Math.max(stunnedUntil, actionDelayUntil);
            const ticksToWait = waitUntil - currentTick + 1;
            await bot.waitForTicks(ticksToWait);
        }

        // Wait for engine-level delay to clear (p_delay)
        if (bot.player.delayed) {
            await bot.waitForCondition(() => !bot.player.delayed, 20);
        }

        // If we've drifted far from Lumbridge center, walk back
        const dist = Math.abs(bot.player.x - LUMBRIDGE_SPAWN_X) + Math.abs(bot.player.z - LUMBRIDGE_SPAWN_Z);
        if (dist > 15) {
            bot.log('STATE', `Drifted to (${bot.player.x},${bot.player.z}), walking back to center`);
            await bot.walkTo(LUMBRIDGE_SPAWN_X, LUMBRIDGE_SPAWN_Z);
            await bot.waitForTicks(2);
        }

        // Find a nearby Man NPC
        let man = bot.findNearbyNpc('Man');
        if (!man) {
            await bot.walkTo(LUMBRIDGE_SPAWN_X, LUMBRIDGE_SPAWN_Z);
            await bot.waitForTicks(2);
            man = bot.findNearbyNpc('Man');
            if (!man) {
                throw new Error(`No Man NPC found near (${LUMBRIDGE_SPAWN_X},${LUMBRIDGE_SPAWN_Z})`);
            }
        }

        attempts++;
        const gpBefore = currentGp;

        // Set interaction - engine will auto-walk to NPC and execute pickpocket
        await bot.interactNpc(man, 3); // op3 = Pickpocket

        // Wait for the pickpocket action to resolve.
        await bot.waitForTicks(5);

        const coinsNow = bot.findItem('Coins');
        const gpNow = coinsNow ? coinsNow.count : 0;
        if (gpNow > gpBefore) {
            successes++;
        }

        // Wait 1 tick then dismiss modals (level-up dialog)
        await bot.waitForTicks(1);
        bot.dismissModals();
    }

    const finalCoins = bot.findItem('Coins');
    throw new Error(`Failed to earn ${targetGp}gp after ${MAX_ATTEMPTS} attempts. Current gp: ${finalCoins ? finalCoins.count : 0}`);
}

/**
 * Walk from Lumbridge to Varrock via the east road.
 */
async function walkLumbridgeToVarrock(bot: BotAPI): Promise<void> {
    bot.log('STATE', 'Walking Lumbridge -> Varrock...');
    await bot.walkToWithPathfinding(3253, 3226);
    await bot.walkToWithPathfinding(3253, 3340);
    await bot.walkToWithPathfinding(3253, 3420);
}

/**
 * Walk from Varrock to Lumbridge/Draynor area.
 */
async function walkVarrockToLumbridge(bot: BotAPI): Promise<void> {
    bot.log('STATE', 'Walking Varrock -> Lumbridge...');
    await bot.walkToWithPathfinding(3253, 3420);
    await bot.walkToWithPathfinding(3253, 3340);
    await bot.walkToWithPathfinding(3253, 3226);
}

/**
 * Walk from Lumbridge area to Port Sarim (south-west).
 * Uses proven route: east side of Lumbridge -> Draynor area -> Port Sarim.
 */
async function walkLumbridgeToPortSarim(bot: BotAPI): Promise<void> {
    bot.log('STATE', 'Walking Lumbridge -> Port Sarim...');
    // Go to east side of Lumbridge bridge area, then west through Draynor
    await bot.walkToWithPathfinding(3253, 3226);
    await bot.walkToWithPathfinding(3110, 3260);
    await bot.walkToWithPathfinding(3047, 3237);
}

/**
 * Walk from Port Sarim to Varrock.
 */
async function walkPortSarimToVarrock(bot: BotAPI): Promise<void> {
    bot.log('STATE', 'Walking Port Sarim -> Varrock...');
    // Reverse proven route: Port Sarim -> Draynor -> Lumbridge -> Varrock
    await bot.walkToWithPathfinding(3047, 3237);
    await bot.walkToWithPathfinding(3110, 3260);
    await bot.walkToWithPathfinding(3253, 3226);
    await walkLumbridgeToVarrock(bot);
}

/**
 * Walk from Varrock to Falador Park area.
 */
async function walkVarrockToFalador(bot: BotAPI): Promise<void> {
    bot.log('STATE', 'Walking Varrock -> Falador Park...');
    // South from Varrock to Lumbridge area via proven route
    await bot.walkToWithPathfinding(3253, 3420);
    await bot.walkToWithPathfinding(3253, 3340);
    await bot.walkToWithPathfinding(3253, 3226);
    // West through Draynor area (proven waypoint from prince-ali-rescue)
    await bot.walkToWithPathfinding(3110, 3260);
    // South-west to Port Sarim area (proven route, avoids river crossings)
    await bot.walkToWithPathfinding(3047, 3237);
    // North along the road to Falador south gate
    await bot.walkToWithPathfinding(3007, 3258);
    await bot.walkToWithPathfinding(2984, 3307);
    await bot.walkToWithPathfinding(2965, 3339);
    // Into Falador proper
    await bot.walkToWithPathfinding(2965, 3370);
}

/**
 * Walk from Lumbridge to Falador Park.
 * Used for death recovery when respawning at Lumbridge.
 */
async function walkLumbridgeToFalador(bot: BotAPI): Promise<void> {
    bot.log('STATE', 'Walking Lumbridge -> Falador Park...');
    // East side of Lumbridge, then west through Draynor
    await bot.walkToWithPathfinding(3253, 3226);
    await bot.walkToWithPathfinding(3110, 3260);
    // South-west to Port Sarim area
    await bot.walkToWithPathfinding(3047, 3237);
    // North along the road to Falador south gate
    await bot.walkToWithPathfinding(3007, 3258);
    await bot.walkToWithPathfinding(2984, 3307);
    await bot.walkToWithPathfinding(2965, 3339);
    // Into Falador proper
    await bot.walkToWithPathfinding(2965, 3370);
}

/**
 * Buy white apron from Thessalia's clothes shop in Varrock.
 */
async function buyWhiteApron(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Buying white apron from Thessalia ===');

    await bot.walkToWithPathfinding(THESSALIA_X, THESSALIA_Z);
    bot.log('STATE', `At Thessalia: pos=(${bot.player.x},${bot.player.z})`);

    const thessalia = bot.findNearbyNpc('Thessalia');
    if (!thessalia) {
        throw new Error(`Thessalia not found near (${bot.player.x},${bot.player.z})`);
    }

    await bot.interactNpc(thessalia, 3); // op3 = Trade
    await bot.waitForTicks(3);

    // Thessalia might open a dialog first
    if (bot.isDialogOpen()) {
        await bot.continueDialog();
        await bot.waitForTicks(2);
    }

    await bot.buyFromShop('White apron', 1);
    await bot.waitForTicks(1);

    bot.dismissModals();

    const apron = bot.findItem('White apron');
    if (!apron) {
        throw new Error('Failed to buy White apron -- not in inventory after purchase');
    }
    bot.log('EVENT', `Purchased White apron (id=${apron.id})`);
}

/**
 * Talk to Redbeard Frank to start the quest.
 * Dialog flow (from redbeard_frank.rs2):
 *   1. chatnpc "Arrrh Matey!" -> continue
 *   2. multi3: "I'm in search of treasure." (1), "Arr!" (2), "Do you have anything for trade?" (3)
 *   3. Select 1: "I'm in search of treasure."
 *   4. chatplayer "I'm in search of treasure." -> continue
 *   5. chatnpc "Arr, treasure you be after eh?..." -> continue
 *   6. chatplayer "What sort of price?" -> continue
 *   7. chatnpc "Well for example if you can get me a bottle of rum..." -> continue
 *   8. chatnpc "I'd like some rum made on Karamja Island..." -> continue
 *   9. Sets %hunt = 1 (fetch_rum)
 */
async function startQuest(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Starting Pirate\'s Treasure quest ===');

    await bot.walkToWithPathfinding(REDBEARD_FRANK_X, REDBEARD_FRANK_Z);
    bot.log('STATE', `Near Redbeard Frank: pos=(${bot.player.x},${bot.player.z})`);

    await bot.talkToNpc('Redbeard Frank');

    const dialogOpened = await bot.waitForDialog(30);
    if (!dialogOpened) {
        throw new Error('No dialog opened after talking to Redbeard Frank');
    }

    // chatnpc "Arrrh Matey!" -> continue
    await bot.continueDialog();

    // multi3: select "I'm in search of treasure." (option 1)
    const hasChoice = await bot.waitForDialog(10);
    if (!hasChoice) throw new Error('No dialog: expected multi3 options');
    await bot.selectDialogOption(1);

    // chatplayer "I'm in search of treasure." -> continue
    const hasDialog2 = await bot.waitForDialog(10);
    if (!hasDialog2) throw new Error('No dialog after selecting treasure option');
    await bot.continueDialog();

    // chatnpc "Arr, treasure you be after eh?..." -> continue
    const hasDialog3 = await bot.waitForDialog(10);
    if (!hasDialog3) throw new Error('No dialog: expected chatnpc about treasure');
    await bot.continueDialog();

    // chatplayer "What sort of price?" -> continue
    const hasDialog4 = await bot.waitForDialog(10);
    if (!hasDialog4) throw new Error('No dialog: expected chatplayer about price');
    await bot.continueDialog();

    // chatnpc "Well for example if you can get me a bottle of rum..." -> continue
    const hasDialog5 = await bot.waitForDialog(10);
    if (!hasDialog5) throw new Error('No dialog: expected chatnpc about rum');
    await bot.continueDialog();

    // chatnpc "I'd like some rum made on Karamja Island..." -> continue
    const hasDialog6 = await bot.waitForDialog(10);
    if (!hasDialog6) throw new Error('No dialog: expected chatnpc about Karamja rum');
    await bot.continueDialog();

    // Continue any remaining dialogs
    await bot.continueRemainingDialogs(5);

    await bot.waitForTicks(2);
    bot.dismissModals();

    const varp = bot.getQuestProgress(HUNT_VARP);
    if (varp !== STAGE_FETCH_RUM) {
        throw new Error(`Quest varp after starting is ${varp}, expected ${STAGE_FETCH_RUM}`);
    }
    bot.log('EVENT', `Quest started! varp=${varp}`);
}

/**
 * Sail from Port Sarim to Karamja.
 * Talk to one of the sailors (Captain Tobias, Seaman Lorris, Seaman Thresnor).
 * Dialog:
 *   1. chatnpc "Do you want to go on a trip to Karamja?" -> continue
 *   2. chatnpc "The trip will cost you 30 coins." -> continue
 *   3. p_choice2: "Yes please." (1), "No, thank you." (2)
 *   4. Select 1: "Yes please."
 *   5. chatplayer "Yes please." -> continue (if enough coins)
 *   6. mes "You pay the 30 coins..." -> set_sail proc runs
 *   7. Ship journey interface opens, 7 tick delay, teleport to Karamja
 *   8. mesbox "The ship arrives at Karamja." -> continue
 */
async function sailToKaramja(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Sailing Port Sarim -> Karamja ===');

    // Walk to the dock area where sailors spawn at level 0
    // Sailors: Captain Tobias (3028,3216), Seaman Lorris (3028,3221), Seaman Thresnor (3026,3217)
    await bot.walkToWithPathfinding(PORT_SARIM_DOCK_X, PORT_SARIM_DOCK_Z);
    bot.log('STATE', `At Port Sarim dock: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Find a sailor at dock level (level 0) — do NOT board gangplank first
    let sailor = bot.findNearbyNpc('Captain Tobias', 16);
    if (!sailor) sailor = bot.findNearbyNpc('Seaman Lorris', 16);
    if (!sailor) sailor = bot.findNearbyNpc('Seaman Thresnor', 16);
    if (!sailor) {
        throw new Error(`No sailor found near (${bot.player.x},${bot.player.z},${bot.player.level})`);
    }

    bot.log('STATE', `Found sailor at (${sailor.x},${sailor.z})`);
    await bot.interactNpc(sailor, 1); // Talk-to

    const dialogOpened = await bot.waitForDialog(30);
    if (!dialogOpened) {
        throw new Error('No dialog opened after talking to sailor');
    }

    // chatnpc "Do you want to go on a trip to Karamja?" -> continue
    await bot.continueDialog();

    // chatnpc "The trip will cost you 30 coins." -> continue
    const hasDialog2 = await bot.waitForDialog(10);
    if (!hasDialog2) throw new Error('No dialog: expected cost message');
    await bot.continueDialog();

    // p_choice2 or p_choice3: "Yes please." (1)
    const hasChoice = await bot.waitForDialog(10);
    if (!hasChoice) throw new Error('No dialog: expected yes/no choice');
    await bot.selectDialogOption(1); // "Yes please."

    // chatplayer "Yes please." -> continue
    const hasConfirm = await bot.waitForDialog(10);
    if (!hasConfirm) throw new Error('No dialog: expected confirmation');
    await bot.continueDialog();

    // Save position before teleport
    const prevX = bot.player.x;
    const prevZ = bot.player.z;

    // Wait for set_sail teleport (7 tick delay + some buffer)
    // The ship journey interface opens as a modal, then p_telejump happens
    bot.log('STATE', 'Waiting for ship journey teleport...');
    await bot.waitForTicks(12);

    // After teleport, there's a mesbox "The ship arrives at Karamja."
    // The player is now on the ship deck at Karamja (level 1)
    if (bot.isDialogOpen()) {
        await bot.continueDialog();
    }
    await bot.waitForTicks(2);
    bot.dismissModals();

    // Check that we've been teleported
    if (bot.player.x === prevX && bot.player.z === prevZ) {
        throw new Error(`Sailing teleport did not occur -- still at (${bot.player.x},${bot.player.z})`);
    }

    bot.log('STATE', `Arrived at Karamja ship: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Cross the gangplank to get to ground level.
    // The Karamja ship uses sarimshipplank_off (at 2956,3144 level=1) for disembarking.
    const disembarkPlank = bot.findNearbyLoc('sarimshipplank_off', 16);
    if (disembarkPlank) {
        bot.log('STATE', `Found disembark gangplank at (${disembarkPlank.x},${disembarkPlank.z})`);
        await bot.interactLoc(disembarkPlank, 1);
    } else {
        throw new Error(`No disembark gangplank found at Karamja ship (${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    await bot.waitForTicks(5);

    bot.log('STATE', `On Karamja ground: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
}

/**
 * Buy Karamja rum from Zambo's bar.
 * Dialog:
 *   1. chatnpc "Hey, are you wanting to try some of my fine wines..." -> continue
 *   2. p_choice2: "Yes please." (1), "No, thank you." (2)
 *   3. Select 1 -> opens shop interface (p_opnpc(3))
 *   4. Buy karamja_rum from shop
 */
async function buyRum(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Buying Karamja rum from Zambo ===');

    await bot.walkToWithPathfinding(ZAMBO_X, ZAMBO_Z);
    bot.log('STATE', `At Zambo area: pos=(${bot.player.x},${bot.player.z})`);

    const zambo = bot.findNearbyNpc('Zambo', 16);
    if (!zambo) {
        throw new Error(`Zambo not found near (${bot.player.x},${bot.player.z})`);
    }

    // Talk to Zambo to open shop
    await bot.interactNpc(zambo, 1); // Talk-to

    const dialogOpened = await bot.waitForDialog(30);
    if (!dialogOpened) {
        throw new Error('No dialog opened after talking to Zambo');
    }

    // chatnpc "Hey, are you wanting to try some of my fine wines..." -> continue
    await bot.continueDialog();

    // p_choice2: "Yes please." (1)
    const hasChoice = await bot.waitForDialog(10);
    if (!hasChoice) throw new Error('No dialog: expected yes/no choice for Zambo');
    await bot.selectDialogOption(1); // "Yes please." -> opens shop

    await bot.waitForTicks(3);

    // Buy karamja rum from the shop
    await bot.buyFromShop('Karamjan rum', 1);
    await bot.waitForTicks(1);

    bot.dismissModals();

    const rum = bot.findItem('Karamjan rum');
    if (!rum) {
        throw new Error('Failed to buy Karamjan rum -- not in inventory after purchase');
    }
    bot.log('EVENT', `Purchased Karamjan rum (id=${rum.id})`);
}

/**
 * Get a job at Luthas's banana plantation.
 * Dialog:
 *   1. chatnpc "Hello I'm Luthas..." -> continue
 *   2. multi2: "Could you offer me employment?" (1), "That customs officer..." (2)
 *   3. Select 1
 *   4. chatplayer "Could you offer me employment..." -> continue
 *   5. chatnpc "Yes, I can sort something out..." -> continue
 *   6. chatnpc "If you could fill it up with bananas..." -> continue
 *   7. Sets hunt_store_employed bit 0
 */
async function getPlantationJob(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Getting job at banana plantation ===');

    await bot.walkToWithPathfinding(LUTHAS_X, LUTHAS_Z);
    bot.log('STATE', `Near Luthas: pos=(${bot.player.x},${bot.player.z})`);

    await bot.talkToNpc('Luthas');

    const dialogOpened = await bot.waitForDialog(30);
    if (!dialogOpened) {
        throw new Error('No dialog opened after talking to Luthas');
    }

    // chatnpc "Hello I'm Luthas..." -> continue
    await bot.continueDialog();

    // multi2: "Could you offer me employment..." (1)
    const hasChoice = await bot.waitForDialog(10);
    if (!hasChoice) throw new Error('No dialog: expected employment choice');
    await bot.selectDialogOption(1);

    // chatplayer "Could you offer me employment..." -> continue
    const hasDialog3 = await bot.waitForDialog(10);
    if (!hasDialog3) throw new Error('No dialog: expected chatplayer employment');
    await bot.continueDialog();

    // chatnpc "Yes, I can sort something out..." -> continue
    const hasDialog4 = await bot.waitForDialog(10);
    if (!hasDialog4) throw new Error('No dialog: expected chatnpc employment response');
    await bot.continueDialog();

    // chatnpc "If you could fill it up with bananas..." -> continue
    const hasDialog5 = await bot.waitForDialog(10);
    if (!hasDialog5) throw new Error('No dialog: expected chatnpc about bananas');
    await bot.continueDialog();

    // Continue any remaining dialogs
    await bot.continueRemainingDialogs(5);

    await bot.waitForTicks(2);
    bot.dismissModals();

    const employed = bot.getVarp(HUNT_STORE_EMPLOYED_VARP);
    if ((employed & 1) === 0) {
        throw new Error(`Not employed at plantation: hunt_store_employed=${employed}`);
    }
    bot.log('EVENT', `Got plantation job! hunt_store_employed=${employed}`);
}

/**
 * Stash rum in the banana crate, then fill it with bananas.
 * Steps:
 *   1. Use karamja_rum on bananacrate
 *   2. Pick 10 bananas from banana trees
 *   3. Use each banana on the crate
 */
async function smuggleRum(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Smuggling rum in banana crate ===');

    // Walk to the banana crate area
    await bot.walkToWithPathfinding(BANANA_CRATE_X, BANANA_CRATE_Z);
    bot.log('STATE', `Near banana crate: pos=(${bot.player.x},${bot.player.z})`);

    // Use rum on the banana crate
    await bot.useItemOnLoc('Karamjan rum', 'bananacrate');
    await bot.waitForTicks(3);
    bot.dismissModals();

    const crateRum = bot.getVarp(CRATE_RUM_VARP);
    if (crateRum !== 1) {
        throw new Error(`Rum not stashed in crate: crate_rum=${crateRum}`);
    }
    bot.log('EVENT', 'Rum stashed in banana crate');

    // Now pick 10 bananas and put them in the crate.
    // Banana trees are 2x2 tiles and cycle through stages (full->four->three->two->one->empty).
    // Each tree gives 5 bananas before becoming empty (respawns after 500 ticks).
    // We need to find non-empty trees by searching for specific debugnames.
    const NON_EMPTY_TREES = ['bananatreefull', 'bananatreefour', 'bananatreethree', 'bananatreetwo', 'bananatreeone'];

    // Plantation area waypoints to search for trees — walk to these and pick nearby
    const TREE_SEARCH_SPOTS = [
        [2920, 3160], [2924, 3158], [2928, 3158], [2914, 3162],
        [2918, 3156], [2926, 3162], [2922, 3164], [2930, 3162]
    ];
    let searchIdx = 0;

    for (let i = 0; i < 10; i++) {
        // Walk to a plantation area search spot to be close to trees
        const [sx, sz] = TREE_SEARCH_SPOTS[searchIdx % TREE_SEARCH_SPOTS.length];
        await bot.walkToWithPathfinding(sx, sz);

        // Find a non-empty banana tree nearby
        let bananaTree = null;
        for (const treeName of NON_EMPTY_TREES) {
            bananaTree = bot.findNearbyLoc(treeName, 16);
            if (bananaTree) break;
        }

        // If no tree at this spot, try other spots
        if (!bananaTree) {
            for (let attempt = 0; attempt < TREE_SEARCH_SPOTS.length; attempt++) {
                searchIdx++;
                const [sx2, sz2] = TREE_SEARCH_SPOTS[searchIdx % TREE_SEARCH_SPOTS.length];
                await bot.walkToWithPathfinding(sx2, sz2);
                for (const treeName of NON_EMPTY_TREES) {
                    bananaTree = bot.findNearbyLoc(treeName, 16);
                    if (bananaTree) break;
                }
                if (bananaTree) break;
            }
        }

        if (!bananaTree) {
            throw new Error(`No non-empty banana tree found near (${bot.player.x},${bot.player.z}) after searching plantation`);
        }

        // interactLoc handles pathfinding to the loc via findPathToLocSegment
        await bot.interactLoc(bananaTree, 1); // op1 = Search (pick banana)
        await bot.waitForTicks(5);

        const banana = bot.findItem('Banana');
        if (!banana) {
            // Tree might have been depleted between finding and interacting — try next spot
            bot.log('STATE', `No banana from tree at (${bananaTree.x},${bananaTree.z}), advancing search`);
            searchIdx++;
            i--; // retry this banana
            continue;
        }

        // Use banana on the crate
        await bot.walkToWithPathfinding(BANANA_CRATE_X, BANANA_CRATE_Z);
        await bot.useItemOnLoc('Banana', 'bananacrate');
        await bot.waitForTicks(5);
        bot.dismissModals();

        const bananas = bot.getVarp(CRATE_BANANAS_VARP);
        bot.log('EVENT', `Packed banana ${i + 1}/10 into crate (crate_bananas=${bananas})`);
    }

    const finalBananas = bot.getVarp(CRATE_BANANAS_VARP);
    if (finalBananas !== 10) {
        throw new Error(`Crate not full: crate_bananas=${finalBananas}, expected 10`);
    }
    bot.log('EVENT', 'Banana crate is full with rum hidden inside');
}

/**
 * Talk to Luthas to ship the crate.
 * Dialog when crate is full:
 *   1. chatnpc "Have you completed your task yet?" (if crate not reported done)
 *   OR if crate_bananas=10:
 *   1. chatplayer "I've filled a crate with bananas." -> continue
 *   2. chatnpc "Well done, here's your payment." -> continue
 *   3. mes "Luthas hands you 30 coins."
 *   4. Resets crate_bananas=0, sets crate_rum=2 (shipped to Wydin's)
 */
async function shipCrate(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Shipping crate to Port Sarim ===');

    await bot.walkToWithPathfinding(LUTHAS_X, LUTHAS_Z);
    await bot.talkToNpc('Luthas');

    const dialogOpened = await bot.waitForDialog(30);
    if (!dialogOpened) {
        throw new Error('No dialog opened after talking to Luthas about shipment');
    }

    // chatplayer "I've filled a crate with bananas." -> continue
    await bot.continueDialog();

    // chatnpc "Well done, here's your payment." -> continue
    const hasDialog2 = await bot.waitForDialog(10);
    if (!hasDialog2) throw new Error('No dialog: expected well done response');
    await bot.continueDialog();

    // Wait for the payment and crate shipping
    await bot.waitForTicks(5);

    // There might be a multi4 choice after payment
    if (bot.isDialogOpen()) {
        if (bot.isMultiChoiceOpen()) {
            // multi4: "Will you pay me for another crate full?" (1), "Thank you, I'll be on my way" (2), etc.
            await bot.selectDialogOption(2); // "Thank you, I'll be on my way"
            await bot.waitForDialog(5);
            if (bot.isDialogOpen()) {
                await bot.continueDialog();
            }
        } else {
            await bot.continueDialog();
        }
    }

    await bot.continueRemainingDialogs(5);
    await bot.waitForTicks(2);
    bot.dismissModals();

    const crateRum = bot.getVarp(CRATE_RUM_VARP);
    if (crateRum !== 2) {
        throw new Error(`Crate rum not shipped: crate_rum=${crateRum}, expected 2`);
    }
    bot.log('EVENT', `Crate shipped! crate_rum=${crateRum}`);
}

/**
 * Sail from Karamja back to Port Sarim via the Customs Officer.
 * Dialog:
 *   1. chatnpc "Can I help you?" -> continue
 *   2. multi2: "Can I journey on this ship?" (1), "Does Karamja have unusual customs..." (2)
 *   3. Select 1
 *   After quest progress >= 2 (plantation employed + crate shipped):
 *   4. chatnpc "Hey, I know you, you work at the plantation." -> continue
 *   5. chatnpc "I don't think you'll try smuggling anything..." -> continue
 *   6. p_choice2: "Ok." (1), "Oh, I'll not bother then." (2)
 *   7. Select 1: "Ok."
 *   8. chatplayer "Ok." -> pays 30 coins, set_sail
 *
 *   Before quest progress (hunt_store_employed bit 0 set, no rum in inv):
 *   4. chatnpc "You need to be searched before you can board." -> continue
 *   5. multi3: "Why?" (1), "Search away..." (2), "You're not putting..." (3)
 *   6. Select 2: "Search away..."
 *   7. chatnpc "Well you've got some odd stuff..." -> continue
 *   8. p_choice2: "Ok." (1), "Oh, I'll not bother then." (2)
 *   9. Select 1
 *   10. chatplayer "Ok." -> pays 30 coins, set_sail
 */
async function sailToPortSarim(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Sailing Karamja -> Port Sarim ===');

    // Walk to the customs officer area (Musa Point docks)
    await bot.walkToWithPathfinding(2954, 3147);
    bot.log('STATE', `Near customs area: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    const customs = bot.findNearbyNpc('Customs Officer', 16);
    if (!customs) {
        throw new Error(`Customs Officer not found near (${bot.player.x},${bot.player.z})`);
    }

    await bot.interactNpc(customs, 1); // Talk-to

    const dialogOpened = await bot.waitForDialog(30);
    if (!dialogOpened) {
        throw new Error('No dialog opened after talking to Customs Officer');
    }

    // chatnpc "Can I help you?" -> continue
    await bot.continueDialog();

    // multi2: "Can I journey on this ship?" (1)
    const hasChoice1 = await bot.waitForDialog(10);
    if (!hasChoice1) throw new Error('No dialog: expected journey choice');
    await bot.selectDialogOption(1);

    // chatplayer "Can I journey on this ship?" -> continue
    const hasDialog3 = await bot.waitForDialog(10);
    if (!hasDialog3) throw new Error('No dialog: expected chatplayer journey');
    await bot.continueDialog();

    // The customs officer script checks %hunt >= 2 (received_key or later).
    // At this point, hunt=1 (fetch_rum), so the bot goes through the search path:
    //   chatnpc "You need to be searched..." -> continue
    //   multi3: "Why?"(1), "Search away..."(2), "You're not putting..."(3) -> select 2
    //   chatplayer "Search away, I have nothing to hide." -> continue
    //   Since no rum in inv: chatnpc "Well you've got some odd stuff... 30 coins." -> continue
    //   p_choice2: "Ok."(1), "Oh, I'll not bother then."(2) -> select 1
    //   chatplayer "Ok." -> continue, pays 30gp, set_sail
    //
    // If hunt >= 2 (e.g. second trip), the customs officer recognizes us:
    //   chatnpc "Hey, I know you, you work at the plantation." -> continue
    //   chatnpc "I don't think you'll try smuggling..." -> continue
    //   p_choice2: "Ok."(1), "Oh, I'll not bother then."(2) -> select 1
    //   chatplayer "Ok." -> continue

    const huntVarp = bot.getVarp(HUNT_VARP);

    if (huntVarp >= 2) {
        // Recognized as plantation worker - skip search
        // chatnpc "Hey, I know you..." -> continue
        const hasDialog4a = await bot.waitForDialog(10);
        if (!hasDialog4a) throw new Error('No dialog: expected plantation recognition');
        await bot.continueDialog();

        // chatnpc "I don't think you'll try smuggling..." -> continue
        const hasDialog4b = await bot.waitForDialog(10);
        if (!hasDialog4b) throw new Error('No dialog: expected no smuggling message');
        await bot.continueDialog();

        // p_choice2: "Ok." (1)
        const hasPayChoice = await bot.waitForDialog(10);
        if (!hasPayChoice) throw new Error('No dialog: expected payment choice');
        await bot.selectDialogOption(1); // "Ok."
    } else {
        // Need to be searched first
        // chatnpc "You need to be searched..." -> continue
        const hasDialog4 = await bot.waitForDialog(10);
        if (!hasDialog4) throw new Error('No dialog: expected search message');
        await bot.continueDialog();

        // multi3: select "Search away, I have nothing to hide." (2)
        const hasSearchChoice = await bot.waitForDialog(10);
        if (!hasSearchChoice) throw new Error('No dialog: expected search choice');
        await bot.selectDialogOption(2); // "Search away, I have nothing to hide."

        // chatplayer "Search away, I have nothing to hide." -> continue
        const hasDialog5 = await bot.waitForDialog(10);
        if (!hasDialog5) throw new Error('No dialog: expected search away chatplayer');
        await bot.continueDialog();

        // chatnpc "Well you've got some odd stuff... 30 coins." -> continue
        const hasDialog6 = await bot.waitForDialog(10);
        if (!hasDialog6) throw new Error('No dialog: expected odd stuff message');
        await bot.continueDialog();

        // p_choice2: "Ok." (1)
        const hasPayChoice = await bot.waitForDialog(10);
        if (!hasPayChoice) throw new Error('No dialog: expected payment choice after search');
        await bot.selectDialogOption(1); // "Ok."
    }

    // chatplayer "Ok." -> continue
    const hasConfirm = await bot.waitForDialog(10);
    if (hasConfirm) await bot.continueDialog();

    // Save position before teleport
    const prevX = bot.player.x;
    const prevZ = bot.player.z;

    // Wait for set_sail teleport
    bot.log('STATE', 'Waiting for return ship journey teleport...');
    await bot.waitForTicks(12);

    // After teleport, mesbox "The ship arrives at Port Sarim."
    if (bot.isDialogOpen()) {
        await bot.continueDialog();
    }
    await bot.waitForTicks(2);
    bot.dismissModals();

    if (bot.player.x === prevX && bot.player.z === prevZ) {
        throw new Error(`Return sailing teleport did not occur -- still at (${bot.player.x},${bot.player.z})`);
    }

    bot.log('STATE', `Arrived at Port Sarim ship: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Cross the gangplank to get to ground level.
    // The ship in Port Sarim uses karamjashipplank_off (at 3031,3217 level=1) for disembarking.
    const disembarkPlank = bot.findNearbyLoc('karamjashipplank_off', 16);
    if (disembarkPlank) {
        bot.log('STATE', `Found disembark gangplank at (${disembarkPlank.x},${disembarkPlank.z})`);
        await bot.interactLoc(disembarkPlank, 1);
        await bot.waitForTicks(5);
    } else {
        throw new Error(`No disembark gangplank found at Port Sarim ship (${bot.player.x},${bot.player.z},${bot.player.level})`);
    }

    bot.log('STATE', `On Port Sarim ground: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
}

/**
 * Get a job at Wydin's store, equip white apron, enter back room, search grocery crate.
 *
 * Dialog with Wydin (wydin.rs2):
 * If hunt=1 (fetch_rum):
 *   1. chatnpc "Welcome to my food store!..." -> continue
 *   2. multi4: "Yes please."(1), "No, thank you."(2), "What can you recommend?"(3), "Can I get a job here?"(4)
 *   3. Select 4: "Can I get a job here?"
 *   4. chatplayer "Can I get a job here?" -> continue
 *   5. chatnpc "Well, you're keen... Have you got your own white apron?" -> continue
 *   6. If white apron in inv: chatplayer "Yes, I have one right here." -> continue
 *   7. chatnpc "Wow - you are well prepared!..." -> continue
 *   8. Sets hunt_store_employed bit 1
 *
 * Then enter back room through wydindoor (requires bit 1 set + white apron worn).
 * Search grocerycrate (oploc1): if crate_rum=2, get rum from crate.
 */
async function retrieveRumFromWydin(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Retrieving rum from Wydin\'s store ===');

    await bot.walkToWithPathfinding(WYDIN_X, WYDIN_Z);
    bot.log('STATE', `At Wydin store: pos=(${bot.player.x},${bot.player.z})`);

    // Talk to Wydin to ask for a job
    await bot.talkToNpc('Wydin');

    const dialogOpened = await bot.waitForDialog(30);
    if (!dialogOpened) {
        throw new Error('No dialog opened after talking to Wydin');
    }

    // chatnpc "Welcome to my food store!..." -> continue
    await bot.continueDialog();

    // multi4: select "Can I get a job here?" (4)
    const hasChoice = await bot.waitForDialog(10);
    if (!hasChoice) throw new Error('No dialog: expected Wydin shop choices');
    await bot.selectDialogOption(4); // "Can I get a job here?"

    // chatplayer "Can I get a job here?" -> continue
    const hasDialog3 = await bot.waitForDialog(10);
    if (!hasDialog3) throw new Error('No dialog: expected chatplayer job request');
    await bot.continueDialog();

    // chatnpc "Well, you're keen... Have you got your own white apron?" -> continue
    const hasDialog4 = await bot.waitForDialog(10);
    if (!hasDialog4) throw new Error('No dialog: expected apron question');
    await bot.continueDialog();

    // chatplayer "Yes, I have one right here." -> continue
    const hasDialog5 = await bot.waitForDialog(10);
    if (!hasDialog5) throw new Error('No dialog: expected yes apron response');
    await bot.continueDialog();

    // chatnpc "Wow - you are well prepared!..." -> continue
    const hasDialog6 = await bot.waitForDialog(10);
    if (!hasDialog6) throw new Error('No dialog: expected hired response');
    await bot.continueDialog();

    // Continue any remaining dialogs
    await bot.continueRemainingDialogs(5);

    await bot.waitForTicks(2);
    bot.dismissModals();

    const employed = bot.getVarp(HUNT_STORE_EMPLOYED_VARP);
    if ((employed & 2) === 0) {
        throw new Error(`Not employed at Wydin's: hunt_store_employed=${employed}`);
    }
    bot.log('EVENT', `Got Wydin job! hunt_store_employed=${employed}`);

    // Now equip the white apron and enter the back room
    await bot.equipItem('White apron');
    await bot.waitForTicks(1);
    bot.log('EVENT', 'Equipped white apron');

    // Open the back room door (wydindoor)
    // The door check requires: hunt_store_employed bit 1 = true AND white_apron worn
    const wydindoor = bot.findNearbyLoc('wydindoor', 16);
    if (!wydindoor) {
        throw new Error(`wydindoor not found near (${bot.player.x},${bot.player.z})`);
    }
    bot.log('STATE', `Found wydindoor at (${wydindoor.x},${wydindoor.z})`);
    await bot.interactLoc(wydindoor, 1); // op1 = Open
    await bot.waitForTicks(3);

    // Walk through the door into the back room
    // The back room is to the west of the door
    await bot.walkToWithPathfinding(3010, 3207);
    bot.log('STATE', `In back room: pos=(${bot.player.x},${bot.player.z})`);

    // Search the grocery crate to find the rum
    const groceryCrate = bot.findNearbyLoc('grocerycrate', 16);
    if (!groceryCrate) {
        throw new Error(`grocerycrate not found near (${bot.player.x},${bot.player.z})`);
    }

    bot.log('STATE', `Found grocerycrate at (${groceryCrate.x},${groceryCrate.z})`);
    await bot.interactLoc(groceryCrate, 1); // op1 = Search

    // The search script shows "There are a lot of bananas..." then if crate_rum=2,
    // "You find your bottle of rum..." and adds karamja_rum to inv
    await bot.waitForTicks(5);

    // After the initial messages, there's a p_choice2 "Do you want to take a banana?"
    // We need to dismiss the "take a banana" choice
    if (bot.isDialogOpen() || bot.isMultiChoiceOpen()) {
        if (bot.isMultiChoiceOpen()) {
            await bot.selectDialogOption(2); // "No" - don't take a banana
        } else {
            await bot.continueDialog();
            await bot.waitForTicks(2);
            if (bot.isMultiChoiceOpen()) {
                await bot.selectDialogOption(2); // "No"
            }
        }
    }

    await bot.waitForTicks(2);
    bot.dismissModals();

    const rum = bot.findItem('Karamjan rum');
    if (!rum) {
        throw new Error('Failed to retrieve Karamjan rum from grocery crate');
    }
    bot.log('EVENT', `Retrieved Karamjan rum from Wydin's back room (id=${rum.id})`);
}

/**
 * Give rum to Redbeard Frank and receive the chest key.
 * Dialog (from redbeard_frank.rs2):
 *   1. chatnpc "Arrrh Matey!" -> continue
 *   2. @redboard_progress: chatnpc "Have ye brought some rum..." -> continue
 *   3. Since we have rum: chatplayer "Yes, I've got some." -> continue
 *   4. @redbeard_hand_rum: chatnpc about One-Eyed Hector -> continue x3
 *   5. objbox "Frank happily takes the rum... and hands you a key." -> continue
 *   6. chatnpc about Blue Moon Inn -> continue x2
 *   7. p_choice2: "Ok thanks, I'll go and get it." (1), "So why didn't you ever get it?" (2)
 *   8. Select 1
 *   9. Sets %hunt = 2 (received_key), gives chest_key
 */
async function giveRumToFrank(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Giving rum to Redbeard Frank ===');

    await bot.walkToWithPathfinding(REDBEARD_FRANK_X, REDBEARD_FRANK_Z);

    await bot.talkToNpc('Redbeard Frank');

    const dialogOpened = await bot.waitForDialog(30);
    if (!dialogOpened) {
        throw new Error('No dialog opened after talking to Redbeard Frank for rum');
    }

    // chatnpc "Arrrh Matey!" -> continue
    await bot.continueDialog();

    // chatnpc "Have ye brought some rum..." -> continue
    const hasDialog2 = await bot.waitForDialog(10);
    if (!hasDialog2) throw new Error('No dialog: expected rum question');
    await bot.continueDialog();

    // chatplayer "Yes, I've got some." -> continue
    const hasDialog3 = await bot.waitForDialog(10);
    if (!hasDialog3) throw new Error('No dialog: expected yes response');
    await bot.continueDialog();

    // chatnpc about One-Eyed Hector - multiple pages
    // "Now a deal's a deal..."
    const hasDialog4 = await bot.waitForDialog(10);
    if (!hasDialog4) throw new Error('No dialog: expected Hector story');
    await bot.continueDialog();

    // "Hector were very successful..."
    const hasDialog5 = await bot.waitForDialog(10);
    if (!hasDialog5) throw new Error('No dialog: expected Hector story pt2');
    await bot.continueDialog();

    // "Hector were killed..."
    const hasDialog6 = await bot.waitForDialog(10);
    if (!hasDialog6) throw new Error('No dialog: expected Hector story pt3');
    await bot.continueDialog();

    // objbox "Frank happily takes the rum... and hands you a key."
    const hasObjbox = await bot.waitForDialog(10);
    if (!hasObjbox) throw new Error('No dialog: expected key objbox');
    await bot.continueDialog();

    // chatnpc "This be Hector's key..."
    const hasDialog8 = await bot.waitForDialog(10);
    if (!hasDialog8) throw new Error('No dialog: expected chest info');
    await bot.continueDialog();

    // chatnpc "With any luck his treasure will be in there."
    const hasDialog9 = await bot.waitForDialog(10);
    if (!hasDialog9) throw new Error('No dialog: expected treasure info');
    await bot.continueDialog();

    // p_choice2: "Ok thanks, I'll go and get it." (1)
    const hasChoice = await bot.waitForDialog(10);
    if (!hasChoice) throw new Error('No dialog: expected ok/why choice');
    await bot.selectDialogOption(1); // "Ok thanks, I'll go and get it."

    // chatplayer "Ok thanks, I'll go and get it." -> continue
    const hasFinal = await bot.waitForDialog(10);
    if (hasFinal) await bot.continueDialog();

    await bot.continueRemainingDialogs(5);
    await bot.waitForTicks(2);
    bot.dismissModals();

    const varp = bot.getQuestProgress(HUNT_VARP);
    if (varp !== STAGE_RECEIVED_KEY) {
        throw new Error(`Quest varp after giving rum is ${varp}, expected ${STAGE_RECEIVED_KEY}`);
    }

    const key = bot.findItem('Chest key');
    if (!key) {
        throw new Error('No chest key in inventory after giving rum');
    }
    bot.log('EVENT', `Received chest key! varp=${varp}, key id=${key.id}`);
}

/**
 * Open the pirate chest in Blue Moon Inn (Varrock) and read the message.
 * The chest is on the upper floor of the Blue Moon Inn.
 * Steps:
 *   1. Walk to Blue Moon Inn, enter
 *   2. Climb stairs to upper floor
 *   3. Find piratechest, use chest_key on it (oplocu)
 *   4. Chest opens, gives piratemessage
 *   5. Read the message (opheld1) -> sets %hunt = 3 (read_note)
 */
async function openChestAndReadNote(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Opening pirate chest in Blue Moon Inn ===');

    // Walk to Blue Moon Inn
    await bot.walkToWithPathfinding(BLUE_MOON_DOOR_X, BLUE_MOON_DOOR_Z);
    await bot.openDoor('inaccastledoubledoorropen');
    await bot.walkToWithPathfinding(BLUE_MOON_X, BLUE_MOON_Z);
    bot.log('STATE', `In Blue Moon Inn: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Find stairs/ladder to go up
    const allLocs = bot.findAllNearbyLocs(10);
    const stairs = allLocs.filter(l =>
        l.displayName === 'Staircase' || l.displayName === 'Ladder' ||
        l.debugname.includes('stair') || l.debugname.includes('ladder')
    );
    bot.log('STATE', `Nearby stairs/ladders: ${stairs.map(s => `${s.debugname}=${s.displayName}@(${s.x},${s.z})`).join(', ')}`);

    // Climb up the stairs
    if (stairs.length > 0) {
        // Try each stair/ladder looking for one that goes up
        for (const stairInfo of stairs) {
            const debugname = stairInfo.debugname;
            // loc_1725 = Staircase (op1 = Climb-up) — Blue Moon Inn ground floor
            // loc_1747 = Ladder (op1 = Climb-up)
            // loc_1750 = Ladder (op1 = Climb-up)
            // loc_1738 = Staircase (op1 = Climb-up)
            // loc_1739 = Staircase (op2=up, op3=down)
            if (debugname === 'loc_1725' || debugname === 'loc_1747' || debugname === 'loc_1750' ||
                debugname === 'loc_1738') {
                await bot.climbStairs(debugname, 1);
                await bot.waitForTicks(2);
                if ((bot.player.level as number) === 1) break;
            } else if (debugname === 'loc_1739') {
                // Mid-level staircase: op2 = climb up
                await bot.climbStairs(debugname, 2);
                await bot.waitForTicks(2);
                if ((bot.player.level as number) === 1) break;
            }
        }
    }

    if ((bot.player.level as number) !== 1) {
        throw new Error(`Failed to climb to upper floor of Blue Moon Inn: level=${bot.player.level}`);
    }
    bot.log('STATE', `On upper floor: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Find the pirate chest
    const chest = bot.findNearbyLoc('piratechest', 16);
    if (!chest) {
        // Walk around the upper floor to find it
        bot.log('STATE', 'Pirate chest not found immediately, searching...');
        const upperLocs = bot.findAllNearbyLocs(20);
        const chests = upperLocs.filter(l => l.debugname.includes('chest') || l.displayName.includes('Chest'));
        bot.log('STATE', `Chests on upper floor: ${chests.map(c => `${c.debugname}=${c.displayName}@(${c.x},${c.z})`).join(', ')}`);
        throw new Error(`piratechest not found on upper floor near (${bot.player.x},${bot.player.z})`);
    }

    bot.log('STATE', `Found pirate chest at (${chest.x},${chest.z})`);

    // The upper floor of Blue Moon Inn has internal walls/doors.
    // The bot spawns at (3230,3393) after climbing stairs, and the chest is at (3218,3396).
    // There's a wall/door around x=3222 blocking direct access.
    // Log all upper floor locs to find doors, then open them.
    const upperFloorLocs = bot.findAllNearbyLocs(20);
    const doors = upperFloorLocs.filter(l =>
        l.displayName.includes('Door') || l.displayName.includes('door') ||
        l.debugname.includes('door') || l.debugname.includes('Door')
    );
    bot.log('STATE', `Upper floor doors: ${doors.map(d => `${d.debugname}=${d.displayName}@(${d.x},${d.z})`).join(', ') || 'none'}`);
    bot.log('STATE', `All upper floor locs: ${upperFloorLocs.map(l => `${l.debugname}=${l.displayName}@(${l.x},${l.z})`).join(', ')}`);

    // Walk as far as possible toward the chest, then check for doors
    try {
        await bot.walkToWithPathfinding(chest.x + 1, chest.z);
    } catch {
        // Pathfinding failed — there's probably a door in the way
        bot.log('STATE', `Path blocked at (${bot.player.x},${bot.player.z}), looking for doors...`);

        // Try to open any nearby door
        for (const door of doors) {
            if (Math.abs(door.x - bot.player.x) <= 5 && Math.abs(door.z - bot.player.z) <= 5) {
                bot.log('ACTION', `Opening door: ${door.debugname} at (${door.x},${door.z})`);
                try {
                    await bot.openDoor(door.debugname);
                    await bot.waitForTicks(2);
                } catch (e) {
                    bot.log('STATE', `Failed to open door ${door.debugname}: ${(e as Error).message}`);
                }
            }
        }

        // Try walking again
        await bot.walkToWithPathfinding(chest.x + 1, chest.z);
    }
    await bot.waitForTicks(2);
    bot.log('STATE', `Walked near chest: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Use chest_key on the pirate chest
    await bot.useItemOnLoc('Chest key', 'piratechest');
    await bot.waitForTicks(10);
    bot.dismissModals();

    // Verify we got the pirate message
    const message = bot.findItem('Pirate message');
    if (!message) {
        throw new Error('No pirate message in inventory after opening chest');
    }
    bot.log('EVENT', `Got pirate message (id=${message.id})`);

    // Read the pirate message (opheld1) -> sets %hunt = 3 (read_note)
    await bot.useItemOp1('Pirate message');
    await bot.waitForTicks(3);

    // The scroll interface opens - dismiss it
    bot.dismissModals();

    const varp = bot.getQuestProgress(HUNT_VARP);
    if (varp !== STAGE_READ_NOTE) {
        throw new Error(`Quest varp after reading note is ${varp}, expected ${STAGE_READ_NOTE}`);
    }
    bot.log('EVENT', `Read pirate message! varp=${varp}`);
}

/**
 * Dig at Falador Park with the spade to complete the quest.
 * The dig spot is at (2999, 3383) level 0 - "Saradomin points to the X."
 * The spade script (spade.rs2) checks distance <= 1 from the spot.
 */
async function killWysonAndDig(bot: BotAPI): Promise<boolean> {
    // Find Wyson near the dig spot
    const wyson = bot.findNearbyNpc('Wyson the gardener');
    if (!wyson) {
        bot.log('STATE', 'Wyson not found nearby — digging directly');
        await bot.useItemOp1('Spade');
        await bot.waitForTicks(10);
        bot.dismissModals();
        await bot.waitForTicks(3);
        bot.dismissModals();
        return bot.getQuestProgress(HUNT_VARP) === STAGE_COMPLETE;
    }

    bot.log('STATE', `Wyson at (${wyson.x},${wyson.z}) — attacking`);

    // Equip bronze pickaxe for combat stats if available and not already equipped
    if (bot.findItem('Bronze pickaxe')) {
        await bot.equipItem('Bronze pickaxe');
        await bot.waitForTicks(1);
    }

    // Attack Wyson
    try {
        await bot.interactNpc(wyson, 2);
    } catch {
        if (!wyson.isActive) {
            bot.log('EVENT', 'Wyson died during initial approach');
            await bot.walkToWithPathfinding(DIG_X, DIG_Z);
            await bot.waitForTicks(1);
            await bot.useItemOp1('Spade');
            await bot.waitForTicks(10);
            bot.dismissModals();
            await bot.waitForTicks(3);
            bot.dismissModals();
            return bot.getQuestProgress(HUNT_VARP) === STAGE_COMPLETE;
        }
        throw new Error('Failed to start combat with Wyson: interactNpc failed');
    }

    // Fight until Wyson dies or bot dies
    const COMBAT_TIMEOUT = 300;
    let lastWysonX = wyson.x;
    let lastWysonZ = wyson.z;

    for (let tick = 0; tick < COMBAT_TIMEOUT; tick++) {
        await bot.waitForTick();
        bot.dismissModals();

        // Check if bot died
        if (bot.isDead()) {
            bot.log('STATE', 'Bot died fighting Wyson');
            return false;
        }

        if (wyson.isActive) {
            lastWysonX = wyson.x;
            lastWysonZ = wyson.z;
        }

        if (!wyson.isActive) {
            bot.log('EVENT', `Wyson killed at (${lastWysonX},${lastWysonZ}) after ~${tick} ticks`);
            await bot.waitForTicks(2);

            // Walk to dig spot and dig immediately
            await bot.walkToWithPathfinding(DIG_X, DIG_Z);
            await bot.waitForTicks(1);
            bot.log('STATE', `Digging at (${bot.player.x},${bot.player.z})`);
            await bot.useItemOp1('Spade');
            await bot.waitForTicks(10);
            bot.dismissModals();
            await bot.waitForTicks(3);
            bot.dismissModals();
            return bot.getQuestProgress(HUNT_VARP) === STAGE_COMPLETE;
        }

        // Do NOT re-engage — the engine's player_melee_attack script ends with
        // p_opnpc(2) which self-sustains the combat loop. Re-engaging cancels the
        // pending p_opnpc(2), resetting the combat cycle and preventing hits.

        if (tick > 0 && tick % 30 === 0) {
            const hp = bot.player.levels[3];
            bot.log('STATE', `Fighting Wyson... tick ${tick}, HP=${hp}, Wyson at (${wyson.x},${wyson.z})`);
        }
    }

    throw new Error(`Combat with Wyson timed out after ${COMBAT_TIMEOUT} ticks`);
}

async function digForTreasure(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Digging for treasure in Falador Park ===');

    // Wyson the gardener (spawn ~2996,3381, respawn 50 ticks) interferes with digging via
    // npc_find(coord, wyson, 10, 0). He has 7 HP, 2 attack, 5 defence.
    // Strategy: attack Wyson, kill him, then dig during his 50-tick respawn window.
    // If the bot dies (low combat stats), respawn at Lumbridge, walk back, and retry.
    // Each death also gives the bot combat XP from hitting Wyson, making subsequent attempts easier.

    const MAX_ATTEMPTS = 5;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        bot.log('STATE', `Dig attempt ${attempt + 1}/${MAX_ATTEMPTS}`);

        // Make sure we're at the dig spot
        await bot.walkToWithPathfinding(DIG_X, DIG_Z);
        bot.log('STATE', `At dig spot: pos=(${bot.player.x},${bot.player.z})`);

        const success = await killWysonAndDig(bot);
        if (success) {
            return;
        }

        // Bot died — respawn and walk back
        bot.log('STATE', `Attempt ${attempt + 1} failed — recovering from death`);
        await bot.waitForRespawn();
        bot.log('STATE', `Respawned at (${bot.player.x},${bot.player.z})`);

        // Walk back to Falador Park from Lumbridge
        await walkLumbridgeToFalador(bot);
        await bot.walkToWithPathfinding(DIG_X, DIG_Z);
    }

    throw new Error(`Failed to dig for treasure after ${MAX_ATTEMPTS} attempts`);
}

/**
 * Build the Pirate's Treasure state machine.
 * States: earn-coins, buy-apron, start-quest, smuggle-rum, retrieve-rum, get-key, open-chest, dig-treasure
 */
export function buildPiratesTreasureStates(bot: BotAPI): BotState {
    return {
        name: 'pirates-treasure',
        isComplete: () => bot.getQuestProgress(HUNT_VARP) === STAGE_COMPLETE,
        run: async () => { throw new Error('Composite state should not be called directly'); },
        children: [
            {
                name: 'earn-coins',
                isComplete: () => {
                    const coins = bot.findItem('Coins');
                    return coins !== null && coins.count >= 200;
                },
                run: async () => {
                    await earnCoins(bot, 200);
                }
            },
            {
                name: 'buy-apron',
                isComplete: () => bot.findItem('White apron') !== null,
                run: async () => {
                    // Ensure bot is outside Lumbridge Castle before pathing to Varrock.
                    // earn-coins may leave the bot inside the castle (pickpocketing men).
                    await bot.walkToWithPathfinding(LUMBRIDGE_SPAWN_X, LUMBRIDGE_SPAWN_Z);
                    await walkLumbridgeToVarrock(bot);
                    await buyWhiteApron(bot);
                }
            },
            {
                name: 'start-quest',
                isComplete: () => bot.getQuestProgress(HUNT_VARP) >= STAGE_FETCH_RUM,
                run: async () => {
                    await walkVarrockToLumbridge(bot);
                    await walkLumbridgeToPortSarim(bot);
                    await bot.walkToWithPathfinding(REDBEARD_FRANK_X, REDBEARD_FRANK_Z);
                    await startQuest(bot);
                }
            },
            {
                name: 'smuggle-rum',
                isComplete: () => bot.getVarp(CRATE_RUM_VARP) >= 2,
                stuckThreshold: 3000,
                run: async () => {
                    // Sail to Karamja
                    await walkLumbridgeToPortSarim(bot);
                    await sailToKaramja(bot);
                    // Buy rum from Zambo
                    await buyRum(bot);
                    // Get plantation job and smuggle rum
                    await getPlantationJob(bot);
                    await smuggleRum(bot);
                    // Ship the crate
                    await shipCrate(bot);
                }
            },
            {
                name: 'retrieve-rum',
                isComplete: () => {
                    return bot.findItem('Karamjan rum') !== null ||
                           bot.getQuestProgress(HUNT_VARP) >= STAGE_RECEIVED_KEY;
                },
                run: async () => {
                    // Sail back to Port Sarim
                    await sailToPortSarim(bot);
                    // Retrieve rum from Wydin's back room
                    await bot.walkToWithPathfinding(WYDIN_X, WYDIN_Z);
                    await retrieveRumFromWydin(bot);
                }
            },
            {
                name: 'get-key',
                isComplete: () => bot.getQuestProgress(HUNT_VARP) >= STAGE_RECEIVED_KEY,
                run: async () => {
                    // Exit Wydin's back room through the wydindoor
                    const exitDoor = bot.findNearbyLoc('wydindoor', 16);
                    if (exitDoor) {
                        await bot.interactLoc(exitDoor, 1);
                        await bot.waitForTicks(3);
                    }
                    await bot.walkToWithPathfinding(3014, 3204);
                    // Give rum to Redbeard Frank
                    await bot.walkToWithPathfinding(REDBEARD_FRANK_X, REDBEARD_FRANK_Z);
                    await giveRumToFrank(bot);
                }
            },
            {
                name: 'open-chest',
                isComplete: () => bot.getQuestProgress(HUNT_VARP) >= STAGE_READ_NOTE,
                run: async () => {
                    // Walk to Varrock Blue Moon Inn
                    await walkPortSarimToVarrock(bot);
                    await bot.walkToWithPathfinding(BLUE_MOON_DOOR_X, BLUE_MOON_DOOR_Z);
                    await openChestAndReadNote(bot);
                }
            },
            {
                name: 'dig-treasure',
                isComplete: () => bot.getQuestProgress(HUNT_VARP) === STAGE_COMPLETE,
                maxRetries: 5,
                run: async () => {
                    // Descend from upper floor if needed
                    if ((bot.player.level as number) === 1) {
                        // Try to exit Blue Moon Inn upper floor
                        try {
                            await bot.openDoor('desertdoorclosed');
                            await bot.waitForTicks(2);
                        } catch { /* may already be open */ }

                        await bot.walkToWithPathfinding(3230, 3398);
                        try {
                            await bot.openDoor('desertdoorclosed');
                            await bot.waitForTicks(2);
                        } catch { /* may already be open */ }

                        await bot.walkToWithPathfinding(3230, 3394);
                        await bot.climbStairs('loc_1726', 1);
                        await bot.waitForTicks(3);
                    }

                    // Get spade if we don't have one
                    if (!bot.findItem('Spade')) {
                        // Walk to bar area ladder and climb up
                        await bot.walkToWithPathfinding(3214, 3411);
                        await bot.climbStairs('loc_1747', 1);
                        await bot.waitForTicks(3);

                        // Pick up spade from ground spawn
                        await bot.walkToWithPathfinding(SPADE_SPAWN_X, SPADE_SPAWN_Z);
                        const spadeGround = bot.findNearbyGroundItem('Spade', 5);
                        if (!spadeGround) {
                            throw new Error(`No spade ground spawn at (${SPADE_SPAWN_X},${SPADE_SPAWN_Z})`);
                        }
                        await bot.takeGroundItem('Spade', spadeGround.x, spadeGround.z);
                        await bot.waitForTicks(5);

                        if (!bot.findItem('Spade')) {
                            throw new Error('Failed to pick up spade');
                        }

                        // Climb back down
                        await bot.climbStairs('loc_1746', 1);
                        await bot.waitForTicks(3);
                    }

                    // Exit Blue Moon Inn if inside
                    if (bot.player.x >= 3220 && bot.player.x <= 3240 && bot.player.z >= 3390 && bot.player.z <= 3420) {
                        await bot.walkToWithPathfinding(3228, 3396);
                        await bot.openDoor('inaccastledoubledoorropen');
                    }

                    // Walk to Falador dig spot
                    await walkVarrockToFalador(bot);
                    await bot.walkToWithPathfinding(DIG_X, DIG_Z);
                    await digForTreasure(bot);

                    // Verify quest completion
                    await bot.waitForTicks(5);
                    bot.dismissModals();

                    const finalVarp = bot.getQuestProgress(HUNT_VARP);
                    if (finalVarp !== STAGE_COMPLETE) {
                        throw new Error(`Quest not complete: varp is ${finalVarp}, expected ${STAGE_COMPLETE}`);
                    }

                    bot.log('SUCCESS', `Pirate's Treasure quest complete! varp=${finalVarp}`);
                }
            }
        ]
    };
}

export async function piratesTreasure(bot: BotAPI): Promise<void> {
    // === Setup: skip tutorial, start in Lumbridge ===
    await skipTutorial(bot);
    await bot.waitForTicks(2);

    bot.log('STATE', `Starting Pirate's Treasure quest at (${bot.player.x},${bot.player.z},${bot.player.level})`);

    const initialVarp = bot.getQuestProgress(HUNT_VARP);
    if (initialVarp !== STAGE_NOT_STARTED) {
        throw new Error(`Quest varp is ${initialVarp}, expected ${STAGE_NOT_STARTED} (not started)`);
    }

    const root = buildPiratesTreasureStates(bot);
    const snapshotDir = path.resolve(import.meta.dir, '..', 'test', 'snapshots');
    await runStateMachine(bot, { root, varpIds: [HUNT_VARP, CRATE_RUM_VARP], captureSnapshots: true, snapshotDir });
}

export const metadata: ScriptMeta = {
    name: 'piratestreasure',
    type: 'quest',
    varpId: HUNT_VARP,
    varpComplete: STAGE_COMPLETE,
    maxTicks: 30000,
    run: piratesTreasure,
    buildStates: buildPiratesTreasureStates,
};
