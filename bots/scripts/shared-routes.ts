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
