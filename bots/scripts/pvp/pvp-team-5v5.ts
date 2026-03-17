import { BotAPI } from '../../runtime/api.js';
import type { StateSnapshot } from '../../runtime/state-machine.js';
import type { ScriptMeta } from '../../runtime/script-meta.js';
import BotManager from '../../runtime/manager.js';

// ---- Fight location ----
// Chunk 0_50_56 in multiway.csv: x=3200-3263, z=3584-3647 — confirmed multi-combat.
// Wilderness level at z=3590: (3590 - 3520) / 8 + 1 = ~10.
const FIGHT_X = 3210;
const FIGHT_Z = 3590;

// ---- Team definitions (secondary bots only — A1 is named by the server) ----
// Index 0-4 = Team A (captain = A1 = index 0), 5-9 = Team B
const TEAM_SIZE = 5;
// A1's name is determined at runtime from bot.player.username
const TEAM_A_SECONDARY_NAMES = ['pvp5v5-a2', 'pvp5v5-a3', 'pvp5v5-a4', 'pvp5v5-a5'];
const TEAM_B_NAMES = ['pvp5v5-b1', 'pvp5v5-b2', 'pvp5v5-b3', 'pvp5v5-b4', 'pvp5v5-b5'];

// ---- Spawn positions (near Edgeville, outside bank walls) ----
const TEAM_A_SPAWNS = [
    { x: 3108, z: 3492 }, // A1 (main bot)
    { x: 3110, z: 3492 }, // A2
    { x: 3112, z: 3492 }, // A3
    { x: 3108, z: 3494 }, // A4
    { x: 3110, z: 3494 }, // A5
];
const TEAM_B_SPAWNS = [
    { x: 3115, z: 3492 }, // B1
    { x: 3117, z: 3492 }, // B2
    { x: 3119, z: 3492 }, // B3
    { x: 3115, z: 3494 }, // B4
    { x: 3117, z: 3494 }, // B5
];

// ---- Item IDs (from content/pack/obj.pack) ----
const RUNE_SCIMITAR_ID  = 1333;
const RUNE_FULL_HELM_ID = 1163;
const RUNE_PLATEBODY_ID = 1127;
const RUNE_PLATELEGS_ID = 1079;
const RUNE_SQ_SHIELD_ID = 1185;
const LOBSTER_ID        = 379;

const RUNE_SCIMITAR  = 'Rune scimitar';
const RUNE_FULL_HELM = 'Rune full helm';
const RUNE_PLATEBODY = 'Rune platebody';
const RUNE_PLATELEGS = 'Rune platelegs';
const RUNE_SQ_SHIELD = 'Rune sq shield';
const LOBSTER        = 'Lobster';

// ---- Shared coordination object ----
interface TeamBattle {
    /** true once a bot has reached the fight area and is ready */
    ready: boolean[];          // length 10: 0-4 Team A, 5-9 Team B
    /** true once a bot has died */
    dead: boolean[];           // length 10
    /** non-null when a bot's script throws */
    errors: (string | null)[]; // length 10
    /** set by A1 once all bots are in position */
    startFight: boolean;
}

// ---- Snapshot: Edgeville area, rune gear + 20 lobsters, 40/40/40 combat ----
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
            { id: LOBSTER_ID,        name: LOBSTER,        count: 20 },
        ],
    };
}

// ---- Equip rune gear and walk to fight area ----
async function equipGearAndWalk(bot: BotAPI, targetX: number, targetZ: number): Promise<void> {
    await bot.equipItem(RUNE_SCIMITAR);  await bot.waitForTicks(1);
    await bot.equipItem(RUNE_FULL_HELM); await bot.waitForTicks(1);
    await bot.equipItem(RUNE_PLATEBODY); await bot.waitForTicks(1);
    await bot.equipItem(RUNE_PLATELEGS); await bot.waitForTicks(1);
    await bot.equipItem(RUNE_SQ_SHIELD); await bot.waitForTicks(1);
    await bot.walkToWithPathfinding(targetX, targetZ);
}

// ---- Return index of first alive enemy, or null if all dead ----
function firstAliveEnemy(enemyStartIdx: number, battle: TeamBattle): number | null {
    for (let i = enemyStartIdx; i < enemyStartIdx + TEAM_SIZE; i++) {
        if (!battle.dead[i]) return i;
    }
    return null;
}

// ---- Return first non-null error, or null ----
function firstBattleError(battle: TeamBattle): string | null {
    for (const e of battle.errors) {
        if (e !== null) return e;
    }
    return null;
}

/**
 * Combat loop for any bot (called after fight signal is set).
 * Focus-fires: all bots on same team attack the first alive enemy.
 * Eats when HP < 50%. Switches targets when current target dies.
 *
 * @param allBotNames - full 10-element array [a1Username, a2..a5, b1..b5]
 */
async function teamCombatLoop(
    bot: BotAPI,
    battle: TeamBattle,
    myIdx: number,
    enemyStartIdx: number,
    allBotNames: string[],
): Promise<void> {
    const MAX_TICKS = 5000;
    const isTeamA = myIdx < TEAM_SIZE;
    const label = isTeamA ? `A${myIdx + 1}` : `B${myIdx - TEAM_SIZE + 1}`;

    // Find first alive enemy and initiate attack
    let currentTargetIdx = firstAliveEnemy(enemyStartIdx, battle);
    if (currentTargetIdx === null) {
        bot.log('SUCCESS', `Bot ${label}: all enemies already dead`);
        return;
    }

    const firstTargetName = allBotNames[currentTargetIdx];
    const firstTargetPlayer = bot.findNearbyPlayerByUsername(firstTargetName, 200);
    if (!firstTargetPlayer || !firstTargetPlayer.isActive) {
        throw new Error(`Bot ${label}: cannot find active enemy ${firstTargetName}`);
    }
    await bot.attackPlayer(firstTargetPlayer);
    bot.log('STATE', `Bot ${label} attacking ${firstTargetName}`);

    for (let tick = 0; tick < MAX_TICKS; tick++) {
        await bot.waitForTick();
        bot.dismissModals();

        // Check own death
        if (bot.isDead() || bot.player.vars[78] === 1) {
            bot.log('STATE', `Bot ${label} died`);
            battle.dead[myIdx] = true;
            return;
        }

        // Check win condition
        if (firstAliveEnemy(enemyStartIdx, battle) === null) {
            bot.log('SUCCESS', `Bot ${label}: all enemies dead — victory!`);
            return;
        }

        // Propagate any error from the battle
        const err = firstBattleError(battle);
        if (err) throw new Error(`Battle error: ${err}`);

        // Eat lobster when HP < 50%
        const health = bot.getHealth();
        if ((health.current / health.max) * 100 < 50 && bot.findItem(LOBSTER)) {
            bot.log('ACTION', `Bot ${label} eating (HP=${health.current}/${health.max})`);
            await bot.useItemOp1(LOBSTER);
            await bot.waitForTicks(1);
        }

        // Switch to next alive target if current one died
        if (battle.dead[currentTargetIdx]) {
            const nextIdx = firstAliveEnemy(enemyStartIdx, battle);
            if (nextIdx !== null) {
                currentTargetIdx = nextIdx;
                const nextName = allBotNames[currentTargetIdx];
                const nextPlayer = bot.findNearbyPlayerByUsername(nextName, 200);
                if (nextPlayer && nextPlayer.isActive) {
                    bot.log('STATE', `Bot ${label} switching to ${nextName}`);
                    await bot.attackPlayer(nextPlayer);
                }
            }
        }

        if (tick > 0 && tick % 500 === 0) {
            const h = bot.getHealth();
            bot.log('STATE', `Bot ${label} tick ${tick}: HP=${h.current}/${h.max}`);
        }
    }

    throw new Error(`Bot ${label}: combat timed out after ${MAX_TICKS} ticks`);
}

/**
 * Full path for a secondary bot (A2–A5 or B1–B5).
 * Restores snapshot, gears up, walks to fight area, waits for signal, fights.
 *
 * @param allBotNames - full 10-element array [a1Username, a2..a5, b1..b5]
 */
async function runSecondaryBot(
    bot: BotAPI,
    battle: TeamBattle,
    myIdx: number,
    spawnX: number,
    spawnZ: number,
    enemyStartIdx: number,
    allBotNames: string[],
): Promise<void> {
    const isTeamA = myIdx < TEAM_SIZE;
    const label = isTeamA ? `A${myIdx + 1}` : `B${myIdx - TEAM_SIZE + 1}`;

    try {
        bot.restoreFromSnapshot(makePvPSnapshot(spawnX, spawnZ));
        await bot.waitForTicks(2);
        bot.log('STATE', `Bot ${label} at (${bot.player.x},${bot.player.z})`);

        await equipGearAndWalk(bot, FIGHT_X, FIGHT_Z);
        battle.ready[myIdx] = true;
        bot.log('STATE', `Bot ${label} in fight area — ready`);

        // Wait for A1 to signal fight start
        for (let i = 0; i < 3000; i++) {
            await bot.waitForTick();
            if (battle.startFight) break;
            const err = firstBattleError(battle);
            if (err) throw new Error(`Error while waiting for fight: ${err}`);
        }
        if (!battle.startFight) {
            throw new Error(`Bot ${label}: timed out waiting for fight signal`);
        }

        // Stagger slightly so bots don't all call attackPlayer on the exact same tick
        await bot.waitForTicks(myIdx % 3);

        await teamCombatLoop(bot, battle, myIdx, enemyStartIdx, allBotNames);
    } catch (err) {
        battle.errors[myIdx] = (err as Error).message;
        throw err;
    }
}

// ---- Main entry point (Bot A1 — the captain) ----
export async function pvpTeam5v5(bot: BotAPI): Promise<void> {
    const A1_IDX = 0;
    const TEAM_B_START = TEAM_SIZE; // Team B indices start at 5

    bot.restoreFromSnapshot(makePvPSnapshot(TEAM_A_SPAWNS[0].x, TEAM_A_SPAWNS[0].z));
    await bot.waitForTicks(2);

    // A1's actual username (set by the server, e.g. 'testbot_0')
    const A1_USERNAME = bot.player.username;
    // Full bot name list: A1's real name + secondary names
    const ALL_BOT_NAMES = [A1_USERNAME, ...TEAM_A_SECONDARY_NAMES, ...TEAM_B_NAMES];

    bot.log('STATE', `A1 (${A1_USERNAME}) starting at (${bot.player.x},${bot.player.z})`);

    const battle: TeamBattle = {
        ready:      new Array(10).fill(false),
        dead:       new Array(10).fill(false),
        errors:     new Array(10).fill(null),
        startFight: false,
    };

    // Cleanup any stale bots from a previous run
    for (const name of [...TEAM_A_SECONDARY_NAMES, ...TEAM_B_NAMES]) {
        BotManager.forceCleanup(name);
    }

    // Spawn Team A bots A2–A5 (indices 1–4)
    for (let i = 0; i < TEAM_A_SECONDARY_NAMES.length; i++) {
        const botName = TEAM_A_SECONDARY_NAMES[i];
        const spawnPos = TEAM_A_SPAWNS[i + 1]; // +1 since TEAM_A_SPAWNS[0] is A1
        const myIdx = i + 1;                   // index 1-4 in ALL_BOT_NAMES
        BotManager.spawnBot(botName, async (spawned: BotAPI) => {
            try {
                for (let t = 0; t < 40; t++) {
                    await spawned.waitForTick();
                    if (spawned.player.isActive) break;
                }
                if (!spawned.player.isActive) {
                    throw new Error(`${botName}: isActive=false after 40 ticks`);
                }
                await runSecondaryBot(spawned, battle, myIdx, spawnPos.x, spawnPos.z, TEAM_B_START, ALL_BOT_NAMES);
            } catch (err) {
                battle.errors[myIdx] = (err as Error).message;
            }
        });
    }

    // Spawn Team B bots B1–B5 (indices 5–9)
    for (let i = 0; i < TEAM_SIZE; i++) {
        const botName = TEAM_B_NAMES[i];
        const spawnPos = TEAM_B_SPAWNS[i];
        const myIdx = TEAM_SIZE + i;
        BotManager.spawnBot(botName, async (spawned: BotAPI) => {
            try {
                for (let t = 0; t < 40; t++) {
                    await spawned.waitForTick();
                    if (spawned.player.isActive) break;
                }
                if (!spawned.player.isActive) {
                    throw new Error(`${botName}: isActive=false after 40 ticks`);
                }
                await runSecondaryBot(spawned, battle, myIdx, spawnPos.x, spawnPos.z, 0 /* Team A starts at 0 */, ALL_BOT_NAMES);
            } catch (err) {
                battle.errors[myIdx] = (err as Error).message;
            }
        });
    }

    try {
        // A1: equip gear and walk to fight area
        await equipGearAndWalk(bot, FIGHT_X, FIGHT_Z);
        battle.ready[A1_IDX] = true;
        bot.log('STATE', `A1 in fight area at (${bot.player.x},${bot.player.z}) — waiting for team`);

        // Wait for all 10 bots to reach the fight area
        for (let i = 0; i < 5000; i++) {
            await bot.waitForTick();
            const err = firstBattleError(battle);
            if (err) throw new Error(`Bot failed during setup: ${err}`);
            if (battle.ready.every(r => r)) break;
        }
        if (!battle.ready.every(r => r)) {
            const notReady = battle.ready
                .map((r, idx) => (r ? null : ALL_BOT_NAMES[idx]))
                .filter(Boolean);
            throw new Error(`Setup timeout — not in position: ${notReady.join(', ')}`);
        }

        bot.log('STATE', 'All 10 bots in fight area');

        // Brief settle before fight
        await bot.waitForTicks(5);

        // Signal all bots to start fighting
        battle.startFight = true;
        bot.log('STATE', '=== FIGHT START ===');

        // A1 enters its own combat loop (no stagger — A1 is the initiator)
        await teamCombatLoop(bot, battle, A1_IDX, TEAM_B_START, ALL_BOT_NAMES);

        // Wait for all bots to resolve
        for (let i = 0; i < 2000; i++) {
            await bot.waitForTick();
            const teamAAllDead = battle.dead.slice(0, TEAM_SIZE).every(d => d);
            const teamBAllDead = battle.dead.slice(TEAM_SIZE).every(d => d);
            if (teamAAllDead || teamBAllDead) break;
        }

        // Final result
        const teamADeadCount = battle.dead.slice(0, TEAM_SIZE).filter(d => d).length;
        const teamBDeadCount = battle.dead.slice(TEAM_SIZE).filter(d => d).length;

        if (teamBDeadCount === TEAM_SIZE) {
            bot.log('SUCCESS', `Fight complete: TEAM A wins! (A dead: ${teamADeadCount}/${TEAM_SIZE})`);
        } else if (teamADeadCount === TEAM_SIZE) {
            bot.log('SUCCESS', `Fight complete: TEAM B wins! (B dead: ${teamBDeadCount}/${TEAM_SIZE})`);
        } else {
            throw new Error(
                `Fight did not fully resolve: Team A dead=${teamADeadCount}/${TEAM_SIZE}, Team B dead=${teamBDeadCount}/${TEAM_SIZE}`
            );
        }
    } finally {
        for (const name of [...TEAM_A_SECONDARY_NAMES, ...TEAM_B_NAMES]) {
            BotManager.forceCleanup(name);
        }
    }
}

export const metadata: ScriptMeta = {
    name: 'pvp-team-5v5',
    type: 'activity',
    maxTicks: 15000,
    run: pvpTeam5v5,
};
