import { BotAPI } from '../runtime/api.js';
import { skipTutorial } from './skip-tutorial.js';
import { type BotState, runStateMachine } from '../runtime/state-machine.js';
import type { ScriptMeta } from '../runtime/script-meta.js';

/**
 * Test scripts that verify stuck detection catches different stuck patterns.
 *
 * 1. "intentionally-stuck" — does nothing at all (no movement, no XP, no items).
 *    Current detector catches this.
 *
 * 2. "moving-but-no-progress" — walks back and forth but never gains XP/items/varps.
 *    Simulates the player.delayed bug where interactNpc silently fails but the bot
 *    keeps walking to NPCs. The two-tier detector should catch this via the
 *    progressThreshold (XP/inventory/varp must change, position alone isn't enough).
 */

const STUCK_THRESHOLD = 20; // Very low threshold so test completes quickly

// --- Test 1: totally idle (original test) ---

function buildStuckTestStates(_bot: BotAPI): BotState {
    return {
        name: 'stuck-test',
        isComplete: () => false,
        run: async () => { throw new Error('composite state should not run'); },
        children: [
            {
                name: 'intentionally-stuck',
                stuckThreshold: STUCK_THRESHOLD,
                maxRetries: 1,
                isComplete: () => false,
                run: async (bot: BotAPI) => {
                    // Do nothing — no movement, no XP, no items.
                    for (let i = 0; i < 5000; i++) {
                        await bot.waitForTicks(10);
                    }
                },
            },
        ],
    };
}

async function stuckTest(bot: BotAPI): Promise<void> {
    await skipTutorial(bot);
    await bot.waitForTicks(2);

    const root = buildStuckTestStates(bot);
    await runStateMachine(bot, { root });
}

export const metadata: ScriptMeta = {
    name: 'stucktest',
    type: 'activity',
    maxTicks: 500,
    run: stuckTest,
};

// --- Test 2: moving but no real progress ---

function buildMovingStuckTestStates(_bot: BotAPI): BotState {
    return {
        name: 'moving-stuck-test',
        isComplete: () => false,
        run: async () => { throw new Error('composite state should not run'); },
        children: [
            {
                name: 'moving-but-no-progress',
                stuckThreshold: STUCK_THRESHOLD,
                progressThreshold: STUCK_THRESHOLD, // NEW: XP/inv/varp must change within this many ticks
                maxRetries: 1,
                isComplete: () => false,
                run: async (bot: BotAPI) => {
                    // Walk back and forth — position changes, but no XP/items/varps ever change.
                    // This simulates a bot stuck in a failed-interaction loop.
                    const startX = bot.getPosition().x;
                    const startZ = bot.getPosition().z;
                    for (let i = 0; i < 500; i++) {
                        // Walk 5 tiles east
                        await bot.walkTo(startX + 5, startZ);
                        // Walk 5 tiles west
                        await bot.walkTo(startX - 5, startZ);
                    }
                },
            },
        ],
    };
}

async function movingStuckTest(bot: BotAPI): Promise<void> {
    await skipTutorial(bot);
    await bot.waitForTicks(2);

    const root = buildMovingStuckTestStates(bot);
    await runStateMachine(bot, { root });
}

export const movingStuckMetadata: ScriptMeta = {
    name: 'movingstucktest',
    type: 'activity',
    maxTicks: 500,
    run: movingStuckTest,
};
