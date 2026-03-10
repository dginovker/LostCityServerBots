import InvType from '../../src/cache/config/InvType.ts';
import ObjType from '../../src/cache/config/ObjType.ts';
import { BotAPI } from '../runtime/api.ts';

const TUTORIAL_VARP_ID = 281;
const TUTORIAL_COMPLETE_VALUE = 1000;
const LUMBRIDGE_X = 3222;
const LUMBRIDGE_Z = 3218;
const LUMBRIDGE_LEVEL = 0;

export async function skipTutorial(bot: BotAPI): Promise<void> {
    const player = bot.player;

    // Set tutorial progress to complete
    player.vars[TUTORIAL_VARP_ID] = TUTORIAL_COMPLETE_VALUE;

    // Teleport to Lumbridge
    player.teleport(LUMBRIDGE_X, LUMBRIDGE_Z, LUMBRIDGE_LEVEL);

    // Add bronze pickaxe to inventory
    const bronzePickaxeId = ObjType.getId('bronze_pickaxe');
    if (bronzePickaxeId === -1) {
        throw new Error('Could not find bronze_pickaxe object type');
    }
    player.invAdd(InvType.INV, bronzePickaxeId, 1);

    bot.log('INFO', `Tutorial skipped. Teleported to Lumbridge (${LUMBRIDGE_X},${LUMBRIDGE_Z}). Bronze pickaxe added.`);
}
