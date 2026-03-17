import type { BotAPI } from '../runtime/api.js';
import type Player from '../../src/engine/entity/Player.js';
import type { StateSnapshot } from '../runtime/state-machine.js';
import InvType from '../../src/cache/config/InvType.js';

// ---- Item IDs (from content/pack/obj.pack) ----

export const RUNE_FULL_HELM_ID     = 1163;
export const RUNE_PLATELEGS_ID     = 1079;
export const RUNE_SCIMITAR_ID      = 1333;
export const BLACK_DHIDE_BODY_ID   = 2503; // black_dragonhide_body
export const CLIMBING_BOOTS_ID     = 3105; // death_climbingboots
export const CAPE_OF_LEGENDS_ID    = 1052;
export const RING_OF_RECOIL_ID     = 2550;
export const MAGIC_SHORTBOW_ID     = 861;
export const RUNE_ARROW_ID         = 892;
export const AMULET_OF_GLORY4_ID   = 1712; // amulet_of_glory_4
export const DRAGON_DAGGER_ID      = 1231; // dragon_dagger_p (poisoned)
export const DRAGON_BATTLEAXE_ID   = 1377;
export const DRAGON_MACE_ID        = 1434;
export const PRAYER_RESTORE4_ID    = 2434; // 4doseprayerrestore
export const SUPER_DEFENCE4_ID     = 2442; // 4dose2defense
export const SUPER_ATTACK4_ID      = 2436; // 4dose2attack
export const SUPER_STRENGTH4_ID    = 2440; // 4dose2strength
export const CHOCOLATE_BOMB_ID     = 2185;
export const RANGING_POTION4_ID     = 2444;
export const BLACK_DHIDE_VAMBS_ID  = 2491; // black_dragon_vambraces
export const SHARK_ID              = 385;

// ---- Display names (used by equipItem / findItem / useItemOp1) ----
// These are the ObjType.name values at runtime.
// If any don't match, the snapshot's id field ensures correct inventory placement.

export const RUNE_FULL_HELM     = 'Rune full helm';
export const RUNE_PLATELEGS     = 'Rune platelegs';
export const RUNE_SCIMITAR      = 'Rune scimitar';
export const BLACK_DHIDE_BODY   = 'Dragonhide body';
export const CLIMBING_BOOTS     = 'Climbing boots';
export const CAPE_OF_LEGENDS    = 'Cape of legends';
export const RING_OF_RECOIL     = 'Ring of recoil';
export const MAGIC_SHORTBOW     = 'Magic shortbow';
export const RUNE_ARROW         = 'Rune arrow';
export const AMULET_OF_GLORY4   = 'Amulet of glory(4)';
export const DRAGON_DAGGER      = 'Dragon dagger(p)';
export const DRAGON_BATTLEAXE   = 'Dragon battleaxe';
export const PRAYER_RESTORE4    = 'Prayer potion(4)';
export const SUPER_DEFENCE4     = 'Super defence(4)';
export const SUPER_ATTACK4      = 'Super attack(4)';
export const SUPER_STRENGTH4    = 'Super strength(4)';
export const CHOCOLATE_BOMB     = 'Chocolate bomb';
export const RANGING_POTION4    = 'Ranging potion(4)';
export const BLACK_DHIDE_VAMBS  = 'Dragon vambraces';
export const SHARK              = 'Shark';

// ---- Potion base names (for any-dose searching) ----

export const PRAYER_POTION_BASE  = 'Prayer potion';
export const RANGING_POTION_BASE = 'Ranging potion';
export const SUPER_DEFENCE_BASE  = 'Super defence';
export const SUPER_ATTACK_BASE   = 'Super attack';
export const SUPER_STRENGTH_BASE = 'Super strength';

// ---- Fight location ----
// Wilderness level 1, just north of Edgeville
export const FIGHT_X = 3108;
export const FIGHT_Z = 3525;

// ---- Coordination ----

export interface FightCoord {
    botAReady: boolean;
    botBReady: boolean;
    botADead: boolean;
    botBDead: boolean;
    botAEscaped: boolean;
    botBEscaped: boolean;
    botAError: string | null;
    botBError: string | null;
    fightStarted: boolean;
}

export function makeFightCoord(): FightCoord {
    return {
        botAReady: false,
        botBReady: false,
        botADead: false,
        botBDead: false,
        botAEscaped: false,
        botBEscaped: false,
        botAError: null,
        botBError: null,
        fightStarted: false,
    };
}

// ---- PvP bot function signature ----

export type PvPBotFn = (
    bot: BotAPI,
    opponentName: string,
    coord: FightCoord,
    isInitiator: boolean,
) => Promise<void>;

// ---- Snapshot: 99 all combat stats, full PvP gear loadout ----

export function makeTournamentSnapshot(x: number, z: number): StateSnapshot {
    return {
        position: { x, z, level: 0 },
        skills: {
            ATTACK: 99, DEFENCE: 99, STRENGTH: 99, HITPOINTS: 99,
            RANGED: 99, PRAYER: 99, MAGIC: 99, COOKING: 99,
            WOODCUTTING: 1, FLETCHING: 1, FISHING: 1, FIREMAKING: 1,
            CRAFTING: 1, SMITHING: 1, MINING: 1, HERBLORE: 1,
            AGILITY: 1, THIEVING: 1, STAT18: 1, STAT19: 1,
            RUNECRAFT: 1,
        },
        varps: { 147: 6, 188: 15, 314: 80, 300: 1000 },
        wornItems: [
            // Armor — pre-equipped, bots spawn with gear on
            { id: RUNE_FULL_HELM_ID,     name: RUNE_FULL_HELM,     count: 1, slot: 0 },  // hat
            { id: CAPE_OF_LEGENDS_ID,    name: CAPE_OF_LEGENDS,    count: 1, slot: 1 },  // back
            { id: AMULET_OF_GLORY4_ID,   name: AMULET_OF_GLORY4,   count: 1, slot: 2 },  // front (amulet)
            { id: MAGIC_SHORTBOW_ID,     name: MAGIC_SHORTBOW,     count: 1, slot: 3 },  // rhand
            { id: BLACK_DHIDE_BODY_ID,   name: BLACK_DHIDE_BODY,   count: 1, slot: 4 },  // torso
            { id: RUNE_PLATELEGS_ID,     name: RUNE_PLATELEGS,     count: 1, slot: 7 },  // legs
            { id: BLACK_DHIDE_VAMBS_ID,  name: BLACK_DHIDE_VAMBS,  count: 1, slot: 9 },  // hands
            { id: CLIMBING_BOOTS_ID,     name: CLIMBING_BOOTS,     count: 1, slot: 10 }, // feet
            { id: RING_OF_RECOIL_ID,     name: RING_OF_RECOIL,     count: 1, slot: 12 }, // ring
            { id: RUNE_ARROW_ID,         name: RUNE_ARROW,         count: 200, slot: 13 }, // quiver
        ],
        items: [
            // Weapon switches
            { id: RUNE_SCIMITAR_ID,      name: RUNE_SCIMITAR,      count: 1 },
            { id: DRAGON_DAGGER_ID,      name: DRAGON_DAGGER,      count: 1 },
            { id: DRAGON_BATTLEAXE_ID,   name: DRAGON_BATTLEAXE,   count: 1 },
            { id: DRAGON_MACE_ID,        name: 'Dragon mace',      count: 1 },
            // Potions
            { id: PRAYER_RESTORE4_ID,    name: PRAYER_RESTORE4,    count: 1 },
            { id: PRAYER_RESTORE4_ID,    name: PRAYER_RESTORE4,    count: 1 },
            { id: SUPER_DEFENCE4_ID,     name: SUPER_DEFENCE4,     count: 1 },
            { id: SUPER_ATTACK4_ID,      name: SUPER_ATTACK4,      count: 1 },
            { id: SUPER_STRENGTH4_ID,    name: SUPER_STRENGTH4,    count: 1 },
            { id: RANGING_POTION4_ID,    name: RANGING_POTION4,    count: 1 },
            // Food
            { id: CHOCOLATE_BOMB_ID,     name: CHOCOLATE_BOMB,     count: 1 },
            { id: CHOCOLATE_BOMB_ID,     name: CHOCOLATE_BOMB,     count: 1 },
            { id: CHOCOLATE_BOMB_ID,     name: CHOCOLATE_BOMB,     count: 1 },
            { id: CHOCOLATE_BOMB_ID,     name: CHOCOLATE_BOMB,     count: 1 },
            // Spare ring of recoil
            { id: RING_OF_RECOIL_ID,     name: RING_OF_RECOIL,     count: 1 },
            // Sharks fill the rest
            { id: SHARK_ID,              name: SHARK,              count: 1 },
            { id: SHARK_ID,              name: SHARK,              count: 1 },
            { id: SHARK_ID,              name: SHARK,              count: 1 },
            { id: SHARK_ID,              name: SHARK,              count: 1 },
        ],
    };
}

// ---- Helpers ----

export function isBotDead(bot: BotAPI): boolean {
    return bot.isDead() || bot.player.vars[78] === 1;
}

export function countFood(bot: BotAPI): number {
    return bot.countItem(SHARK) + bot.countItem(CHOCOLATE_BOMB);
}

export function getHpPercent(bot: BotAPI): number {
    const health = bot.getHealth();
    return (health.current / health.max) * 100;
}

/**
 * Eat food with the 40 HP rule enforced.
 * If the bot's current HP > 40, eating is ILLEGAL and causes an instant forfeit (thrown error).
 * All bots MUST use this function instead of calling useItemOp1 directly on food.
 */
export async function eatFood(bot: BotAPI, item: string): Promise<void> {
    const health = bot.getHealth();
    if (health.current > 40) {
        throw new Error(`FORFEIT: ${bot.player.username} ate at ${health.current} HP (max allowed: 40)`);
    }
    await bot.useItemOp1(item);
}

/**
 * Find a potion of any dose (4→3→2→1) in inventory.
 * Returns the full item name (e.g. "Prayer potion(2)") or null if none found.
 */
export function findAnyDosePotion(bot: BotAPI, baseName: string): string | null {
    for (const dose of [4, 3, 2, 1]) {
        const name = `${baseName}(${dose})`;
        if (bot.findItem(name)) return name;
    }
    return null;
}

/**
 * Check if bot has PID over the opponent.
 * In RS2, PID = player slot index. Lower slot processes first = "has PID".
 * The player who processes first can deal damage before the opponent can eat.
 */
export function hasPid(bot: BotAPI, opponent: Player): boolean {
    return bot.player.slot < opponent.slot;
}

/**
 * Check if a coordinate is inside the Wilderness (overworld).
 * Copied from Player.isInWilderness() — pure math, no engine access needed.
 */
export function isInWildernessCoord(x: number, z: number): boolean {
    return x >= 2944 && x < 3392 && z >= 3520 && z < 6400;
}

/**
 * Kite to a random free tile within a 4x4 area around the bot.
 * No directional bias — picks a random valid tile to prevent running in one direction.
 * Clears combat target and queues waypoint. Caller must handle re-engage timing.
 * Returns true if a kite tile was found, false otherwise.
 */
export function kite(bot: BotAPI): boolean {
    const bx = bot.player.x;
    const bz = bot.player.z;

    // Build list of all valid tiles in a 4x4 area (offset -2 to +1 from bot = 4x4 grid)
    const candidates: { x: number; z: number }[] = [];
    for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
            if (dx === 0 && dz === 0) continue;
            const tx = bx + dx;
            const tz = bz + dz;
            if (!isInWildernessCoord(tx, tz)) continue;
            if (bot.isMultiCombat(tx, tz)) continue;
            candidates.push({ x: tx, z: tz });
        }
    }

    if (candidates.length === 0) return false;

    // Pick a random tile
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    bot.clearCombatTarget();
    bot.player.queueWaypoint(pick.x, pick.z);
    return true;
}

/**
 * Check if a player has a melee spec weapon (DDS or DBA) equipped.
 * Reads worn slot 3 (right hand) directly from the player entity.
 */
export function hasMeleeSpecEquipped(player: Player): boolean {
    const slot = player.invGetSlot(InvType.WORN, 3);
    return slot != null && (slot.id === DRAGON_DAGGER_ID || slot.id === DRAGON_BATTLEAXE_ID);
}

/** Wear slot index for the amulet (front) position. */
export const WEARPOS_FRONT = 2;

/**
 * Glory teleport escape: rub glory from inventory → choose Edgeville.
 * Glory must be in inventory (not equipped) — all bots skip equipping it during setup.
 * Sets the escaped flag on coord. Returns true if escape succeeded, false if failed.
 */
export async function escapeWithGlory(
    bot: BotAPI,
    coord: FightCoord,
    isInitiator: boolean,
): Promise<boolean> {
    try {
        // Unequip glory from worn slot to inventory (it's equipped in the snapshot)
        try {
            await bot.unequipWornItem(WEARPOS_FRONT);
        } catch {
            // Already unequipped or combat state — continue, glory might be in inventory
        }

        if (!bot.findItem(AMULET_OF_GLORY4)) {
            bot.log('STATE', 'escapeWithGlory: glory not found in inventory');
            return false;
        }

        await bot.useItemOp4(AMULET_OF_GLORY4);
        await bot.waitForTicks(2);

        // Answer the 5-choice dialog: option 1 = Edgeville
        for (let attempt = 0; attempt < 3; attempt++) {
            if (bot.dialog.isMultiChoiceOpen()) {
                bot.dialog.selectOption(1);
                await bot.waitForTicks(5);
                break;
            }
            await bot.waitForTick();
        }

        // Check if teleport succeeded (position changed away from wilderness)
        const pos = bot.getPosition();
        if (pos.z < 3520) {
            bot.log('STATE', `escapeWithGlory: teleported to (${pos.x},${pos.z})`);
            if (isInitiator) coord.botAEscaped = true;
            else coord.botBEscaped = true;
            return true;
        }

        bot.log('STATE', `escapeWithGlory: teleport failed, still at (${pos.x},${pos.z})`);
        return false;
    } catch (err) {
        bot.log('STATE', `escapeWithGlory failed: ${(err as Error).message}`);
        return false;
    }
}
