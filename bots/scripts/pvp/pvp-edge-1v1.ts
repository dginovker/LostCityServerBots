import { BotAPI } from '../../runtime/api.js';
import type { StateSnapshot } from '../../runtime/state-machine.js';
import type { ScriptMeta } from '../../runtime/script-meta.js';
import BotManager from '../../runtime/manager.js';

// ---- Locations ----

// Edgeville bank: 3094,3493 (inside a building — avoid spawning there)
// Open area east of Edgeville bank: x=3115, z=3490
// Wilderness boundary: approx z=3520 at Edgeville entrance (no ditch in 2004 — just walk north)
// Fight spot: wilderness level 1

const FIGHT_X_A = 3108; // Bot A fight position
const FIGHT_Z   = 3525; // Just inside wilderness (level 1)
const FIGHT_X_B = 3108; // Bot B shares same x (engine allows players on same tile)

// ---- Item IDs (from content/pack/obj.pack) ----

const RUNE_SCIMITAR_ID  = 1333;
const RUNE_FULL_HELM_ID = 1163;
const RUNE_PLATEBODY_ID = 1127;
const RUNE_PLATELEGS_ID = 1079;
const RUNE_SQ_SHIELD_ID = 1185;
const LOBSTER_ID        = 379;

// ---- Item display names (ObjType.get(id).name) ----

const RUNE_SCIMITAR  = 'Rune scimitar';
const RUNE_FULL_HELM = 'Rune full helm';
const RUNE_PLATEBODY = 'Rune platebody';
const RUNE_PLATELEGS = 'Rune platelegs';
const RUNE_SQ_SHIELD = 'Rune sq shield';
const LOBSTER        = 'Lobster';

// ---- Coordination ----

interface PvPCoord {
    botAReady: boolean;
    botBReady: boolean;
    botADead: boolean;
    botBDead: boolean;
    botAError: string | null;
    botBError: string | null;
}

// ---- Snapshot: Edgeville, rune gear + 15 lobsters, 40/40/40 combat ----

function makePvPSnapshot(x: number, z: number): StateSnapshot {
    return {
        position: { x, z, level: 0 },
        skills: {
            ATTACK: 40, DEFENCE: 40, STRENGTH: 40, HITPOINTS: 45,
            RANGED: 1, PRAYER: 1, MAGIC: 1, COOKING: 1,
            WOODCUTTING: 1, FLETCHING: 1, FISHING: 1, FIREMAKING: 1,
            CRAFTING: 1, SMITHING: 1, MINING: 1, HERBLORE: 1,
            AGILITY: 1, THIEVING: 1, STAT18: 1, STAT19: 1,
            RUNECRAFT: 1,
        },
        varps: {},
        items: [
            { id: RUNE_SCIMITAR_ID,  name: RUNE_SCIMITAR,  count: 1 },
            { id: RUNE_FULL_HELM_ID, name: RUNE_FULL_HELM, count: 1 },
            { id: RUNE_PLATEBODY_ID, name: RUNE_PLATEBODY, count: 1 },
            { id: RUNE_PLATELEGS_ID, name: RUNE_PLATELEGS, count: 1 },
            { id: RUNE_SQ_SHIELD_ID, name: RUNE_SQ_SHIELD, count: 1 },
            { id: LOBSTER_ID,        name: LOBSTER,        count: 15 },
        ],
    };
}

// ---- Helpers ----

async function equipGearAndWalk(bot: BotAPI, targetX: number, targetZ: number): Promise<void> {
    bot.log('STATE', 'Equipping rune gear');
    await bot.equipItem(RUNE_SCIMITAR);
    await bot.waitForTicks(1);
    await bot.equipItem(RUNE_FULL_HELM);
    await bot.waitForTicks(1);
    await bot.equipItem(RUNE_PLATEBODY);
    await bot.waitForTicks(1);
    await bot.equipItem(RUNE_PLATELEGS);
    await bot.waitForTicks(1);
    await bot.equipItem(RUNE_SQ_SHIELD);
    await bot.waitForTicks(1);

    bot.log('STATE', `Walking to wilderness at (${targetX},${targetZ})`);
    await bot.walkToWithPathfinding(targetX, targetZ);
    bot.log('STATE', `Entered wilderness at (${bot.player.x},${bot.player.z})`);
}

/**
 * Combat loop: eat when HP is low, monitor for death/victory.
 * Returns when the fight is resolved (one bot dead) or times out.
 */
async function combatLoop(bot: BotAPI, coord: PvPCoord, isBotA: boolean): Promise<void> {
    const botLabel = isBotA ? 'A' : 'B';
    const MAX_TICKS = 3000;

    for (let tick = 0; tick < MAX_TICKS; tick++) {
        await bot.waitForTick();
        bot.dismissModals();

        // Check for our death first
        if (bot.isDead() || bot.player.vars[78] === 1) {
            bot.log('STATE', `Bot ${botLabel} died!`);
            if (isBotA) coord.botADead = true;
            else coord.botBDead = true;
            return;
        }

        // Check if opponent died
        if (isBotA ? coord.botBDead : coord.botADead) {
            bot.log('STATE', `Bot ${botLabel} wins — opponent dead`);
            return;
        }

        // Check for partner error
        if (isBotA ? coord.botBError : coord.botAError) {
            throw new Error(`Partner bot failed: ${isBotA ? coord.botBError : coord.botAError}`);
        }

        // Eat lobster when HP < 50%
        const health = bot.getHealth();
        const hpPct = (health.current / health.max) * 100;
        if (hpPct < 50 && bot.findItem(LOBSTER)) {
            bot.log('ACTION', `Bot ${botLabel} eating lobster (HP=${health.current}/${health.max})`);
            await bot.useItemOp1(LOBSTER);
            await bot.waitForTicks(1);
        }

        if (tick > 0 && tick % 500 === 0) {
            const h = bot.getHealth();
            bot.log('STATE', `Bot ${botLabel} tick ${tick}: HP=${h.current}/${h.max}`);
        }
    }

    throw new Error(`Bot ${botLabel} combat timed out after ${MAX_TICKS} ticks`);
}

// ---- Bot B path ----

async function runBotBPath(botB: BotAPI, coord: PvPCoord): Promise<void> {
    try {
        botB.restoreFromSnapshot(makePvPSnapshot(FIGHT_X_B, 3495));
        await botB.waitForTicks(2);

        await equipGearAndWalk(botB, FIGHT_X_B, FIGHT_Z);
        coord.botBReady = true;
        botB.log('STATE', 'Bot B in wilderness — ready');

        await combatLoop(botB, coord, false);
    } catch (err) {
        coord.botBError = (err as Error).message;
        throw err;
    }
}

// ---- Main entry point (Bot A) ----

export async function pvpEdge1v1(bot: BotAPI): Promise<void> {
    bot.restoreFromSnapshot(makePvPSnapshot(FIGHT_X_A, 3492));
    await bot.waitForTicks(2);

    bot.log('STATE', `Bot A starting at (${bot.player.x},${bot.player.z})`);

    const coord: PvPCoord = {
        botAReady: false,
        botBReady: false,
        botADead: false,
        botBDead: false,
        botAError: null,
        botBError: null,
    };

    const BOT_B_NAME = 'pvp-edge-b';
    BotManager.forceCleanup(BOT_B_NAME);

    BotManager.spawnBot(BOT_B_NAME, async (botB: BotAPI) => {
        try {
            // Wait for processLogin to activate the player
            for (let i = 0; i < 15; i++) {
                await botB.waitForTick();
                if (botB.player.isActive) break;
            }
            if (!botB.player.isActive) {
                throw new Error('Bot B login failed: isActive=false after 15 ticks');
            }
            await runBotBPath(botB, coord);
        } catch (err) {
            coord.botBError = (err as Error).message;
            throw err;
        }
    });

    try {
        // Bot A: gear up and enter wilderness
        await equipGearAndWalk(bot, FIGHT_X_A, FIGHT_Z);
        coord.botAReady = true;
        bot.log('STATE', 'Bot A in wilderness — waiting for Bot B');

        // Wait for Bot B to enter wilderness
        for (let i = 0; i < 3000; i++) {
            await bot.waitForTick();
            if (coord.botBError) throw new Error(`Bot B failed before fight: ${coord.botBError}`);
            if (coord.botBReady) break;
        }
        if (!coord.botBReady) {
            throw new Error('Timed out waiting for Bot B to enter wilderness');
        }

        // Allow both bots to settle in position
        await bot.waitForTicks(5);

        // Find Bot B and initiate combat
        bot.log('STATE', 'Initiating PvP combat');
        const botBPlayer = bot.findNearbyPlayerByUsername(BOT_B_NAME, 60);
        if (!botBPlayer) {
            throw new Error(`Cannot find Bot B (${BOT_B_NAME}) within 60 tiles of (${bot.player.x},${bot.player.z})`);
        }

        // Attack Bot B once — auto-retaliate (pvp_retaliate queue) handles Bot B's side
        // Do NOT re-call attackPlayer during combat: it would trigger p_stopaction
        await bot.attackPlayer(botBPlayer);
        bot.log('STATE', 'Combat started');

        // Bot A combat loop
        await combatLoop(bot, coord, true);

        // Wait for Bot B to finish if we won
        if (!coord.botADead) {
            for (let i = 0; i < 500; i++) {
                if (coord.botBDead || coord.botBError) break;
                await bot.waitForTick();
            }
        }

        // Validate outcome
        if (!coord.botADead && !coord.botBDead) {
            throw new Error('Fight resolved but neither bot registered as dead');
        }
        if (coord.botADead && coord.botBDead) {
            throw new Error('Both bots died simultaneously — unexpected outcome');
        }

        if (coord.botADead) {
            bot.log('SUCCESS', 'Fight complete: Bot B wins (Bot A died)');
        } else {
            bot.log('SUCCESS', 'Fight complete: Bot A wins (Bot B died)');
        }
    } finally {
        BotManager.forceCleanup(BOT_B_NAME);
    }
}

export const metadata: ScriptMeta = {
    name: 'pvp-edge-1v1',
    type: 'activity',
    maxTicks: 10000,
    run: pvpEdge1v1,
};
