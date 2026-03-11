import LocType from '../../src/cache/config/LocType.js';
import { BotAPI } from '../runtime/api.js';
import { skipTutorial } from './skip-tutorial.js';

// Varp IDs (from content/pack/varp.pack)
const PRINCEQUEST_VARP = 273;
const PRINCE_KEYSTATUS_VARP = 274;

// Quest stages (from content/scripts/quests/quest_prince/configs/quest_prince.constant)
const STAGE_NOT_STARTED = 0;
const STAGE_STARTED = 10;
const STAGE_SPOKEN_OSMAN = 20;
const STAGE_PREP_FINISHED = 30;
const STAGE_GUARD_DRUNK = 40;
const STAGE_TIED_KELI = 50;
const STAGE_SAVED = 100;
const STAGE_COMPLETE = 110;

// Varp values for key status
const KEY_MADE = 1;
const _KEY_CLAIMED = 2;

// Stun/delay varps (same as thieving-men.ts)
const VARP_ACTION_DELAY = 58;
const VARP_STUNNED = 103;

// ---- Key locations ----

// Lumbridge spawn
const LUMBRIDGE_SPAWN_X = 3222;
const LUMBRIDGE_SPAWN_Z = 3218;

// Al-Kharid palace area - OUTSIDE the palace door (Hassan is inside)
// The palace door blocks pathfinding, so walk to just outside first, then open the door.
const AL_KHARID_PALACE_X = 3293;
const AL_KHARID_PALACE_Z = 3167;

// SE Varrock mine area (copper, tin rocks)
const MINE_AREA_X = 3298;
const MINE_AREA_Z = 3315;

// Champion's Guild mine (clay rocks at 3180,3372 / 3183,3377)
// Walk to (3184,3377) which is adjacent to the eastern clay rock
const CLAY_MINE_X = 3184;
const CLAY_MINE_Z = 3377;

// Lumbridge furnace (the furnace loc is at 3226,3255 but approach from south at z=3254)
const FURNACE_AREA_X = 3226;
const FURNACE_AREA_Z = 3254;

// Lumbridge General Store
const GENERAL_STORE_X = 3212;
const GENERAL_STORE_Z = 3247;

// Varrock clothes shop (Thessalia) - east side of Varrock square
const THESSALIA_X = 3206;
const THESSALIA_Z = 3417;

// Blue Moon Inn (Varrock) - south Varrock
// Blue Moon Inn: door at (3229,3396). Approach from west at (3228,3396).
const BLUE_MOON_DOOR_X = 3228;
const BLUE_MOON_DOOR_Z = 3396;
const BLUE_MOON_X = 3226;
const BLUE_MOON_Z = 3399;

// Onion field south of Fred's farm / east of Lumbridge
// Onion locs spawn around (3184-3190, 3259-3263)
// Onion field is enclosed by fencing. Entry is via a gate at (3186,3268)/(3186,3269).
// Approach from the west side to open the gate.
const ONION_GATE_X = 3185;
const ONION_GATE_Z = 3268;

// Sheep shearing area (same as sheep-shearer.ts)
const SHEEP_AREA_X = 3198;
const SHEEP_AREA_Z = 3274;

// Lumbridge Castle stairs
const STAIRS_AREA_X = 3206;
const STAIRS_AREA_Z = 3210;

// Spinning wheel on level 1 (Lumbridge Castle)
const SPINNING_WHEEL_X = 3209;
const SPINNING_WHEEL_Z = 3213;

// Ned in Draynor Village
// Ned is inside his house. Door at (3101,3258) faces east; approach from east side.
const NED_DOOR_X = 3102;
const NED_DOOR_Z = 3258;
const NED_X = 3100;
const NED_Z = 3258;

// Aggie in Draynor Village
// Aggie is inside her house. Door at (3088,3258) faces east; approach from east side.
const AGGIE_DOOR_X = 3089;
const AGGIE_DOOR_Z = 3258;
const AGGIE_X = 3086;
const AGGIE_Z = 3259;

// Port Sarim food store (Wydin)
// Wydin is at (3014,3204). Store is open on the east side (desertdoor at 3017,3206 is open).
// Walk in from the east. No door to open.
const WYDIN_X = 3014;
const WYDIN_Z = 3204;

// Draynor jail area (Lady Keli, Joe, Prince Ali)
// The jail building has a door (poordooropen) at (3128,3246) angle=1.
// Approach from the north side (3128,3247), open door, walk inside.
const JAIL_DOOR_X = 3128;
const JAIL_DOOR_Z = 3247;
const JAIL_X = 3128;
const JAIL_Z = 3244;

// Leela is near the jail, lurking to the north-west
const LEELA_X = 3113;
const LEELA_Z = 3263;

// NPC type IDs
const NPC_SHEEPUNSHEERED = 43;

// ---- Utility functions ----

/**
 * Count total number of items with a given name in inventory (across all slots).
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
 * Pickpocket men in Lumbridge to earn coins.
 */
async function earnCoins(bot: BotAPI, targetGp: number): Promise<void> {
    bot.log('STATE', `=== Earning ${targetGp}gp by pickpocketing men ===`);

    let attempts = 0;
    const MAX_ATTEMPTS = 600;

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
            await bot.waitForTicks(ticksToWait);
        }

        if (bot.player.delayed) {
            await bot.waitForCondition(() => !bot.player.delayed, 20);
        }

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
        await bot.interactNpc(man, 3); // op3 = Pickpocket
        await bot.waitForTicks(5);
        await bot.waitForTicks(1);
        bot.dismissModals();
    }

    const finalCoins = bot.findItem('Coins');
    throw new Error(`Failed to earn ${targetGp}gp after ${MAX_ATTEMPTS} attempts. Current gp: ${finalCoins ? finalCoins.count : 0}`);
}

/**
 * Navigate through the Al-Kharid toll gate.
 * The gate locs (border_gate_toll_left/right) are at approximately (3268, 3227).
 * Interacting with the gate triggers a border guard dialog that asks for 10gp.
 * After the Prince Ali Rescue quest is complete, passage is free.
 *
 * The dialog flow:
 *   chatplayer "Can I come through this gate?"
 *   chatnpc "You must pay a toll of 10 gold coins to pass."
 *   p_choice3: (1) "No thank you..." (2) "Who does my money go to?" (3) "Yes, ok."
 *   -> select 3: "Yes, ok." -> pays 10gp -> gate opens and teleports through
 *
 * After quest completion (varp >= prince_saved):
 *   chatplayer "Can I come through this gate?"
 *   chatnpc "You may pass for free, you are a friend of Al-Kharid."
 *   -> gate opens automatically
 */
async function crossAlKharidGate(bot: BotAPI, goingEast: boolean): Promise<void> {
    if (goingEast) {
        // Walk to the west side of the gate
        await bot.walkToWithPathfinding(3267, 3227);
    } else {
        // Walk to the east side of the gate
        await bot.walkToWithPathfinding(3269, 3227);
    }

    bot.log('ACTION', `crossAlKharidGate: goingEast=${goingEast} pos=(${bot.player.x},${bot.player.z})`);

    // Find and interact with the toll gate loc (border_gate_toll_left or border_gate_toll_right)
    const gateLoc = bot.findNearbyLoc('border_gate_toll_left', 5) ?? bot.findNearbyLoc('border_gate_toll_right', 5);
    if (!gateLoc) {
        throw new Error(`crossAlKharidGate: no toll gate found near (${bot.player.x},${bot.player.z})`);
    }

    await bot.interactLoc(gateLoc, 1); // op1 = Open

    // The gate interaction triggers dialog with a nearby border guard
    await bot.waitForDialog(15);

    // chatplayer "Can I come through this gate?"
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // Check if quest is complete (free passage)
    if (bot.getQuestProgress(PRINCEQUEST_VARP) >= STAGE_SAVED) {
        // chatnpc "You may pass for free..."
        await bot.continueDialog();
    } else {
        // chatnpc "You must pay a toll of 10 gold coins to pass."
        await bot.continueDialog();

        // p_choice3: (1) No (2) Who gets money? (3) Yes, ok.
        await bot.waitForDialog(10);
        await bot.selectDialogOption(3); // "Yes, ok."

        // chatplayer "Yes, ok."
        await bot.waitForDialog(10);
        await bot.continueDialog();
    }

    // The gate script handles opening/teleporting through the gate.
    // Wait for the teleport to complete.
    await bot.waitForTicks(5);
    bot.dismissModals();

    bot.log('STATE', `crossAlKharidGate: after crossing pos=(${bot.player.x},${bot.player.z})`);
}

/**
 * Walk from Lumbridge to Al-Kharid palace.
 * Route: Lumbridge spawn -> north to bridge area -> cross bridge east -> toll gate -> Al-Kharid
 * The River Lum runs N-S between Lumbridge and Al-Kharid. The bridge is around z=3226-3230.
 * Must cross the bridge first, then walk east to the toll gate.
 */
async function walkToAlKharid(bot: BotAPI): Promise<void> {
    bot.log('STATE', 'Walking to Al-Kharid...');

    // Walk east of the river (bridge is crossable at z<=3226)
    // (3253,3226) is reachable from Lumbridge spawn and east of the River Lum
    await bot.walkToWithPathfinding(3253, 3226);

    // Cross the toll gate (pays 10gp if quest not complete)
    await crossAlKharidGate(bot, true);

    // Continue south-east to Al-Kharid palace
    await bot.walkToWithPathfinding(AL_KHARID_PALACE_X, AL_KHARID_PALACE_Z);
    bot.log('STATE', `At Al-Kharid palace: pos=(${bot.player.x},${bot.player.z})`);
}

/**
 * Walk from Al-Kharid back to Lumbridge.
 * Route: Al-Kharid -> toll gate -> bridge -> south to Lumbridge spawn
 */
async function _walkFromAlKharidToLumbridge(bot: BotAPI): Promise<void> {
    bot.log('STATE', 'Walking from Al-Kharid to Lumbridge...');

    // Cross the toll gate going west (free after quest completion)
    await crossAlKharidGate(bot, false);

    // Walk south-west from east of river back to Lumbridge spawn
    // After crossing the gate westward, we're around (3267,3227).
    // Path via (3253,3226) to cross back over the river area.
    await bot.walkToWithPathfinding(3253, 3226);
    await bot.walkToWithPathfinding(LUMBRIDGE_SPAWN_X, LUMBRIDGE_SPAWN_Z);
    bot.log('STATE', `At Lumbridge: pos=(${bot.player.x},${bot.player.z})`);
}

/**
 * Mine a rock by debugname. Waits for the ore to appear in inventory.
 */
async function mineRock(bot: BotAPI, rockDebugname: string, oreName: string): Promise<void> {
    for (let attempt = 1; attempt <= 5; attempt++) {
        if (bot.player.delayed) {
            await bot.waitForCondition(() => !bot.player.delayed, 30);
        }
        bot.dismissModals();

        // Try primary debugname, then fall back to variant (rock1 <-> rock2)
        let rock = bot.findNearbyLoc(rockDebugname, 16);
        if (!rock) {
            const altName = rockDebugname.endsWith('1')
                ? rockDebugname.slice(0, -1) + '2'
                : rockDebugname.endsWith('2') ? rockDebugname.slice(0, -1) + '1' : null;
            if (altName) {
                rock = bot.findNearbyLoc(altName, 16);
            }
        }
        if (!rock) {
            throw new Error(`mineRock: "${rockDebugname}" not found near (${bot.player.x},${bot.player.z})`);
        }
        bot.log('ACTION', `Mining ${rockDebugname} at (${rock.x},${rock.z}) (attempt ${attempt})`);

        await bot.interactLoc(rock, 1);

        try {
            await bot.waitForCondition(() => bot.findItem(oreName) !== null, 60);
            await bot.waitForTicks(1);
            bot.dismissModals();
            bot.log('EVENT', `Mined ${oreName}`);
            return;
        } catch {
            bot.log('STATE', `Mining attempt ${attempt} timed out, retrying...`);
            await bot.waitForTicks(5);
        }
    }
    throw new Error(`mineRock: failed to mine "${oreName}" after 5 attempts`);
}

/**
 * Navigate into Lumbridge Castle and up to spinning wheel on level 1.
 */
async function goToSpinningWheel(bot: BotAPI): Promise<void> {
    await bot.walkToWithPathfinding(3218, 3218);
    await bot.openDoor('openbankdoor_l');
    await bot.walkToWithPathfinding(3215, 3215);
    await bot.openDoor('poordooropen');
    await bot.walkToWithPathfinding(STAIRS_AREA_X, STAIRS_AREA_Z);

    await bot.climbStairs('loc_1738', 1);
    await bot.waitForTicks(2);

    if (bot.player.level !== 1) {
        throw new Error(`Failed to climb to level 1: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }

    await bot.openDoor('poordooropen');
    await bot.waitForTicks(1);
    await bot.walkToWithPathfinding(SPINNING_WHEEL_X, SPINNING_WHEEL_Z);
    bot.log('STATE', `Near spinning wheel: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
}

/**
 * Climb back down from level 1 to ground floor.
 */
async function goDownFromSpinningWheel(bot: BotAPI): Promise<void> {
    await bot.walkToWithPathfinding(3206, 3210);
    await bot.climbStairs('loc_1739', 3); // op3=Climb-down
    await bot.waitForTicks(2);

    if (bot.player.level !== 0) {
        throw new Error(`Failed to climb down to level 0: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    bot.log('STATE', `Back on ground floor: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
}

/**
 * Exit Lumbridge Castle to the outside.
 */
async function exitLumbridgeCastle(bot: BotAPI): Promise<void> {
    await bot.walkToWithPathfinding(3215, 3210);
    await bot.openDoor('poordooropen');
    await bot.walkToWithPathfinding(3215, 3215);
    await bot.walkToWithPathfinding(3217, 3218);
    await bot.openDoor('openbankdoor_l');
    await bot.walkToWithPathfinding(LUMBRIDGE_SPAWN_X, LUMBRIDGE_SPAWN_Z);
}

/**
 * Navigate to Aggie's house: walk to the door, open it, then walk inside.
 */
async function walkToAggie(bot: BotAPI): Promise<void> {
    await bot.walkToWithPathfinding(AGGIE_DOOR_X, AGGIE_DOOR_Z);
    await bot.openDoor('inaccastledoubledoorropen');
    await bot.walkToWithPathfinding(AGGIE_X, AGGIE_Z);
    bot.log('STATE', `At Aggie: pos=(${bot.player.x},${bot.player.z})`);
}

/**
 * Navigate into the Draynor jail building: walk to door, open it, walk inside.
 */
async function walkToJail(bot: BotAPI): Promise<void> {
    await bot.walkToWithPathfinding(JAIL_DOOR_X, JAIL_DOOR_Z);
    await bot.openDoor('poordooropen');
    await bot.walkToWithPathfinding(JAIL_X, JAIL_Z);
    bot.log('STATE', `Inside jail: pos=(${bot.player.x},${bot.player.z})`);
}

/**
 * Walk from Draynor Village area to Varrock (Thessalia's shop area).
 * Route: east toward Lumbridge, cross bridge, north along east side of Varrock, west into city.
 */
async function walkDraynorToVarrock(bot: BotAPI): Promise<void> {
    bot.log('STATE', 'Walking Draynor -> Varrock via Lumbridge bridge...');
    await bot.walkToWithPathfinding(3253, 3226);
    await bot.walkToWithPathfinding(3253, 3340);
    await bot.walkToWithPathfinding(3253, 3420);
    await bot.walkToWithPathfinding(3210, 3420);
}

/**
 * Walk from Varrock area back to Draynor Village area.
 * Reverse route: east to SE opening, south along east side, west across bridge.
 */
async function walkVarrockToDraynor(bot: BotAPI): Promise<void> {
    bot.log('STATE', 'Walking Varrock -> Draynor via Lumbridge bridge...');
    await bot.walkToWithPathfinding(3253, 3420);
    await bot.walkToWithPathfinding(3253, 3340);
    await bot.walkToWithPathfinding(3253, 3226);
    await bot.walkToWithPathfinding(3110, 3260);
}

/**
 * Open a double gate and walk through to the target tile.
 */
async function openGateAndCross(bot: BotAPI, targetX: number, targetZ: number, label: string): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt++) {
        await bot.openGate(5);
        await bot.waitForTicks(1);
        await bot.openGate(5);
        await bot.waitForTicks(2);

        try {
            await bot.walkTo(targetX, targetZ);
            return;
        } catch (err) {
            bot.log('STATE', `Gate crossing failed (${label}, attempt ${attempt}/3): ${(err as Error).message}`);
            if (attempt === 3) {
                throw new Error(`Failed to cross gate after 3 attempts (${label}): ${(err as Error).message}`);
            }
            await bot.waitForTicks(3);
        }
    }
}

/**
 * Navigate to the sheep wander area (same strategy as sheep-shearer.ts).
 */
async function walkToSheepArea(bot: BotAPI): Promise<void> {
    const px = bot.player.x;
    const pz = bot.player.z;

    if (px >= 3193 && px <= 3210 && pz >= 3271 && pz <= 3276) {
        bot.log('STATE', `Already in sheep area: pos=(${px},${pz})`);
        return;
    }

    // Enter from the east gate
    await bot.walkToWithPathfinding(3214, 3262);
    await openGateAndCross(bot, 3211, 3262, 'enter sheep field');
    await bot.walkToWithPathfinding(SHEEP_AREA_X, SHEEP_AREA_Z);
    bot.log('STATE', `In sheep area: pos=(${bot.player.x},${bot.player.z})`);
}

/**
 * Shear sheep and collect wool. Returns when we have the target count.
 */
async function shearSheep(bot: BotAPI, count: number): Promise<void> {
    bot.log('STATE', `=== Shearing ${count} sheep ===`);

    let woolCollected = 0;
    let waitTicks = 0;
    const MAX_WAIT_TICKS = 3000;

    while (woolCollected < count && waitTicks < MAX_WAIT_TICKS) {
        bot.dismissModals();

        if (bot.player.delayed) {
            await bot.waitForCondition(() => !bot.player.delayed, 20);
        }

        // Find a nearby unsheered sheep
        const sheep = bot.findNearbyNpcByTypeId(NPC_SHEEPUNSHEERED, 16);
        if (!sheep) {
            await bot.walkToWithPathfinding(SHEEP_AREA_X, SHEEP_AREA_Z);
            await bot.waitForTicks(5);
            waitTicks += 5;
            continue;
        }

        const dist = Math.max(Math.abs(sheep.x - bot.player.x), Math.abs(sheep.z - bot.player.z));
        if (dist > 1) {
            bot.player.queueWaypoint(sheep.x, sheep.z);
            await bot.waitForTicks(Math.min(dist, 5));
            waitTicks += Math.min(dist, 5);
            continue;
        }

        const woolBefore = countItem(bot, 'Wool');
        await bot.useItemOnNpcDirect('Shears', sheep);
        await bot.waitForTicks(5);
        bot.dismissModals();

        const woolAfter = countItem(bot, 'Wool');
        if (woolAfter > woolBefore) {
            woolCollected++;
            bot.log('EVENT', `Wool collected: ${woolCollected}/${count}`);
        }

        // Keep sheep area bounds
        if (bot.player.x < 3193 || bot.player.x > 3210 || bot.player.z < 3258 || bot.player.z > 3276) {
            await bot.walkToWithPathfinding(SHEEP_AREA_X, SHEEP_AREA_Z);
        }

        await bot.waitForTicks(1);
        waitTicks++;
    }

    if (woolCollected < count) {
        throw new Error(`Failed to shear ${count} sheep after ${MAX_WAIT_TICKS} ticks (got ${woolCollected})`);
    }
}

/**
 * Spin all wool into balls of wool at the spinning wheel.
 */
async function spinAllWool(bot: BotAPI): Promise<void> {
    const woolCount = countItem(bot, 'Wool');
    bot.log('STATE', `Spinning ${woolCount} wool...`);

    for (let i = 0; i < woolCount; i++) {
        const wool = bot.findItem('Wool');
        if (!wool) {
            throw new Error(`Wool disappeared while spinning (spun ${i}/${woolCount})`);
        }

        if (bot.player.delayed) {
            await bot.waitForCondition(() => !bot.player.delayed, 20);
        }

        await bot.useItemOnLoc('Wool', 'spinning_wheel');
        await bot.waitForTicks(6);
        bot.dismissModals();
        bot.log('EVENT', `Spun ball of wool: ${i + 1}/${woolCount}`);
    }
}

// ================================================================
// Main quest function
// ================================================================

export async function princeAliRescue(bot: BotAPI): Promise<void> {
    // === Setup: skip tutorial, start in Lumbridge ===
    await skipTutorial(bot);
    await bot.waitForTicks(2);

    bot.log('STATE', `Starting Prince Ali Rescue quest at (${bot.player.x},${bot.player.z},${bot.player.level})`);

    const initialVarp = bot.getQuestProgress(PRINCEQUEST_VARP);
    if (initialVarp !== STAGE_NOT_STARTED) {
        throw new Error(`Quest varp is ${initialVarp}, expected ${STAGE_NOT_STARTED} (not started)`);
    }

    // ================================================================
    // Step 1: Earn coins by pickpocketing
    // We need roughly: 10gp (toll gate x2) + 2gp (bucket) + 1gp (pot) + 5gp (yellow dye)
    // + 15gp (rope from Ned) + 2gp (pink skirt ~2gp) + ~6gp (3 beers x2gp) + ~10gp (pot_flour)
    // + ~5gp (redberries) + extra buffer = ~80gp
    // Let's aim for 150gp to be safe.
    // ================================================================
    bot.log('STATE', '=== Step 1: Earn coins ===');
    await earnCoins(bot, 150);

    // ================================================================
    // Step 2: Talk to Hassan in Al-Kharid to start the quest
    // ================================================================
    bot.log('STATE', '=== Step 2: Talk to Hassan ===');
    await walkToAlKharid(bot);

    // Open the palace double doors (Large door: loc_1506 at (3292,3167) and loc_1508 at (3293,3167))
    await bot.openDoor('loc_1506');
    await bot.openDoor('loc_1508');
    await bot.waitForTicks(1);

    await bot.talkToNpc('Hassan');
    await bot.waitForDialog(30);
    await bot.continueDialog(); // "Greetings I am Hassan..."

    // Multi3: "Can I help you?" (1), "It's just too hot here..." (2), "Do you mind if I just kill..." (3)
    await bot.waitForDialog(10);
    await bot.selectDialogOption(1); // "Can I help you?"

    await bot.waitForDialog(10);
    await bot.continueDialog(); // chatplayer "Can I help you?..."

    await bot.waitForDialog(10);
    await bot.continueDialog(); // chatnpc "I need the services of someone..."

    await bot.waitForTicks(2);
    const varpAfterHassan = bot.getQuestProgress(PRINCEQUEST_VARP);
    if (varpAfterHassan !== STAGE_STARTED) {
        throw new Error(`Quest varp after Hassan is ${varpAfterHassan}, expected ${STAGE_STARTED}`);
    }
    bot.log('EVENT', `Quest started! varp=${varpAfterHassan}`);

    // ================================================================
    // Step 3: Talk to Osman (Al-Kharid) for instructions
    // ================================================================
    bot.log('STATE', '=== Step 3: Talk to Osman ===');

    // Osman is outside the palace, near the gate
    await bot.walkToWithPathfinding(3286, 3181);
    await bot.talkToNpc('Osman');

    // varp=10 (started) -> goes to @osman_instructions
    // chatplayer "The chancellor trusts me..."
    await bot.waitForDialog(15);
    await bot.continueDialog();

    // chatnpc "Our prince is captive..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // Multi2: "What is the first thing..." (1), "What is the second thing..." (2)
    await bot.waitForDialog(10);
    await bot.selectDialogOption(1); // "What is the first thing..."

    // chatplayer "What is the first thing..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "The prince is guarded..." (first thing explanation)
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "I think you will need to tie her up..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatplayer "How good must the disguise be?"
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Only enough to fool the guards..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Get a blonde wig, too..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "My daughter and top spy, Leela..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "It's near Draynor Village..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // Multi3: "Explain the first thing again." (1), "What is the second thing..." (2), "Okay, I better go..." (3)
    await bot.waitForDialog(10);
    await bot.selectDialogOption(3); // "Okay, I better go find some things."

    // chatplayer "Okay, I had better go..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "May good luck travel with you..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    await bot.waitForTicks(2);
    const varpAfterOsman = bot.getQuestProgress(PRINCEQUEST_VARP);
    if (varpAfterOsman !== STAGE_SPOKEN_OSMAN) {
        throw new Error(`Quest varp after Osman is ${varpAfterOsman}, expected ${STAGE_SPOKEN_OSMAN}`);
    }
    bot.log('EVENT', `Spoken to Osman! varp=${varpAfterOsman}`);

    // ================================================================
    // Step 4: Mine copper+tin at SE Varrock mine, clay near Champion's Guild
    // ================================================================
    bot.log('STATE', '=== Step 4: Mine copper, tin, clay ===');

    // Walk from Al-Kharid to the SE Varrock mine (copper and tin)
    await bot.walkToWithPathfinding(MINE_AREA_X, MINE_AREA_Z);
    bot.log('STATE', `At SE Varrock mine: pos=(${bot.player.x},${bot.player.z})`);

    await mineRock(bot, 'copperrock1', 'Copper ore');
    await mineRock(bot, 'tinrock1', 'Tin ore');

    // Walk west to the Champion's Guild area for clay
    await bot.walkToWithPathfinding(CLAY_MINE_X, CLAY_MINE_Z);
    bot.log('STATE', `At clay mine: pos=(${bot.player.x},${bot.player.z})`);

    // Try clayrock2 first (closer to our approach point), then clayrock1
    const clayRock = bot.findNearbyLoc('clayrock2', 16) ?? bot.findNearbyLoc('clayrock1', 16);
    if (!clayRock) {
        throw new Error(`No clay rock found near (${bot.player.x},${bot.player.z})`);
    }
    const clayLocType = LocType.get(clayRock.type);
    await mineRock(bot, clayLocType.debugname!, 'Clay');

    bot.log('EVENT', `Mining complete. Inventory: ${bot.getInventory().map(i => i.name).join(', ')}`);

    // ================================================================
    // Step 5: Walk to Lumbridge, smelt bronze bar, make soft clay
    // ================================================================
    bot.log('STATE', '=== Step 5: Smelt bronze bar, make soft clay ===');

    // Walk to Lumbridge furnace (from clay mine via Lumbridge area)
    await bot.walkToWithPathfinding(FURNACE_AREA_X, FURNACE_AREA_Z);

    if (bot.player.delayed) {
        await bot.waitForCondition(() => !bot.player.delayed, 20);
    }

    // Smelt bronze bar
    await bot.useItemOnLoc('Copper ore', 'furnace1');
    await bot.waitForCondition(() => bot.findItem('Bronze bar') !== null, 20);
    await bot.waitForTicks(1);
    bot.dismissModals();
    bot.log('EVENT', 'Smelted bronze bar');

    // Buy a bucket from general store to get water
    await bot.walkToWithPathfinding(GENERAL_STORE_X, GENERAL_STORE_Z);
    await bot.openDoor('poordooropen');

    const shopkeeper = bot.findNearbyNpc('Shop keeper');
    if (!shopkeeper) {
        throw new Error(`Shop keeper not found near (${bot.player.x},${bot.player.z})`);
    }
    await bot.interactNpc(shopkeeper, 3); // Trade
    await bot.waitForTicks(3);
    await bot.buyFromShop('Bucket', 1);
    await bot.waitForTicks(1);
    bot.dismissModals();

    const bucket = bot.findItem('Bucket');
    if (!bucket) {
        throw new Error('Failed to buy bucket');
    }
    bot.log('EVENT', 'Bought bucket');

    // Fill bucket with water at a water source (fountain near Lumbridge castle)
    // The Lumbridge fountain is around (3221, 3213)
    await bot.walkToWithPathfinding(3221, 3213);

    // Use bucket on fountain (water source)
    const fountain = bot.findNearbyLoc('fountain');
    if (!fountain) {
        // Try finding any water source
        const well = bot.findNearbyLoc('well', 20);
        if (well) {
            await bot.useItemOnLoc('Bucket', well.type.toString());
        } else {
            throw new Error(`No water source found near (${bot.player.x},${bot.player.z})`);
        }
    } else {
        // Use bucket on fountain
        const locType = LocType.get(fountain.type);
        await bot.useItemOnLoc('Bucket', locType.debugname!);
    }
    await bot.waitForTicks(3);
    bot.dismissModals();

    const bucketWater = bot.findItem('Bucket of water');
    if (!bucketWater) {
        throw new Error('Failed to fill bucket with water');
    }
    bot.log('EVENT', 'Filled bucket with water');

    // Use bucket of water on clay to make soft clay
    await bot.useItemOnItem('Bucket of water', 'Clay');
    await bot.waitForTicks(3);
    bot.dismissModals();

    const softClay = bot.findItem('Soft clay');
    if (!softClay) {
        throw new Error('Failed to make soft clay');
    }
    bot.log('EVENT', 'Made soft clay');

    // ================================================================
    // Step 6: Buy shears if we don't have them, shear sheep, spin wool
    // ================================================================
    bot.log('STATE', '=== Step 6: Shear sheep and spin wool ===');

    // Buy shears from general store if we don't have them
    if (!bot.findItem('Shears')) {
        await bot.walkToWithPathfinding(GENERAL_STORE_X, GENERAL_STORE_Z);
        await bot.openDoor('poordooropen');

        const sk2 = bot.findNearbyNpc('Shop keeper');
        if (!sk2) {
            throw new Error('Shop keeper not found');
        }
        await bot.interactNpc(sk2, 3);
        await bot.waitForTicks(3);
        await bot.buyFromShop('Shears', 1);
        await bot.waitForTicks(1);
        bot.dismissModals();

        if (!bot.findItem('Shears')) {
            throw new Error('Failed to buy shears');
        }
        bot.log('EVENT', 'Bought shears');
    }

    // Walk to sheep area and shear 3 sheep (for Ned's wig)
    await walkToSheepArea(bot);
    await shearSheep(bot, 3);

    // Exit sheep field
    await bot.walkToWithPathfinding(3212, 3262);
    await openGateAndCross(bot, 3214, 3262, 'exit sheep field');

    // Walk to spinning wheel and spin wool
    await goToSpinningWheel(bot);
    await spinAllWool(bot);

    const ballsOfWool = countItem(bot, 'Ball of wool');
    if (ballsOfWool < 3) {
        throw new Error(`Expected 3 balls of wool, found ${ballsOfWool}`);
    }
    bot.log('EVENT', `Spun ${ballsOfWool} balls of wool`);

    // Go back down
    await goDownFromSpinningWheel(bot);
    await exitLumbridgeCastle(bot);

    // ================================================================
    // Step 7: Walk to Draynor, make wig and dye, buy rope
    // ================================================================
    bot.log('STATE', '=== Step 7: Ned (wig + rope), Aggie (yellow dye) ===');

    // Pick 2 onions from the enclosed field. Enter via the gate at (3186,3268).
    await bot.walkToWithPathfinding(ONION_GATE_X, ONION_GATE_Z);
    bot.log('STATE', `At onion gate: pos=(${bot.player.x},${bot.player.z})`);
    await bot.openGate(5);
    await bot.waitForTicks(2);
    // Walk inside the field to be near the onions
    await bot.walkToWithPathfinding(3189, 3267);
    bot.log('STATE', `Inside onion field: pos=(${bot.player.x},${bot.player.z})`);

    for (let i = 0; i < 2; i++) {
        bot.dismissModals();
        if (bot.player.delayed) {
            await bot.waitForCondition(() => !bot.player.delayed, 20);
        }

        const onionsBefore = countItem(bot, 'Onion');
        const onionLoc = bot.findNearbyLoc('onion', 10);
        if (!onionLoc) {
            throw new Error(`No onion loc found near (${bot.player.x},${bot.player.z})`);
        }

        bot.log('ACTION', `Picking onion at (${onionLoc.x},${onionLoc.z}), player at (${bot.player.x},${bot.player.z})`);
        await bot.interactLoc(onionLoc, 2); // op2 = Pick

        // waitForCondition throws on timeout, so if we get past here the onion was picked
        await bot.waitForCondition(() => countItem(bot, 'Onion') > onionsBefore, 20);
        bot.dismissModals();
        bot.log('EVENT', `Picked onion ${i + 1}/2 (now have ${countItem(bot, 'Onion')})`);
    }

    const onionCount = countItem(bot, 'Onion');
    if (onionCount < 2) {
        throw new Error(`Expected 2 onions, found ${onionCount}`);
    }

    // Walk to Ned in Draynor Village - need to open the door to his house
    await bot.walkToWithPathfinding(NED_DOOR_X, NED_DOOR_Z);
    await bot.openDoor('inaccastledoubledoorropen');
    await bot.walkToWithPathfinding(NED_X, NED_Z);
    bot.log('STATE', `At Ned: pos=(${bot.player.x},${bot.player.z})`);

    // Talk to Ned for wig
    await bot.talkToNpc('Ned');
    await bot.waitForDialog(15);
    await bot.continueDialog(); // "Why hello there..."

    // Multi3 (with prince quest active): "Ned, could you make other things from wool?" (1),
    // "Yes, I would like some rope." (2), "No thanks, Ned..." (3)
    await bot.waitForDialog(10);
    await bot.selectDialogOption(1); // "Ned, could you make other things from wool?"

    await bot.waitForDialog(10);
    await bot.continueDialog(); // chatplayer "Ned, could you make other things from wool?"

    await bot.waitForDialog(10);
    await bot.continueDialog(); // chatnpc "I am sure I can..."

    // Multi3: "Could you knit me a sweater?" (1), "How about some sort of wig?" (2), "Could you repair..." (3)
    await bot.waitForDialog(10);
    await bot.selectDialogOption(2); // "How about some sort of wig?"

    await bot.waitForDialog(10);
    await bot.continueDialog(); // chatplayer "How about some sort of wig?"

    await bot.waitForDialog(10);
    await bot.continueDialog(); // chatnpc "Well... That's an interesting thought..."

    // Multi2: "I have that now. Please, make me a wig." (1), "I will come back..." (2)
    await bot.waitForDialog(10);
    await bot.selectDialogOption(1); // "I have that now..."

    await bot.waitForDialog(10);
    await bot.continueDialog(); // chatplayer "I have that now..."

    await bot.waitForDialog(10);
    await bot.continueDialog(); // chatnpc "Okay, I will have a go."

    await bot.waitForDialog(10);
    await bot.continueDialog(); // mesbox "You hand Ned 3 balls of wool..."

    await bot.waitForDialog(10);
    await bot.continueDialog(); // chatnpc "Here you go, how's that..."

    await bot.waitForDialog(10);
    await bot.continueDialog(); // mesbox "Ned gives you a pretty good wig."

    // There may be one more dialog
    const moreDialog = await bot.waitForDialog(5);
    if (moreDialog) {
        await bot.continueDialog(); // chatplayer "Thanks Ned..."
    }
    await bot.waitForTicks(2);

    const plainWig = bot.findItem('Wig');
    if (!plainWig) {
        throw new Error('Failed to get plain wig from Ned');
    }
    bot.log('EVENT', 'Got plain wig from Ned');

    // Now talk to Ned again to buy rope
    await bot.talkToNpc('Ned');
    await bot.waitForDialog(15);
    await bot.continueDialog(); // "Why hello there..."

    // Multi3: "Ned, could you make other things from wool?" (1), "Yes, I would like some rope." (2), "No thanks..." (3)
    await bot.waitForDialog(10);
    await bot.selectDialogOption(2); // "Yes, I would like some rope."

    await bot.waitForDialog(10);
    await bot.continueDialog(); // chatplayer "Yes, I would like some rope."

    await bot.waitForDialog(10);
    await bot.continueDialog(); // chatnpc "Well, I can sell you some rope for 15 coins..."

    // Multi3: "Okay, please sell me some rope." (1), "That's a little more..." (2), "I will go and get some wool." (3)
    // (we don't have 4 balls of wool, so we get 3 options without the "I have wool" option)
    await bot.waitForDialog(10);
    await bot.selectDialogOption(1); // "Okay, please sell me some rope."

    await bot.waitForDialog(10);
    await bot.continueDialog(); // chatplayer "Okay, please sell me some rope."

    await bot.waitForDialog(10);
    await bot.continueDialog(); // chatnpc "There you go, finest rope..."

    await bot.waitForDialog(10);
    await bot.continueDialog(); // mesbox "You hand Ned 15 coins..."

    await bot.waitForTicks(2);
    bot.dismissModals();

    const rope = bot.findItem('Rope');
    if (!rope) {
        throw new Error('Failed to buy rope from Ned');
    }
    bot.log('EVENT', 'Bought rope from Ned');

    // Walk to Aggie for yellow dye (2 onions + 5 coins)
    await walkToAggie(bot);

    await bot.talkToNpc('Aggie');
    await bot.waitForDialog(15);
    await bot.continueDialog(); // "What can I help you with?"

    // Multi5 (with prince quest active):
    // 1: "Could you think of a way to make skin paste?"
    // 2: "What could you make for me?"
    // 3: "Cool, do you turn people into frogs?"
    // 4: "You mad old witch, you can't help me."
    // 5: "Can you make dyes for me please?"
    await bot.waitForDialog(10);
    await bot.selectDialogOption(5); // "Can you make dyes for me please?"

    await bot.waitForDialog(10);
    await bot.continueDialog(); // chatplayer "Can you make dyes for me please?"

    await bot.waitForDialog(10);
    await bot.continueDialog(); // chatnpc "What sort of dye would you like?..."

    // @aggie_dyes -> Multi4: "What do you need to make red dye?" (1), "...yellow dye?" (2), "...blue dye?" (3), "No thanks..." (4)
    await bot.waitForDialog(10);
    await bot.selectDialogOption(2); // "What do you need to make yellow dye?"

    await bot.waitForDialog(10);
    await bot.continueDialog(); // chatplayer "What do you need to make yellow dye?"

    await bot.waitForDialog(10);
    await bot.continueDialog(); // chatnpc "Yellow is a strange colour..."

    // Multi3: "Okay, make me some yellow dye please." (1), "I don't think I have..." (2), "I can do without dye..." (3)
    await bot.waitForDialog(10);
    await bot.selectDialogOption(1); // "Okay, make me some yellow dye please."

    // @aggie_yellow_dye: checks for 2 onions and 5 coins, then makes dye
    await bot.waitForDialog(10);
    await bot.continueDialog(); // chatplayer "Okay, make me some yellow dye please."

    await bot.waitForDialog(10);
    await bot.continueDialog(); // objbox "You hand the onions..."

    await bot.waitForTicks(2);
    bot.dismissModals();

    const yellowDye = bot.findItem('Yellow dye');
    if (!yellowDye) {
        throw new Error('Failed to get yellow dye from Aggie');
    }
    bot.log('EVENT', 'Got yellow dye from Aggie');

    // Use yellow dye on plain wig -> blonde wig
    await bot.useItemOnItem('Yellow dye', 'Wig');
    await bot.waitForTicks(3);
    bot.dismissModals();

    bot.findItem('Wig');
    // The wig display name stays "Wig" but the desc changes; check by looking for yellow dye being consumed
    if (bot.findItem('Yellow dye')) {
        throw new Error('Yellow dye was not consumed - blonde wig creation may have failed');
    }
    bot.log('EVENT', 'Made blonde wig');

    // ================================================================
    // Step 8: Walk to Varrock, buy pink skirt and 3 beers
    // ================================================================
    bot.log('STATE', '=== Step 8: Varrock shopping (pink skirt, beers) ===');

    // Exit Aggie's house and walk Draynor -> Lumbridge -> Varrock
    await bot.openDoor('inaccastledoubledoorropen');
    await walkDraynorToVarrock(bot);
    await bot.walkToWithPathfinding(THESSALIA_X, THESSALIA_Z);
    bot.log('STATE', `At Thessalia: pos=(${bot.player.x},${bot.player.z})`);

    // Buy pink skirt from Thessalia (op3 = Trade)
    const thessalia = bot.findNearbyNpc('Thessalia');
    if (!thessalia) {
        throw new Error(`Thessalia not found near (${bot.player.x},${bot.player.z})`);
    }
    await bot.interactNpc(thessalia, 3);
    await bot.waitForTicks(3);

    // Thessalia might open a dialog first
    if (bot.isDialogOpen()) {
        // She asks about buying or makeover - just continue through
        await bot.continueDialog();
        await bot.waitForDialog(5);
        if (bot.isDialogOpen()) {
            await bot.continueDialog();
        }
        await bot.waitForTicks(2);
    }

    await bot.buyFromShop('Pink skirt', 1);
    await bot.waitForTicks(1);
    bot.dismissModals();

    const pinkSkirt = bot.findItem('Pink skirt');
    if (!pinkSkirt) {
        throw new Error('Failed to buy pink skirt');
    }
    bot.log('EVENT', 'Bought pink skirt');

    // Walk to Blue Moon Inn for beers — enter via door at south side
    await bot.walkToWithPathfinding(BLUE_MOON_DOOR_X, BLUE_MOON_DOOR_Z);
    await bot.openDoor('inaccastledoubledoorropen');
    await bot.walkToWithPathfinding(BLUE_MOON_X, BLUE_MOON_Z);
    bot.log('STATE', `At Blue Moon Inn: pos=(${bot.player.x},${bot.player.z})`);

    // Buy 3 beers by talking to bartender
    for (let i = 0; i < 3; i++) {
        if (bot.player.delayed) {
            await bot.waitForCondition(() => !bot.player.delayed, 20);
        }

        await bot.talkToNpc('Bartender');
        await bot.waitForDialog(15);
        await bot.continueDialog(); // "What can I do yer for?"

        // Multi3 or Multi4: "A glass of your finest ale please." (1), ...
        await bot.waitForDialog(10);
        await bot.selectDialogOption(1); // "A glass of your finest ale please."

        await bot.waitForDialog(10);
        await bot.continueDialog(); // chatplayer "A glass of your finest ale please."

        await bot.waitForDialog(10);
        await bot.continueDialog(); // chatnpc "No problemo. That'll be 2 coins."

        await bot.waitForTicks(3);
        bot.dismissModals();
        bot.log('EVENT', `Bought beer ${i + 1}/3`);
    }

    const beerCount = countItem(bot, 'Beer');
    if (beerCount < 3) {
        throw new Error(`Expected 3 beers, found ${beerCount}`);
    }

    // ================================================================
    // Step 9: Walk to Port Sarim, buy flour and redberries from Wydin
    // ================================================================
    bot.log('STATE', '=== Step 9: Port Sarim shopping (flour, redberries) ===');

    // Walk from Varrock to Port Sarim: exit Varrock SE, south, west to Port Sarim
    await bot.openDoor('inaccastledoubledoorropen'); // exit Blue Moon Inn
    await walkVarrockToDraynor(bot);
    await bot.walkToWithPathfinding(3047, 3237);
    // Intermediate waypoint near Port Sarim store entrance
    await bot.walkToWithPathfinding(3016, 3215);
    await bot.walkToWithPathfinding(WYDIN_X, WYDIN_Z);
    bot.log('STATE', `At Wydin food store: pos=(${bot.player.x},${bot.player.z})`);

    const wydin = bot.findNearbyNpc('Wydin');
    if (!wydin) {
        throw new Error(`Wydin not found near (${bot.player.x},${bot.player.z})`);
    }
    await bot.interactNpc(wydin, 3); // Trade
    await bot.waitForTicks(3);

    await bot.buyFromShop('Pot of flour', 1);
    await bot.waitForTicks(1);
    await bot.buyFromShop('Redberries', 1);
    await bot.waitForTicks(1);
    bot.dismissModals();

    if (!bot.findItem('Pot of flour')) {
        throw new Error('Failed to buy pot of flour');
    }
    if (!bot.findItem('Redberries')) {
        throw new Error('Failed to buy redberries');
    }
    bot.log('EVENT', 'Bought pot of flour and redberries');

    // ================================================================
    // Step 10: Get ashes (pick up from ground or burn logs)
    // Ashes spawn on the ground in various places. Let's look for them
    // near Draynor/Lumbridge. If none found, we can pick them up near
    // any fireplace.
    // ================================================================
    bot.log('STATE', '=== Step 10: Get ashes ===');

    // Exit Wydin's store first (go east to open area, then north)
    await bot.walkToWithPathfinding(3016, 3215);
    // Walk toward Draynor, looking for ashes on the ground
    await bot.walkToWithPathfinding(3093, 3243);

    // Try finding ashes on the ground nearby
    let ashesFound = false;
    for (let searchAttempt = 0; searchAttempt < 5 && !ashesFound; searchAttempt++) {
        const ashesObj = bot.findNearbyGroundItem('Ashes', 20);
        if (ashesObj) {
            await bot.takeGroundItem('Ashes', ashesObj.x, ashesObj.z);
            await bot.waitForTicks(3);
            if (bot.findItem('Ashes')) {
                ashesFound = true;
                bot.log('EVENT', 'Picked up ashes from ground');
            }
        } else {
            // Walk around a bit to find ashes - check Draynor area roads (avoid house interiors)
            const searchPoints = [
                [3080, 3250], [3093, 3243], [3100, 3245],
                [3110, 3250], [3120, 3244]
            ];
            if (searchAttempt < searchPoints.length) {
                const [sx, sz] = searchPoints[searchAttempt]!;
                await bot.walkToWithPathfinding(sx, sz);
                await bot.waitForTicks(3);
            }
        }
    }

    if (!ashesFound) {
        // Ashes might not be on the ground. We can make them by burning logs.
        // Let's try to find a tree, chop it, and burn the logs.
        bot.log('STATE', 'No ashes found on ground, will burn logs...');

        // Check if we have a tinderbox from general store
        if (!bot.findItem('Tinderbox')) {
            // Walk back to Lumbridge general store to buy tinderbox
            await bot.walkToWithPathfinding(GENERAL_STORE_X, GENERAL_STORE_Z);
            await bot.openDoor('poordooropen');

            const sk3 = bot.findNearbyNpc('Shop keeper');
            if (!sk3) {
                throw new Error('Shop keeper not found for tinderbox');
            }
            await bot.interactNpc(sk3, 3);
            await bot.waitForTicks(3);
            await bot.buyFromShop('Tinderbox', 1);
            await bot.waitForTicks(1);
            bot.dismissModals();
        }

        // Chop a tree (we have bronze pickaxe but need bronze axe for trees...)
        // Actually we should buy a bronze axe too. Let's check what we have.
        // Actually, we could just buy from Bob's axes
        // Let's go to Lumbridge and find Bob
        await bot.walkToWithPathfinding(3232, 3205); // Bob's axes area
        const bob = bot.findNearbyNpc('Bob');
        if (bob) {
            await bot.interactNpc(bob, 3); // Trade
            await bot.waitForTicks(3);
            await bot.buyFromShop('Bronze axe', 1);
            await bot.waitForTicks(1);
            bot.dismissModals();
        }

        // Walk to an open area with trees near Bob's axes
        await bot.walkToWithPathfinding(3233, 3213);

        // Now chop a tree (find normal tree)
        const tree = bot.findNearbyLoc('tree', 20) ?? bot.findNearbyLoc('tree2', 20) ?? bot.findNearbyLoc('tree3', 20);
        if (!tree) {
            throw new Error(`No tree found near (${bot.player.x},${bot.player.z})`);
        }
        await bot.interactLoc(tree, 1);
        await bot.waitForCondition(() => bot.findItem('Logs') !== null, 60);
        await bot.waitForTicks(1);
        bot.dismissModals();
        bot.log('EVENT', 'Chopped logs');

        // Burn the logs (use tinderbox on logs)
        await bot.useItemOnItem('Tinderbox', 'Logs');
        await bot.waitForTicks(8);
        bot.dismissModals();
        bot.log('EVENT', 'Lit fire, waiting for it to burn out and drop ashes...');

        // Wait for the fire to burn out and drop ashes (fires last 100-200 ticks)
        await bot.waitForCondition(() => bot.findNearbyGroundItem('Ashes', 10) !== null, 250);

        const ashesOnGround = bot.findNearbyGroundItem('Ashes', 10);
        if (!ashesOnGround) {
            throw new Error('Ashes appeared but then disappeared');
        }
        await bot.takeGroundItem('Ashes', ashesOnGround.x, ashesOnGround.z);
        await bot.waitForTicks(3);
        if (!bot.findItem('Ashes')) {
            throw new Error('Failed to pick up ashes from fire');
        }
        ashesFound = true;
        bot.log('EVENT', 'Picked up ashes from fire');
    }

    // ================================================================
    // Step 11: Get skin paste from Aggie
    // Need: ashes + redberries + pot of flour + bucket of water (or jug of water)
    // The bucket of water was consumed making soft clay in step 5, so refill it.
    // ================================================================
    bot.log('STATE', '=== Step 11: Get skin paste from Aggie ===');

    // Refill bucket with water if needed (consumed when making soft clay in step 5)
    if (!bot.findItem('Bucket of water') && !bot.findItem('Jug of water')) {
        // We should still have the empty bucket from step 5
        if (!bot.findItem('Bucket')) {
            throw new Error('No bucket found for water — needed for skin paste');
        }
        // Walk to Lumbridge fountain to fill bucket
        await bot.walkToWithPathfinding(3221, 3213);
        const fountain = bot.findNearbyLoc('fountain');
        if (!fountain) {
            throw new Error(`No fountain found near (${bot.player.x},${bot.player.z})`);
        }
        const locType = LocType.get(fountain.type);
        await bot.useItemOnLoc('Bucket', locType.debugname!);
        await bot.waitForTicks(3);
        bot.dismissModals();
        if (!bot.findItem('Bucket of water')) {
            throw new Error('Failed to fill bucket with water at fountain');
        }
        bot.log('EVENT', 'Refilled bucket with water for skin paste');
    }

    await walkToAggie(bot);

    await bot.talkToNpc('Aggie');
    await bot.waitForDialog(15);
    await bot.continueDialog(); // "What can I help you with?"

    // Multi5: skin paste option is 1 (with prince quest active + ingredients)
    await bot.waitForDialog(10);
    await bot.selectDialogOption(1); // "Could you think of a way to make skin paste?"

    await bot.waitForDialog(10);
    await bot.continueDialog(); // chatplayer "Could you think of a way to make skin paste?"

    // chatnpc "Yes I can, I see you already have the ingredients..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // Multi2: "Yes please. Mix me some skin paste." (1), "No thank you..." (2)
    await bot.waitForDialog(10);
    await bot.selectDialogOption(1); // "Yes please..."

    await bot.waitForDialog(10);
    await bot.continueDialog(); // chatplayer "Yes please..."

    await bot.waitForDialog(10);
    await bot.continueDialog(); // chatnpc "That should be simple..."

    // mesbox "You hand the ash, flour, water and redberries to Aggie..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Tourniquet, Fenderbaum..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // mesbox "Aggie hands you the skin paste."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "There you go dearie..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    await bot.waitForTicks(2);
    bot.dismissModals();

    const skinPaste = bot.findItem('Paste');
    if (!skinPaste) {
        throw new Error('Failed to get skin paste from Aggie');
    }
    bot.log('EVENT', 'Got skin paste');

    // ================================================================
    // Step 12: Talk to Lady Keli to get key imprint
    // ================================================================
    bot.log('STATE', '=== Step 12: Get key imprint from Lady Keli ===');

    // Exit Aggie's house, then walk to jail
    await bot.openDoor('inaccastledoubledoorropen');
    await walkToJail(bot);

    await bot.talkToNpc('Lady Keli');
    await bot.waitForDialog(15);

    // chatplayer "Are you the famous Lady Keli?..."
    await bot.continueDialog();

    // chatnpc "I am Keli, you have heard of me then?"
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // Multi4: "Heard of you? You are famous..." (1), "I have heard a little..." (2), "I have heard rumours..." (3), "No I have never..." (4)
    await bot.waitForDialog(10);
    await bot.selectDialogOption(1); // "Heard of you? You are famous..."

    // chatplayer "The great Lady Keli..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "That's very kind..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // Multi4: "I think Katrine..." (1), "What is your latest plan?" (2), "You must have trained..." (3), "I should not disturb..." (4)
    await bot.waitForDialog(10);
    await bot.selectDialogOption(2); // "What is your latest plan then?"

    // chatplayer "What is your latest plan then?..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Well, I can tell you I have a valuable prisoner..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "I can expect a high reward..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // Multi4: "Ah I see. You must have been very skillful." (1), "That's great..." (2), "Can you be sure they will not try to get him out?" (3), "I should not disturb..." (4)
    await bot.waitForDialog(10);
    await bot.selectDialogOption(3); // "Can you be sure they will not try to get him out?"

    // chatplayer "Can you be sure..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "There is no way to release him..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "There is not another key like this..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // Multi3: "Could I see the key please?" (1), "That is a good way..." (2), "I should not disturb..." (3)
    await bot.waitForDialog(10);
    await bot.selectDialogOption(1); // "Could I see the key please?"

    // chatplayer "Could I see the key please?..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "As you put it that way..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // mesbox "Keli shows you a small key..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // Since we have soft clay and varp=20 (spoken_osman):
    // Multi2: "Could I touch the key for a moment?" (1), "I should not disturb..." (2)
    await bot.waitForDialog(10);
    await bot.selectDialogOption(1); // "Could I touch the key..."

    // chatplayer "Could I touch the key a moment please?"
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Only for a moment then."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // mesbox "You put a piece of your soft clay..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatplayer "Thank you so much..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "You are welcome, run along now..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    await bot.waitForTicks(2);
    bot.dismissModals();

    const keyPrint = bot.findItem('Key print');
    if (!keyPrint) {
        throw new Error('Failed to get key imprint from Lady Keli');
    }
    bot.log('EVENT', 'Got key imprint');

    // ================================================================
    // Step 13: Give Osman the key imprint + bronze bar
    // ================================================================
    bot.log('STATE', '=== Step 13: Give Osman key imprint + bronze bar ===');

    // Walk to Al-Kharid (Osman) - east of river then through toll gate
    await bot.walkToWithPathfinding(3253, 3226);
    await crossAlKharidGate(bot, true);
    await bot.walkToWithPathfinding(3286, 3181);

    await bot.talkToNpc('Osman');
    await bot.waitForDialog(15);

    // varp=20 (spoken_osman) + has key imprint + bronze bar -> @osman_items
    // chatnpc "Well done; we can make the key now."
    await bot.continueDialog();

    // mesbox "Osman takes the key imprint and the bronze bar."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Pick the key up from Leela."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // Multi2: "Thank you..." (1), "Can you tell me what I still need to get?" (2)
    await bot.waitForDialog(10);
    await bot.selectDialogOption(1); // "Thank you..."

    // chatplayer "Thank you..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    await bot.waitForTicks(2);
    bot.dismissModals();

    const keystatus = bot.getVarp(PRINCE_KEYSTATUS_VARP);
    if (keystatus !== KEY_MADE) {
        throw new Error(`Key status after Osman is ${keystatus}, expected ${KEY_MADE}`);
    }
    bot.log('EVENT', `Key made! keystatus=${keystatus}`);

    // ================================================================
    // Step 14: Talk to Leela to get key + advance quest
    // ================================================================
    bot.log('STATE', '=== Step 14: Talk to Leela ===');

    // Walk back to Draynor area (Leela is near the jail) - via toll gate
    await crossAlKharidGate(bot, false);
    await bot.walkToWithPathfinding(3253, 3226);
    await bot.walkToWithPathfinding(LEELA_X, LEELA_Z);
    bot.log('STATE', `Near Leela: pos=(${bot.player.x},${bot.player.z})`);

    await bot.talkToNpc('Leela');
    await bot.waitForDialog(15);

    // @leela_help: key_made -> gives key
    // chatnpc "My father sent this key for you..."
    await bot.continueDialog();

    // mesbox "Leela gives you a copy of the key..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // Since we have all items (key, wig, pink skirt, skin paste):
    // varp -> prince_prep_finished (30)
    // chatnpc "Good, you have all the basic equipment..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    await bot.waitForTicks(2);
    bot.dismissModals();

    const bronzeKey = bot.findItem('Bronze key');
    if (!bronzeKey) {
        throw new Error('Failed to get bronze key from Leela');
    }

    const varpAfterLeela = bot.getQuestProgress(PRINCEQUEST_VARP);
    if (varpAfterLeela !== STAGE_PREP_FINISHED) {
        throw new Error(`Quest varp after Leela is ${varpAfterLeela}, expected ${STAGE_PREP_FINISHED}`);
    }
    bot.log('EVENT', `Prep finished! varp=${varpAfterLeela}`);

    // ================================================================
    // Step 15: Talk to Joe, give 3 beers -> varp 40
    // ================================================================
    bot.log('STATE', '=== Step 15: Get Joe drunk ===');

    await walkToJail(bot);

    await bot.talkToNpc('Joe');
    await bot.waitForDialog(15);

    // varp=30 (prep_finished) -> @joe_distract -> @multi4 immediately
    // Multi4: "I have some beer here, fancy one?" (1), "Tell me about..." (2), "What did you want to be..." (3), "I had better leave..." (4)
    await bot.selectDialogOption(1); // "I have some beer here, fancy one?"

    // chatplayer "I have some beer here, fancy one?"
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Ah, that would be lovely..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatplayer "Of course, it must be tough..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // mesbox "You hand a beer to the guard..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "That was perfect..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatplayer "How are you? Still ok?..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // Since we have >= 2 more beers:
    // chatplayer "Would you care for another, my friend?"
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "I better not..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatplayer "Here, just keep these for later..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // mesbox "You hand two more beers to the guard..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc "Franksh, that wash just what I need..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // mesbox "The guard is drunk..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    await bot.waitForTicks(2);
    bot.dismissModals();

    const varpAfterJoe = bot.getQuestProgress(PRINCEQUEST_VARP);
    if (varpAfterJoe !== STAGE_GUARD_DRUNK) {
        throw new Error(`Quest varp after Joe is ${varpAfterJoe}, expected ${STAGE_GUARD_DRUNK}`);
    }
    bot.log('EVENT', `Guard is drunk! varp=${varpAfterJoe}`);

    // ================================================================
    // Step 16: Use rope on Lady Keli -> varp 50
    // ================================================================
    bot.log('STATE', '=== Step 16: Tie up Lady Keli ===');

    // Lady Keli wanders near the jail
    await bot.useItemOnNpc('Rope', 'Lady Keli');
    await bot.waitForTicks(3);

    // mesbox "You overpower Keli, tie her up..."
    if (bot.isDialogOpen()) {
        await bot.continueDialog();
    }
    await bot.waitForTicks(2);
    bot.dismissModals();

    const varpAfterKeli = bot.getQuestProgress(PRINCEQUEST_VARP);
    if (varpAfterKeli !== STAGE_TIED_KELI) {
        throw new Error(`Quest varp after tying Keli is ${varpAfterKeli}, expected ${STAGE_TIED_KELI}`);
    }
    bot.log('EVENT', `Keli is tied up! varp=${varpAfterKeli}`);

    // ================================================================
    // Step 17: Use key on Ali's door, rescue prince -> varp 100
    // ================================================================
    bot.log('STATE', '=== Step 17: Rescue Prince Ali ===');

    // The jail door (alidoor) is at the jail. We need to use the key on it.
    // We need to be on the south side (outside) of the door.
    // The alidoor is a locked door that requires princeskey to open.
    await bot.useItemOnLoc('Bronze key', 'alidoor');
    await bot.waitForTicks(5);
    bot.dismissModals();

    // Walk through the door to Prince Ali
    // The prince is inside the jail cell
    await bot.waitForTicks(2);

    // Talk to Prince Ali
    await bot.talkToNpc('Prince Ali');
    await bot.waitForDialog(15);

    // @prince_rescue (varp=50, tied_keli)
    // chatplayer "Prince, I come to rescue you."
    await bot.continueDialog();

    // chatnpc "That is very very kind of you..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatplayer "With a disguise. I have removed the Lady Keli..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // Since we have all items (key, wig, pink_skirt, skinpaste):
    // chatplayer "Take this disguise, and this key."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // mesbox "You hand over the disguise and key..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatnpc_specific "Thank you my friend..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // chatplayer "Go to Leela, she is close to here."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    // mesbox "The prince has escaped, well done!..."
    await bot.waitForDialog(10);
    await bot.continueDialog();

    await bot.waitForTicks(3);
    bot.dismissModals();

    const varpAfterRescue = bot.getQuestProgress(PRINCEQUEST_VARP);
    if (varpAfterRescue !== STAGE_SAVED) {
        throw new Error(`Quest varp after rescue is ${varpAfterRescue}, expected ${STAGE_SAVED}`);
    }
    bot.log('EVENT', `Prince saved! varp=${varpAfterRescue}`);

    // ================================================================
    // Step 18: Talk to Hassan for quest completion -> varp 110
    // ================================================================
    bot.log('STATE', '=== Step 18: Return to Hassan for reward ===');

    // Exit the jail: walk north through alidoor, then through jail door, then outside
    await bot.openDoor('alidoor');
    await bot.walkToWithPathfinding(JAIL_DOOR_X, JAIL_DOOR_Z);
    await bot.openDoor('poordooropen');
    await bot.waitForTicks(1);

    await walkToAlKharid(bot);

    // Open the palace double doors
    await bot.openDoor('loc_1506');
    await bot.openDoor('loc_1508');
    await bot.waitForTicks(1);

    await bot.talkToNpc('Hassan');
    await bot.waitForDialog(30);

    // varp=100 (saved) -> "You have the eternal gratitude..."
    // chatnpc "You have the eternal gratitude..."
    await bot.continueDialog();

    // queue(prince_complete) fires
    await bot.waitForTicks(5);
    bot.dismissModals();

    // ================================================================
    // Verify quest completion
    // ================================================================
    const finalVarp = bot.getQuestProgress(PRINCEQUEST_VARP);
    if (finalVarp !== STAGE_COMPLETE) {
        throw new Error(`Quest not complete: varp is ${finalVarp}, expected ${STAGE_COMPLETE}`);
    }

    const finalCoins = bot.findItem('Coins');
    bot.log('SUCCESS', `Prince Ali Rescue quest complete! varp=${finalVarp}, coins=${finalCoins ? finalCoins.count : 0}`);
}
