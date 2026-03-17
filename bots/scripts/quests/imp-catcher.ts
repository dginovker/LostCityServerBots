import path from 'path';
import { BotAPI } from '../../runtime/api.js';
import { skipTutorial } from '../skip-tutorial.js';
import { type BotState, runStateMachine } from '../../runtime/state-machine.js';
import type { ScriptMeta } from '../../runtime/script-meta.js';

// Varp ID for Imp Catcher quest progress (from content/pack/varp.pack: 160=imp)
const IMP_CATCHER_VARP = 160;

// Quest stages (from content/scripts/quests/quest_imp/configs/quest_imp.constant
// and content/scripts/general/configs/quest.constant)
const STAGE_NOT_STARTED = 0;
const STAGE_STARTED = 1;
const STAGE_COMPLETE = 2;

// Bead names (from content/scripts/quests/quest_imp/configs/quest_imp.obj)
const BEAD_NAMES = ['Red bead', 'Yellow bead', 'Black bead', 'White bead'];

// Attack op for imps (op2 = Attack, from content/scripts/_unpack/225/all.npc [imp] op2=Attack)
const ATTACK_OP = 2;

// ---- Key locations ----

// Imp search patrol route — cover a wide area near Lumbridge for reliable pathfinding.
// Imps wander with range 27 from their spawns, so they pass through these areas.
// Extended route covers more ground to find imps faster.
const IMP_PATROL_ROUTE = [
    { x: 3222, z: 3218, name: 'Lumbridge spawn' },
    { x: 3208, z: 3218, name: 'Lumbridge west' },
    { x: 3195, z: 3218, name: 'Road west' },
    { x: 3195, z: 3230, name: 'Road northwest' },
    { x: 3208, z: 3230, name: 'North Lumbridge' },
    { x: 3222, z: 3240, name: 'Northeast Lumbridge' },
    { x: 3235, z: 3225, name: 'East Lumbridge' },
    { x: 3235, z: 3210, name: 'Southeast Lumbridge' },
];

// Wizard Tower entrance (ground level, south of Lumbridge across the bridge)
const WIZARD_TOWER_ENTRANCE_X = 3109;
const WIZARD_TOWER_ENTRANCE_Z = 3167;

// Wizard Tower staircase locations (from content/scripts/ladders+stairs/scripts/stairs.rs2)
// Level 0 stairs: loc_1738 at (3103, 3159) -> climbs up to level 1 landing at (3105, 3160)
// Level 1 stairs: loc_1739 at (3103, 3159) -> op2=Climb-up to level 2 at (3104, 3161),
//                                              op3=Climb-down to level 0 at (3105, 3160)
// Level 2 stairs: loc_1740 at (3104, 3160) -> op1=Climb-down to level 1 at (3105, 3160)

/**
 * Count how many beads we still need to collect.
 * Returns an object with the names of beads still missing.
 */
function getMissingBeads(bot: BotAPI): string[] {
    const missing: string[] = [];
    for (const beadName of BEAD_NAMES) {
        if (!bot.findItem(beadName)) {
            missing.push(beadName);
        }
    }
    return missing;
}

/**
 * Check if we have all 4 beads in inventory.
 */
function hasAllBeads(bot: BotAPI): boolean {
    return getMissingBeads(bot).length === 0;
}

/**
 * Attack an imp and wait for it to die or become inactive.
 * Imps have retreat=4 (flee at 4 HP) and givechase=false, so they run.
 *
 * The bot MUST have running enabled to catch fleeing imps. Imps move 1 tile/tick
 * when fleeing; running lets the bot move 2 tiles/tick to close the gap.
 *
 * The engine's combat auto-loop (p_opnpc(2) at end of player_melee_attack) keeps
 * the player chasing and re-attacking each cycle, so we just wait for the imp to die.
 *
 * Returns the coordinates where the imp died (for loot pickup),
 * or null if the imp escaped/disappeared.
 */
async function attackImpAndWait(bot: BotAPI, imp: import('../../../src/engine/entity/Npc.ts').default): Promise<{ x: number; z: number } | null> {
    const dist = Math.max(Math.abs(imp.x - bot.player.x), Math.abs(imp.z - bot.player.z));
    bot.log('ACTION', `Attacking imp at (${imp.x},${imp.z}), bot at (${bot.player.x},${bot.player.z}), dist=${dist}`);

    // Clear any stale state that would block canAccess() from firing the attack.
    // player.delayed or containsModalInterface() → canAccess() returns false →
    // setInteraction dispatches but tryInteract() never fires the OP trigger.
    await bot.clearPendingState();

    // Enable running to close the gap to the imp quickly. Imps have givechase=false,
    // meaning they reset to wandering after each retaliation and can wander up to
    // 27 tiles from spawn. Running (2 tiles/tick) helps close the gap faster.
    if (!bot.player.run && bot.player.runenergy >= 500) {
        bot.enableRun(true);
    }

    // Initiate attack (op2 = Attack on imps)
    try {
        await bot.interactNpc(imp, ATTACK_OP);
    } catch {
        bot.log('STATE', 'Failed to initiate attack on imp');
        return null;
    }

    // Wait for combat to resolve. The imp has 8 HP.
    // Imps wander randomly (givechase=false) so the distance fluctuates.
    // If the imp gets too far away, give up and find a closer one.
    let lastKnownX = imp.x;
    let lastKnownZ = imp.z;
    let ticksAtDistance = 0; // Count ticks where imp is far away
    let ticksNoHit = 0; // Count ticks where imp stays at full HP despite being close
    let reengageCount = 0;
    const MAX_REENGAGES = 3;
    const COMBAT_TIMEOUT = 200;

    // NpcStat.HITPOINTS = 3 (from const enum NpcStat in NpcStat.ts)
    const HITPOINTS_STAT = 3;
    const startHP = imp.levels[HITPOINTS_STAT] ?? 8;
    let lastSeenHP = startHP;

    for (let tick = 0; tick < COMBAT_TIMEOUT; tick++) {
        await bot.waitForTick();

        // Update last known position while imp is still active
        if (imp.isActive) {
            lastKnownX = imp.x;
            lastKnownZ = imp.z;
        }

        // Imp died — it becomes inactive after death animation
        if (!imp.isActive) {
            bot.log('EVENT', `Imp died at (${lastKnownX},${lastKnownZ}) after ~${tick} ticks`);
            // Wait a couple more ticks for drops to appear
            await bot.waitForTicks(2);
            return { x: lastKnownX, z: lastKnownZ };
        }

        const impHP = imp.levels[HITPOINTS_STAT];
        const curDist = Math.max(Math.abs(imp.x - bot.player.x), Math.abs(imp.z - bot.player.z));

        // Keep running enabled if energy allows and imp is far
        if (!bot.player.run && bot.player.runenergy >= 500 && curDist > 3) {
            bot.enableRun(true);
        }

        // Track whether we're landing hits. If impHP decreased, reset the counter.
        if (impHP < lastSeenHP) {
            ticksNoHit = 0;
            lastSeenHP = impHP;
        } else if (curDist <= 2) {
            // We're close but not dealing damage — combat loop may have broken
            ticksNoHit++;
        }

        // Re-engage if combat is clearly not working: close to imp but no damage dealt
        // for 25+ ticks. The engine's p_opnpc(2) self-loop can break if the bot's
        // interaction was cleared or if canAccess() blocked. Re-engaging restarts it.
        if (ticksNoHit >= 25 && impHP >= startHP && reengageCount < MAX_REENGAGES) {
            reengageCount++;
            ticksNoHit = 0;
            bot.log('STATE', `Re-engaging imp (attempt ${reengageCount}/${MAX_REENGAGES}): impHP=${impHP}/${startHP} dist=${curDist}`);

            // Clear any blocking state before re-engaging
            await bot.clearPendingState();

            try {
                await bot.interactNpc(imp, ATTACK_OP);
            } catch {
                bot.log('STATE', 'Re-engage failed');
                return null;
            }
            continue;
        }

        // If we've exhausted re-engages and still no damage, give up on this imp
        if (ticksNoHit >= 25 && impHP >= startHP && reengageCount >= MAX_REENGAGES) {
            bot.log('STATE', `Giving up — combat not connecting after ${MAX_REENGAGES} re-engages (impHP=${impHP}/${startHP})`);
            return null;
        }

        // Track time spent chasing at distance > 10 (actually far away, not just 5-6)
        if (curDist > 10) {
            ticksAtDistance++;
        } else {
            ticksAtDistance = 0;
        }
        // Give up if we've been very far for 50+ ticks
        if (ticksAtDistance > 50) {
            bot.log('STATE', `Giving up — imp too far for too long (dist=${curDist}, ticksChasing=${ticksAtDistance})`);
            return null;
        }

        // Log combat state every 30 ticks
        if (tick % 30 === 0 && tick > 0) {
            bot.log('STATE', `Combat tick ${tick}: impHP=${impHP}/${startHP} dist=${curDist} run=${bot.player.run} energy=${bot.player.runenergy} noHit=${ticksNoHit}`);
        }
    }

    const finalImpHP = imp.levels[HITPOINTS_STAT];
    bot.log('STATE', `Combat timed out after ${COMBAT_TIMEOUT} ticks, impHP=${finalImpHP}/${startHP}`);
    return null;
}

/**
 * Try to pick up any bead drops at the given location.
 * Also picks up ashes (the default death drop).
 * Returns names of beads successfully picked up.
 */
async function pickUpBeadDrops(bot: BotAPI, _deathX: number, _deathZ: number): Promise<string[]> {
    const pickedUp: string[] = [];

    // Check for each bead type on the ground near the death location
    for (const beadName of BEAD_NAMES) {
        // Only pick up beads we still need
        if (bot.findItem(beadName)) {
            continue;
        }

        const groundItem = bot.findNearbyGroundItem(beadName, 5);
        if (groundItem) {
            bot.log('ACTION', `Found ${beadName} on ground at (${groundItem.x},${groundItem.z})`);
            try {
                await bot.takeGroundItem(beadName, groundItem.x, groundItem.z);
                await bot.waitForTicks(2);

                if (bot.findItem(beadName)) {
                    pickedUp.push(beadName);
                    bot.log('EVENT', `Picked up ${beadName}!`);
                }
            } catch (err) {
                bot.log('STATE', `Failed to pick up ${beadName}: ${(err as Error).message}`);
            }
        }
    }

    return pickedUp;
}

/**
 * Walk to a search area, handling pathfinding failures gracefully.
 * Returns true if we made it close enough, false if pathfinding failed entirely.
 */
async function tryWalkTo(bot: BotAPI, x: number, z: number): Promise<boolean> {
    try {
        await bot.walkToWithPathfinding(x, z);
        return true;
    } catch {
        // Pathfinding failed — we may have gotten close though
        const dist = Math.max(Math.abs(bot.player.x - x), Math.abs(bot.player.z - z));
        bot.log('STATE', `Pathfinding to (${x},${z}) failed, ended at (${bot.player.x},${bot.player.z}), dist=${dist}`);
        return dist <= 5; // Close enough
    }
}

/**
 * Patrol the route looking for imps. Walks to each patrol point
 * and checks for imps nearby. Returns the first imp found, or null.
 */
async function patrolForImps(bot: BotAPI): Promise<import('../../../src/engine/entity/Npc.ts').default | null> {
    for (const point of IMP_PATROL_ROUTE) {
        // Check if there's already an imp nearby before walking (wide search radius)
        const nearbyImp = bot.findNearbyNpc('Imp', 20);
        if (nearbyImp) {
            return nearbyImp;
        }

        await tryWalkTo(bot, point.x, point.z);
        await bot.waitForTicks(3);

        const imp = bot.findNearbyNpc('Imp', 20);
        if (imp) {
            bot.log('EVENT', `Found imp near ${point.name} at (${imp.x},${imp.z})`);
            return imp;
        }
    }
    return null;
}

/**
 * Navigate into the Wizard Tower and up to level 2 (top floor) where Mizgog is.
 *
 * The Wizard Tower layout:
 * - Ground floor: entrance door at (3109, 3166), inner door at (3107, 3162)
 *   Spiral staircase (loc_1738): (3103, 3159) — op1=Climb-up -> level 1 at (3105, 3160)
 * - Level 1: staircase (loc_1739): (3103, 3159) — op2=Climb-up -> level 2 at (3104, 3161)
 * - Level 2: Mizgog is here (top floor).
 */
async function enterWizardTowerTopFloor(bot: BotAPI): Promise<void> {
    // Walk to the tower entrance area
    await bot.walkToWithPathfinding(WIZARD_TOWER_ENTRANCE_X, WIZARD_TOWER_ENTRANCE_Z);
    bot.log('STATE', `At Wizard Tower entrance: pos=(${bot.player.x},${bot.player.z})`);

    // Open the entrance door
    await bot.openDoor('poordooropen');

    // Walk into the outer ring, toward the inner door
    await bot.walkToWithPathfinding(3108, 3163);
    bot.log('STATE', `Inside tower outer ring: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Open the inner diagonal door to access the central room
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

    // Climb up from level 1 to level 2 using loc_1739 (op2=Climb-up)
    // The staircase is at (3103, 3159) on level 1. climbStairs will walk to it.
    await bot.climbStairs('loc_1739', 2);
    await bot.waitForTicks(2);

    if (bot.player.level as number !== 2) {
        throw new Error(`Failed to climb to level 2: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    bot.log('STATE', `On Wizard Tower level 2 (top floor): pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
}

/**
 * Navigate back down from Wizard Tower level 2 to the ground floor and exit.
 */
async function exitWizardTower(bot: BotAPI): Promise<void> {
    // Climb down from level 2 to level 1 using loc_1740 (op1=Climb-down)
    // climbStairs will walk to the loc automatically.
    await bot.climbStairs('loc_1740', 1);
    await bot.waitForTicks(2);

    if (bot.player.level as number !== 1) {
        throw new Error(`Failed to climb down to level 1: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    bot.log('STATE', `On level 1: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Climb down from level 1 to level 0 using loc_1739 (op3=Climb-down)
    await bot.climbStairs('loc_1739', 3);
    await bot.waitForTicks(2);

    if (bot.player.level as number !== 0) {
        throw new Error(`Failed to climb down to level 0: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    bot.log('STATE', `Back on ground floor: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Walk out through the inner and entrance doors
    await bot.walkToWithPathfinding(3108, 3163);
    await bot.openDoor('poordooropen');
    await bot.walkToWithPathfinding(3109, 3167);
    await bot.openDoor('poordooropen');
    await bot.walkToWithPathfinding(3109, 3169);
    bot.log('STATE', `Exited Wizard Tower: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
}

/**
 * Talk to Wizard Mizgog to start the quest.
 *
 * Dialog flow (from content/scripts/areas/area_wizard_tower/scripts/wizard_mizgog.rs2):
 * 1. chatnpc "Hello there."
 * 2. multi2: "Give me a quest!" (1) / "Most of your friends are pretty quiet..." (2)
 * 3. chatplayer "Give me a quest!"
 * 4. chatnpc "Give me a quest what?"
 * 5. multi3: "Give me a quest please." (1) / "Give me a quest or else!" (2) / "Just stop messing..." (3)
 * 6. chatplayer "Give me a quest please."
 * 7. chatnpc "Well seeing as you asked nicely..."
 * 8. chatnpc "The wizard Grayzag next door..." (summon imps)
 * 9. chatnpc "These imps stole all sorts..." (eggs, wool, etc.)
 * 10. chatnpc "But they stole my four magical beads..." (red, yellow, black, white)
 * 11. chatnpc "These imps have now spread out..." (get beads back)
 *     %imp = ^imp_started (varp set here)
 * 12. chatplayer "I'll try."
 */
async function startQuestWithMizgog(bot: BotAPI): Promise<void> {
    const mizgog = bot.findNearbyNpc('Wizard Mizgog', 20);
    if (!mizgog) {
        throw new Error(`Wizard Mizgog not found near (${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    bot.log('STATE', `Found Wizard Mizgog at (${mizgog.x},${mizgog.z})`);

    await bot.interactNpc(mizgog, 1); // op1 = Talk-to
    const dialogOpened = await bot.waitForDialog(30);
    if (!dialogOpened) {
        throw new Error(`No dialog opened when talking to Wizard Mizgog at (${mizgog.x},${mizgog.z})`);
    }

    // 1. chatnpc "Hello there." -> continue
    await bot.continueDialog();

    // 2. multi2: select "Give me a quest!" (option 1)
    await bot.waitForDialog(10);
    await bot.selectDialogOption(1);

    // 3. chatplayer "Give me a quest!" -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 4. chatnpc "Give me a quest what?" -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 5. multi3: select "Give me a quest please." (option 1)
    await bot.waitForDialog(10);
    await bot.selectDialogOption(1);

    // 6. chatplayer "Give me a quest please." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 7. chatnpc "Well seeing as you asked nicely..." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 8. chatnpc "The wizard Grayzag next door..." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 9. chatnpc "These imps stole all sorts..." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 10. chatnpc "But they stole my four magical beads..." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 11. chatnpc "These imps have now spread out..." -> continue
    // varp is set to ^imp_started here
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 12. chatplayer "I'll try." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    await bot.waitForTicks(2);
}

/**
 * Talk to Wizard Mizgog to complete the quest (with all 4 beads).
 *
 * Dialog flow when %imp = ^imp_started and all 4 beads in inventory:
 * 1. chatnpc "So how are you doing finding my beads?"
 * 2. chatplayer "I've got all four beads. It was hard work I can tell you."
 * 3. chatnpc "Give them here and I'll sort out a reward."
 * 4. mesbox "You give four coloured beads to Wizard Mizgog."
 *    (inv_del x4, queue(imp_quest_complete))
 * 5. chatnpc "Here's your reward then, an amulet of accuracy."
 *    mes "The Wizard hands you an amulet."
 */
async function completeQuestWithMizgog(bot: BotAPI): Promise<void> {
    const mizgog = bot.findNearbyNpc('Wizard Mizgog', 20);
    if (!mizgog) {
        throw new Error(`Wizard Mizgog not found near (${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    bot.log('STATE', `Found Wizard Mizgog for completion at (${mizgog.x},${mizgog.z})`);

    await bot.interactNpc(mizgog, 1); // op1 = Talk-to
    const dialogOpened = await bot.waitForDialog(30);
    if (!dialogOpened) {
        throw new Error('No dialog opened when talking to Wizard Mizgog for quest completion');
    }

    // 1. chatnpc "So how are you doing finding my beads?" -> continue
    await bot.continueDialog();

    // 2. chatplayer "I've got all four beads..." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 3. chatnpc "Give them here and I'll sort out a reward." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 4. mesbox "You give four coloured beads to Wizard Mizgog." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // 5. chatnpc "Here's your reward then, an amulet of accuracy." -> continue
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // Wait for queued scripts (imp_quest_complete) to fire
    await bot.waitForTicks(5);
    bot.dismissModals();
}

/**
 * Collect all 4 beads by hunting imps near Lumbridge.
 * Extracted from the main function to be reusable by the state machine.
 */
async function collectBeads(bot: BotAPI): Promise<void> {
    // Equip the bronze pickaxe as a weapon for faster kills
    bot.log('STATE', 'Equipping bronze pickaxe as weapon');
    await bot.equipItem('Bronze pickaxe');
    await bot.waitForTicks(1);

    if (bot.findItem('Bronze pickaxe')) {
        bot.log('STATE', 'Warning: Bronze pickaxe still in inventory after equip attempt');
    } else {
        bot.log('EVENT', 'Bronze pickaxe equipped');
    }

    let impsKilled = 0;
    let combatAttempts = 0;

    while (!hasAllBeads(bot)) {
        const missing = getMissingBeads(bot);
        if (combatAttempts % 5 === 0) {
            bot.log('STATE', `Beads missing: [${missing.join(', ')}], imps killed: ${impsKilled}, attempts: ${combatAttempts}`);
        }

        // Clear any stale interaction state before searching for new imps
        await bot.clearPendingState();

        // Disable running during patrol to conserve energy for combat chasing
        if (bot.player.run) {
            bot.enableRun(false);
        }

        // Only rest if energy is critically low — short rest, don't waste too many ticks
        if (bot.player.runenergy < 1000) {
            const restTicks = Math.min(15, Math.floor((1500 - bot.player.runenergy) / 80));
            if (restTicks > 3) {
                bot.log('STATE', `Resting ${restTicks} ticks to recover run energy (${bot.player.runenergy})`);
                await bot.waitForTicks(restTicks);
            }
        }

        // Search wide for imps — they wander far (range 27)
        let imp = bot.findNearbyNpc('Imp', 20);

        if (!imp) {
            imp = await patrolForImps(bot);

            if (!imp) {
                // No imps found on full patrol — wait a bit and try again
                await bot.waitForTicks(5);
                continue;
            }
        }

        combatAttempts++;
        const deathPos = await attackImpAndWait(bot, imp);

        if (deathPos) {
            impsKilled++;
            bot.dismissModals();

            const beadsPickedUp = await pickUpBeadDrops(bot, deathPos.x, deathPos.z);

            if (beadsPickedUp.length > 0) {
                bot.log('EVENT', `Picked up beads: [${beadsPickedUp.join(', ')}] (total imps killed: ${impsKilled})`);
            }

            if (impsKilled % 10 === 0) {
                const remainingBeads = getMissingBeads(bot);
                bot.log('STATE', `Progress: ${impsKilled} imps killed, missing beads: [${remainingBeads.join(', ')}]`);
            }
        }

        await bot.waitForTicks(2);
    }

    bot.log('EVENT', `All 4 beads collected after ${impsKilled} imp kills (${combatAttempts} combat attempts)!`);
}

/**
 * Build the Imp Catcher state machine.
 * States: start-quest, collect-beads, deliver-to-wizard
 */
export function buildImpCatcherStates(bot: BotAPI): BotState {
    return {
        name: 'imp-catcher',
        isComplete: () => bot.getQuestProgress(IMP_CATCHER_VARP) === STAGE_COMPLETE,
        run: async () => { throw new Error('Composite state should not be called directly'); },
        children: [
            {
                name: 'start-quest',
                isComplete: () => bot.getQuestProgress(IMP_CATCHER_VARP) >= STAGE_STARTED,
                run: async () => {
                    await enterWizardTowerTopFloor(bot);
                    await startQuestWithMizgog(bot);

                    const varpAfterStart = bot.getQuestProgress(IMP_CATCHER_VARP);
                    if (varpAfterStart !== STAGE_STARTED) {
                        throw new Error(`Quest varp after starting is ${varpAfterStart}, expected ${STAGE_STARTED}`);
                    }
                    bot.log('EVENT', `Quest started! varp=${varpAfterStart}`);
                }
            },
            {
                name: 'collect-beads',
                isComplete: () => hasAllBeads(bot),
                stuckThreshold: 5000,
                progressThreshold: 40000,
                run: async () => {
                    await exitWizardTower(bot);
                    await collectBeads(bot);
                }
            },
            {
                name: 'deliver-to-wizard',
                isComplete: () => bot.getQuestProgress(IMP_CATCHER_VARP) === STAGE_COMPLETE,
                run: async () => {
                    // Disable running to conserve energy for the walk
                    if (bot.player.run) {
                        bot.enableRun(false);
                    }

                    // Walk to Lumbridge spawn first for reliable pathfinding
                    bot.log('STATE', `Walking to Lumbridge spawn first from (${bot.player.x},${bot.player.z})`);
                    await bot.walkToWithPathfinding(3222, 3218);

                    await enterWizardTowerTopFloor(bot);
                    await completeQuestWithMizgog(bot);

                    await bot.waitForTicks(5);
                    bot.dismissModals();

                    const finalVarp = bot.getQuestProgress(IMP_CATCHER_VARP);
                    const magicSkill = bot.getSkill('Magic');
                    const hasAmulet = bot.findItem('Amulet of accuracy') !== null;

                    if (finalVarp !== STAGE_COMPLETE) {
                        throw new Error(`Quest not complete: varp is ${finalVarp}, expected ${STAGE_COMPLETE}`);
                    }
                    if (magicSkill.exp <= 0) {
                        throw new Error('No magic XP gained during quest');
                    }
                    if (!hasAmulet) {
                        throw new Error('Amulet of accuracy not received as reward');
                    }

                    bot.log('SUCCESS', `Imp Catcher quest complete! varp=${finalVarp}, magic_xp=${magicSkill.exp}, has_amulet=${hasAmulet}`);
                }
            }
        ]
    };
}

export async function impCatcher(bot: BotAPI): Promise<void> {
    // === Setup: skip tutorial, start in Lumbridge ===
    await skipTutorial(bot);
    await bot.waitForTicks(2);

    bot.log('STATE', `Starting Imp Catcher quest at (${bot.player.x},${bot.player.z},${bot.player.level})`);

    const initialVarp = bot.getQuestProgress(IMP_CATCHER_VARP);
    if (initialVarp !== STAGE_NOT_STARTED) {
        throw new Error(`Quest varp is ${initialVarp}, expected ${STAGE_NOT_STARTED} (not started)`);
    }

    const root = buildImpCatcherStates(bot);
    const snapshotDir = path.resolve(import.meta.dir, '..', 'test', 'snapshots');
    await runStateMachine(bot, { root, varpIds: [IMP_CATCHER_VARP], captureSnapshots: true, snapshotDir });
}

export const metadata: ScriptMeta = {
    name: 'impcatcher',
    type: 'quest',
    varpId: IMP_CATCHER_VARP,
    varpComplete: STAGE_COMPLETE,
    maxTicks: 100000, // Bead drops are RNG-heavy (~1/128 per type per kill)
    run: impCatcher,
    buildStates: buildImpCatcherStates,
};
