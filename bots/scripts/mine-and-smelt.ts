import { BotAPI } from '../runtime/api.ts';
import { skipTutorial } from './skip-tutorial.ts';

// Closest copper/tin rocks to Lumbridge: SE Varrock mine area
// copperrock1 at (3296,3314), (3297,3315), (3301,3318)
// tinrock1 at (3302,3316)
// Teleport to a walkable tile near the rocks (NOT on a rock tile itself,
// since rock tiles block movement in most directions).
const MINE_AREA_X = 3298;
const MINE_AREA_Z = 3315;

// Lumbridge furnace
const FURNACE_AREA_X = 3226;
const FURNACE_AREA_Z = 3255;

export async function mineAndSmelt(bot: BotAPI): Promise<void> {
    // Step 1: Skip tutorial — gives bronze pickaxe and teleports to Lumbridge
    await skipTutorial(bot);
    await bot.waitForTicks(2);

    bot.log('STATE', `Starting mine-and-smelt script at (${bot.player.x},${bot.player.z})`);

    // Step 2: Teleport to near the mine, then walk the last few tiles
    // (The rsmod pathfinder has a ~30-tile search radius, so we teleport
    //  for the bulk of the distance and pathfind for the last stretch.)
    bot.player.teleport(MINE_AREA_X, MINE_AREA_Z, 0);
    await bot.waitForTicks(2);
    bot.log('STATE', `Teleported to mine area (${bot.player.x},${bot.player.z})`);

    // Step 3: Mine copper ore
    const copperRock = bot.findNearbyLoc('copperrock1') ?? bot.findNearbyLoc('copperrock2');
    if (!copperRock) {
        throw new Error(`No copper rock found near (${bot.player.x},${bot.player.z})`);
    }
    bot.log('STATE', `Found copper rock at (${copperRock.x},${copperRock.z})`);

    await bot.interactLoc(copperRock, 1);
    // Wait for copper ore to appear in inventory
    await bot.waitForCondition(() => bot.findItem('Copper ore') !== null, 50);
    // Dismiss any level-up modal
    await bot.waitForTicks(1);
    bot.dismissModals();

    bot.log('EVENT', `Mined copper ore. Mining XP: ${bot.getSkill('Mining').exp}`);

    // Step 4: Mine tin ore
    // Wait for player delay to fully clear
    if (bot.player.delayed) {
        bot.log('STATE', 'Waiting for player delay to clear before mining tin...');
        await bot.waitForCondition(() => !bot.player.delayed, 30);
    }
    // Dismiss any level-up modal from mining copper
    bot.dismissModals();

    const tinRock = bot.findNearbyLoc('tinrock1') ?? bot.findNearbyLoc('tinrock2');
    if (!tinRock) {
        throw new Error(`No tin rock found near (${bot.player.x},${bot.player.z})`);
    }
    bot.log('STATE', `Found tin rock at (${tinRock.x},${tinRock.z}), player at (${bot.player.x},${bot.player.z}), delayed=${bot.player.delayed}`);

    await bot.interactLoc(tinRock, 1);
    // Wait for tin ore to appear in inventory (need approach walk + mining time)
    await bot.waitForCondition(() => bot.findItem('Tin ore') !== null, 60);
    // Dismiss any level-up modal
    await bot.waitForTicks(1);
    bot.dismissModals();

    bot.log('EVENT', `Mined tin ore. Mining XP: ${bot.getSkill('Mining').exp}`);

    // Step 5: Teleport to near the Lumbridge furnace, then walk to it
    if (bot.player.delayed) {
        await bot.waitForCondition(() => !bot.player.delayed, 20);
    }

    bot.player.teleport(FURNACE_AREA_X, FURNACE_AREA_Z, 0);
    await bot.waitForTicks(2);
    bot.log('STATE', `Teleported to furnace area (${bot.player.x},${bot.player.z})`);

    // Step 6: Use copper ore on furnace to smelt bronze bar
    await bot.useItemOnLoc('Copper ore', 'furnace1');
    // Wait for bronze bar to appear in inventory
    await bot.waitForCondition(() => bot.findItem('Bronze bar') !== null, 20);
    // Dismiss any level-up modal
    await bot.waitForTicks(1);
    bot.dismissModals();

    // Step 7: Log success
    const inv = bot.getInventory();
    const miningXp = bot.getSkill('Mining').exp;
    const smithingXp = bot.getSkill('Smithing').exp;
    bot.log('SUCCESS', `Mine-and-smelt complete! Mining XP=${miningXp}, Smithing XP=${smithingXp}, Inventory: ${inv.map(i => i.name).join(', ')}`);
}
