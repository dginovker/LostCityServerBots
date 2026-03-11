/**
 * Shared test utilities for bot tests.
 * Provides a tick loop with AFK detection.
 */

interface TickLoopOptions {
    /** Maximum ticks before timeout */
    maxTicks: number;
    /** Reference to the World module */
    world: { cycle: () => void };
    /** Returns true when the script is done */
    isDone: () => boolean;
    /** Get current bot state snapshot for AFK detection */
    getState: () => { x: number; z: number; totalXp: number };
    /** How many ticks of no change before AFK fail (default: 500 = ~5 min) */
    afkThreshold?: number;
    /** Extra ticks to run after isDone returns true (default: 5) */
    settleTicks?: number;
}

/**
 * Run the game tick loop with AFK detection.
 * Returns { timedOut, afk, ticksRun }.
 */
export async function runTickLoop(opts: TickLoopOptions): Promise<{ timedOut: boolean; afk: boolean; ticksRun: number }> {
    const afkThreshold = opts.afkThreshold ?? 500;
    const settleTicks = opts.settleTicks ?? 5;

    let lastX = 0;
    let lastZ = 0;
    let lastXp = 0;
    let idleTicks = 0;

    for (let tick = 0; tick < opts.maxTicks; tick++) {
        opts.world.cycle();
        await Promise.resolve();

        if (opts.isDone()) {
            for (let i = 0; i < settleTicks; i++) {
                opts.world.cycle();
                await Promise.resolve();
            }
            return { timedOut: false, afk: false, ticksRun: tick };
        }

        // AFK detection — check every 50 ticks
        if (tick % 50 === 0 && tick > 0) {
            const state = opts.getState();
            if (state.x === lastX && state.z === lastZ && state.totalXp === lastXp) {
                idleTicks += 50;
                if (idleTicks >= afkThreshold) {
                    return { timedOut: false, afk: true, ticksRun: tick };
                }
            } else {
                idleTicks = 0;
            }
            lastX = state.x;
            lastZ = state.z;
            lastXp = state.totalXp;
        }
    }

    return { timedOut: true, afk: false, ticksRun: opts.maxTicks };
}

/**
 * Get total XP across all stats for a player.
 */
export function getTotalXp(player: { stats: number[] }): number {
    let total = 0;
    for (let i = 0; i < 21; i++) {
        total += player.stats[i] ?? 0;
    }
    return total;
}
