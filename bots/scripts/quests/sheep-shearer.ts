import LocType from '../../../src/cache/config/LocType.js';
import { BotAPI } from '../../runtime/api.js';
import { skipTutorial } from '../skip-tutorial.js';
import { reachedEntity } from '../../../src/engine/GameMap.js';
import type Npc from '../../../src/engine/entity/Npc.js';
import { type BotState, runStateMachine } from '../../runtime/state-machine.js';
import type { ScriptMeta } from '../../runtime/script-meta.js';

// Varp ID for Sheep Shearer quest progress (from content/pack/varp.pack: 179=sheep)
export const SHEEP_SHEARER_VARP = 179;

// Quest stages (from content/scripts/quests/quest_sheep/configs/quest_sheep.constant
// and content/scripts/general/configs/quest.constant)
const STAGE_NOT_STARTED = 0;
const STAGE_STARTED = 1;
const _STAGE_LAST_WOOL = 20;
const STAGE_COMPLETE = 22;

// NPC type IDs (from content/pack/npc.pack)
const NPC_SHEEPUNSHEERED = 43;

// ---- Key locations ----

// Lumbridge General Store area (Shop keeper is inside)
const GENERAL_STORE_X = 3212;
const GENERAL_STORE_Z = 3247;

// Fred the Farmer — approach from south on the road, then walk north.
// Fred wanders outside his house at roughly (3188-3191, 3268-3278).
const _FRED_APPROACH_X = 3190;
const _FRED_APPROACH_Z = 3260;

// Sheep wander area inside Fred's farm yard (between his house and the pen fence).
// Sheep roam roughly x=3193-3205, z=3271-3276.
// The bot enters through the west gate and positions itself here.
const SHEEP_AREA_X = 3198;
const SHEEP_AREA_Z = 3274;

// Lumbridge Castle stairs (south side, 2x2 loc)
// loc_1738 on level 0: op1=Climb-up
// loc_1739 on level 1: op2=Climb-up, op3=Climb-down
const STAIRS_AREA_X = 3206;
const STAIRS_AREA_Z = 3210;

// Spinning wheel area on level 1 (Lumbridge Castle)
const SPINNING_WHEEL_X = 3209;
const SPINNING_WHEEL_Z = 3213;

/**
 * Navigate to Fred the Farmer's area. The farm is surrounded by fences and brickwalls.
 *
 * Layout (from debug):
 * - Fred's house: brickwalls at x=3188-3192, z=3270-3275
 * - Sheep pen fence (south): z=3277 from x=3193-3205 (no gate)
 * - West gates (double gate): loc_1551@(3188,3279) + loc_1553@(3189,3279)
 * - North gates: loc_1551@(3198,3282) + loc_1553@(3197,3282)
 *
 * The approach is to walk west to the gate area, open the west gate,
 * walk through, and then approach Fred from the north side of his house.
 */
async function walkToFred(bot: BotAPI): Promise<void> {
    // Walk west to the gate area at (3187,3280)
    await bot.walkToWithPathfinding(3187, 3280);

    // Open the west gate (loc_1551 at (3188,3279))
    await bot.openGate(10);
    await bot.waitForTicks(2);

    // Walk through the gate into the pen area
    await bot.walkToWithPathfinding(3190, 3278);

    // Navigate to Fred's house door. The north wall at z=3275 has a door at x=3189.
    await bot.walkToWithPathfinding(3189, 3276);

    // Open the door to Fred's house (debugname is misleading: "inaccastledoubledoorropen" = closed)
    await bot.openDoor('inaccastledoubledoorropen');
    await bot.waitForTicks(2);

    // Walk through into the house
    await bot.walkToWithPathfinding(3189, 3274);
    bot.log('STATE', `Inside Fred's house: pos=(${bot.player.x},${bot.player.z})`);
}

/**
 * Exit the pen/Fred's area through the west gate.
 * The gate was opened when entering (duration 500 ticks, ~5 minutes).
 * If it auto-closed, we re-open it.
 * Can be called from anywhere inside the pen (sheep area or Fred's house).
 */
async function exitFredArea(bot: BotAPI): Promise<void> {
    // If inside Fred's house (z < 3276), walk out through the door first
    if (bot.player.z < 3276) {
        await bot.openDoor('inaccastledoubledoorropen');
        await bot.waitForTicks(1);
        await bot.walkToWithPathfinding(3189, 3276);
    }

    // Walk toward the west gate passage area.
    // The gate at (3188,3279) was opened when we entered and has a 500-tick duration.
    // Try to walk through directly. If blocked, re-open the gate.
    try {
        await bot.walkToWithPathfinding(3187, 3280);
        bot.log('STATE', `Exited Fred's area: pos=(${bot.player.x},${bot.player.z})`);
    } catch {
        // Gate may have auto-closed. Walk to just inside it and re-open.
        bot.log('STATE', 'Gate appears closed, re-opening...');
        await bot.walkToWithPathfinding(3188, 3280);
        // Find the specific closed gate at (3188,3279) area (within 3 tiles)
        const gate = bot.findNearbyLocByDisplayName('Gate', 3);
        if (gate) {
            const locT = LocType.get(gate.type);
            if (locT.op?.[0]?.toLowerCase() === 'open') {
                await bot.interactLoc(gate, 1);
                await bot.waitForTicks(2);
            }
        }
        await bot.walkToWithPathfinding(3187, 3280);
        bot.log('STATE', `Exited Fred's area: pos=(${bot.player.x},${bot.player.z})`);
    }
}

/**
 * Open a double gate (two panels) and walk through to the target tile.
 * Retries up to 3 times if walkTo fails (gate may not have opened properly).
 */
async function openGateAndCross(bot: BotAPI, targetX: number, targetZ: number, label: string): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt++) {
        // Open both gate panels
        await bot.openGate(5);
        await bot.waitForTicks(1);
        await bot.openGate(5);
        await bot.waitForTicks(2);

        try {
            await bot.walkTo(targetX, targetZ);
            return; // Success
        } catch (err) {
            bot.log('STATE', `Gate crossing failed (${label}, attempt ${attempt}/3): ${(err as Error).message}`);
            if (attempt === 3) {
                throw new Error(`Failed to cross gate after 3 attempts (${label}): ${(err as Error).message}`);
            }
            // Wait a moment before retrying — gate may have auto-closed
            await bot.waitForTicks(3);
        }
    }
}

/**
 * Talk to Fred for delivery. Handles Fred being anywhere in his wander area.
 * Fred's house has brickwalls that prevent east-west pathfinding, so the
 * approach depends on where Fred currently is:
 * - If Fred is in the pen (z >= 3276): enter pen via west gate, interact from pen
 * - If Fred is inside house (x >= 3189, z <= 3274): enter pen, open door, interact
 * - If Fred is west of house (x <= 3187): approach from the road south of the house
 * Retries up to 10 times, waiting for Fred to wander to a reachable position.
 */
async function talkToFredForDelivery(bot: BotAPI): Promise<void> {
    // Fred wanders in x=3188-3192, z=3270-3275 when his house door is closed.
    // The door at (3189,3275) is the only entrance. When it opens, Fred can
    // escape into the pen (z >= 3276) and wander west out of reach.
    //
    // Strategy: use walkToFred to enter the house (opens gate, enters pen,
    // opens door, walks inside). Then immediately interact with Fred before
    // he can wander through the now-open door.

    await walkToFred(bot);

    // Fred should be in the east room. Find and interact immediately.
    for (let attempt = 0; attempt < 10; attempt++) {
        const fredRef = bot.findNearbyNpc('Fred the Farmer', 20);
        if (!fredRef) throw new Error('Fred the Farmer not found for delivery');

        bot.log('STATE', `Delivery: Fred at (${fredRef.x},${fredRef.z}), bot at (${bot.player.x},${bot.player.z}) (attempt ${attempt + 1})`);
        await bot.interactNpc(fredRef, 1);
        const dialogOpened = await bot.waitForDialog(30);
        if (dialogOpened) {
            return;
        }

        // Dialog didn't open — Fred may have moved. Wait a tick and retry.
        bot.log('STATE', 'Dialog didn\'t open, retrying...');
        await bot.waitForTicks(3);

        // If Fred wandered to the pen, re-open the door and walk back inside
        if (fredRef.z > 3275 || fredRef.x < 3188) {
            bot.log('STATE', `Fred escaped to pen at (${fredRef.x},${fredRef.z}), re-entering house`);
            await bot.walkToWithPathfinding(3189, 3276);
            await bot.openDoor('inaccastledoubledoorropen');
            await bot.waitForTicks(1);
            await bot.walkToWithPathfinding(3189, 3274);
        }
    }
    throw new Error(`Failed to talk to Fred after 10 attempts. pos=(${bot.player.x},${bot.player.z})`);
}

/**
 * Navigate to the sheep wander area inside Fred's farm yard.
 * Sheep roam in the open area between Fred's house and the pen fence (z=3271-3276).
 * This area is accessible from the east — no fences block east access.
 * We route from the road east of Lumbridge, north to z=3274, then west to x=3198.
 */
async function walkToSheepArea(bot: BotAPI): Promise<void> {
    const px = bot.player.x;
    const pz = bot.player.z;

    // Already in the sheep wander area?
    if (px >= 3193 && px <= 3210 && pz >= 3271 && pz <= 3276) {
        bot.log('STATE', `Already in sheep area: pos=(${px},${pz})`);
        return;
    }

    // If inside Fred's house or his yard west of x=3192, exit through the farm
    if (px >= 3184 && px <= 3192 && pz >= 3268 && pz <= 3282) {
        // Exit Fred's area entirely through the west gate
        await exitFredArea(bot);
        // Fall through to route from outside
    }

    // If in the pen (north of z=3277), exit through the west gate
    if (px >= 3188 && px <= 3205 && pz >= 3277 && pz <= 3282) {
        await exitFredArea(bot);
        // Fall through to route from outside
    }

    // The sheep area is enclosed by fences on all sides:
    // - West: N-S wall at x=3192-3193
    // - South: E-W fence at z=3257
    // - East: N-S wall at x=3212-3213 with a gate at (3213,3261-3262)
    // - North: pen fence at z=3276-3277 with a stile at (3197,3276)
    // Access from outside: open the east gate at (3213,3261-3262) from the road.
    await bot.walkToWithPathfinding(3214, 3262);
    bot.log('STATE', `Near sheep field gate: pos=(${bot.player.x},${bot.player.z})`);

    // Open the east gate and walk through. Retry if walkTo times out (gate may
    // not have opened properly — rare ~5% failure rate without retry).
    await openGateAndCross(bot, 3211, 3262, 'enter sheep field');

    await bot.walkToWithPathfinding(SHEEP_AREA_X, SHEEP_AREA_Z);
    bot.log('STATE', `In sheep area: pos=(${bot.player.x},${bot.player.z})`);
}

// earnCoins is now handled by bot.earnCoinsViaPickpocket()

/**
 * Buy shears from the Lumbridge General Store.
 * Uses Trade (op3) on the Shop keeper to open the shop, then buys.
 */
async function buyShears(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Buying shears from General Store ===');

    // Walk to the General Store
    await bot.walkToWithPathfinding(GENERAL_STORE_X, GENERAL_STORE_Z);
    bot.log('STATE', `At General Store area: pos=(${bot.player.x},${bot.player.z})`);

    // The shop keeper may be inside the building. Open the door if needed.
    await bot.openDoor('poordooropen');

    // Find and Trade with the Shop keeper (op3 = Trade)
    // This directly opens the shop interface via [opnpc3,_shop_keeper]
    const shopkeeper = bot.findNearbyNpc('Shop keeper');
    if (!shopkeeper) {
        throw new Error(`Shop keeper not found near (${bot.player.x},${bot.player.z})`);
    }

    await bot.interactNpc(shopkeeper, 3);
    await bot.waitForTicks(3);

    // The shop should now be open. Buy 1 shears.
    await bot.buyFromShop('Shears', 1);
    await bot.waitForTicks(1);

    // Close the shop interface
    bot.dismissModals();

    // Verify we got shears
    const shears = bot.findItem('Shears');
    if (!shears) {
        throw new Error('Failed to buy shears — not in inventory after purchase');
    }

    bot.log('EVENT', `Purchased shears (id=${shears.id})`);
}

/**
 * Navigate from ground floor to level 1 of Lumbridge Castle and walk near the spinning wheel.
 */
async function goToSpinningWheel(bot: BotAPI): Promise<void> {
    // Navigate through the castle to the stairwell.
    // Castle entrance doors are at x=3217, then interior door at (3215,3211).
    await bot.walkToWithPathfinding(3218, 3218);
    await bot.openDoor('openbankdoor_l');
    await bot.walkToWithPathfinding(3215, 3215);
    await bot.openDoor('poordooropen');
    await bot.walkToWithPathfinding(STAIRS_AREA_X, STAIRS_AREA_Z);

    // Climb the ground floor staircase up to level 1
    await bot.climbStairs('loc_1738', 1);
    await bot.waitForTicks(2);

    if (bot.player.level !== 1) {
        throw new Error(`Failed to climb to level 1: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }

    // Walk to the spinning wheel area on level 1.
    // There may be doors between the stairwell and the spinning wheel room.
    // Open any door in the way, then walk to the spinning wheel.
    await bot.openDoor('poordooropen');
    await bot.waitForTicks(1);
    await bot.walkToWithPathfinding(SPINNING_WHEEL_X, SPINNING_WHEEL_Z);
    bot.log('STATE', `Near spinning wheel: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
}

/**
 * Climb back down from level 1 to ground floor.
 */
async function goDownFromSpinningWheel(bot: BotAPI): Promise<void> {
    // Walk back to the stairwell area on level 1
    await bot.walkToWithPathfinding(3206, 3210);

    // Climb down the staircase from level 1 to ground floor
    await bot.climbStairs('loc_1739', 3); // op3=Climb-down
    await bot.waitForTicks(2);

    if (bot.player.level !== 0) {
        throw new Error(`Failed to climb down to level 0: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }

    bot.log('STATE', `Back on ground floor: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
}

/**
 * Count total number of items with a given name in inventory.
 * Unlike findItem which returns the first matching slot, this sums across all slots.
 * Needed for unstackable items like Wool where each occupies a separate slot.
 */
function countItem(bot: BotAPI, name: string): number {
    const items = bot.getInventory();
    const lowerName = name.toLowerCase();
    let total = 0;
    for (const item of items) {
        if (item.name.toLowerCase() === lowerName) {
            total += item.count;
        }
    }
    return total;
}

/**
 * Find a sheep that is adjacent to the bot AND reachable (no wall between them).
 * Returns the sheep NPC, or null if no reachable adjacent sheep exists.
 */
function findAdjacentReachableSheep(bot: BotAPI): Npc | null {
    const px = bot.player.x;
    const pz = bot.player.z;
    const level = bot.player.level;

    // Search for unsheered sheep within 1 tile (adjacent)
    const candidates = bot.findAllNearbyNpcsByTypeId(NPC_SHEEPUNSHEERED, 1);
    for (const npc of candidates) {
        // Check if the bot can actually reach this sheep (no wall between them)
        if (reachedEntity(level, px, pz, npc.x, npc.z, npc.width, npc.length, bot.player.width)) {
            return npc;
        }
    }
    return null;
}

/**
 * Shear one sheep that is already adjacent and reachable.
 * Returns true if wool was obtained, false if the sheep escaped (25% chance).
 */
async function shearOneSheep(bot: BotAPI, sheep: Npc): Promise<boolean> {
    const dist = Math.max(Math.abs(sheep.x - bot.player.x), Math.abs(sheep.z - bot.player.z));
    bot.log('ACTION', `Shearing sheep at (${sheep.x},${sheep.z}), player at (${bot.player.x},${bot.player.z}), dist=${dist}`);

    const woolCountBefore = countItem(bot, 'Wool');

    // Use shears on the sheep — already adjacent so no long-distance pathing needed
    await bot.useItemOnNpcDirect('Shears', sheep);

    // Wait for the shear script to complete (interaction + p_delay(0) x2)
    await bot.waitForTicks(5);

    // Dismiss any objbox modal
    bot.dismissModals();

    const woolCountAfter = countItem(bot, 'Wool');

    if (woolCountAfter > woolCountBefore) {
        return true; // Got wool
    }
    return false; // Sheep escaped
}

/**
 * Spin one wool into a ball of wool at the spinning wheel.
 */
async function spinOneWool(bot: BotAPI): Promise<void> {
    // Use wool on spinning wheel
    await bot.useItemOnLoc('Wool', 'spinning_wheel');
    await bot.waitForTicks(6); // p_delay(3) in the RS2 script = 3 ticks after, plus approach time

    // Dismiss any objbox modal
    bot.dismissModals();
}

/**
 * Build the Sheep Shearer state machine.
 * States: earn-coins, buy-shears, start-quest, deliver-wool
 */
export function buildSheepShearerStates(bot: BotAPI): BotState {
    return {
        name: 'sheep-shearer',
        isComplete: () => bot.getQuestProgress(SHEEP_SHEARER_VARP) === STAGE_COMPLETE,
        run: async () => { throw new Error('Composite state should not be called directly'); },
        entrySnapshot: {
            position: { x: 3222, z: 3218 },
            varps: { [SHEEP_SHEARER_VARP]: 0 },
            items: ['Bronze pickaxe'],
        },
        children: [
            {
                name: 'earn-coins',
                entrySnapshot: {
                    position: { x: 3222, z: 3218 },
                    varps: { [SHEEP_SHEARER_VARP]: 0 },
                    items: ['Bronze pickaxe'],
                },
                stuckThreshold: 3000,
                isComplete: () => {
                    const coins = bot.findItem('Coins');
                    return coins !== null && coins.count >= 1;
                },
                run: async () => {
                    await bot.earnCoinsViaPickpocket(5);
                }
            },
            {
                name: 'buy-shears',
                entrySnapshot: {
                    position: { x: 3217, z: 3219 },
                    varps: { [SHEEP_SHEARER_VARP]: 0 },
                    items: ['Bronze pickaxe', { name: 'Coins', count: 6 }],
                },
                isComplete: () => bot.findItem('Shears') !== null,
                run: async () => {
                    await buyShears(bot);
                }
            },
            {
                name: 'start-quest',
                entrySnapshot: {
                    position: { x: 3211, z: 3246 },
                    varps: { [SHEEP_SHEARER_VARP]: 0 },
                    items: ['Bronze pickaxe', { name: 'Coins', count: 5 }, 'Shears'],
                },
                isComplete: () => bot.getQuestProgress(SHEEP_SHEARER_VARP) >= STAGE_STARTED,
                run: async () => {
                    await walkToFred(bot);

                    const fred = bot.findNearbyNpc('Fred the Farmer', 20);
                    if (!fred) {
                        throw new Error(`Fred the Farmer not found near (${bot.player.x},${bot.player.z})`);
                    }
                    bot.log('STATE', `Found Fred at (${fred.x},${fred.z}), interacting...`);
                    await bot.interactNpc(fred, 1);
                    const fredDialog = await bot.waitForDialog(30);
                    if (!fredDialog) {
                        throw new Error(`No dialog opened after talking to Fred the Farmer. pos=(${bot.player.x},${bot.player.z}), Fred at (${fred.x},${fred.z})`);
                    }
                    await bot.continueDialog();

                    // Multi3: "I'm looking for a quest." (1)
                    await bot.waitForDialog(10);
                    await bot.selectDialogOption(1);

                    // chatplayer "I'm looking for a quest." -> continue
                    await bot.waitForDialog(10);
                    await bot.continueDialog();

                    // chatnpc "You're after a quest, you say?..." -> continue
                    await bot.waitForDialog(10);
                    await bot.continueDialog();

                    // chatnpc "My sheep are getting mighty woolly..." -> continue
                    await bot.waitForDialog(10);
                    await bot.continueDialog();

                    // chatnpc "Yes, that's it. Bring me 20 balls of wool..." -> continue
                    await bot.waitForDialog(10);
                    await bot.continueDialog();

                    // Multi3: "Yes okay. I can do that." (1)
                    await bot.waitForDialog(10);
                    await bot.selectDialogOption(1);

                    // chatplayer "Yes okay. I can do that." -> continue
                    await bot.waitForDialog(10);
                    await bot.continueDialog();

                    // chatnpc "Ok I'll see you when you have some wool." (varp 0 -> 1)
                    await bot.waitForDialog(10);
                    await bot.continueDialog();

                    await bot.waitForTicks(2);

                    const varpAfterStart = bot.getQuestProgress(SHEEP_SHEARER_VARP);
                    if (varpAfterStart !== STAGE_STARTED) {
                        throw new Error(`Quest varp after starting is ${varpAfterStart}, expected ${STAGE_STARTED}`);
                    }
                    bot.log('EVENT', `Quest started! varp=${varpAfterStart}`);
                }
            },
            {
                name: 'deliver-wool',
                entrySnapshot: {
                    position: { x: 3189, z: 3273 },
                    skills: { COOKING: 4 },
                    varps: { [SHEEP_SHEARER_VARP]: 1 },
                    items: [
                        'Bronze pickaxe',
                        'Bronze pickaxe',
                        { name: 'Coins', count: 8 },
                        'Bronze pickaxe',
                        'Shears',
                    ],
                },
                isComplete: () => bot.getQuestProgress(SHEEP_SHEARER_VARP) === STAGE_COMPLETE,
                maxRetries: 5,
                run: async () => {
                    // Batch loop: shear, spin, deliver. Repeat until 20 balls delivered.
                    let woolDelivered = bot.getQuestProgress(SHEEP_SHEARER_VARP) - STAGE_STARTED;

                    while (woolDelivered < 20) {
                        const batchSize = Math.min(10, 20 - woolDelivered);
                        bot.log('STATE', `--- Batch: need ${batchSize} more balls of wool (${woolDelivered}/20 delivered) ---`);

                        // 4a: Walk to the sheep pen and shear sheep
                        await walkToSheepArea(bot);

                        let woolCollected = 0;
                        let waitTicks = 0;
                        const MAX_WAIT_TICKS = 3000;

                        while (woolCollected < batchSize && waitTicks < MAX_WAIT_TICKS) {
                            await bot.clearPendingState();

                            const sheep = findAdjacentReachableSheep(bot);
                            if (!sheep) {
                                const nearest = bot.findNearbyNpcByTypeId(NPC_SHEEPUNSHEERED, 16);
                                if (nearest) {
                                    const dist = Math.max(Math.abs(nearest.x - bot.player.x), Math.abs(nearest.z - bot.player.z));
                                    if (dist > 1) {
                                        bot.player.queueWaypoint(nearest.x, nearest.z);
                                        await bot.waitForTicks(Math.min(dist, 5));
                                        waitTicks += Math.min(dist, 5);
                                    } else {
                                        await bot.waitForTick();
                                        waitTicks++;
                                    }
                                } else {
                                    await bot.walkToWithPathfinding(SHEEP_AREA_X, SHEEP_AREA_Z);
                                    await bot.waitForTicks(5);
                                    waitTicks += 5;
                                }

                                if (waitTicks % 100 === 0) {
                                    const nearLog = bot.findNearbyNpcByTypeId(NPC_SHEEPUNSHEERED, 16);
                                    bot.log('STATE', `Chasing sheep... tick=${waitTicks} wool=${woolCollected}/${batchSize} pos=(${bot.player.x},${bot.player.z}) nearestSheep=${nearLog ? `(${nearLog.x},${nearLog.z})` : 'none'}`);
                                }

                                if (bot.player.x < 3193 || bot.player.x > 3210 || bot.player.z < 3258 || bot.player.z > 3276) {
                                    bot.log('STATE', `Drifted outside sheep area to (${bot.player.x},${bot.player.z}), returning`);
                                    await bot.walkToWithPathfinding(SHEEP_AREA_X, SHEEP_AREA_Z);
                                }

                                continue;
                            }

                            const success = await shearOneSheep(bot, sheep);
                            if (success) {
                                woolCollected++;
                                bot.log('EVENT', `Wool collected: ${woolCollected}/${batchSize} (waitTicks=${waitTicks})`);
                            } else {
                                bot.log('EVENT', `Sheep escaped or failed (waitTicks=${waitTicks})`);
                                if (bot.player.x < 3193 || bot.player.x > 3205 || bot.player.z < 3271 || bot.player.z > 3276) {
                                    await bot.walkToWithPathfinding(SHEEP_AREA_X, SHEEP_AREA_Z);
                                }
                            }
                            await bot.waitForTicks(1);
                            waitTicks++;
                        }

                        if (woolCollected < batchSize) {
                            throw new Error(`Failed to collect ${batchSize} wool after ${MAX_WAIT_TICKS} ticks (got ${woolCollected})`);
                        }

                        // 4b: Walk to Lumbridge Castle and spin wool
                        bot.log('STATE', `Spinning ${woolCollected} wool...`);

                        await bot.walkToWithPathfinding(3212, 3262);
                        await openGateAndCross(bot, 3214, 3262, 'exit sheep field');

                        await goToSpinningWheel(bot);

                        for (let i = 0; i < woolCollected; i++) {
                            const wool = bot.findItem('Wool');
                            if (!wool) {
                                throw new Error(`Wool disappeared from inventory while spinning (spun ${i}/${woolCollected})`);
                            }

                            if (bot.player.delayed) {
                                await bot.waitForCondition(() => !bot.player.delayed, 20);
                            }

                            await spinOneWool(bot);
                            bot.log('EVENT', `Spun ball of wool: ${i + 1}/${woolCollected}`);
                        }

                        const ballsOfWoolCount = countItem(bot, 'Ball of wool');
                        if (ballsOfWoolCount < woolCollected) {
                            throw new Error(`Expected ${woolCollected} balls of wool, found ${ballsOfWoolCount}`);
                        }

                        // 4c: Go back down and deliver to Fred
                        bot.log('STATE', 'Delivering wool to Fred...');
                        await goDownFromSpinningWheel(bot);

                        await talkToFredForDelivery(bot);
                        await bot.continueDialog();

                        const d2 = await bot.waitForDialog(10);
                        if (!d2) throw new Error('No dialog: expected chatplayer "I have some."');
                        await bot.continueDialog();

                        const d3 = await bot.waitForDialog(10);
                        if (!d3) throw new Error('No dialog: expected chatnpc "Give em here then."');
                        await bot.continueDialog();

                        const woolInInv = countItem(bot, 'Ball of wool');
                        await bot.waitForTicks(woolInInv + 5);

                        for (let dialogIdx = 0; dialogIdx < 5; dialogIdx++) {
                            const hasDialog = await bot.waitForDialog(10);
                            if (!hasDialog) break;
                            await bot.continueDialog();
                        }

                        await bot.waitForTicks(5);
                        bot.dismissModals();

                        const updatedVarp = bot.getQuestProgress(SHEEP_SHEARER_VARP);
                        woolDelivered = updatedVarp - STAGE_STARTED;
                        bot.log('EVENT', `Delivered wool, varp=${updatedVarp}, woolDelivered=${woolDelivered}/20`);
                    }

                    // Verify quest completion
                    await bot.waitForTicks(5);
                    bot.dismissModals();

                    const finalVarp = bot.getQuestProgress(SHEEP_SHEARER_VARP);
                    const craftingSkill = bot.getSkill('Crafting');

                    if (finalVarp !== STAGE_COMPLETE) {
                        throw new Error(`Quest not complete: varp is ${finalVarp}, expected ${STAGE_COMPLETE}`);
                    }
                    if (craftingSkill.exp <= 0) {
                        throw new Error('No crafting XP gained during quest');
                    }

                    bot.log('SUCCESS', `Sheep Shearer quest complete! varp=${finalVarp}, crafting_xp=${craftingSkill.exp}`);
                }
            }
        ]
    };
}

export async function sheepShearer(bot: BotAPI): Promise<void> {
    // === Setup: skip tutorial, start in Lumbridge ===
    await skipTutorial(bot);
    await bot.waitForTicks(2);

    bot.log('STATE', `Starting Sheep Shearer quest at (${bot.player.x},${bot.player.z},${bot.player.level})`);

    const initialVarp = bot.getQuestProgress(SHEEP_SHEARER_VARP);
    if (initialVarp !== STAGE_NOT_STARTED) {
        throw new Error(`Quest varp is ${initialVarp}, expected ${STAGE_NOT_STARTED} (not started)`);
    }

    const root = buildSheepShearerStates(bot);
    await runStateMachine(bot, { root, varpIds: [SHEEP_SHEARER_VARP] });
}

export const metadata: ScriptMeta = {
    name: 'sheepshearer',
    type: 'quest',
    varpId: SHEEP_SHEARER_VARP,
    varpComplete: STAGE_COMPLETE,
    maxTicks: 20000,
    run: sheepShearer,
    buildStates: buildSheepShearerStates,
};
