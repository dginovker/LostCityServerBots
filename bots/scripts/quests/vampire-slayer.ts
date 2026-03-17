import path from 'path';
import { BotAPI } from '../../runtime/api.js';
import { skipTutorial } from '../skip-tutorial.js';
import { type BotState, runStateMachine } from '../../runtime/state-machine.js';
import type { ScriptMeta } from '../../runtime/script-meta.js';

// Varp ID for Vampire Slayer quest progress (from content/pack/varp.pack: 178=vampire)
const VAMPIRE_SLAYER_VARP = 178;

// Quest stages (from content/scripts/quests/quest_vampire/configs/quest_vampire.constant
// and content/scripts/general/configs/quest.constant)
const STAGE_NOT_STARTED = 0;
const STAGE_STARTED = 1;
const STAGE_SPOKE_TO_HARLOW = 2;
const STAGE_COMPLETE = 3;

// NPC type IDs (from content/pack/npc.pack)
const NPC_CHICKEN = 41;
const NPC_SWORDSHOP1 = 551;

// ---- Key locations ----

// Lumbridge General Store (shop keeper inside)
const GENERAL_STORE_X = 3212;
const GENERAL_STORE_Z = 3247;

// Chicken area east of Lumbridge — inside the pen (south fence is at z=3295)
const CHICKEN_AREA_X = 3237;
const CHICKEN_AREA_Z = 3298;

// Morgan's house ground floor door area in Draynor Village
const MORGAN_HOUSE_X = 3098;
const MORGAN_HOUSE_Z = 3268;

// Morgan's house garlic cupboard (level 1): garliccupboardshut at 1_48_51_24_4 => x=3096, z=3268
const _GARLIC_CUPBOARD_X = 3096;
const _GARLIC_CUPBOARD_Z = 3268;

// Jolly Boar Inn (NE Varrock) — Dr Harlow and bartender are inside
const JOLLY_BOAR_INN_X = 3278;
const JOLLY_BOAR_INN_Z = 3488;

// Draynor Manor — main entrance area
const DRAYNOR_MANOR_ENTRANCE_X = 3108;
const DRAYNOR_MANOR_ENTRANCE_Z = 3330;

// Draynor Manor basement stairs (ground level): cryptstairsdown
// 0_48_52_43_29 => x=48*64+43=3115, z=52*64+29=3357
const _CRYPT_STAIRS_DOWN_X = 3115;
const _CRYPT_STAIRS_DOWN_Z = 3357;

// Draynor Manor basement landing after descending stairs
// 0_48_152_5_43 => x=48*64+5=3077, z=152*64+43=9771
const _BASEMENT_LANDING_X = 3077;
const _BASEMENT_LANDING_Z = 9771;

// Coffin in basement (Count Draynor spawns from here)
// 0_48_152_6_46 => x=48*64+6=3078, z=152*64+46=9774
const COFFIN_X = 3078;
const COFFIN_Z = 9774;

// Varrock Sword Shop location (southwest Varrock, near palace)
const VARROCK_SWORD_SHOP_X = 3204;
const VARROCK_SWORD_SHOP_Z = 3399;

// earnCoins is now handled by bot.earnCoinsViaPickpocket()

/**
 * Buy an item from the Lumbridge General Store.
 */
async function buyFromGeneralStore(bot: BotAPI, itemName: string, quantity: number): Promise<void> {
    bot.log('STATE', `=== Buying ${quantity}x ${itemName} from General Store ===`);

    await bot.walkToWithPathfinding(GENERAL_STORE_X, GENERAL_STORE_Z);

    // Open the door if needed
    await bot.openDoor('poordooropen');

    const shopkeeper = bot.findNearbyNpc('Shop keeper');
    if (!shopkeeper) {
        throw new Error(`Shop keeper not found near (${bot.player.x},${bot.player.z})`);
    }

    await bot.interactNpc(shopkeeper, 3); // op3 = Trade
    await bot.waitForTicks(3);

    await bot.buyFromShop(itemName, quantity);
    await bot.waitForTicks(1);

    bot.dismissModals();

    const item = bot.findItem(itemName);
    if (!item) {
        throw new Error(`Failed to buy ${itemName} — not in inventory after purchase`);
    }

    bot.log('EVENT', `Purchased ${quantity}x ${itemName}`);
}

/**
 * Buy an iron sword from the Varrock Sword Shop and equip it.
 * The shop keeper has op3=Trade which opens the shop directly.
 */
async function buyFromVarrockSwordShop(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Buying iron sword from Varrock Sword Shop ===');

    await bot.walkToWithPathfinding(VARROCK_SWORD_SHOP_X, VARROCK_SWORD_SHOP_Z);

    // Open door if needed (Varrock buildings use poordooropen)
    await bot.openDoor('poordooropen');
    await bot.waitForTicks(1);
    await bot.walkToWithPathfinding(VARROCK_SWORD_SHOP_X, VARROCK_SWORD_SHOP_Z);

    // Find the sword shop keeper specifically by NPC type ID to avoid finding
    // other shop keepers in nearby Varrock buildings
    const shopkeeper = bot.findNearbyNpcByTypeId(NPC_SWORDSHOP1, 15);
    if (!shopkeeper) {
        throw new Error(`Sword shop keeper (swordshop1) not found near (${bot.player.x},${bot.player.z})`);
    }
    bot.log('STATE', `Found sword shop keeper at (${shopkeeper.x},${shopkeeper.z})`);

    await bot.interactNpc(shopkeeper, 3); // op3 = Trade (opens shop directly)
    await bot.waitForTicks(5);

    // Buy the iron sword from the shop interface
    await bot.buyFromShop('Iron sword', 1);
    await bot.waitForTicks(1);

    bot.dismissModals();

    const sword = bot.findItem('Iron sword');
    if (!sword) {
        throw new Error('Failed to buy iron sword');
    }
    bot.log('EVENT', 'Bought iron sword');

    // Equip the iron sword
    await bot.equipItem('Iron sword');
    await bot.waitForTicks(1);
    bot.log('EVENT', 'Equipped iron sword');
}

/**
 * Train combat by fighting chickens near Lumbridge until we reach the target level.
 * Chickens have 3 HP and are easy to kill, giving attack and hitpoints XP.
 * Uses attackNpcUntilDead for each chicken kill.
 */
async function trainCombat(bot: BotAPI, targetAttackLevel: number, targetStrengthLevel: number, targetHitpointsLevel: number): Promise<void> {
    bot.log('STATE', `=== Training combat to atk=${targetAttackLevel}, str=${targetStrengthLevel}, hp=${targetHitpointsLevel} ===`);

    // Equip bronze pickaxe as weapon (if available — may have been lost on death during pickpocketing)
    if (bot.findItem('Bronze pickaxe')) {
        bot.log('STATE', 'Equipping bronze pickaxe as weapon');
        await bot.equipItem('Bronze pickaxe');
        await bot.waitForTicks(1);
    } else {
        bot.log('STATE', 'No bronze pickaxe available, training unarmed');
    }

    // Set combat style:
    // Bronze pickaxe: 0=Accurate (attack XP), 1=Aggressive (strength XP)
    // Start with Accurate to train attack first, then switch to Aggressive for strength.
    bot.setCombatStyle(0); // Accurate for attack XP

    // Walk to chicken pen gate area (south side of pen)
    await bot.walkToWithPathfinding(3236, 3295);
    bot.log('STATE', `At chicken pen gate: pos=(${bot.player.x},${bot.player.z})`);

    // Open the gate to enter the chicken pen
    await bot.openGate(10);
    await bot.waitForTicks(1);

    // Walk inside the pen
    await bot.walkToWithPathfinding(CHICKEN_AREA_X, CHICKEN_AREA_Z);
    bot.log('STATE', `Inside chicken pen: pos=(${bot.player.x},${bot.player.z})`);

    let chickensKilled = 0;
    const MAX_CHICKENS = 800; // Safety limit

    while (chickensKilled < MAX_CHICKENS) {
        const attack = bot.getSkill('Attack');
        const strength = bot.getSkill('Strength');
        const hitpoints = bot.getSkill('Hitpoints');

        // Check if we've reached our target levels
        if (attack.baseLevel >= targetAttackLevel &&
            strength.baseLevel >= targetStrengthLevel &&
            hitpoints.baseLevel >= targetHitpointsLevel) {
            bot.log('EVENT', `Combat training complete! atk=${attack.baseLevel} str=${strength.baseLevel} hp=${hitpoints.baseLevel} killed=${chickensKilled}`);

            // Exit the chicken pen by walking near the gate and opening it
            await bot.walkToWithPathfinding(3236, 3296);
            await bot.openGate(10);
            await bot.waitForTicks(1);
            // Walk through the gate
            await bot.walkTo(3236, 3293);
            bot.log('STATE', `Exited chicken pen: pos=(${bot.player.x},${bot.player.z})`);
            return;
        }

        // Switch to aggressive once attack level is reached to train strength
        if (attack.baseLevel >= targetAttackLevel && strength.baseLevel < targetStrengthLevel) {
            bot.setCombatStyle(1); // Aggressive for strength XP
        }

        bot.dismissModals();

        // Find a chicken to fight
        const chicken = bot.findNearbyNpcByTypeId(NPC_CHICKEN, 16);
        if (!chicken) {
            // Walk back to chicken area center
            await bot.walkToWithPathfinding(CHICKEN_AREA_X, CHICKEN_AREA_Z);
            await bot.waitForTicks(5);
            continue;
        }

        // Use attackNpcUntilDead for the actual combat (chickens have 3 HP, 100 ticks is generous)
        try {
            await bot.attackNpcUntilDead('Chicken', { maxTicks: 100 });
        } catch {
            // Chicken might have despawned or moved too far — just continue
            bot.dismissModals();
            await bot.waitForTicks(2);

            // If drifted far from chicken area, walk back
            const dist = Math.max(Math.abs(bot.player.x - CHICKEN_AREA_X), Math.abs(bot.player.z - CHICKEN_AREA_Z));
            if (dist > 20) {
                await bot.walkToWithPathfinding(CHICKEN_AREA_X, CHICKEN_AREA_Z);
            }
            continue;
        }

        chickensKilled++;
        bot.dismissModals();

        if (chickensKilled % 10 === 0) {
            const atk = bot.getSkill('Attack');
            const str = bot.getSkill('Strength');
            const hp = bot.getSkill('Hitpoints');
            bot.log('STATE', `Chickens killed: ${chickensKilled}, atk=${atk.baseLevel} str=${str.baseLevel} hp=${hp.baseLevel}`);
        }

        await bot.waitForTicks(2);

        // If drifted far from chicken area, walk back
        const dist = Math.max(Math.abs(bot.player.x - CHICKEN_AREA_X), Math.abs(bot.player.z - CHICKEN_AREA_Z));
        if (dist > 20) {
            await bot.walkToWithPathfinding(CHICKEN_AREA_X, CHICKEN_AREA_Z);
        }
    }

    const atk = bot.getSkill('Attack');
    const str = bot.getSkill('Strength');
    const hp = bot.getSkill('Hitpoints');
    throw new Error(`Combat training timed out after ${MAX_CHICKENS} chickens. atk=${atk.baseLevel} str=${str.baseLevel} hp=${hp.baseLevel}`);
}

/**
 * Talk to Morgan in Draynor Village to start the quest.
 *
 * Dialog flow (from morgan.rs2):
 * 1. chatnpc "Please please help us, bold adventurer!"
 * 2. chatplayer "What's the problem?"
 * 3. chatnpc "Our little village has been dreadfully ravaged..." (long)
 * 4. multi3: "No, vampires are scary!" (1), "Ok, I'm up for an adventure." (2), "Have you got any tips..." (3)
 *    -> select option 2
 * 5. chatplayer "Okay, I'm up for an adventure."
 * 6. chatnpc "I think first you should seek help..." (long)
 * 7. chatnpc "an old soak these days..." (continuation)
 *    -> varp set to 1 (started)
 * 8. chatplayer "I'll look him up then."
 */
async function talkToMorgan(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Talking to Morgan to start quest ===');

    // Walk to Morgan's house in Draynor Village.
    // If east of the fences (x > 3230), route south first to avoid
    // chicken pen/farm fences blocking the pathfinder.
    if (bot.player.x > 3230) {
        await bot.walkToWithPathfinding(3240, 3226); // South to Lumbridge bridge area (open)
        await bot.walkToWithPathfinding(3222, 3218); // West across bridge to Lumbridge spawn
    }
    await bot.walkToWithPathfinding(MORGAN_HOUSE_X, MORGAN_HOUSE_Z);

    // Open door to Morgan's house
    await bot.openDoor('poordooropen');
    await bot.waitForTicks(1);

    // Walk inside
    await bot.walkToWithPathfinding(MORGAN_HOUSE_X, MORGAN_HOUSE_Z);

    const morgan = bot.findNearbyNpc('Morgan', 20);
    if (!morgan) {
        throw new Error(`Morgan not found near (${bot.player.x},${bot.player.z})`);
    }
    bot.log('STATE', `Found Morgan at (${morgan.x},${morgan.z})`);

    await bot.interactNpc(morgan, 1); // op1 = Talk-to
    const dialogOpened = await bot.waitForDialog(30);
    if (!dialogOpened) {
        throw new Error('No dialog opened after talking to Morgan');
    }

    // 1. chatnpc "Please please help us, bold adventurer!"
    await bot.continueDialog();

    // 2. chatplayer "What's the problem?"
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 3. chatnpc "Our little village has been dreadfully ravaged..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 4. multi3: select option 2 "Ok, I'm up for an adventure."
    await bot.waitForDialog(10);
    await bot.selectDialogOption(2);

    // 5. chatplayer "Okay, I'm up for an adventure."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 6. chatnpc "I think first you should seek help..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 7. chatnpc "an old soak these days..."
    // varp is set to started here
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 8. chatplayer "I'll look him up then."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    await bot.waitForTicks(2);
}

/**
 * Buy beer from the Jolly Boar Inn bartender and give it to Dr Harlow.
 *
 * Bartender dialog (from varrock bartender.rs2):
 * 1. chatnpc "Can I help you?"
 * 2. multi3: "I'll have a beer please." (1), "Any hints..." (2), "Heard any good gossip?" (3)
 *    -> select option 1
 * 3. chatplayer "I'll have a pint of beer please."
 * 4. chatnpc "Ok, that'll be two coins please."
 *    -> beer added to inventory, 2gp removed
 *
 * Dr Harlow dialog first visit (varp=1, from harlow.rs2):
 * 1. chatnpc "Buy me a drrink pleassh..."
 * 2. multi2: "No, you've had enough." (1), "Morgan needs your help" (2)
 *    -> select option 2
 * 3. chatplayer "Morgan needs your help"
 * 4. chatnpc "Morgan you shhay..?"
 * 5. chatplayer "His village is being terrorised..."
 * 6. chatnpc "Buy me a beer..."
 * 7. chatplayer "But this is your friend Morgan..."
 * 8. chatnpc "Buy ush a drink anyway..."
 *    -> varp set to 2 (spoke to harlow)
 *
 * Dr Harlow second visit (varp=2, need beer in inv):
 * 1. chatnpc "Buy me a drrink pleassh..."
 * 2. chatplayer "Here you go." (if has beer)
 *    -> beer removed
 * 3. chatnpc "Cheersh matey..."
 * 4. chatplayer "So tell me how to kill vampires then."
 * 5. chatnpc "Yesh Yesh vampires..."
 * 6. mesbox "Dr Harlow appears to sober up slightly."
 * 7. chatnpc "Well you're gonna need a stake..." -> stake added
 * 8. objbox "Dr Harlow hands you a stake."
 * 9. chatnpc "You'll need a hammer as well..."
 * 10. chatnpc "always liked garlic..."
 * 11. chatplayer "Thank you very much!"
 */
async function talkToHarlow(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Talking to Dr Harlow at Jolly Boar Inn ===');

    // Walk to the Jolly Boar Inn (NE Varrock) from Draynor Village.
    // Must use waypoints to avoid Draynor Manor grounds (blocked by invisible walls).
    // Route: south to road, west to clear the manor, north through Barbarian Village,
    // then east into Varrock and north to the Jolly Boar Inn.
    const jollyBoarRoute = [
        { x: 3098, z: 3250 },   // South to Draynor road (clear of manor)
        { x: 3082, z: 3336 },   // NW to Barbarian Village area
        { x: 3080, z: 3400 },   // North along west side of Varrock
        { x: 3175, z: 3427 },   // East toward Varrock west gate
        { x: 3240, z: 3460 },   // NE through Varrock
        { x: JOLLY_BOAR_INN_X, z: JOLLY_BOAR_INN_Z },
    ];
    for (const wp of jollyBoarRoute) {
        await bot.walkToWithPathfinding(wp.x, wp.z);
    }
    bot.log('STATE', `At Jolly Boar Inn area: pos=(${bot.player.x},${bot.player.z})`);

    // Open door if needed
    await bot.openDoor('poordooropen');
    await bot.waitForTicks(1);
    await bot.walkToWithPathfinding(JOLLY_BOAR_INN_X, JOLLY_BOAR_INN_Z);

    // === First talk: introduce Morgan's problem ===
    const harlow = bot.findNearbyNpc('Dr Harlow', 20);
    if (!harlow) {
        throw new Error(`Dr Harlow not found near (${bot.player.x},${bot.player.z})`);
    }
    bot.log('STATE', `Found Dr Harlow at (${harlow.x},${harlow.z})`);

    await bot.interactNpc(harlow, 1); // op1 = Talk-to
    let dialog = await bot.waitForDialog(30);
    if (!dialog) {
        throw new Error('No dialog opened after talking to Dr Harlow');
    }

    // 1. chatnpc "Buy me a drrink pleassh..."
    await bot.continueDialog();

    // 2. multi2: select "Morgan needs your help" (option 2)
    await bot.waitForDialog(10);
    await bot.selectDialogOption(2);

    // 3. chatplayer "Morgan needs your help"
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 4. chatnpc "Morgan you shhay..?"
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 5. chatplayer "His village is being terrorised..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 6. chatnpc "Buy me a beer..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 7. chatplayer "But this is your friend Morgan..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 8. chatnpc "Buy ush a drink anyway..."
    // varp set to 2 here
    await bot.waitForDialog(10);
    await bot.continueDialog();

    await bot.waitForTicks(2);

    const varpAfterHarlow1 = bot.getQuestProgress(VAMPIRE_SLAYER_VARP);
    if (varpAfterHarlow1 !== STAGE_SPOKE_TO_HARLOW) {
        throw new Error(`Expected varp ${STAGE_SPOKE_TO_HARLOW} after first Harlow talk, got ${varpAfterHarlow1}`);
    }
    bot.log('EVENT', `Spoke to Harlow, varp=${varpAfterHarlow1}`);

    // === Buy beer from Bartender ===
    bot.log('STATE', 'Buying beer from bartender');

    const bartender = bot.findNearbyNpc('Bartender', 20);
    if (!bartender) {
        throw new Error(`Bartender not found near (${bot.player.x},${bot.player.z})`);
    }

    await bot.interactNpc(bartender, 1); // op1 = Talk-to
    dialog = await bot.waitForDialog(30);
    if (!dialog) {
        throw new Error('No dialog opened after talking to Bartender');
    }

    // 1. chatnpc "Can I help you?"
    await bot.continueDialog();

    // 2. multi3: select "I'll have a beer please." (option 1)
    await bot.waitForDialog(10);
    await bot.selectDialogOption(1);

    // 3. chatplayer "I'll have a pint of beer please."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 4. chatnpc "Ok, that'll be two coins please." -> beer added, coins removed
    await bot.waitForDialog(10);
    await bot.continueDialog();

    await bot.waitForTicks(2);

    const hasBeer = bot.findItem('Beer');
    if (!hasBeer) {
        throw new Error('Failed to buy beer from bartender');
    }
    bot.log('EVENT', 'Bought beer from bartender');

    // === Second talk to Harlow: give beer and get stake ===
    bot.log('STATE', 'Giving beer to Dr Harlow');

    const harlow2 = bot.findNearbyNpc('Dr Harlow', 20);
    if (!harlow2) {
        throw new Error(`Dr Harlow not found for second talk near (${bot.player.x},${bot.player.z})`);
    }

    await bot.interactNpc(harlow2, 1); // op1 = Talk-to
    dialog = await bot.waitForDialog(30);
    if (!dialog) {
        throw new Error('No dialog opened for second Harlow talk');
    }

    // 1. chatnpc "Buy me a drrink pleassh..."
    await bot.continueDialog();

    // Since varp=2 and we have no stake yet, the script goes directly to
    // the beer-giving flow (not the multi2 choice):
    // chatplayer "Here you go." (if has beer)
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // objbox "You give a beer to Dr Harlow."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Cheersh matey..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatplayer "So tell me how to kill vampires then."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Yesh Yesh vampires..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // mesbox "Dr Harlow appears to sober up slightly."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Well you're gonna need a stake..." -> stake added
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // objbox "Dr Harlow hands you a stake."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "You'll need a hammer as well..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "always liked garlic..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatplayer "Thank you very much!"
    await bot.waitForDialog(10);
    await bot.continueDialog();

    await bot.waitForTicks(2);
    bot.dismissModals();

    const hasStake = bot.findItem('Stake');
    if (!hasStake) {
        throw new Error('Did not receive stake from Dr Harlow');
    }
    bot.log('EVENT', 'Received stake from Dr Harlow');
}

/**
 * Get garlic from the cupboard upstairs in Morgan's house.
 *
 * The garlic cupboard is at level 1, coords (3096, 3268).
 * Cupboard flow:
 * 1. Open the cupboard (op1 on garliccupboardshut -> loc_change to garliccupboardopen)
 * 2. Search the open cupboard (op1 on garliccupboardopen -> adds garlic to inv)
 */
async function getGarlic(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Getting garlic from Morgan house ===');

    // Walk to Morgan's house area
    await bot.walkToWithPathfinding(MORGAN_HOUSE_X, MORGAN_HOUSE_Z);

    // Open door to Morgan's house if needed
    await bot.openDoor('poordooropen');
    await bot.waitForTicks(1);

    bot.log('STATE', `Inside Morgan house near stairs: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Climb up to level 1 — interactLoc handles approach walking to the stairs
    await bot.climbStairs('loc_1722', 1);
    await bot.waitForTicks(2);

    if ((bot.player.level as number) !== 1) {
        throw new Error(`Failed to climb to level 1 in Morgan's house: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    bot.log('STATE', `On level 1 of Morgan house: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Open the garlic cupboard (garliccupboardshut -> garliccupboardopen)
    const closedCupboard = bot.findNearbyLoc('garliccupboardshut', 16);
    if (closedCupboard) {
        bot.log('ACTION', `Opening garlic cupboard at (${closedCupboard.x},${closedCupboard.z})`);
        await bot.interactLoc(closedCupboard, 1); // op1 = Open
        await bot.waitForTicks(3);
    }

    // Search the open cupboard (garliccupboardopen, op1 = Search)
    const openCupboard = bot.findNearbyLoc('garliccupboardopen', 16);
    if (!openCupboard) {
        throw new Error('Garlic cupboard (open) not found after opening');
    }

    bot.log('ACTION', `Searching garlic cupboard at (${openCupboard.x},${openCupboard.z})`);
    await bot.interactLoc(openCupboard, 1); // op1 = Search
    await bot.waitForTicks(3);

    const hasGarlic = bot.findItem('Garlic');
    if (!hasGarlic) {
        throw new Error('Failed to get garlic from cupboard');
    }
    bot.log('EVENT', 'Got garlic from cupboard');

    // Go back downstairs
    await bot.climbStairs('loc_1723', 1); // op1 = Climb-down
    await bot.waitForTicks(2);

    if ((bot.player.level as number) !== 0) {
        throw new Error(`Failed to climb back down: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    bot.log('STATE', `Back on ground floor: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
}

/**
 * Navigate into Draynor Manor and down to the basement.
 * The manor has an entrance that the player can walk through.
 * Inside, find the cryptstairsdown loc and climb down.
 */
async function goToBasement(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Navigating to Draynor Manor basement ===');

    // The crypt stairs are in the NE part of the manor at (3115,3357).
    // Enter through the front doors and navigate the interior.
    // Same approach as the Ernest the Chicken bot.
    await bot.walkToWithPathfinding(DRAYNOR_MANOR_ENTRANCE_X, DRAYNOR_MANOR_ENTRANCE_Z - 1);
    bot.log('STATE', `At manor entrance: pos=(${bot.player.x},${bot.player.z})`);

    // Open the manor front doors (same as Ernest the Chicken quest)
    await bot.openDoor('haunteddoorl');
    await bot.waitForTicks(1);

    // Walk through front doors into the manor
    await bot.walkToWithPathfinding(DRAYNOR_MANOR_ENTRANCE_X, DRAYNOR_MANOR_ENTRANCE_Z + 5);
    bot.log('STATE', `Inside manor: pos=(${bot.player.x},${bot.player.z})`);

    // Walk to the back of the manor first (through the back door auto-opener),
    // then navigate to the crypt stairs room from the east.
    await bot.walkToWithPathfinding(3120, 3359);
    bot.log('STATE', `East wing: pos=(${bot.player.x},${bot.player.z})`);

    // The crypt stairs are at (3115,3357). Walk west from the east wing.
    // The fencing and walls create a corridor — navigate through it.
    await bot.walkToWithPathfinding(3118, 3357);
    bot.log('STATE', `Near crypt stairs: pos=(${bot.player.x},${bot.player.z})`);

    // Climb down to the basement — interactLoc handles approach
    await bot.climbStairs('cryptstairsdown', 1); // op1 = Walk-Down
    await bot.waitForTicks(3);

    // Check we're in the basement (z should be ~9771, since basement uses z+6400)
    if (bot.player.z < 9000) {
        throw new Error(`Failed to reach basement: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    bot.log('STATE', `In basement: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
}

/**
 * Fight Count Draynor in the basement.
 *
 * 1. Walk to the coffin and open it (op1 on loc_2614 -> spawns Count Draynor)
 * 2. Count Draynor attacks the player (aggressive hunt mode)
 * 3. If player has garlic, vampire is weakened on first hit
 * 4. When Count Draynor reaches 0 HP, ai_queue3 fires:
 *    - If player has stake + hammer: quest completes
 *    - Otherwise: vampire regenerates
 * 5. Wait for quest completion queue to fire
 */
async function fightCountDraynor(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Fighting Count Draynor ===');

    // Walk to the coffin
    await bot.walkToWithPathfinding(COFFIN_X, COFFIN_Z);
    bot.log('STATE', `Near coffin: pos=(${bot.player.x},${bot.player.z})`);

    // Verify we have the required items
    const hasStake = bot.findItem('Stake');
    const hasHammer = bot.findItem('Hammer');
    const hasGarlic = bot.findItem('Garlic');
    if (!hasStake) throw new Error('Missing stake for vampire fight');
    if (!hasHammer) throw new Error('Missing hammer for vampire fight');
    bot.log('STATE', `Items: stake=${!!hasStake} hammer=${!!hasHammer} garlic=${!!hasGarlic}`);

    // Open the coffin to spawn Count Draynor
    const coffin = bot.findNearbyLoc('loc_2614', 10);
    if (!coffin) {
        // Coffin might already be open (vampcoffinopen)
        const openCoffin = bot.findNearbyLoc('vampcoffinopen', 10);
        if (!openCoffin) {
            throw new Error(`No coffin found near (${bot.player.x},${bot.player.z})`);
        }
        bot.log('STATE', 'Coffin already open');
    } else {
        bot.log('ACTION', `Opening coffin at (${coffin.x},${coffin.z})`);
        await bot.interactLoc(coffin, 1); // op1 = Open
        await bot.waitForTicks(6); // p_delay(4) in script + processing time
    }

    // Count Draynor should have spawned and be aggressive
    // Wait a moment for the NPC to spawn and start hunting
    await bot.waitForTicks(3);

    const vampire = bot.findNearbyNpc('Count Draynor', 20);
    if (!vampire) {
        throw new Error('Count Draynor did not spawn after opening coffin');
    }
    bot.log('EVENT', `Count Draynor spawned at (${vampire.x},${vampire.z})`);

    // The vampire has aggressive hunt mode and will attack us.
    // Wait a tick then engage. Use attackNpcUntilDead for the combat loop.
    // If the bot dies, respawn and try again (the vampire regenerates and respawns).
    await bot.waitForTicks(2);

    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        bot.log('STATE', `Fight attempt ${attempt}/${MAX_ATTEMPTS}`);

        try {
            // Re-equip iron sword if we have one (might have been lost on death on first attempt)
            if (bot.findItem('Iron sword')) {
                await bot.equipItem('Iron sword');
            }

            // Set combat style to aggressive for max damage
            bot.setCombatStyle(1);

            // Find Count Draynor (might need to re-find after respawn)
            let vamp = bot.findNearbyNpc('Count Draynor', 20);
            if (!vamp) {
                // Vampire despawned — re-open the coffin to spawn it again
                bot.log('STATE', 'Count Draynor not found, re-opening coffin...');
                const coffin2 = bot.findNearbyLoc('loc_2614', 10);
                if (coffin2) {
                    await bot.interactLoc(coffin2, 1);
                    await bot.waitForTicks(6);
                }
                await bot.waitForTicks(3);
                vamp = bot.findNearbyNpc('Count Draynor', 20);
                if (!vamp) {
                    throw new Error('Count Draynor still not found after re-opening coffin');
                }
                bot.log('EVENT', `Count Draynor re-spawned at (${vamp.x},${vamp.z})`);
                await bot.waitForTicks(2);
            }

            await bot.attackNpcUntilDead('Count Draynor', { maxTicks: 500 });

            // When Count Draynor reaches 0 HP, ai_queue3 fires which checks for stake+hammer.
            await bot.waitForTicks(10);
            bot.dismissModals();

            const finalVarp = bot.getQuestProgress(VAMPIRE_SLAYER_VARP);
            if (finalVarp === STAGE_COMPLETE) {
                bot.log('EVENT', `Count Draynor defeated! Quest varp=${finalVarp}`);
                return;
            }
            throw new Error(`Vampire died but quest not complete. varp=${finalVarp}. Missing stake/hammer?`);
        } catch (err) {
            const errMsg = (err as Error).message;
            const isRetryable = errMsg.includes('bot died') || errMsg.includes('Count Draynor still not found');
            if (!isRetryable || attempt >= MAX_ATTEMPTS) {
                throw err; // Re-throw non-retryable errors or if out of attempts
            }

            bot.log('STATE', `Died to Count Draynor on attempt ${attempt}, respawning...`);
            await bot.waitForRespawn(30);
            await bot.waitForTicks(5);

            // After respawn, bot is in Lumbridge. Walk back to the manor basement.
            // The vampire should still be there (timer-based despawn).
            bot.log('STATE', `Respawned at (${bot.player.x},${bot.player.z}). Walking back to manor...`);

            // Walk back to Draynor Manor
            const returnRoute = [
                { x: 3082, z: 3336 },
                { x: DRAYNOR_MANOR_ENTRANCE_X, z: DRAYNOR_MANOR_ENTRANCE_Z },
            ];
            for (const wp of returnRoute) {
                await bot.walkToWithPathfinding(wp.x, wp.z);
            }

            // Re-enter the manor and go to the basement
            await bot.walkToWithPathfinding(DRAYNOR_MANOR_ENTRANCE_X, DRAYNOR_MANOR_ENTRANCE_Z - 1);
            await bot.openDoor('haunteddoorl');
            await bot.waitForTicks(1);
            await bot.walkToWithPathfinding(DRAYNOR_MANOR_ENTRANCE_X, DRAYNOR_MANOR_ENTRANCE_Z + 5);
            await bot.walkToWithPathfinding(3120, 3359);
            await bot.walkToWithPathfinding(3118, 3357);
            await bot.climbStairs('cryptstairsdown', 1);
            await bot.waitForTicks(3);
            if (bot.player.z < 9000) {
                throw new Error(`Failed to reach basement on retry: pos=(${bot.player.x},${bot.player.z})`);
            }
            await bot.walkToWithPathfinding(COFFIN_X, COFFIN_Z);
        }
    }
}

/**
 * Build the Vampire Slayer state machine.
 * States: earn-coins, buy-hammer, train-combat, talk-to-morgan, get-garlic, get-stake-and-sword, kill-vampire
 */
export function buildVampireSlayerStates(bot: BotAPI): BotState {
    return {
        name: 'vampire-slayer',
        isComplete: () => bot.getQuestProgress(VAMPIRE_SLAYER_VARP) === STAGE_COMPLETE,
        run: async () => { throw new Error('Composite state should not be called directly'); },
        children: [
            {
                name: 'earn-coins',
                stuckThreshold: 3000,
                isComplete: () => {
                    const coins = bot.findItem('Coins');
                    return coins !== null && coins.count >= 130;
                },
                run: async () => {
                    await bot.earnCoinsViaPickpocket(130);
                }
            },
            {
                name: 'buy-hammer',
                isComplete: () => bot.findItem('Hammer') !== null,
                run: async () => {
                    await buyFromGeneralStore(bot, 'Hammer', 1);
                }
            },
            {
                name: 'train-combat',
                isComplete: () => {
                    const attack = bot.getSkill('Attack');
                    const strength = bot.getSkill('Strength');
                    const hitpoints = bot.getSkill('Hitpoints');
                    return attack.baseLevel >= 15 && strength.baseLevel >= 15 && hitpoints.baseLevel >= 18;
                },
                stuckThreshold: 3000,
                run: async () => {
                    await trainCombat(bot, 15, 15, 18);
                }
            },
            {
                name: 'talk-to-morgan',
                isComplete: () => bot.getQuestProgress(VAMPIRE_SLAYER_VARP) >= STAGE_STARTED,
                run: async () => {
                    await talkToMorgan(bot);

                    const varpAfterMorgan = bot.getQuestProgress(VAMPIRE_SLAYER_VARP);
                    if (varpAfterMorgan !== STAGE_STARTED) {
                        throw new Error(`Quest varp after Morgan is ${varpAfterMorgan}, expected ${STAGE_STARTED}`);
                    }
                    bot.log('EVENT', `Quest started! varp=${varpAfterMorgan}`);
                }
            },
            {
                name: 'get-garlic',
                isComplete: () => bot.findItem('Garlic') !== null,
                run: async () => {
                    await getGarlic(bot);
                }
            },
            {
                name: 'get-stake-and-sword',
                isComplete: () => bot.findItem('Stake') !== null,
                run: async () => {
                    await talkToHarlow(bot);
                    await buyFromVarrockSwordShop(bot);
                }
            },
            {
                name: 'kill-vampire',
                isComplete: () => bot.getQuestProgress(VAMPIRE_SLAYER_VARP) === STAGE_COMPLETE,
                maxRetries: 5,
                run: async () => {
                    // Walk to Draynor Manor. The bot may be starting from
                    // Varrock (after get-stake-and-sword), Lumbridge (after
                    // death respawn), or already inside the manor (retry
                    // after a failed fight attempt).
                    const bx = bot.player.x;
                    const bz = bot.player.z;
                    const insideManor = bx >= 3095 && bx <= 3125 && bz >= 3330 && bz <= 3370;

                    if (insideManor) {
                        // Already inside Draynor Manor — go straight to
                        // the crypt stairs without re-routing through the
                        // entrance. Walk to the east wing first then to the
                        // stairs room (same path goToBasement uses inside).
                        bot.log('STATE', `Already inside manor at (${bx},${bz}), heading to basement`);
                        await bot.walkToWithPathfinding(3120, 3359);
                        await bot.walkToWithPathfinding(3118, 3357);
                        await bot.climbStairs('cryptstairsdown', 1);
                        await bot.waitForTicks(3);
                        if (bot.player.z < 9000) {
                            throw new Error(`Failed to reach basement from inside manor: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
                        }
                        bot.log('STATE', `In basement: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
                    } else if (bz >= 3380) {
                        // In Varrock (north of Champions' Guild) — reverse the
                        // shared Varrock route: west gate -> west road -> south
                        const returnRoute = [
                            { x: 3175, z: 3427 },
                            { x: 3080, z: 3400 },
                            { x: 3082, z: 3336 },
                            { x: DRAYNOR_MANOR_ENTRANCE_X, z: DRAYNOR_MANOR_ENTRANCE_Z },
                        ];
                        for (const wp of returnRoute) {
                            await bot.walkToWithPathfinding(wp.x, wp.z);
                        }
                        await goToBasement(bot);
                    } else {
                        // In Lumbridge area or south of Champions' Guild after
                        // death respawn. Go west first (south of the guild's
                        // brickwalls/fencing at ~3187-3193,3355-3365), then
                        // north to the manor.
                        const returnRoute = [
                            { x: 3105, z: 3250 },   // West to Draynor road (well south of guild)
                            { x: 3082, z: 3336 },   // NW along western road
                            { x: DRAYNOR_MANOR_ENTRANCE_X, z: DRAYNOR_MANOR_ENTRANCE_Z },
                        ];
                        for (const wp of returnRoute) {
                            await bot.walkToWithPathfinding(wp.x, wp.z);
                        }
                        await goToBasement(bot);
                    }

                    await fightCountDraynor(bot);

                    await bot.waitForTicks(5);
                    bot.dismissModals();

                    const finalVarp = bot.getQuestProgress(VAMPIRE_SLAYER_VARP);
                    const attackSkill = bot.getSkill('Attack');

                    if (finalVarp !== STAGE_COMPLETE) {
                        throw new Error(`Quest not complete: varp is ${finalVarp}, expected ${STAGE_COMPLETE}`);
                    }

                    if (attackSkill.exp <= 0) {
                        throw new Error('No attack XP gained during quest');
                    }

                    bot.log('SUCCESS', `Vampire Slayer quest complete! varp=${finalVarp}, attack_xp=${attackSkill.exp}`);
                }
            }
        ]
    };
}

export async function vampireSlayer(bot: BotAPI): Promise<void> {
    // === Setup: skip tutorial, start in Lumbridge ===
    await skipTutorial(bot);
    await bot.waitForTicks(2);

    bot.log('STATE', `Starting Vampire Slayer quest at (${bot.player.x},${bot.player.z},${bot.player.level})`);

    const initialVarp = bot.getQuestProgress(VAMPIRE_SLAYER_VARP);
    if (initialVarp !== STAGE_NOT_STARTED) {
        throw new Error(`Quest varp is ${initialVarp}, expected ${STAGE_NOT_STARTED} (not started)`);
    }

    const root = buildVampireSlayerStates(bot);
    const snapshotDir = path.resolve(import.meta.dir, '..', 'test', 'snapshots');
    await runStateMachine(bot, { root, varpIds: [VAMPIRE_SLAYER_VARP], captureSnapshots: true, snapshotDir });
}

export const metadata: ScriptMeta = {
    name: 'vampireslayer',
    type: 'quest',
    varpId: VAMPIRE_SLAYER_VARP,
    varpComplete: STAGE_COMPLETE,
    maxTicks: 60000,
    run: vampireSlayer,
    buildStates: buildVampireSlayerStates,
};
