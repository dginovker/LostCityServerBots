import { BotAPI } from '../runtime/api.js';

/**
 * Proven waypoint route from Lumbridge to Varrock.
 * Avoids fences/gates that block the pathfinder.
 */
const VARROCK_ROUTE = [
    { x: 3105, z: 3250 },   // West to Draynor road
    { x: 3082, z: 3336 },   // NW to Barbarian Village area
    { x: 3080, z: 3400 },   // North along west side of Varrock wall
    { x: 3175, z: 3427 },   // East to Varrock west gate area
];

/**
 * Walk from Lumbridge area to Varrock using proven waypoints.
 * Uses walkToWithPathfinding which auto-opens doors along the way.
 */
export async function walkLumbridgeToVarrock(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Walking to Varrock ===');
    for (const wp of VARROCK_ROUTE) {
        await bot.walkToWithPathfinding(wp.x, wp.z);
    }
    bot.log('STATE', `Arrived in Varrock: pos=(${bot.player.x},${bot.player.z})`);
}

// ---- Al Kharid toll gate ----

// The Al Kharid toll gate (border_gate_toll_left/right) is at approximately (3268, 3227-3228).
// Interacting with the gate triggers a border guard NPC dialog:
//   - If Prince Ali Rescue is complete (varp 273 >= 100): free passage
//   - Otherwise: 10gp toll. Dialog option 3 ("Yes, ok.") to pay.
//
// walkToWithPathfinding CANNOT handle this gate because the oploc1 handler triggers
// an NPC dialog rather than simply opening the gate. Scripts that need to cross
// the toll gate must use this helper explicitly.

// Prince Ali Rescue varp (from content/pack/varp.pack: 273=princequest)
const PRINCEQUEST_VARP = 273;
const PRINCE_SAVED_STAGE = 100;

/**
 * Cross the Al Kharid toll gate. Handles both paid (10gp) and free (Prince Ali
 * Rescue complete) passage.
 *
 * @param goingEast true = Lumbridge side -> Al Kharid; false = Al Kharid -> Lumbridge
 */
export async function crossAlKharidTollGate(bot: BotAPI, goingEast: boolean): Promise<void> {
    if (goingEast) {
        // Walk to the west side of the gate
        await bot.walkToWithPathfinding(3267, 3227);
    } else {
        // Walk to the east side of the gate
        await bot.walkToWithPathfinding(3269, 3227);
    }

    bot.log('ACTION', `crossAlKharidTollGate: goingEast=${goingEast} pos=(${bot.player.x},${bot.player.z})`);

    // Find and interact with the toll gate loc
    const gateLoc = bot.findNearbyLoc('border_gate_toll_left', 5) ?? bot.findNearbyLoc('border_gate_toll_right', 5);
    if (!gateLoc) {
        throw new Error(`crossAlKharidTollGate: no toll gate found near (${bot.player.x},${bot.player.z})`);
    }

    await bot.interactLoc(gateLoc, 1); // op1 = Open

    // The gate interaction triggers dialog with a nearby border guard
    await bot.waitForDialog(15);

    // chatplayer "Can I come through this gate?"
    await bot.continueDialog();
    await bot.waitForDialog(10);

    // Check if Prince Ali Rescue is complete (free passage)
    if (bot.getVarp(PRINCEQUEST_VARP) >= PRINCE_SAVED_STAGE) {
        // chatnpc "You may pass for free, you are a friend of Al-Kharid."
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
    await bot.waitForTicks(5);
    bot.dismissModals();

    bot.log('STATE', `crossAlKharidTollGate: after crossing pos=(${bot.player.x},${bot.player.z})`);
}

/**
 * Check if the bot is east of the Al Kharid toll gate (in Al Kharid territory).
 * The toll gate is at x=3268. Anything east (x > 3268) is Al Kharid side.
 */
export function isEastOfTollGate(bot: BotAPI): boolean {
    return bot.player.x > 3268;
}

/**
 * If the bot is east of the Al Kharid toll gate, cross west to Lumbridge side.
 * No-op if already on the Lumbridge side.
 */
export async function ensureWestOfTollGate(bot: BotAPI): Promise<void> {
    if (isEastOfTollGate(bot)) {
        bot.log('STATE', `Bot is east of toll gate at (${bot.player.x},${bot.player.z}), crossing west`);
        await crossAlKharidTollGate(bot, false);
    }
}
