import fs from 'fs';
import path from 'path';
import { BotAPI } from './api.js';
import { PlayerStatMap } from '../../src/engine/entity/PlayerStat.js';
import ObjType from '../../src/cache/config/ObjType.js';

/**
 * Ergonomic snapshot entry that scripters define inline on BotState.
 * Item names (not IDs), partial skill overrides (omitted = fresh account defaults).
 */
export interface StateEntry {
    /** Position to restore to. level defaults to 0 if omitted. */
    position?: { x: number; z: number; level?: number };
    /** Varp overrides — varp id -> value. Omitted varps default to 0. */
    varps?: Record<number, number>;
    /** Items in inventory. String = item name with count 1.
     *  Object = {name, count} for named items, or {id, name, count} when items
     *  share the same display name (e.g. "Map part" with IDs 1535/1536/1537). */
    items?: Array<string | { name: string; count: number; id?: number }>;
    /** Skill overrides — only include skills that differ from fresh account defaults.
     *  Fresh account: all skills level 1, HITPOINTS level 10. */
    skills?: Partial<Record<string, number>>;
}

/**
 * A single state in a hierarchical state machine.
 *
 * - **Leaf states** have `run()` with the actual logic.
 * - **Composite states** have `children` and delegate to them in order.
 *   A composite state must NOT have its own `run()`.
 */
export interface BotState {
    /** Hierarchical name like "earn-coins" or "enter-palace" */
    name: string;
    /** Optional sub-states — if present, this is a composite state */
    children?: BotState[];
    /** Ergonomic inline snapshot for single-state testing. Resolved to StateSnapshot at runtime. */
    entrySnapshot?: StateEntry;
    /** Check if this state is already complete (for resume) */
    isComplete: () => boolean;
    /** Execute this state's logic */
    run: (bot: BotAPI) => Promise<void>;
    /** Max retries on failure (default 3) */
    maxRetries?: number;
    /** Ticks without any activity (including movement) before stuck (default 1000) */
    stuckThreshold?: number;
    /** Ticks without real progress (XP/inventory/varp change) before stuck.
     *  Movement alone does not count. Defaults to stuckThreshold * 3.
     *  Set explicitly for states where position changes mask lack of real progress. */
    progressThreshold?: number;
}

export interface StateSnapshot {
    position: { x: number; z: number; level: number };
    skills: Record<string, number>; // skill name -> base level
    varps: Record<number, number>;  // varp id -> value
    items: Array<{ id: number; name: string; count: number }>; // items in inventory
}

/**
 * Find an ObjType by its display name (case-insensitive).
 * When multiple items share the same display name (e.g. "Coins" vs "fake_coins"),
 * prefers stackable items over non-stackable ones since the canonical game item
 * (coins, runes, arrows) is almost always the stackable version.
 * Throws if not found.
 */
function resolveObjByDisplayName(displayName: string): ObjType {
    const lower = displayName.toLowerCase();
    let firstMatch: ObjType | null = null;
    for (let id = 0; id < ObjType.count; id++) {
        const obj = ObjType.get(id);
        if (obj && obj.name?.toLowerCase() === lower) {
            if (obj.stackable) {
                return obj; // Prefer stackable match immediately
            }
            if (!firstMatch) {
                firstMatch = obj;
            }
        }
    }
    if (firstMatch) {
        return firstMatch;
    }
    throw new Error(`resolveStateEntry: unknown item display name "${displayName}" — not found in ObjType`);
}

/**
 * Resolve a StateEntry (ergonomic scripter format) into a StateSnapshot
 * (full format compatible with restoreFromSnapshot).
 *
 * - Resolves item display names to IDs (throws if not found — no fallback).
 * - Fills missing skills with fresh-account defaults (level 1, HITPOINTS 10).
 * - Defaults position.level to 0 if omitted.
 */
export function resolveStateEntry(entry: StateEntry): StateSnapshot {
    // Position — default level to 0
    const position = entry.position
        ? { x: entry.position.x, z: entry.position.z, level: entry.position.level ?? 0 }
        : { x: 3222, z: 3218, level: 0 }; // Lumbridge default

    // Skills — fresh account defaults, then apply overrides
    const skills: Record<string, number> = {};
    for (const [name] of PlayerStatMap) {
        skills[name] = name === 'HITPOINTS' ? 10 : 1;
    }
    if (entry.skills) {
        for (const [name, level] of Object.entries(entry.skills)) {
            if (!PlayerStatMap.has(name)) {
                throw new Error(`resolveStateEntry: unknown skill "${name}"`);
            }
            skills[name] = level;
        }
    }

    // Varps
    const varps: Record<number, number> = entry.varps ?? {};

    // Items — resolve display names to IDs (or use explicit id if provided)
    const items: Array<{ id: number; name: string; count: number }> = [];
    if (entry.items) {
        for (const item of entry.items) {
            const name = typeof item === 'string' ? item : item.name;
            const count = typeof item === 'string' ? 1 : item.count;
            const explicitId = typeof item === 'object' && 'id' in item ? item.id : undefined;
            if (explicitId !== undefined) {
                // Use explicit ID — for items that share display names (e.g. Map part 1/2/3)
                const obj = ObjType.get(explicitId);
                if (!obj) {
                    throw new Error(`resolveStateEntry: invalid explicit item id ${explicitId}`);
                }
                items.push({ id: explicitId, name: obj.name ?? name, count });
            } else {
                const obj = resolveObjByDisplayName(name);
                items.push({ id: obj.id, name: obj.name ?? name, count });
            }
        }
    }

    return { position, skills, varps, items };
}

/**
 * Compute a simple hash of inventory contents for progress comparison.
 */
function inventoryHash(bot: BotAPI): string {
    return bot.getInventory().map(i => `${i.id}:${i.count}`).join(',');
}

/**
 * Compute total XP across all skills.
 */
function totalXp(bot: BotAPI): number {
    let total = 0;
    for (const [name] of PlayerStatMap) {
        total += bot.getSkill(name).exp;
    }
    return total;
}

/**
 * Progress baseline for stuck detection.
 */
interface ProgressBaseline {
    x: number;
    z: number;
    totalXp: number;
    invHash: string;
    varpValues: number[];
}

/**
 * Capture a progress baseline for stuck detection.
 */
function captureBaseline(bot: BotAPI, varpIds: number[]): ProgressBaseline {
    const pos = bot.getPosition();
    return {
        x: pos.x,
        z: pos.z,
        totalXp: totalXp(bot),
        invHash: inventoryHash(bot),
        varpValues: varpIds.map(id => bot.getVarp(id)),
    };
}

/**
 * Check whether game state has actually changed (XP, inventory, varps).
 * This is "real progress" — the bot accomplished something meaningful.
 */
function hasRealProgress(bot: BotAPI, baseline: ProgressBaseline, varpIds: number[]): boolean {
    if (totalXp(bot) !== baseline.totalXp) return true;
    if (inventoryHash(bot) !== baseline.invHash) return true;
    for (let i = 0; i < varpIds.length; i++) {
        if (bot.getVarp(varpIds[i]!) !== baseline.varpValues[i]) return true;
    }
    return false;
}

/**
 * Check whether the bot has any activity (including movement).
 * A bot walking around is "active" even if game state hasn't changed.
 */
function hasActivity(bot: BotAPI, baseline: ProgressBaseline, varpIds: number[]): boolean {
    if (hasRealProgress(bot, baseline, varpIds)) return true;
    const pos = bot.getPosition();
    const manhattan = Math.abs(pos.x - baseline.x) + Math.abs(pos.z - baseline.z);
    return manhattan > 3;
}

const DEFAULT_PROGRESS_CHECK_INTERVAL = 200; // check every N ticks

/**
 * Run a state's `run()` with stuck detection.
 * Patches the controller's onTick and waitForTick to check for progress periodically.
 * If no progress is detected for `stuckThreshold` ticks, rejects the pending waitForTick
 * promise with a [STUCK] error.
 *
 * The key constraint is microtask ordering: the runner calls World.cycle() then
 * await Promise.resolve(). The bot must fully process its tick AND set up the next
 * waitForTick resolver within a single microtask level. Any extra Promise wrapping
 * (via .then() or async) would cause the runner to advance before the bot is ready,
 * doubling the effective tick count. To avoid this, we:
 *   1. Patch controller.onTick to do progress checks (synchronous, no extra microtask)
 *   2. Patch controller.waitForTick to store a reject function alongside resolve
 *   3. When stuck, onTick calls reject instead of resolve — the rejection propagates
 *      at the same microtask level as a normal resolution
 */
async function runWithStuckDetection(
    bot: BotAPI,
    state: BotState,
    statePath: string,
    varpIds: number[]
): Promise<void> {
    // Tier 1: "activity" — any change including movement. Short timeout.
    const activityThreshold = state.stuckThreshold ?? 1000;
    // Tier 2: "progress" — XP/inventory/varp must change. Movement alone doesn't count.
    // Catches bots that walk around but never accomplish anything (e.g. player.delayed loop).
    const progressThreshold = state.progressThreshold ?? activityThreshold * 3;

    const checkInterval = Math.min(DEFAULT_PROGRESS_CHECK_INTERVAL, Math.max(1, Math.floor(activityThreshold / 3)));
    let activityBaseline = captureBaseline(bot, varpIds);
    let progressBaseline = captureBaseline(bot, varpIds);
    let ticksSinceActivity = 0;
    let ticksSinceRealProgress = 0;

    const controller = bot.controller;

    let pendingReject: ((err: Error) => void) | null = null;

    const originalControllerWaitForTick = controller.waitForTick.bind(controller);
    controller.waitForTick = () => {
        return new Promise<void>((resolve, reject) => {
            (controller as any).tickResolver = resolve;
            pendingReject = reject;
        });
    };

    const originalOnTick = controller.onTick.bind(controller);
    controller.onTick = () => {
        bot.player.lastConnected = bot.getCurrentTick();
        bot.player.lastResponse = bot.getCurrentTick();
        bot.player.afkEventReady = false;

        ticksSinceActivity++;
        ticksSinceRealProgress++;

        if (ticksSinceActivity % checkInterval === 0 || ticksSinceRealProgress % checkInterval === 0) {
            // Check real progress (XP/inventory/varp — no position)
            if (hasRealProgress(bot, progressBaseline, varpIds)) {
                progressBaseline = captureBaseline(bot, varpIds);
                ticksSinceRealProgress = 0;
                // Real progress also counts as activity
                activityBaseline = captureBaseline(bot, varpIds);
                ticksSinceActivity = 0;
            }
            // Check activity (includes position changes)
            else if (hasActivity(bot, activityBaseline, varpIds)) {
                activityBaseline = captureBaseline(bot, varpIds);
                ticksSinceActivity = 0;
                // Activity does NOT reset the real progress timer
            }

            // Tier 1: no activity at all (completely idle)
            if (ticksSinceActivity >= activityThreshold) {
                const pos = bot.getPosition();
                const msg = `[STUCK] State "${statePath}" had no activity for ${ticksSinceActivity} ticks. ` +
                    `pos=(${pos.x},${pos.z}), totalXp=${totalXp(bot)}, invHash=${inventoryHash(bot)}`;
                bot.log('ERROR', msg);
                if (pendingReject) {
                    const reject = pendingReject;
                    pendingReject = null;
                    (controller as any).tickResolver = null;
                    reject(new Error(msg));
                    return;
                }
            }

            // Tier 2: moving around but no real progress
            if (ticksSinceRealProgress >= progressThreshold) {
                const pos = bot.getPosition();
                const msg = `[STUCK] State "${statePath}" had no real progress for ${ticksSinceRealProgress} ticks ` +
                    '(position changed but XP/inventory/varps did not). ' +
                    `pos=(${pos.x},${pos.z}), totalXp=${totalXp(bot)}, invHash=${inventoryHash(bot)}`;
                bot.log('ERROR', msg);
                if (pendingReject) {
                    const reject = pendingReject;
                    pendingReject = null;
                    (controller as any).tickResolver = null;
                    reject(new Error(msg));
                    return;
                }
            }
        }

        // Normal tick — resolve the pending waitForTick promise
        const resolver = (controller as any).tickResolver;
        if (resolver) {
            (controller as any).tickResolver = null;
            resolver();
        }
    };

    try {
        await state.run(bot);
    } finally {
        controller.onTick = originalOnTick;
        controller.waitForTick = originalControllerWaitForTick;
    }
}


export interface StateMachineOptions {
    /** The top-level state (typically a composite with children) */
    root: BotState;
    /** Varp IDs to track for stuck detection */
    varpIds?: number[];
    /** Start execution from this state path (e.g. "sheep-shearer/shear-sheep") */
    startFromState?: string;
}

/**
 * Run a hierarchical state machine depth-first.
 *
 * - Walks the state tree depth-first
 * - Skips states where isComplete() returns true
 * - On failure: checks death (waitForRespawn), checks isComplete (might have succeeded), retries up to maxRetries
 * - Logs state transitions: [STATE] Entering: root/child
 * - Supports runFromState to start execution from a specific named state
 */
export async function runStateMachine(bot: BotAPI, options: StateMachineOptions): Promise<void> {
    const { root, varpIds = [], startFromState } = options;

    let started = !startFromState; // if no startFromState, start immediately

    async function executeState(state: BotState, parentPath: string): Promise<void> {
        const statePath = parentPath ? `${parentPath}/${state.name}` : state.name;

        // If we haven't reached the startFromState yet, check if this is it
        if (!started) {
            if (statePath === startFromState) {
                started = true;
            } else if (state.children) {
                // Check children recursively — the target might be nested
                for (const child of state.children) {
                    await executeState(child, statePath);
                    if (started) {
                        // We found and started from the target — continue with remaining children
                        // but the found child already ran, so skip it in the loop below
                    }
                }
                return;
            } else {
                // Leaf state that isn't the target — skip
                return;
            }
        }

        // Skip completed states
        if (state.isComplete()) {
            bot.log('STATE', `[STATE] Skipping (complete): ${statePath}`);
            return;
        }

        bot.log('STATE', `[STATE] Entering: ${statePath}`);
        bot.currentStatePath = statePath;

        // Composite state: delegate to children in order
        if (state.children) {
            for (const child of state.children) {
                await executeState(child, statePath);
            }
            return;
        }

        // Leaf state: execute with retry logic and stuck detection
        const maxRetries = state.maxRetries ?? 3;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                await runWithStuckDetection(bot, state, statePath, varpIds);
                bot.log('STATE', `[STATE] Completed: ${statePath}`);
                return;
            } catch (err) {
                const msg = (err as Error).message;
                bot.log('ERROR', `[STATE] ${statePath} failed (attempt ${attempt}/${maxRetries}): ${msg}`);

                // Death recovery
                if (bot.isDead()) {
                    bot.log('STATE', `[STATE] Death during ${statePath}, recovering...`);
                    await bot.waitForRespawn();
                }

                // Maybe the state completed despite the error
                if (state.isComplete()) {
                    bot.log('STATE', `[STATE] ${statePath} completed despite error`);
                    return;
                }

                if (attempt === maxRetries) {
                    throw new Error(`${statePath} failed after ${maxRetries} attempts: ${msg}`);
                }

                // Clear any stuck pending state before retrying
                await bot.clearPendingState();

                bot.log('STATE', `[STATE] Retrying ${statePath} (attempt ${attempt + 1}/${maxRetries})...`);
                await bot.waitForTicks(5);
            }
        }
    }

    await executeState(root, '');
}

/**
 * Snapshot file format — one per test, saved to engine/bots/test/snapshots/.
 * Legacy: used for JSON snapshot files. New scripts should use inline entrySnapshot instead.
 */
export interface SnapshotFile {
    test: string;
    states: Array<{ path: string; snapshot: StateSnapshot }>;
}

/**
 * Serialize snapshots to a JSON file.
 * @deprecated Legacy — used by scripts that pre-create JSON snapshot files (e.g. navigation-obstacles).
 * New scripts should use inline entrySnapshot on BotState instead.
 */
export function saveSnapshots(dir: string, testName: string, snapshots: Record<string, StateSnapshot>): void {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const data: SnapshotFile = {
        test: testName,
        states: Object.entries(snapshots).map(([p, snapshot]) => ({ path: p, snapshot }))
    };
    const filePath = path.join(dir, `${testName}.json`);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/**
 * Restore a bot to a specific state's snapshot and run only that state.
 *
 * Snapshot resolution order:
 * 1. Inline entrySnapshot on the BotState (resolved via resolveStateEntry)
 * 2. JSON snapshot file (legacy — loaded from bots/test/snapshots/{root}.json)
 *    Logs a deprecation warning encouraging migration to inline entrySnapshot.
 *
 * @param statePath The hierarchical state path, e.g. "sheep-shearer/deliver-wool"
 * @param bot The bot API to restore and run on
 * @param root The full state tree (needed to find the target state's run/isComplete)
 */
export async function loadAndRunFromState(
    statePath: string,
    bot: BotAPI,
    root: BotState,
    varpIds: number[] = []
): Promise<void> {
    // Find the target state node in the tree
    const targetState = findStateByPath(root, statePath);
    if (!targetState) {
        throw new Error(`State "${statePath}" not found in state tree`);
    }

    let snapshot: StateSnapshot;

    // 1. Check for inline entrySnapshot on the BotState
    if (targetState.entrySnapshot) {
        bot.log('STATE', `[STATE] Resolving inline entrySnapshot for "${statePath}"`);
        snapshot = resolveStateEntry(targetState.entrySnapshot);
    }
    // 2. Legacy fallback: JSON snapshot file
    else {
        const snapshotFilePath = path.resolve(import.meta.dir, '..', 'test', 'snapshots', `${root.name}.json`);
        if (!fs.existsSync(snapshotFilePath)) {
            throw new Error(`State "${statePath}" has no inline entrySnapshot and no legacy snapshot file at ${snapshotFilePath}. Add an entrySnapshot to the BotState definition.`);
        }

        const raw = fs.readFileSync(snapshotFilePath, 'utf-8');
        const data: SnapshotFile = JSON.parse(raw);

        const entry = data.states.find(s => s.path === statePath);
        if (!entry) {
            const available = data.states.map(s => s.path).join(', ');
            throw new Error(`State "${statePath}" not found in legacy snapshot file. Available states: ${available}`);
        }
        snapshot = entry.snapshot;
        bot.log('STATE', `[DEPRECATION] State "${statePath}" is using a legacy JSON snapshot. Migrate to inline entrySnapshot on the BotState definition.`);
    }

    bot.log('STATE', `[STATE] Restoring snapshot for "${statePath}"`);
    bot.restoreFromSnapshot(snapshot);
    await bot.waitForTicks(2); // Let the engine process teleport/state changes

    // Run only the target state (with normal retry logic)
    bot.log('STATE', `[STATE] Running single state: ${statePath}`);
    await runSingleState(bot, targetState, statePath, varpIds);
}

/**
 * Find a BotState node by its full hierarchical path (e.g. "sheep-shearer/deliver-wool").
 */
function findStateByPath(root: BotState, targetPath: string): BotState | null {
    function search(state: BotState, parentPath: string): BotState | null {
        const currentPath = parentPath ? `${parentPath}/${state.name}` : state.name;
        if (currentPath === targetPath) {
            return state;
        }
        if (state.children) {
            for (const child of state.children) {
                const found = search(child, currentPath);
                if (found) return found;
            }
        }
        return null;
    }
    return search(root, '');
}

/**
 * Run a single state (leaf or composite) with retry logic.
 * Used by loadAndRunFromState for single-state testing.
 */
async function runSingleState(bot: BotAPI, state: BotState, statePath: string, varpIds: number[]): Promise<void> {
    // Composite state: run children in order
    if (state.children) {
        for (const child of state.children) {
            const childPath = `${statePath}/${child.name}`;
            if (child.isComplete()) {
                bot.log('STATE', `[STATE] Skipping (complete): ${childPath}`);
                continue;
            }
            bot.log('STATE', `[STATE] Entering: ${childPath}`);
            await runSingleState(bot, child, childPath, varpIds);
        }
        return;
    }

    // Leaf state: execute with retry logic and stuck detection
    const maxRetries = state.maxRetries ?? 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            await runWithStuckDetection(bot, state, statePath, varpIds);
            bot.log('STATE', `[STATE] Completed: ${statePath}`);
            return;
        } catch (err) {
            const msg = (err as Error).message;
            bot.log('ERROR', `[STATE] ${statePath} failed (attempt ${attempt}/${maxRetries}): ${msg}`);

            if (bot.isDead()) {
                bot.log('STATE', `[STATE] Death during ${statePath}, recovering...`);
                await bot.waitForRespawn();
            }

            if (state.isComplete()) {
                bot.log('STATE', `[STATE] ${statePath} completed despite error`);
                return;
            }

            if (attempt === maxRetries) {
                throw new Error(`${statePath} failed after ${maxRetries} attempts: ${msg}`);
            }

            // Clear any stuck pending state before retrying
            await bot.clearPendingState();

            bot.log('STATE', `[STATE] Retrying ${statePath} (attempt ${attempt + 1}/${maxRetries})...`);
            await bot.waitForTicks(5);
        }
    }
}
