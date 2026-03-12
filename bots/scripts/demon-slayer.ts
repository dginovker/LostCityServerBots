import path from 'path';
import { BotAPI } from '../runtime/api.js';
import { skipTutorial } from './skip-tutorial.js';
import { walkLumbridgeToVarrock } from './shared-routes.js';
import { type BotState, runStateMachine } from '../runtime/state-machine.js';
import type { ScriptMeta } from '../runtime/script-meta.js';
import { buildCooksAssistantStates, walkToKitchen } from './cooks-assistant.js';

// Varp IDs (from content/pack/varp.pack: 222=demonstart, 29=quest_cook)
export const DEMON_SLAYER_VARP = 222;
const COOK_QUEST_VARP = 29;
const COOK_QUEST_COMPLETE = 2;

// Quest stages (from content/scripts/quests/quest_demon/configs/demon.constant)
const STAGE_NOT_STARTED = 0;
const STAGE_TALKED_ARIS = 1;
const STAGE_KEY_HUNT = 2;
const STAGE_FIND_BONES = 3;
// Stages 3-27: each stage = one bone given to Traiborn
const STAGE_GOT_TRAIBORN_KEY = 28;
const STAGE_SILVERLIGHT = 29;
const STAGE_COMPLETE = 30;

// NpcStat.HITPOINTS = 3
const _HITPOINTS_STAT = 3;

// ---- Key locations ----

// Lumbridge
const LUMBRIDGE_SPAWN_X = 3222;
const LUMBRIDGE_SPAWN_Z = 3218;

// Lumbridge General Store (shop keeper)
const GENERAL_STORE_X = 3212;
const GENERAL_STORE_Z = 3247;

// Varrock Square area (Gypsy Aris is inside tent)
const VARROCK_SQUARE_X = 3203;
const VARROCK_SQUARE_Z = 3424;

// Varrock Palace entrance (ground floor, south side)
const VARROCK_PALACE_ENTRANCE_X = 3212;
const VARROCK_PALACE_ENTRANCE_Z = 3473;

// Sir Prysin is in the palace ground floor, west side
const SIR_PRYSIN_AREA_X = 3204;
const SIR_PRYSIN_AREA_Z = 3472;

// Varrock Palace NW tower staircase (loc_1738 at ground level)
// The NW tower stairs are at x=3202, z=3497 (from stairs.rs2: 0_50_54_2_41)
const _PALACE_NW_STAIRS_X = 3202;
const _PALACE_NW_STAIRS_Z = 3497;

// Drain location (palace kitchen area)
// The drain is near the palace kitchen, approximately (3225, 3496)
const DRAIN_AREA_X = 3225;
const DRAIN_AREA_Z = 3496;

// Varrock Palace manhole (enters sewer)
// The manhole is east of the palace at approximately (3237, 3457)
const MANHOLE_AREA_X = 3237;
const MANHOLE_AREA_Z = 3457;

// Sewer key location (from demon_slayer.rs2: obj_add at 0_50_154_25_41)
// x = 50*64+25 = 3225, z = 154*64+41 = 9897
const SEWER_KEY_X = 3225;
const SEWER_KEY_Z = 9897;

// Wizard Tower entrance
const WIZARD_TOWER_ENTRANCE_X = 3109;
const WIZARD_TOWER_ENTRANCE_Z = 3167;

// Dark wizards stone circle (Delrith spawn)
const STONE_CIRCLE_X = 3228;
const STONE_CIRCLE_Z = 3368;

// Chicken coop area — inside the pen (south fence is at z=3295)
const CHICKEN_AREA_X = 3235;
const CHICKEN_AREA_Z = 3298;

// Chicken pen gate — fencing at x=3236 blocks direct east-west path.
// Gate panels (loc_1551, loc_1553) at (3236,3295) and (3236,3296) with op1=Open.
const CHICKEN_GATE_X = 3236;
const CHICKEN_GATE_Z = 3296;

// Cow field east of Lumbridge (open area, no gate required on south/east approach)
const COW_FIELD_X = 3253;
const COW_FIELD_Z = 3270;

// Lumbridge castle kitchen (ground floor, where cooksquestrange is)
const _LUMBRIDGE_KITCHEN_X = 3211;
const _LUMBRIDGE_KITCHEN_Z = 3214;

// Fountain in Varrock Square (a water source for filling bucket)
const _VARROCK_FOUNTAIN_X = 3212;
const _VARROCK_FOUNTAIN_Z = 3428;

// walkToVarrock is now handled by walkLumbridgeToVarrock() from shared-routes

// earnCoins is now handled by bot.earnCoinsViaPickpocket()

/**
 * Walk to the chicken pen gate, open it, and walk through into the pen.
 * The fencing at x=3236 blocks the direct path from east to west.
 * Gate panels (loc_1551, loc_1553) at (3236,3295-3296) must be opened.
 */
async function enterChickenPen(bot: BotAPI): Promise<void> {
    // Walk to just east of the gate
    await bot.walkToWithPathfinding(CHICKEN_GATE_X + 1, CHICKEN_GATE_Z);
    bot.log('STATE', `At chicken gate: pos=(${bot.player.x},${bot.player.z})`);

    // Open both gate panels and walk through
    for (let attempt = 1; attempt <= 3; attempt++) {
        await bot.openGate(5);
        await bot.waitForTicks(1);
        await bot.openGate(5);
        await bot.waitForTicks(2);

        try {
            await bot.walkTo(CHICKEN_AREA_X, CHICKEN_AREA_Z);
            bot.log('STATE', `Inside chicken pen: pos=(${bot.player.x},${bot.player.z})`);
            return;
        } catch (err) {
            bot.log('STATE', `Gate crossing failed (attempt ${attempt}/3): ${(err as Error).message}`);
            if (attempt === 3) {
                throw new Error(`Failed to enter chicken pen after 3 attempts: ${(err as Error).message}`);
            }
            await bot.waitForTicks(3);
        }
    }
}

/**
 * Exit the chicken pen by walking back through the gate in the fencing at x=3236.
 */
async function exitChickenPen(bot: BotAPI): Promise<void> {
    bot.log('STATE', `Exiting chicken pen from pos=(${bot.player.x},${bot.player.z})`);

    // Walk to well inside the pen (3+ tiles from fence at x=3236) to avoid
    // walkTo's 1-tile tolerance landing us ON the fence collision.
    await bot.walkTo(CHICKEN_GATE_X - 3, CHICKEN_GATE_Z);

    // Use walkToWithPathfinding which auto-opens doors/gates when path is blocked
    await bot.walkToWithPathfinding(CHICKEN_GATE_X + 4, CHICKEN_GATE_Z);
    bot.log('STATE', `Exited chicken pen: pos=(${bot.player.x},${bot.player.z})`);
}

/**
 * Find a cooking loc (Range or Fireplace) near the player.
 * Returns the debugname to use with useItemOnLoc, or null if none found.
 * Skips the cooksquestrange since it blocks cooking without Cook's Quest.
 */
function _findCookingLoc(bot: BotAPI): string | null {
    const allLocs = bot.findAllNearbyLocs(16);
    // Look for ranges first (except cooksquestrange), then fireplaces
    for (const loc of allLocs) {
        if (loc.debugname === 'cooksquestrange') continue; // blocked without Cook's Quest
        if (loc.displayName === 'Range' || loc.displayName === 'Cooking range') {
            return loc.debugname;
        }
    }
    for (const loc of allLocs) {
        if (loc.displayName === 'Fireplace' || loc.displayName === 'Fire' || loc.displayName === 'Cooking pot') {
            return loc.debugname;
        }
    }
    return null;
}

/**
 * Train combat on chickens until attack reaches targetLevel.
 * Also collects raw chicken for cooking (food for cow farming).
 * Chickens have 3 HP, barely hit (0-1 damage, mostly miss), so death risk is near zero.
 */
async function trainCombatOnChickens(bot: BotAPI, targetAttackLevel: number, minRawChicken: number = 0): Promise<void> {
    const currentAtk = bot.getSkill('Attack').level;
    const currentRawChicken = bot.countItem('Raw chicken');
    if (currentAtk >= targetAttackLevel && currentRawChicken >= minRawChicken) {
        bot.log('STATE', `Attack already ${currentAtk} >= ${targetAttackLevel} and raw chicken ${currentRawChicken} >= ${minRawChicken}, skipping`);
        return;
    }

    bot.log('STATE', `=== Training combat on chickens until Attack >= ${targetAttackLevel} (currently ${currentAtk}), minRawChicken=${minRawChicken} ===`);

    await enterChickenPen(bot);

    if (bot.player.runenergy >= 500) {
        bot.enableRun(true);
    }

    let chickensKilled = 0;
    let totalTicks = 0;
    const MAX_TICKS = 30000;

    while (totalTicks < MAX_TICKS) {
        const atk = bot.getSkill('Attack').level;
        const rawChicken = bot.countItem('Raw chicken');
        if (atk >= targetAttackLevel && rawChicken >= minRawChicken) {
            bot.log('STATE', `Attack reached ${atk}, raw chicken ${rawChicken} >= ${minRawChicken}, done training on chickens`);
            break;
        }

        bot.dismissModals();
        if (bot.player.delayed) {
            await bot.waitForCondition(() => !bot.player.delayed, 20);
        }
        if (bot.isDead()) {
            bot.log('STATE', 'Died during chicken training, respawning');
            await bot.waitForRespawn();
            await enterChickenPen(bot);
            totalTicks += 100;
            continue;
        }

        const chicken = bot.findNearbyNpc('Chicken', 15);
        if (!chicken) {
            if (bot.player.x > CHICKEN_GATE_X) {
                await enterChickenPen(bot);
            } else {
                await bot.walkToWithPathfinding(CHICKEN_AREA_X, CHICKEN_AREA_Z);
            }
            await bot.waitForTicks(5);
            totalTicks += 10;
            continue;
        }

        try {
            await bot.interactNpc(chicken, 2);
        } catch {
            await bot.waitForTicks(3);
            totalTicks += 3;
            continue;
        }

        for (let tick = 0; tick < 100; tick++) {
            await bot.waitForTick();
            totalTicks++;
            if (!chicken.isActive) {
                chickensKilled++;
                break;
            }
        }

        // Pick up raw chicken for cooking later (food for cow farming)
        const rawChickenOnGround = bot.findNearbyGroundItem('Raw chicken', 5);
        if (rawChickenOnGround && bot.freeSlots() > 2) {
            try {
                await bot.takeGroundItem('Raw chicken', rawChickenOnGround.x, rawChickenOnGround.z);
                await bot.waitForTicks(2);
                totalTicks += 2;
            } catch { /* ignore */ }
        }

        // Drop bones and feathers to keep inventory clear for raw chicken
        for (const dropName of ['Bones', 'Feather']) {
            if (bot.findItem(dropName)) {
                await bot.dropItem(dropName);
                await bot.waitForTicks(1);
                totalTicks++;
            }
        }

        if (chickensKilled % 10 === 0 && chickensKilled > 0) {
            const hp = bot.getHealth();
            const rawChicken = bot.countItem('Raw chicken');
            bot.log('STATE', `Chickens killed: ${chickensKilled}, Attack: ${bot.getSkill('Attack').level}, HP: ${hp.current}/${hp.max}, raw chicken: ${rawChicken}`);
        }

        totalTicks += 2;
    }

    await exitChickenPen(bot);
    if (bot.player.run) {
        bot.enableRun(false);
    }
    const rawChicken = bot.countItem('Raw chicken');
    bot.log('EVENT', `Chicken training done: ${chickensKilled} kills, Attack=${bot.getSkill('Attack').level}, HP=${bot.getHealth().max}, raw chicken=${rawChicken}`);
}

/**
 * Kill cows east of Lumbridge for raw beef collection.
 * Cows have 8 HP, always drop raw_beef and cow_hide.
 *
 * Uses attackNpcClearingCollision for cows (size-2 NPCs that block each other).
 *
 * @param targetKills Minimum number of cows to kill (for training)
 * @param targetBeef Target raw beef count (stops early if reached even if kills < targetKills)
 */
async function _farmCows(bot: BotAPI, targetKills: number, targetBeef: number): Promise<void> {
    bot.log('STATE', `=== Farming cows: target ${targetKills} kills, ${targetBeef} beef ===`);

    // Free inventory space — drop items we don't need (keep Coins for potential tinderbox purchase)
    for (const dropName of ['Bucket', 'Bucket of water', 'Bones', 'Cow hide']) {
        while (bot.findItem(dropName)) {
            await bot.dropItem(dropName);
            await bot.waitForTicks(1);
        }
    }

    // Walk to cow field
    await bot.walkToWithPathfinding(COW_FIELD_X, COW_FIELD_Z);

    // Enable running for faster movement between cows
    if (bot.player.runenergy >= 500) {
        bot.enableRun(true);
    }

    let cowsKilled = 0;
    let totalTicks = 0;
    const MAX_TICKS = 30000;

    while (totalTicks < MAX_TICKS) {
        // Check both exit conditions
        const rawBeef = bot.countItem('Raw beef');
        const cookedMeat = bot.countItem('Cooked meat');
        if (cowsKilled >= targetKills && (rawBeef + cookedMeat) >= targetBeef) {
            break;
        }
        // Also stop if inventory is full and we have enough beef
        if (bot.freeSlots() === 0) {
            bot.log('STATE', 'Inventory full, stopping cow farming');
            break;
        }

        bot.dismissModals();

        if (bot.player.delayed) {
            await bot.waitForCondition(() => !bot.player.delayed, 20);
        }

        // Check if we died
        if (bot.isDead()) {
            bot.log('STATE', 'Died while farming cows, waiting for respawn');
            await bot.waitForRespawn();
            await bot.walkToWithPathfinding(COW_FIELD_X, COW_FIELD_Z);
            totalTicks += 100;
            continue;
        }

        // Eat food if HP is below 50%
        const hp = bot.getHealth();
        if (hp.current < hp.max / 2) {
            for (const foodName of ['Cooked meat', 'Cooked chicken']) {
                const food = bot.findItem(foodName);
                if (food) {
                    bot.log('ACTION', `Eating ${foodName} (HP=${hp.current}/${hp.max})`);
                    await bot.useItemOp1(foodName);
                    await bot.waitForTicks(2);
                    totalTicks += 2;
                    break;
                }
            }
        }

        // Find a cow
        const cow = bot.findNearbyNpc('Cow', 20);
        if (!cow) {
            await bot.walkToWithPathfinding(COW_FIELD_X, COW_FIELD_Z);
            await bot.waitForTicks(10);
            totalTicks += 15;
            continue;
        }

        // Attack the cow using collision-clearing (cows are size-2 and block each other)
        const deathPos = await bot.attackNpcClearingCollision(cow, 200);
        if (!deathPos) {
            await bot.waitForTicks(3);
            totalTicks += 3;
            continue;
        }

        cowsKilled++;
        await bot.waitForTicks(3); // Wait for death animation + drops
        totalTicks += 3;

        // Pick up raw beef from where the cow died
        const beefOnGround = bot.findNearbyGroundItem('Raw beef', 8);
        if (beefOnGround) {
            try {
                await bot.takeGroundItem('Raw beef', beefOnGround.x, beefOnGround.z);
                await bot.waitForTicks(2);
                totalTicks += 2;
            } catch {
                bot.log('STATE', 'Failed to pick up raw beef');
            }
        }

        // Drop cow hide to save inventory space (we don't need it)
        if (bot.findItem('Cow hide')) {
            await bot.dropItem('Cow hide');
            await bot.waitForTicks(1);
            totalTicks += 1;
        }
        // Drop bones to save inventory space
        if (bot.findItem('Bones')) {
            await bot.dropItem('Bones');
            await bot.waitForTicks(1);
            totalTicks += 1;
        }

        if (cowsKilled % 5 === 0) {
            const hp = bot.getHealth();
            bot.log('STATE', `Cows killed: ${cowsKilled}, raw beef: ${bot.countItem('Raw beef')}, HP: ${hp.current}/${hp.max}`);
        }

        totalTicks += 5;
    }

    // Disable running to conserve energy
    if (bot.player.run) {
        bot.enableRun(false);
    }

    const hp = bot.getHealth();
    bot.log('EVENT', `Cow farming done: ${cowsKilled} kills, ${bot.countItem('Raw beef')} raw beef, HP=${hp.current}/${hp.max}`);
}

/**
 * Cook all raw meat (beef + chicken) in the inventory.
 * Uses the Lumbridge castle cooksquestrange (requires Cook's Quest completed).
 */
async function cookAllRawMeat(bot: BotAPI): Promise<void> {
    const rawBeef = bot.countItem('Raw beef');
    const rawChicken = bot.countItem('Raw chicken');
    if (rawBeef === 0 && rawChicken === 0) return;

    bot.log('STATE', `=== Cooking ${rawBeef} raw beef + ${rawChicken} raw chicken ===`);

    // If near the chicken pen fence (x~3236), walk east first to escape fence collision
    if (Math.abs(bot.player.x - 3236) <= 2) {
        await bot.walkTo(3241, bot.player.z);
    }

    // Walk to Lumbridge castle kitchen (requires opening doors)
    await walkToKitchen(bot);

    const cookingLocDebugname = 'cooksquestrange';
    bot.log('STATE', `Using cooking loc: ${cookingLocDebugname}`);

    // Cook each raw meat one at a time (beef first, then chicken)
    let cooked = 0;
    let burnt = 0;
    let noEffect = 0;
    let exceptions = 0;

    for (const rawName of ['Raw beef', 'Raw chicken']) {
        const cookedName = rawName === 'Raw beef' ? 'Cooked meat' : 'Cooked chicken';
        noEffect = 0; // Reset per-item-type no-effect counter
        while (bot.findItem(rawName)) {
            try {
                const beforeRaw = bot.countItem(rawName);
                const beforeCooked = bot.countItem(cookedName);
                await bot.useItemOnLoc(rawName, cookingLocDebugname);
                await bot.waitForTicks(5);
                bot.dismissModals();

                const afterRaw = bot.countItem(rawName);
                const afterCooked = bot.countItem(cookedName);

                if (afterRaw < beforeRaw) {
                    if (afterCooked > beforeCooked) {
                        cooked++;
                    } else {
                        burnt++;
                    }
                } else {
                    noEffect++;
                    bot.log('STATE', `Cooking ${rawName} had no effect (attempt ${noEffect})`);
                    if (noEffect >= 2) {
                        bot.log('STATE', 'Cooking loc is not working, aborting');
                        break;
                    }
                }
            } catch (err) {
                exceptions++;
                bot.log('STATE', `Cooking exception: ${(err as Error).message}`);
                if (exceptions >= 3) {
                    bot.log('STATE', 'Too many cooking exceptions, giving up');
                    break;
                }
                bot.dismissModals();
                await bot.waitForTicks(3);
            }
        }
    }

    // If we climbed to level 1 to cook, climb back down
    if (bot.player.level === 1) {
        bot.log('STATE', 'Climbing back down from level 1');
        try { await bot.walkTo(3206, 3208); } catch { /* already near stairs */ }
        await bot.climbStairs('loc_1739', 3); // Climb-down
        await bot.waitForTicks(2);
    }

    const totalFood = bot.countItem('Cooked meat') + bot.countItem('Cooked chicken');
    bot.log('EVENT', `Cooking done: ${cooked} cooked, ${burnt} burnt. Total food: ${totalFood} (${bot.countItem('Cooked meat')} meat, ${bot.countItem('Cooked chicken')} chicken)`);
}

/**
 * Kill chickens near Lumbridge to collect bones (and train combat).
 * Chickens have 3 HP and always drop bones.
 */
async function collectBones(bot: BotAPI, targetBones: number): Promise<void> {
    bot.log('STATE', `=== Collecting ${targetBones} bones by killing chickens ===`);

    // Free inventory space — drop items we don't need for bone collecting
    // Keep: Bones (obviously), Keys (quest items needed later)
    // Drop: Coins, Bucket (already used for water earlier)
    const freeSlots = 28 - bot.getInventory().length;
    if (freeSlots < targetBones - bot.countItem('Bones')) {
        for (const dropName of ['Coins', 'Bucket', 'Bucket of water']) {
            const item = bot.findItem(dropName);
            if (item) {
                bot.log('STATE', `Dropping ${item.count}x ${dropName} to free inventory space`);
                await bot.dropItem(dropName);
                await bot.waitForTicks(2);
            }
        }
    }

    let bonesCollected = bot.countItem('Bones');
    let chickensKilled = 0;
    let totalTicks = 0;
    const MAX_TICKS = 30000;

    // Walk to chicken area (must open gate in the fencing at x=3236)
    await enterChickenPen(bot);

    // Enable running for faster movement between chickens
    if (bot.player.runenergy >= 500) {
        bot.enableRun(true);
    }

    while (bonesCollected < targetBones && totalTicks < MAX_TICKS) {
        bot.dismissModals();

        if (bot.player.delayed) {
            await bot.waitForCondition(() => !bot.player.delayed, 20);
        }

        // Check if we died
        if (bot.isDead()) {
            bot.log('STATE', 'Died while collecting bones, waiting for respawn');
            await bot.waitForRespawn();
            await enterChickenPen(bot);
            totalTicks += 100;
            continue;
        }

        // Find a chicken
        let chicken = bot.findNearbyNpc('Chicken', 15);
        if (!chicken) {
            // Walk back to chicken area (re-enter pen if we wandered outside the fence)
            if (bot.player.x > CHICKEN_GATE_X) {
                await enterChickenPen(bot);
            } else {
                await bot.walkToWithPathfinding(CHICKEN_AREA_X, CHICKEN_AREA_Z);
            }
            await bot.waitForTicks(5);
            totalTicks += 10;
            chicken = bot.findNearbyNpc('Chicken', 15);
            if (!chicken) {
                await bot.waitForTicks(10);
                totalTicks += 10;
                continue;
            }
        }

        // Attack the chicken
        try {
            await bot.interactNpc(chicken, 2); // op2 = Attack
        } catch {
            bot.log('STATE', 'Failed to attack chicken');
            await bot.waitForTicks(3);
            totalTicks += 3;
            continue;
        }

        // Wait for chicken to die — do NOT re-engage.
        // The engine's player_melee_attack script ends with p_opnpc(2) which
        // self-sustains the combat loop. Re-engaging cancels the pending attack.
        let chickenDied = false;

        for (let tick = 0; tick < 100; tick++) {
            await bot.waitForTick();
            totalTicks++;

            if (!chicken.isActive) {
                chickenDied = true;
                break;
            }
        }

        if (chickenDied) {
            chickensKilled++;
            bot.dismissModals();
            await bot.waitForTicks(2);
            totalTicks += 2;

            // Pick up bones
            const bonesOnGround = bot.findNearbyGroundItem('Bones', 5);
            if (bonesOnGround) {
                try {
                    await bot.takeGroundItem('Bones', bonesOnGround.x, bonesOnGround.z);
                    await bot.waitForTicks(2);
                    totalTicks += 2;
                } catch (err) {
                    bot.log('STATE', `Failed to pick up bones: ${(err as Error).message}`);
                }
            }

            bonesCollected = bot.countItem('Bones');
            if (chickensKilled % 5 === 0) {
                bot.log('STATE', `Chickens killed: ${chickensKilled}, bones: ${bonesCollected}/${targetBones}`);
            }
        }

        await bot.waitForTicks(2);
        totalTicks += 2;
    }

    if (bonesCollected < targetBones) {
        throw new Error(`Failed to collect ${targetBones} bones after ${chickensKilled} kills and ${totalTicks} ticks. Have ${bonesCollected} bones.`);
    }

    // Exit the chicken pen
    await exitChickenPen(bot);

    // Disable running to conserve energy
    if (bot.player.run) {
        bot.enableRun(false);
    }

    bot.log('EVENT', `Collected ${bonesCollected} bones in ${chickensKilled} kills`);
}

/**
 * Walk adjacent to Traiborn on Wizard Tower level 1.
 * Uses walkToWithPathfinding which handles door/wall collision better than
 * the engine's built-in pathToTarget (which silently fails with "I can't reach that!").
 */
async function walkToTraiborn(bot: BotAPI): Promise<void> {
    const traiborn = bot.findNearbyNpc('Traiborn', 30);
    if (!traiborn) {
        throw new Error(`Traiborn not found on level ${bot.player.level} near (${bot.player.x},${bot.player.z})`);
    }
    bot.log('STATE', `Traiborn at (${traiborn.x},${traiborn.z}), walking adjacent`);
    // Walk to the tile Traiborn is on (or adjacent). walkToWithPathfinding
    // uses the bot's multi-segment pathfinder which handles complex geometry.
    await bot.walkToWithPathfinding(traiborn.x, traiborn.z);
    await bot.waitForTicks(1);
}

/**
 * Navigate into the Wizard Tower and up to level 1 where Traiborn is.
 */
async function enterWizardTowerLevel1(bot: BotAPI): Promise<void> {
    await bot.walkToWithPathfinding(WIZARD_TOWER_ENTRANCE_X, WIZARD_TOWER_ENTRANCE_Z);
    bot.log('STATE', `At Wizard Tower entrance: pos=(${bot.player.x},${bot.player.z})`);

    // Open the entrance door
    await bot.openDoor('poordooropen');

    // Walk into the outer ring, toward the inner door
    await bot.walkToWithPathfinding(3108, 3163);
    bot.log('STATE', `Inside tower outer ring: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Open the inner door
    await bot.openDoor('poordooropen');

    // Walk closer to the staircase area
    await bot.walkToWithPathfinding(3106, 3161);
    bot.log('STATE', `Near staircase: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Climb up from level 0 to level 1 using loc_1738 (op1=Climb-up)
    await bot.climbStairs('loc_1738', 1);
    await bot.waitForTicks(2);

    if (bot.player.level !== 1) {
        throw new Error(`Failed to climb to level 1: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    bot.log('STATE', `On Wizard Tower level 1: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
}

/**
 * Exit the Wizard Tower from level 1.
 */
async function exitWizardTowerFromLevel1(bot: BotAPI): Promise<void> {
    // Clear any pending modals/scripts from prior dialog interactions.
    // The engine's canAccess() returns false while containsModalInterface() is true,
    // which blocks staircase OP triggers from firing. Complex dialogs (like Traiborn's
    // bone-giving loop) can leave multiple dialog pages unprocessed.
    for (let i = 0; i < 20; i++) {
        bot.dismissModals();
        if (!bot.player.containsModalInterface() && !bot.player.activeScript) break;
        await bot.waitForTicks(1);
    }

    // On level 1, walkToWithPathfinding may fail (no collision data for upper floors).
    // Use walkTo for direct movement since the Wizard Tower interior is open.
    // The staircase (loc_1739, 2x2) is at (3103-3104, 3159-3160).
    try {
        await bot.walkTo(3104, 3160);
    } catch {
        // Already close enough — walkTo fails if we're adjacent/on the loc
    }

    // Climb down from level 1 to level 0 using loc_1739 (op3=Climb-down)
    await bot.climbStairs('loc_1739', 3);
    await bot.waitForTicks(2);

    if (bot.player.level as number !== 0) {
        throw new Error(`Failed to climb down to level 0: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    bot.log('STATE', `Back on ground floor: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Walk out through the doors
    await bot.walkToWithPathfinding(3108, 3163);
    await bot.openDoor('poordooropen');
    await bot.walkToWithPathfinding(3109, 3167);
    await bot.openDoor('poordooropen');
    await bot.walkToWithPathfinding(3109, 3169);
    bot.log('STATE', `Exited Wizard Tower: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
}

/**
 * Talk to Gypsy Aris to start the quest.
 *
 * Dialog flow (from gypsy.rs2):
 * 1. chatnpc "Hello young one. Cross my palm with silver..."
 * 2. choice3: "Ok, here you go." (1) / "Who are you calling young one?!" (2) / "No..." (3)
 * 3. Select 1 -> chatplayer "Ok, here you go."
 *    (needs 1gp: inv_del(inv, coins, 1))
 * 4. chatnpc "Come closer..." (fortune telling sequence)
 * ... several dialogs ...
 * -> Eventually sets %demonstart = ^demon_talked_aris (1)
 * -> Then asks about incantation/silverlight
 */
async function talkToGypsyStart(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Talking to Gypsy Aris to start quest ===');

    await bot.talkToNpc('Gypsy');
    const dialogOpened = await bot.waitForDialog(30);
    if (!dialogOpened) {
        throw new Error('No dialog opened when talking to Gypsy');
    }

    // chatnpc "Hello young one. Cross my palm with silver..."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // choice3: select "Ok, here you go." (option 1)
    await bot.selectDialogOption(1);
    await bot.waitForDialog(10);

    // chatplayer "Ok, here you go."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatnpc "Come closer, and listen carefully..."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatnpc "I can see images forming..."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatnpc "You are holding a very impressive looking sword..."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatnpc "There is a big dark shadow..."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatnpc "Aaargh!"
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // choice3: "Very interesting..." (1) / "Are you alright?" (2) / "Aaargh?" (3)
    await bot.selectDialogOption(1);
    await bot.waitForDialog(10);

    // chatplayer "Very interesting. What does that Aaargh bit mean?"
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatnpc "It's Delrith! Delrith is coming!"
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // choice2: "Who's Delrith?" (1) / "Get a grip!" (2)
    await bot.selectDialogOption(1);
    await bot.waitForDialog(10);

    // chatplayer "Who's Delrith?"
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatnpc "Delrith..."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatnpc "Delrith is a powerful demon."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatnpc "Oh! I really hope he didn't see me..."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatnpc "He tried to destroy this city 150 years ago..."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatnpc "Using his magic sword Silverlight..."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatnpc "Ye gods! Silverlight was the sword..."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // choice3: "How am I meant to fight..." (1) / "Okay, where is he?..." (2) / "Wally doesn't sound..." (3)
    await bot.selectDialogOption(1);
    await bot.waitForDialog(10);

    // chatplayer "How am I meant to fight a demon who can destroy cities?!"
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatnpc "I admit it won't be easy."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatnpc "Wally managed to arrive at the stone circle..."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatnpc "By reciting the correct magical incantation..."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatnpc "Delrith will come forth..."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatnpc "I would imagine an evil sorcerer..."
    // At this point: %demonstart = ^demon_talked_aris
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // choice2: "What is the magical incantation?" (1) / "Where can I find Silverlight?" (2)
    // Ask about incantation first, then silverlight
    await bot.selectDialogOption(1);
    await bot.waitForDialog(10);

    // chatplayer "What is the magical incantation?"
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatnpc "Oh yes, let me think a second..."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatnpc "Alright, I think I've got it now... Carlem... Aber... Camerinthum... Purchai... Gabindo."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatplayer "I think so, yes."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // choice2: "Okay, thanks. I'll do my best..." (1) / "Where can I find Silverlight?" (2)
    // Ask about silverlight location
    await bot.selectDialogOption(2);
    await bot.waitForDialog(10);

    // chatplayer "Where can I find Silverlight?"
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatnpc "Silverlight has been passed down through Wally's descendants..."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatnpc "He shouldn't be too hard to find..."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // choice2: "Okay, thanks..." (1) / "What is the magical incantation?" (2)
    await bot.selectDialogOption(1);
    await bot.waitForDialog(10);

    // chatplayer "Okay, thanks. I'll do my best to stop the demon."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatnpc "Good luck, and may Guthix be with you!"
    await bot.continueDialog();

    await bot.waitForTicks(3);
    bot.dismissModals();
}

/**
 * Talk to Sir Prysin to learn about the three keys.
 *
 * Dialog flow (from sir_prysin.rs2):
 * When %demonstart = demon_talked_aris:
 * 1. chatnpc "Hello, who are you?"
 * 2. choice3: "I am a mighty adventurer..." (1) / "I was hoping you could tell me." (2) / "Gypsy Aris sent me." (3)
 * 3. Select 3 -> leads to quest dialog about Silverlight
 * -> Eventually sets %demonstart = ^demon_key_hunt (2)
 */
async function talkToSirPrysin(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Talking to Sir Prysin about Silverlight ===');

    await bot.talkToNpc('Sir Prysin');
    const dialogOpened = await bot.waitForDialog(30);
    if (!dialogOpened) {
        throw new Error('No dialog opened when talking to Sir Prysin');
    }

    // chatnpc "Hello, who are you?"
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // choice3: select "Gypsy Aris said I should come and talk to you." (option 3)
    await bot.selectDialogOption(3);
    await bot.waitForDialog(10);

    // chatplayer "Gypsy Aris said I should come and talk to you."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatnpc "Gypsy Aris? Is she still alive?..."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // choice2: "I need to find Silverlight." (1) / "Yes, she is still alive." (2)
    await bot.selectDialogOption(1);
    await bot.waitForDialog(10);

    // chatplayer "I need to find Silverlight."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatnpc "What do you need to find that for?"
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatplayer "I need it to fight Delrith."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatnpc "Delrith? I thought the world was rid of him."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // choice2: "Well, the gypsy's crystal ball..." (1) / "He's back..." (2)
    await bot.selectDialogOption(1);
    await bot.waitForDialog(10);

    // chatplayer "Well the gypsy's crystal ball seems to think otherwise."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatnpc "Well if the ball says so, I'd better help you."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatnpc "The problem is getting Silverlight."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatplayer "You mean you don't have it?"
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatnpc "Oh I do have it, but it is so powerful that I have to put it in a special box..."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // choice2: "So give me the keys!" (1) / "And why is this a problem?" (2)
    await bot.selectDialogOption(1);
    await bot.waitForDialog(10);

    // chatplayer "So give me the keys!"
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatnpc "Um, well it's not so easy."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatnpc "I kept one of the keys..."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatnpc "One I gave to Rovin..."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatnpc "I gave the other to the wizard Traiborn."
    // At this point: %demonstart = ^demon_key_hunt (2)
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // choice3: "Can you give me your key?" (1) / "Where can I find Captain Rovin?" (2) / "Where does the wizard live?" (3)
    // Ask about the drain key first
    await bot.selectDialogOption(1);
    await bot.waitForDialog(10);

    // chatplayer "Can you give me your key?"
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatnpc "Um.... ah...."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatnpc "Well there's a problem there as well."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatnpc "I managed to drop the key in the drain..."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // choice3: "So what does the drain lead to?" (1) / "Where can I find Captain Rovin?" (2) / "Where does the wizard live?" (3)
    // Finish dialog
    await bot.selectDialogOption(3);
    await bot.waitForDialog(10);

    // chatplayer "Where does the wizard live?"
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatnpc "Wizard Traiborn?"
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatnpc "He is one of the wizards who lives in the tower..."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // choice3: "Can you give me your key?" (1) / "Where can I find Captain Rovin?" (2) / "Well I'd better go key hunting." (3)
    await bot.selectDialogOption(3);
    await bot.waitForDialog(10);

    // chatplayer "Well I'd better go key hunting."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatnpc "Ok, goodbye."
    await bot.continueDialog();

    await bot.waitForTicks(3);
    bot.dismissModals();
}

/**
 * Get Captain Rovin's key (silverlight_key_2) from the palace NW tower level 2.
 */
async function getCaptainRovinKey(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Getting Captain Rovin\'s key ===');

    // Walk to the NW tower staircase on ground floor.
    // The NW tower is enclosed by bigstone_castlewall on all sides with a door
    // (desertdoorclosed) at (3203,3494) on the south wall. Inside the tower,
    // the staircase is surrounded by more walls with the approach from the east.
    //
    // Strategy: walk through the palace courtyard to just south of the NW tower,
    // open the tower door, walk inside, then use climbStairs which handles
    // pathfinding to the loc via findPathToLocSegment.
    await bot.walkToWithPathfinding(3215, 3480);
    await bot.walkToWithPathfinding(3210, 3490);
    await bot.walkToWithPathfinding(3203, 3492);
    bot.log('STATE', `Near NW tower entrance: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    // Open the NW tower door (desertdoorclosed at 3203,3494) and walk through
    await bot.openDoor('desertdoorclosed');
    await bot.waitForTicks(2);
    // Walk inside the tower — approach from east side of the staircase
    await bot.walkToWithPathfinding(3204, 3496);
    bot.log('STATE', `Inside NW tower: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Climb up from level 0 to level 1 using loc_1738 (op1=Climb-up)
    await bot.climbStairs('loc_1738', 1);
    await bot.waitForTicks(2);

    if (bot.player.level !== 1) {
        throw new Error(`Failed to climb to level 1 in NW tower: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    bot.log('STATE', `NW tower level 1: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Climb up from level 1 to level 2 using loc_1739 (op2=Climb-up)
    await bot.climbStairs('loc_1739', 2);
    await bot.waitForTicks(2);

    if (bot.player.level as number !== 2) {
        throw new Error(`Failed to climb to level 2 in NW tower: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    bot.log('STATE', `NW tower level 2: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Talk to Captain Rovin
    await bot.talkToNpc('Captain Rovin');
    const dialogOpened = await bot.waitForDialog(30);
    if (!dialogOpened) {
        throw new Error('No dialog opened when talking to Captain Rovin');
    }

    // chatnpc "What are you doing up here?..."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // choice3: "I am one of the palace guards." (1) / "What about the King?" (2) / "Yes I know, but this is important." (3)
    await bot.selectDialogOption(3);
    await bot.waitForDialog(10);

    // chatplayer "Yes, I know, but this is important."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatnpc "Ok, I'm listening..."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // choice3: "There's a demon who wants to invade this city." (1) / "Erm I forgot." (2) / "The castle has just received its ale delivery." (3)
    await bot.selectDialogOption(1);
    await bot.waitForDialog(10);

    // chatplayer "There's a demon who wants to invade the city."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatnpc "Is it a powerful demon?"
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatplayer "Yes, very."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatnpc "As good as the palace guards are..."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatplayer "It's not them who are going to fight the demon, it's me."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatnpc "What, all by yourself?..."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatplayer "I'm going to use the powerful sword Silverlight..."
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatnpc "Yes you are right. Here you go."
    // if_close + p_delay(2) + mes "Captain Rovin hands you a key." + inv_add
    await bot.continueDialog();

    await bot.waitForTicks(5);
    bot.dismissModals();

    // Verify we got the key
    if (!bot.findItem('Key')) {
        throw new Error('Failed to receive key from Captain Rovin');
    }
    bot.log('EVENT', 'Got Captain Rovin\'s key (silverlight_key_2)');

    // Climb back down to ground floor
    // Level 2 -> Level 1 using loc_1740 (op1=Climb-down)
    await bot.climbStairs('loc_1740', 1);
    await bot.waitForTicks(2);

    if (bot.player.level as number !== 1) {
        throw new Error(`Failed to climb down to level 1: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }

    // Level 1 -> Level 0 using loc_1739 (op3=Climb-down)
    await bot.climbStairs('loc_1739', 3);
    await bot.waitForTicks(2);

    if (bot.player.level as number !== 0) {
        throw new Error(`Failed to climb down to level 0: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    bot.log('STATE', `Back on ground floor: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
}

/**
 * Get the drain key (silverlight_key_3) by pouring water on the drain and
 * retrieving the key from the sewer.
 */
async function getDrainKey(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Getting drain key ===');

    // Walk to the drain area (palace kitchen)
    await bot.walkToWithPathfinding(DRAIN_AREA_X, DRAIN_AREA_Z);
    bot.log('STATE', `Near drain: pos=(${bot.player.x},${bot.player.z})`);

    // Use bucket of water on the drain
    await bot.useItemOnLoc('Bucket of water', 'questdrain');
    await bot.waitForTicks(5);

    // Verify bucket is now empty
    if (!bot.findItem('Bucket')) {
        bot.log('STATE', 'No empty bucket found after pouring water - checking if water was used');
    }
    bot.log('EVENT', 'Poured water down the drain');

    // Now go to the sewer via the manhole
    // Walk to the manhole area
    await bot.walkToWithPathfinding(MANHOLE_AREA_X, MANHOLE_AREA_Z);
    bot.log('STATE', `Near manhole: pos=(${bot.player.x},${bot.player.z})`);

    // Open the manhole (interact with manholeclosed, op1=Open)
    const manhole = bot.findNearbyLoc('manholeclosed', 10);
    if (manhole) {
        await bot.interactLoc(manhole, 1);
        await bot.waitForTicks(3);
        bot.log('STATE', 'Opened manhole');
    }

    // Climb down through the open manhole (op1=Climb-down on manholeopen)
    const openManhole = bot.findNearbyLoc('manholeopen', 10);
    if (!openManhole) {
        throw new Error(`No open manhole found near (${bot.player.x},${bot.player.z})`);
    }
    await bot.interactLoc(openManhole, 1);
    await bot.waitForTicks(3);

    bot.log('STATE', `In sewer: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Walk to the key location in the sewer
    await bot.walkToWithPathfinding(SEWER_KEY_X, SEWER_KEY_Z);
    bot.log('STATE', `At key location: pos=(${bot.player.x},${bot.player.z})`);

    // Pick up the key from the ground
    await bot.waitForTicks(2);
    const keyOnGround = bot.findNearbyGroundItem('Key', 5);
    if (!keyOnGround) {
        throw new Error(`Key not found on ground near (${SEWER_KEY_X},${SEWER_KEY_Z})`);
    }
    await bot.takeGroundItem('Key', keyOnGround.x, keyOnGround.z);
    await bot.waitForTicks(3);

    bot.log('EVENT', 'Got drain key (silverlight_key_3)');

    // Exit the sewer - walk back to the manhole entry point and climb a ladder.
    // The manhole drops us at (MANHOLE_AREA_X, MANHOLE_AREA_Z + 6400).
    // Ladders (loc_1755, loc_1757) with op1=Climb-up do movecoord(0,0,-6400).
    bot.log('STATE', `Looking for sewer exit from pos=(${bot.player.x},${bot.player.z})`);

    // Walk back toward the manhole entry point underground
    const undergroundZ = MANHOLE_AREA_Z + 6400;
    bot.log('STATE', `Walking to manhole entry point underground at (${MANHOLE_AREA_X},${undergroundZ})`);
    await bot.walkToWithPathfinding(MANHOLE_AREA_X, undergroundZ);
    await bot.waitForTicks(2);

    // Search for a ladder by display name within a wide radius
    let exitLadder = bot.findNearbyLocByDisplayName('Ladder', 30);
    if (!exitLadder) {
        // Also try the specific loc IDs
        exitLadder = bot.findNearbyLoc('loc_1755', 30);
    }
    if (!exitLadder) {
        exitLadder = bot.findNearbyLoc('loc_1757', 30);
    }

    if (!exitLadder) {
        // Dump all nearby locs for debugging
        const allLocs = bot.findAllNearbyLocs(30);
        const locDump = allLocs.map(l => `  ${l.debugname} (${l.displayName}) at (${l.x},${l.z}) dist=${l.dist}`).join('\n');
        throw new Error(`No ladder found near (${bot.player.x},${bot.player.z}) in sewer.\nNearby locs:\n${locDump}`);
    }

    bot.log('STATE', `Found exit ladder at (${exitLadder.x},${exitLadder.z})`);
    await bot.interactLoc(exitLadder, 1);
    await bot.waitForTicks(5);

    if (bot.player.z > 6400) {
        throw new Error(`Still underground after climbing ladder: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }

    bot.log('STATE', `Exited sewer: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
}

/**
 * Get Wizard Traiborn's key (silverlight_key_1) by giving him 25 bones.
 */
async function getTraibornKey(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Getting Traiborn\'s key ===');

    const currentVarp = bot.getQuestProgress(DEMON_SLAYER_VARP);
    bot.log('STATE', `Traiborn step: varp=${currentVarp}`);

    // Phase 1: If we haven't yet asked Traiborn about the key, do the initial dialog.
    // varp < STAGE_FIND_BONES means we need the initial conversation.
    if (currentVarp < STAGE_FIND_BONES) {
        await enterWizardTowerLevel1(bot);

        await walkToTraiborn(bot);
        await bot.talkToNpc('Traiborn');
        const dialogOpened = await bot.waitForDialog(45);
        if (!dialogOpened) {
            throw new Error(`No dialog opened when talking to Traiborn at (${bot.player.x},${bot.player.z},${bot.player.level})`);
        }

        // chatnpc "Ello young thingummywut."
        await bot.continueDialog();
        await bot.waitForDialog(10);

        // choice3: option 3 = "I need to get a key given to you by Sir Prysin."
        await bot.selectDialogOption(3);
        await bot.waitForDialog(10);

        // chatplayer "I need to get a key given to you by Sir Prysin."
        await bot.continueDialog();
        await bot.waitForDialog(10);

        // chatnpc "Sir Prysin? Who's that?..."
        await bot.continueDialog();
        await bot.waitForDialog(10);

        // choice3: option 3 = "Well, have you got any keys knocking around?"
        await bot.selectDialogOption(3);
        await bot.waitForDialog(10);

        // chatplayer "Well, have you got any keys knocking around?"
        await bot.continueDialog();
        await bot.waitForDialog(10);

        // chatnpc "Now you come to mention it, yes I do have a key..."
        await bot.continueDialog();
        await bot.waitForDialog(10);

        // chatnpc "I sealed it using one of my magic rituals..."
        await bot.continueDialog();
        await bot.waitForDialog(10);

        // chatplayer "So do you know what ritual to use?"
        await bot.continueDialog();
        await bot.waitForDialog(10);

        // chatnpc "Let me think a second."
        await bot.continueDialog();
        await bot.waitForDialog(10);

        // chatnpc "Yes a simple drazier style ritual... I'll need 25 sets of bones..."
        await bot.continueDialog();
        await bot.waitForDialog(10);

        // choice2: option 2 = "I'll get the bones for you."
        await bot.selectDialogOption(2);
        await bot.waitForDialog(10);

        // chatplayer "I'll help get the bones for you."
        await bot.continueDialog();
        await bot.waitForDialog(10);

        // chatnpc "Ooh that would be very good of you."
        await bot.continueDialog();
        await bot.waitForDialog(10);

        // chatplayer "Okay, I'll speak to you when I've got some bones."
        // %demonstart = ^demon_find_bones (3)
        await bot.continueDialog();

        await bot.waitForTicks(3);
        bot.dismissModals();

        const varp = bot.getQuestProgress(DEMON_SLAYER_VARP);
        if (varp !== STAGE_FIND_BONES) {
            throw new Error(`Expected varp ${STAGE_FIND_BONES} after Traiborn dialog, got ${varp}`);
        }
        bot.log('EVENT', 'Traiborn wants 25 bones, quest stage set to find_bones');

        // Exit tower to go collect bones
        await exitWizardTowerFromLevel1(bot);
    }

    // Phase 2: Collect bones if we don't have enough.
    // The varp tracks how many bones have been given: each bone increments varp by 1,
    // starting from STAGE_FIND_BONES (3) up to STAGE_GOT_TRAIBORN_KEY (28).
    // So we need (28 - currentVarp) more bones, minus what we already hold.
    const updatedVarp = bot.getQuestProgress(DEMON_SLAYER_VARP);
    if (updatedVarp >= STAGE_FIND_BONES && updatedVarp < STAGE_GOT_TRAIBORN_KEY) {
        const bonesNeeded = STAGE_GOT_TRAIBORN_KEY - updatedVarp;
        const bonesHeld = bot.countItem('Bones');
        const bonesToCollect = bonesNeeded - bonesHeld;

        if (bonesToCollect > 0) {
            bot.log('STATE', `Need ${bonesNeeded} more bones (have ${bonesHeld}), collecting ${bonesToCollect}`);
            await collectBones(bot, bonesToCollect);
        }

        // Go to Wizard Tower to give bones
        bot.log('STATE', 'Walking back to Wizard Tower with bones');
        await bot.walkToWithPathfinding(LUMBRIDGE_SPAWN_X, LUMBRIDGE_SPAWN_Z);
        await enterWizardTowerLevel1(bot);

        // Walk adjacent to Traiborn and talk
        await walkToTraiborn(bot);
        await bot.talkToNpc('Traiborn');
        const dialog2 = await bot.waitForDialog(45);
        if (!dialog2) {
            throw new Error('No dialog opened when talking to Traiborn to give bones');
        }

        // chatnpc "How are you doing finding bones?"
        await bot.continueDialog();
        await bot.waitForDialog(10);

        // chatplayer "I have some bones."
        await bot.continueDialog();
        await bot.waitForDialog(10);

        // chatnpc "Give 'em here then."
        await bot.continueDialog();

        // The script runs demon_slayer_traiborn_give_bones which loops,
        // deleting bones one at a time and incrementing %demonstart.
        // After all 25 bones, it reaches demon_got_traiborn_key stage.
        // Then: "Hurrah! That's all 25 sets of bones."
        // Then the incantation + key delivery

        // Wait for the bone-giving loop to complete
        await bot.waitForTicks(30);

        // The script should now be showing the incantation sequence
        // Wait for any remaining dialogs
        for (let i = 0; i < 30; i++) {
            const hasDialog = await bot.waitForDialog(5);
            if (!hasDialog) break;
            if (bot.isMultiChoiceOpen()) break;
            await bot.continueDialog();
        }

        await bot.waitForTicks(5);
        bot.dismissModals();
    }

    // Verify we got the key
    const keyCount = bot.countItem('Key');
    if (keyCount < 1) {
        throw new Error('Failed to receive key from Traiborn');
    }
    bot.log('EVENT', 'Got Traiborn\'s key (silverlight_key_1)');

    // Exit the tower if we're still inside
    if ((bot.player.level as number) !== 0) {
        await exitWizardTowerFromLevel1(bot);
    }
}

/**
 * Return to Sir Prysin with all 3 keys to get Silverlight.
 */
async function getSilverlight(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Getting Silverlight from Sir Prysin ===');

    // Enter Varrock Palace through front doors
    // Approach palace from south (gate collision blocks direct path to entrance z=3473)
    await bot.walkToWithPathfinding(VARROCK_PALACE_ENTRANCE_X, VARROCK_PALACE_ENTRANCE_Z - 2);
    await bot.openDoor('palacedoor_l');
    await bot.waitForTicks(1);
    await bot.walkToWithPathfinding(SIR_PRYSIN_AREA_X, SIR_PRYSIN_AREA_Z);
    bot.log('STATE', `Near Sir Prysin: pos=(${bot.player.x},${bot.player.z})`);

    await bot.talkToNpc('Sir Prysin');
    const dialogOpened = await bot.waitForDialog(30);
    if (!dialogOpened) {
        throw new Error('No dialog opened when talking to Sir Prysin for keys');
    }

    // chatnpc "So how are you doing with getting the keys?"
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatplayer "I've got all three keys!"
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // chatnpc "Excellent! Now I can give you Silverlight."
    // if_close, mes "You give all three keys...", p_delay(2), mes "Prysin hands you...", inv_add silverlight
    await bot.continueDialog();

    await bot.waitForTicks(10);
    bot.dismissModals();

    // Verify we got Silverlight
    if (!bot.findItem('Silverlight')) {
        throw new Error('Failed to receive Silverlight from Sir Prysin');
    }

    const varp = bot.getQuestProgress(DEMON_SLAYER_VARP);
    if (varp !== STAGE_SILVERLIGHT) {
        throw new Error(`Expected varp ${STAGE_SILVERLIGHT} after getting Silverlight, got ${varp}`);
    }
    bot.log('EVENT', `Got Silverlight! varp=${varp}`);
}

/**
 * Fight Delrith at the dark wizards circle south of Varrock.
 * Must have Silverlight equipped.
 * When Delrith is weakened, choose the correct incantation (option 4).
 */
async function fightDelrith(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Fighting Delrith ===');

    // Equip Silverlight
    await bot.equipItem('Silverlight');
    await bot.waitForTicks(2);

    // Verify Silverlight is equipped (should no longer be in inventory)
    if (bot.findItem('Silverlight')) {
        throw new Error('Silverlight is still in inventory after equipping');
    }
    bot.log('EVENT', 'Silverlight equipped');

    // Walk to the stone circle
    await bot.walkToWithPathfinding(STONE_CIRCLE_X, STONE_CIRCLE_Z);
    bot.log('STATE', `At stone circle: pos=(${bot.player.x},${bot.player.z})`);

    // Enable running for combat
    if (bot.player.runenergy >= 500) {
        bot.enableRun(true);
    }

    // Find and attack Delrith
    let delrith = bot.findNearbyNpc('Delrith', 20);
    if (!delrith) {
        // Wait a bit for Delrith to spawn
        bot.log('STATE', 'Delrith not found, waiting for spawn');
        for (let i = 0; i < 30; i++) {
            await bot.waitForTicks(5);
            delrith = bot.findNearbyNpc('Delrith', 20);
            if (delrith) break;
        }
        if (!delrith) {
            throw new Error('Delrith not found near stone circle');
        }
    }

    bot.log('STATE', `Found Delrith at (${delrith.x},${delrith.z})`);

    // Combat loop - may need to die and retry
    const MAX_ATTEMPTS = 20;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        bot.log('STATE', `Combat attempt ${attempt + 1}`);

        // Check if we died and need to recover
        if (bot.isDead()) {
            bot.log('STATE', 'Died during combat, waiting for respawn');
            await bot.waitForRespawn();
            bot.log('STATE', `Respawned at (${bot.player.x},${bot.player.z})`);

            // Re-gather food if we ran out — use chickens (safe) not cows (dangerous without food)
            const foodLeft = bot.countItem('Cooked meat') + bot.countItem('Cooked chicken');
            if (foodLeft < 5) {
                bot.log('STATE', `Only ${foodLeft} food left after death, re-gathering via chickens`);
                await trainCombatOnChickens(bot, bot.getSkill('Attack').level, 20);
                await cookAllRawMeat(bot);
            }

            // Walk back to the stone circle
            await bot.walkToWithPathfinding(STONE_CIRCLE_X, STONE_CIRCLE_Z);

            // Re-equip Silverlight if we still have it
            if (bot.findItem('Silverlight')) {
                await bot.equipItem('Silverlight');
                await bot.waitForTicks(2);
            }

            // Find Delrith again
            delrith = bot.findNearbyNpc('Delrith', 20);
            if (!delrith) {
                bot.log('STATE', 'Waiting for Delrith to respawn');
                for (let i = 0; i < 60; i++) {
                    await bot.waitForTicks(5);
                    delrith = bot.findNearbyNpc('Delrith', 20);
                    if (delrith) break;
                }
                if (!delrith) {
                    throw new Error('Delrith not found after respawn');
                }
            }
        }

        // Attack Delrith (op2 = Attack)
        try {
            await bot.interactNpc(delrith, 2);
        } catch {
            bot.log('STATE', 'Failed to initiate attack on Delrith');
            await bot.waitForTicks(5);
            continue;
        }

        // Fight until Delrith becomes weakened or we die
        let delrithWeakened = false;
        for (let tick = 0; tick < 600; tick++) {
            await bot.waitForTick();

            // Check for death
            if (bot.isDead()) {
                break;
            }

            // Eat food aggressively — dark wizards at the stone circle can hit 7+,
            // so eat whenever we're missing 3+ HP to stay near full health.
            const health = bot.getHealth();
            if (health.current <= health.max - 3) {
                for (const foodName of ['Cooked meat', 'Cooked chicken']) {
                    const food = bot.findItem(foodName);
                    if (food) {
                        bot.log('ACTION', `Eating ${foodName} (HP=${health.current}/${health.max})`);
                        await bot.useItemOp1(foodName);
                        await bot.waitForTicks(2);
                        break;
                    }
                }
            }

            // Check if the incantation dialog has appeared
            // (happens when Delrith's HP reaches 0 - ai_queue3 fires)
            if (bot.isDialogOpen()) {
                bot.log('STATE', 'Dialog appeared during combat - incantation time!');
                delrithWeakened = true;
                break;
            }

            // Check for "Weakened Delrith" NPC (delrith_weakened type)
            const weakenedDelrith = bot.findNearbyNpc('Weakened Delrith', 20);
            if (weakenedDelrith) {
                bot.log('STATE', 'Delrith is weakened!');
                delrithWeakened = true;
                // Wait for the dialog to appear
                const dialogAppeared = await bot.waitForDialog(30);
                if (!dialogAppeared) {
                    bot.log('STATE', 'No dialog after Delrith weakened, waiting more');
                    await bot.waitForTicks(10);
                    const dialogRetry = await bot.waitForDialog(30);
                    if (!dialogRetry) {
                        throw new Error('Incantation dialog never appeared after Delrith was weakened');
                    }
                }
                break;
            }

            // Check if Delrith went inactive (died/transformed)
            // Do NOT re-engage the same active Delrith — the engine's
            // player_melee_attack p_opnpc(2) self-sustains the combat loop.
            if (!delrith.isActive) {
                // Wait a bit for the weakened version or dialog
                await bot.waitForTicks(5);
                const weakened = bot.findNearbyNpc('Weakened Delrith', 20);
                if (weakened) {
                    delrithWeakened = true;
                    const dialogAppeared = await bot.waitForDialog(30);
                    if (!dialogAppeared) {
                        throw new Error('No incantation dialog after Delrith weakened');
                    }
                    break;
                }
                // Maybe need to find Delrith again (respawned as full strength)
                delrith = bot.findNearbyNpc('Delrith', 20);
                if (!delrith) {
                    await bot.waitForTicks(10);
                    delrith = bot.findNearbyNpc('Delrith', 20);
                }
                if (delrith) {
                    // This IS a new Delrith instance, so attacking is appropriate
                    try {
                        await bot.interactNpc(delrith, 2);
                    } catch {
                        break;
                    }
                }
            }

            // Log progress periodically
            if (tick > 0 && tick % 50 === 0) {
                const hp = bot.getHealth();
                bot.log('STATE', `Combat tick ${tick}: HP=${hp.current}/${hp.max}`);
            }
        }

        if (bot.isDead()) {
            continue; // Will handle death at top of loop
        }

        if (delrithWeakened) {
            // Say the correct incantation
            // From delrith.rs2, the dialog is:
            // chatplayer "Now what was that incantation again?"
            // choice4: option 4 = "Carlem Aber Camerinthum Purchai Gabindo" (correct)

            // First handle the chatplayer line
            if (bot.isDialogOpen()) {
                if (bot.isMultiChoiceOpen()) {
                    // Already at the choice
                    bot.log('STATE', 'At incantation choice');
                } else {
                    // chatplayer "Now what was that incantation again?"
                    await bot.continueDialog();
                    await bot.waitForDialog(10);
                }
            }

            // Select the correct incantation (option 4)
            if (bot.isMultiChoiceOpen()) {
                bot.log('ACTION', 'Selecting correct incantation: option 4');
                await bot.selectDialogOption(4);
                await bot.waitForDialog(10);

                // chatplayer "Carlem Aber Camerinthum Purchai Gabindo"
                await bot.continueDialog();
                await bot.waitForDialog(10);

                // mesbox "As you chant, Delrith is sucked towards the vortex..."
                await bot.continueDialog();

                await bot.waitForTicks(10);
                bot.dismissModals();

                // Quest should now be complete
                const varp = bot.getQuestProgress(DEMON_SLAYER_VARP);
                if (varp === STAGE_COMPLETE) {
                    bot.log('EVENT', 'Delrith banished! Quest complete!');
                    return;
                }
                bot.log('STATE', `After incantation, varp=${varp} (expected ${STAGE_COMPLETE})`);

                // Continue any remaining dialogs
                for (let i = 0; i < 10; i++) {
                    const hasDialog = await bot.waitForDialog(5);
                    if (!hasDialog) break;
                    await bot.continueDialog();
                }
                await bot.waitForTicks(5);
                bot.dismissModals();

                const finalVarp = bot.getQuestProgress(DEMON_SLAYER_VARP);
                if (finalVarp === STAGE_COMPLETE) {
                    bot.log('EVENT', 'Quest complete after settling dialogs!');
                    return;
                }
            } else {
                bot.log('STATE', 'Expected multi-choice for incantation but dialog is not a choice');
                // Try continuing through any remaining dialogs
                for (let i = 0; i < 10; i++) {
                    const hasDialog = await bot.waitForDialog(5);
                    if (!hasDialog) break;
                    if (bot.isMultiChoiceOpen()) {
                        await bot.selectDialogOption(4);
                        await bot.waitForDialog(10);
                        await bot.continueDialog();
                        await bot.waitForDialog(10);
                        await bot.continueDialog();
                        await bot.waitForTicks(10);
                        bot.dismissModals();
                        const varp = bot.getQuestProgress(DEMON_SLAYER_VARP);
                        if (varp === STAGE_COMPLETE) {
                            bot.log('EVENT', 'Quest complete!');
                            return;
                        }
                        break;
                    }
                    await bot.continueDialog();
                }
            }
        }

        // If we get here without completing, the quest might not be done yet
        const varp = bot.getQuestProgress(DEMON_SLAYER_VARP);
        if (varp === STAGE_COMPLETE) {
            bot.log('EVENT', 'Quest complete!');
            return;
        }

        bot.log('STATE', `End of attempt ${attempt + 1}, varp=${varp}`);
        await bot.waitForTicks(5);
        bot.dismissModals();

        // Find Delrith again for next attempt
        delrith = bot.findNearbyNpc('Delrith', 20);
        if (!delrith) {
            bot.log('STATE', 'Waiting for Delrith to respawn');
            for (let i = 0; i < 30; i++) {
                await bot.waitForTicks(10);
                delrith = bot.findNearbyNpc('Delrith', 20);
                if (delrith) break;
            }
            if (!delrith) {
                throw new Error('Delrith not found for re-attempt');
            }
        }
    }

    throw new Error(`Failed to defeat Delrith after ${MAX_ATTEMPTS} attempts`);
}

/**
 * Build the Demon Slayer state machine.
 */
export function buildDemonSlayerStates(bot: BotAPI): BotState {
    return {
        name: 'demon-slayer',
        isComplete: () => bot.getQuestProgress(DEMON_SLAYER_VARP) === STAGE_COMPLETE,
        run: async () => { throw new Error('Composite state should not be called directly'); },
        children: [
            {
                name: 'earn-coins-and-buy-bucket',
                stuckThreshold: 3000,
                isComplete: () => {
                    return bot.findItem('Bucket') !== null || bot.findItem('Bucket of water') !== null;
                },
                run: async () => {
                    await bot.earnCoinsViaPickpocket(5);

                    await bot.walkToWithPathfinding(GENERAL_STORE_X, GENERAL_STORE_Z);
                    const shopKeeper = bot.findNearbyNpc('Shop keeper');
                    if (!shopKeeper) {
                        throw new Error('Shop keeper not found at Lumbridge general store');
                    }
                    await bot.interactNpc(shopKeeper, 3);
                    await bot.waitForTicks(3);
                    await bot.buyFromShop('Bucket', 1);
                    await bot.waitForTicks(1);
                    bot.dismissModals();

                    if (!bot.findItem('Bucket')) {
                        throw new Error('Failed to buy bucket');
                    }
                    bot.log('EVENT', 'Bought bucket');

                    if (bot.findItem('Bronze pickaxe')) {
                        await bot.equipItem('Bronze pickaxe');
                        await bot.waitForTicks(1);
                    }
                }
            },
            {
                name: 'talk-to-gypsy',
                isComplete: () => bot.getQuestProgress(DEMON_SLAYER_VARP) >= STAGE_TALKED_ARIS,
                run: async () => {
                    await walkLumbridgeToVarrock(bot);
                    await bot.walkToWithPathfinding(VARROCK_SQUARE_X, VARROCK_SQUARE_Z);
                    await talkToGypsyStart(bot);

                    const varp = bot.getQuestProgress(DEMON_SLAYER_VARP);
                    if (varp !== STAGE_TALKED_ARIS) {
                        throw new Error(`Expected varp ${STAGE_TALKED_ARIS} after Gypsy, got ${varp}`);
                    }
                    bot.log('EVENT', `Quest started! varp=${varp}`);
                }
            },
            {
                name: 'talk-to-sir-prysin',
                isComplete: () => bot.getQuestProgress(DEMON_SLAYER_VARP) >= STAGE_KEY_HUNT,
                run: async () => {
                    await bot.walkToWithPathfinding(VARROCK_PALACE_ENTRANCE_X, VARROCK_PALACE_ENTRANCE_Z - 2);
                    await bot.openDoor('palacedoor_l');
                    await bot.waitForTicks(1);
                    await bot.walkToWithPathfinding(SIR_PRYSIN_AREA_X, SIR_PRYSIN_AREA_Z);
                    await talkToSirPrysin(bot);

                    const varp = bot.getQuestProgress(DEMON_SLAYER_VARP);
                    if (varp !== STAGE_KEY_HUNT) {
                        throw new Error(`Expected varp ${STAGE_KEY_HUNT} after Sir Prysin, got ${varp}`);
                    }
                    bot.log('EVENT', `Key hunt started! varp=${varp}`);
                }
            },
            {
                name: 'get-rovin-key',
                isComplete: () => bot.countItem('Key') >= 1,
                run: async () => {
                    await getCaptainRovinKey(bot);
                }
            },
            {
                name: 'get-drain-key',
                isComplete: () => bot.countItem('Key') >= 2 && bot.player.z < 6400,
                run: async () => {
                    // The Varrock palace fountain at (3212,3428) is enclosed by
                    // poshwallfencing with no openable gate. Use the Lumbridge
                    // fountain at (3221,3213) instead.
                    await bot.walkToWithPathfinding(LUMBRIDGE_SPAWN_X, LUMBRIDGE_SPAWN_Z);
                    await bot.walkToWithPathfinding(3221, 3213);
                    await bot.useItemOnLoc('Bucket', 'fountain');
                    await bot.waitForTicks(3);

                    if (!bot.findItem('Bucket of water')) {
                        throw new Error('Failed to fill bucket with water at Lumbridge fountain');
                    }
                    bot.log('EVENT', 'Filled bucket with water at Lumbridge fountain');

                    await getDrainKey(bot);
                }
            },
            {
                name: 'get-traiborn-key',
                isComplete: () => bot.countItem('Key') >= 3 || bot.getQuestProgress(DEMON_SLAYER_VARP) >= STAGE_SILVERLIGHT,
                maxRetries: 5,
                run: async () => {
                    if (bot.player.z > 6400) {
                        throw new Error(`Still underground before Traiborn step: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
                    }

                    // If a previous retry left us on level 1 (inside the Wizard Tower),
                    // climb down and exit before trying to walk to Lumbridge.
                    if ((bot.player.level as number) !== 0) {
                        bot.log('STATE', `On level ${bot.player.level}, exiting Wizard Tower first`);
                        await exitWizardTowerFromLevel1(bot);
                    }

                    await bot.walkToWithPathfinding(LUMBRIDGE_SPAWN_X, LUMBRIDGE_SPAWN_Z);
                    await getTraibornKey(bot);
                }
            },
            {
                name: 'get-silverlight',
                isComplete: () => bot.getQuestProgress(DEMON_SLAYER_VARP) >= STAGE_SILVERLIGHT,
                run: async () => {
                    const keyCount = bot.countItem('Key');
                    if (keyCount < 3) {
                        throw new Error(`Only have ${keyCount} keys, need 3`);
                    }

                    await walkLumbridgeToVarrock(bot);
                    await getSilverlight(bot);
                }
            },
            // Cook's Quest is a prerequisite — unlocks the Lumbridge cooking range
            {
                name: 'do-cooks-assistant',
                isComplete: () => bot.getQuestProgress(COOK_QUEST_VARP) >= COOK_QUEST_COMPLETE,
                run: async () => {
                    bot.log('STATE', 'Walking to Lumbridge to complete Cook\'s Assistant');
                    await bot.walkToWithPathfinding(LUMBRIDGE_SPAWN_X, LUMBRIDGE_SPAWN_Z);
                    const cooksStates = buildCooksAssistantStates(bot);
                    await runStateMachine(bot, { root: cooksStates, varpIds: [COOK_QUEST_VARP] });
                }
            },
            {
                name: 'kill-delrith',
                isComplete: () => bot.getQuestProgress(DEMON_SLAYER_VARP) === STAGE_COMPLETE,
                maxRetries: 5,
                stuckThreshold: 40000,
                run: async () => {
                    const totalFood = bot.countItem('Cooked meat') + bot.countItem('Cooked chicken');
                    if (totalFood < 15) {
                        const hp = bot.getHealth();
                        bot.log('STATE', `Preparing for Delrith fight: HP=${hp.current}/${hp.max}, food=${totalFood}`);

                        // If near the chicken pen fence (x~3236), walk east first to escape fence collision
                        if (Math.abs(bot.player.x - CHICKEN_GATE_X) <= 2) {
                            bot.log('STATE', 'Near chicken pen fence, walking east first');
                            await bot.walkTo(CHICKEN_GATE_X + 5, bot.player.z);
                        }

                        // Walk to Lumbridge first (we may be in Varrock after getting Silverlight)
                        await bot.walkToWithPathfinding(LUMBRIDGE_SPAWN_X, LUMBRIDGE_SPAWN_Z);

                        // Train combat on chickens and collect raw chicken for food.
                        // Chickens (3 HP, barely hit) are safe training targets.
                        // Target: Attack >= 10 for accuracy, 20+ raw chicken for cooking.
                        await trainCombatOnChickens(bot, 10, 20);

                        // Cook raw chicken (Cook's Quest unlocked the cooksquestrange)
                        await cookAllRawMeat(bot);

                        const finalFood = bot.countItem('Cooked meat') + bot.countItem('Cooked chicken');
                        const finalHp = bot.getHealth();
                        bot.log('STATE', `Fight prep complete: ${finalFood} food, HP=${finalHp.current}/${finalHp.max}`);

                        if (finalFood < 5) {
                            throw new Error(`Only have ${finalFood} food after farming+cooking. Need at least 5 for the fight.`);
                        }
                    }

                    // Phase 3: Walk to stone circle and fight Delrith
                    await bot.walkToWithPathfinding(STONE_CIRCLE_X, STONE_CIRCLE_Z);
                    await fightDelrith(bot);

                    await bot.waitForTicks(5);
                    bot.dismissModals();

                    const finalVarp = bot.getQuestProgress(DEMON_SLAYER_VARP);
                    if (finalVarp !== STAGE_COMPLETE) {
                        throw new Error(`Quest not complete: varp is ${finalVarp}, expected ${STAGE_COMPLETE}`);
                    }
                    bot.log('SUCCESS', `Demon Slayer quest complete! varp=${finalVarp}`);
                }
            }
        ]
    };
}

export async function demonSlayer(bot: BotAPI): Promise<void> {
    // === Setup: skip tutorial, start in Lumbridge ===
    await skipTutorial(bot);
    await bot.waitForTicks(2);

    bot.log('STATE', `Starting Demon Slayer quest at (${bot.player.x},${bot.player.z},${bot.player.level})`);

    const initialVarp = bot.getQuestProgress(DEMON_SLAYER_VARP);
    if (initialVarp !== STAGE_NOT_STARTED) {
        throw new Error(`Quest varp is ${initialVarp}, expected ${STAGE_NOT_STARTED} (not started)`);
    }

    const root = buildDemonSlayerStates(bot);
    const snapshotDir = path.resolve(import.meta.dir, '..', 'test', 'snapshots');
    await runStateMachine(bot, { root, varpIds: [DEMON_SLAYER_VARP], captureSnapshots: true, snapshotDir });
}

export const metadata: ScriptMeta = {
    name: 'demonslayer',
    type: 'quest',
    varpId: DEMON_SLAYER_VARP,
    varpComplete: STAGE_COMPLETE,
    maxTicks: 80000,
    run: demonSlayer,
    buildStates: buildDemonSlayerStates,
};
