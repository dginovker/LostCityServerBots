/**
 * Shared test utilities for bot tests.
 * Provides a tick loop with AFK detection, heartbeat, and structured failure output.
 */

import LocType from '../../src/cache/config/LocType.ts';
import World from '../../src/engine/World.ts';

interface TickLoopOptions {
    /** Maximum ticks before timeout */
    maxTicks: number;
    /** Reference to the World module */
    world: { cycle: () => void; gameMap: { getZone: (x: number, z: number, level: number) => any } };
    /** Returns true when the script is done */
    isDone: () => boolean;
    /** Get current bot state snapshot for AFK detection */
    getState: () => { x: number; z: number; totalXp: number };
    /** How many ticks of no change before AFK fail (default: 500 = ~5 min) */
    afkThreshold?: number;
    /** Extra ticks to run after isDone returns true (default: 5) */
    settleTicks?: number;
    /** Optional label for current bot state (shown in heartbeat and failure JSON) */
    getLabel?: () => string;
    /** Optional: get HP info for heartbeat */
    getHp?: () => { current: number; max: number };
    /** Optional: get error message if script failed */
    getError?: () => string | null;
    /** Optional: get quest varp value for failure JSON */
    getQuestVarp?: () => number;
    /** Optional: get skills snapshot for failure JSON */
    getSkills?: () => Record<string, number>;
}

interface TickLoopResult {
    timedOut: boolean;
    afk: boolean;
    ticksRun: number;
}

/**
 * Scan zones around a position for locs within a given radius.
 * Returns loc info with debugnames and distances.
 */
export function getNearbyLocs(x: number, z: number, level: number, radius: number = 5): Array<{ name: string; x: number; z: number; dist: number }> {
    const results: Array<{ name: string; x: number; z: number; dist: number }> = [];
    const seen = new Set<string>();

    // Zones are 8x8 tiles. Scan enough zones to cover the radius.
    const zoneRadius = Math.ceil(radius / 8) + 1;
    const centerZoneX = x >> 3;
    const centerZoneZ = z >> 3;

    for (let dzx = -zoneRadius; dzx <= zoneRadius; dzx++) {
        for (let dzz = -zoneRadius; dzz <= zoneRadius; dzz++) {
            const zoneX = (centerZoneX + dzx) << 3;
            const zoneZ = (centerZoneZ + dzz) << 3;

            let zone;
            try {
                zone = World.gameMap.getZone(zoneX, zoneZ, level);
            } catch {
                continue;
            }

            for (const loc of zone.getAllLocsSafe()) {
                const dist = Math.abs(loc.x - x) + Math.abs(loc.z - z);
                if (dist > radius) continue;

                const key = `${loc.type}:${loc.x}:${loc.z}`;
                if (seen.has(key)) continue;
                seen.add(key);

                let name: string;
                try {
                    const locType = LocType.get(loc.type);
                    name = locType.debugname ?? `loc_${loc.type}`;
                } catch {
                    name = `loc_${loc.type}`;
                }

                results.push({ name, x: loc.x, z: loc.z, dist });
            }
        }
    }

    results.sort((a, b) => a.dist - b.dist);
    return results;
}

/**
 * Emit a [FAILURE_JSON] line with structured diagnostic info.
 */
export function emitFailureJson(opts: {
    error: string;
    x: number;
    z: number;
    level: number;
    ticksRun: number;
    lastState?: string;
    questVarp?: number;
    skills?: Record<string, number>;
}): void {
    const nearbyLocs = getNearbyLocs(opts.x, opts.z, opts.level, 5);

    const json = {
        error: opts.error,
        lastPosition: { x: opts.x, z: opts.z, level: opts.level },
        questVarp: opts.questVarp ?? null,
        skills: opts.skills ?? {},
        ticksRun: opts.ticksRun,
        lastState: opts.lastState ?? null,
        nearbyLocs
    };

    console.log(`[FAILURE_JSON] ${JSON.stringify(json)}`);
}

/**
 * Run the game tick loop with AFK detection, heartbeat output, and --timeout support.
 * Returns { timedOut, afk, ticksRun }.
 */
export async function runTickLoop(opts: TickLoopOptions): Promise<TickLoopResult> {
    const afkThreshold = opts.afkThreshold ?? 500;
    const settleTicks = opts.settleTicks ?? 5;

    const effectiveMaxTicks = opts.maxTicks;

    let lastX = 0;
    let lastZ = 0;
    let lastXp = 0;
    let idleTicks = 0;

    for (let tick = 0; tick < effectiveMaxTicks; tick++) {
        opts.world.cycle();
        await Promise.resolve();

        if (opts.isDone()) {
            for (let i = 0; i < settleTicks; i++) {
                opts.world.cycle();
                await Promise.resolve();
            }
            return { timedOut: false, afk: false, ticksRun: tick };
        }

        // Heartbeat every 1000 ticks
        if (tick > 0 && tick % 1000 === 0) {
            const state = opts.getState();
            const label = opts.getLabel?.() ?? 'unknown';
            const hp = opts.getHp?.() ?? { current: 0, max: 0 };
            console.log(`[HEARTBEAT] tick=${tick} pos=(${state.x},${state.z}) state=${label} hp=${hp.current}/${hp.max}`);
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

    return { timedOut: true, afk: false, ticksRun: effectiveMaxTicks };
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

