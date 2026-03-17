import type { BotAPI } from '../runtime/api.js';
import {
    RUNE_SCIMITAR,
    SHARK,
    SUPER_ATTACK4,
    SUPER_STRENGTH4,
    SUPER_DEFENCE4,
    FIGHT_X, FIGHT_Z,
    isBotDead, getHpPercent, eatFood,
    makeTournamentSnapshot,
    makeFightCoord,
} from './pvp-shared.js';
import { run as runAlphaBot } from './pvp-bot-alpha.js';

export const VALID_STRATEGIES = ['alpha', 'echo'] as const;
export type Strategy = typeof VALID_STRATEGIES[number];

// ---- Shared helpers ----

async function findAndAttackHuman(bot: BotAPI, targetUsername: string, strategy: string): Promise<void> {
    await bot.walkToWithPathfinding(FIGHT_X, FIGHT_Z);
    bot.log('STATE', `PvP bot (${strategy}) ready, waiting for ${targetUsername}`);

    let target = null;
    for (let i = 0; i < 5000; i++) {
        await bot.waitForTick();
        target = bot.findNearbyPlayerByUsername(targetUsername, 60);
        if (target) break;
    }
    if (!target) throw new Error(`PvP bot (${strategy}): timed out waiting for ${targetUsername}`);

    await bot.attackPlayer(target);
    bot.log('STATE', `PvP bot (${strategy}) attacking ${targetUsername}`);
}

function isHumanGone(bot: BotAPI, targetUsername: string): boolean {
    return !bot.findNearbyPlayerByUsername(targetUsername, 60);
}

// ---- Alpha: delegates to pvp-bot-alpha.ts to prevent drift ----

async function runAlpha(bot: BotAPI, targetUsername: string): Promise<void> {
    const coord = makeFightCoord();
    coord.fightStarted = true;
    await runAlphaBot(bot, targetUsername, coord, true);
}

// ---- Echo: Static baseline, pure scimitar, no prayer, no escape, no spec ----

async function runEcho(bot: BotAPI, targetUsername: string): Promise<void> {
    bot.restoreFromSnapshot(makeTournamentSnapshot(FIGHT_X, 3492));
    await bot.waitForTicks(2);

    await bot.equipItem(RUNE_SCIMITAR); await bot.waitForTicks(1);
    bot.setCombatStyle(1);
    if (bot.findItem(SUPER_ATTACK4))   { await bot.useItemOp1(SUPER_ATTACK4);   await bot.waitForTicks(1); }
    if (bot.findItem(SUPER_STRENGTH4)) { await bot.useItemOp1(SUPER_STRENGTH4); await bot.waitForTicks(1); }
    if (bot.findItem(SUPER_DEFENCE4))  { await bot.useItemOp1(SUPER_DEFENCE4);  await bot.waitForTicks(1); }
    await findAndAttackHuman(bot, targetUsername, 'echo');

    for (let tick = 0; tick < 5000; tick++) {
        await bot.waitForTick();
        bot.dismissModals();

        if (isBotDead(bot)) { bot.log('STATE', 'Echo died'); return; }
        if (isHumanGone(bot, targetUsername)) { bot.log('STATE', 'Echo: opponent left'); return; }

        const hpPct = getHpPercent(bot);
        if (hpPct <= 40) {
            if (bot.findItem(SHARK)) {
                await eatFood(bot, SHARK);
                await bot.waitForTicks(1);
            }
        }
    }
}

// ---- Main dispatcher ----

export async function runHumanFight(bot: BotAPI, targetUsername: string, strategy: Strategy): Promise<void> {
    switch (strategy) {
        case 'alpha': return runAlpha(bot, targetUsername);
        case 'echo': return runEcho(bot, targetUsername);
    }
}
