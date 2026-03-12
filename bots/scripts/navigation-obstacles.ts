import path from 'path';
import { BotAPI } from '../runtime/api.js';
import { skipTutorial } from './skip-tutorial.js';
import { type BotState, runStateMachine, saveSnapshots, type StateSnapshot } from '../runtime/state-machine.js';
import type { ScriptMeta } from '../runtime/script-meta.js';
import { PlayerStatMap } from '../../src/engine/entity/PlayerStat.js';

/**
 * Navigation obstacle test script.
 *
 * Each child state tests walkToWithPathfinding through a specific obstacle
 * (doors, gates, fences). No manual openGate/openDoor calls — only
 * walkToWithPathfinding. The baseline (lumbridge-door) should pass since
 * single doors already work. Gated enclosures should fail, proving the
 * pathfinder can't route through gates.
 */

interface Scenario {
    name: string;
    start: { x: number; z: number };
    end: { x: number; z: number };
    /** Optional second destination for round-trip scenarios */
    returnTo?: { x: number; z: number };
}

const SCENARIOS: Scenario[] = [
    {
        // Baseline: walk through Lumbridge castle entrance door.
        // Single door auto-open already works in walkToWithPathfinding.
        name: 'lumbridge-door',
        start: { x: 3222, z: 3218 },
        end: { x: 3215, z: 3218 },
    },
    {
        // Chicken pen: fencing at x=3236 blocks east-west passage (z=3285-3301).
        // Gate at (3236,3295-3296). Start east of fence, end west — ghost pathfinder
        // must route south to the gate, open it, and continue west.
        name: 'chicken-pen',
        start: { x: 3237, z: 3300 },
        end: { x: 3235, z: 3300 },
    },
    {
        // Cow field: N-S fence at x=3253, z=3258-3272. Gate at z=3266-3267.
        // Crossing at z=3260 (south of gate) — no gate on the direct path.
        name: 'cow-field',
        start: { x: 3252, z: 3260 },
        end: { x: 3254, z: 3260 },
    },
    {
        // Wheat field: inner fences form enclosures. S fence at z=3291, x=3150-3155.
        // Crossing from south of fence (z=3290) to inside (z=3292) at x=3153
        // where fencing runs but no gate exists.
        name: 'wheat-field',
        start: { x: 3153, z: 3290 },
        end: { x: 3153, z: 3292 },
    },
    {
        // Sheep pen NW fence: x=3193, z=3286-3288. Straight fencing (shape=0), no gate.
        // Start west of fence (x=3192), end east of fence (x=3194).
        name: 'sheep-pen',
        start: { x: 3192, z: 3287 },
        end: { x: 3194, z: 3287 },
    },
    {
        // Fred's farm south fence: z=3277, x=3193-3200. No gate on this segment.
        // Start south of fence, end north — must detour via west gate.
        name: 'fred-house',
        start: { x: 3198, z: 3276 },
        end: { x: 3198, z: 3278 },
    },
    {
        // Round-trip through chicken pen gate — tests both directions.
        name: 'chicken-pen-roundtrip',
        start: { x: 3237, z: 3300 },
        end: { x: 3235, z: 3300 },
        returnTo: { x: 3237, z: 3300 },
    },
];

function buildScenarioState(scenario: Scenario): BotState {
    return {
        name: scenario.name,
        stuckThreshold: 500,
        maxRetries: 1,
        isComplete: () => false,
        run: async (bot: BotAPI) => {
            await skipTutorial(bot);
            await bot.waitForTicks(2);

            bot.log('STATE', `=== Scenario: ${scenario.name} ===`);
            bot.log('STATE', `Walking to start (${scenario.start.x},${scenario.start.z})`);
            await bot.walkToWithPathfinding(scenario.start.x, scenario.start.z);

            const posAfterStart = bot.getPosition();
            if (posAfterStart.x !== scenario.start.x || posAfterStart.z !== scenario.start.z) {
                throw new Error(
                    `Failed to reach start position: expected (${scenario.start.x},${scenario.start.z}) ` +
                    `but at (${posAfterStart.x},${posAfterStart.z})`
                );
            }

            bot.log('STATE', `At start. Walking to end (${scenario.end.x},${scenario.end.z})`);
            await bot.walkToWithPathfinding(scenario.end.x, scenario.end.z);

            const posAfterEnd = bot.getPosition();
            if (posAfterEnd.x !== scenario.end.x || posAfterEnd.z !== scenario.end.z) {
                throw new Error(
                    `Failed to reach end position: expected (${scenario.end.x},${scenario.end.z}) ` +
                    `but at (${posAfterEnd.x},${posAfterEnd.z})`
                );
            }

            if (scenario.returnTo) {
                bot.log('STATE', `At end. Walking back to (${scenario.returnTo.x},${scenario.returnTo.z})`);
                await bot.walkToWithPathfinding(scenario.returnTo.x, scenario.returnTo.z);

                const posAfterReturn = bot.getPosition();
                if (posAfterReturn.x !== scenario.returnTo.x || posAfterReturn.z !== scenario.returnTo.z) {
                    throw new Error(
                        `Failed to reach return position: expected (${scenario.returnTo.x},${scenario.returnTo.z}) ` +
                        `but at (${posAfterReturn.x},${posAfterReturn.z})`
                    );
                }
            }

            bot.log('STATE', `Scenario ${scenario.name} PASSED`);
        },
    };
}

export function buildNavObstacleStates(_bot: BotAPI): BotState {
    return {
        name: 'nav',
        isComplete: () => false,
        run: async () => { throw new Error('Composite state should not be called directly'); },
        children: SCENARIOS.map(buildScenarioState),
    };
}

/**
 * Capture a snapshot representing a fresh post-skipTutorial state.
 * All nav scenarios start from the same state, so one snapshot works for all.
 */
function freshSnapshot(): StateSnapshot {
    const skills: Record<string, number> = {};
    for (const [name] of PlayerStatMap) {
        skills[name] = 1;
    }
    // Hitpoints starts at 10
    skills['HITPOINTS'] = 10;

    return {
        position: { x: 3222, z: 3218, level: 0 },
        skills,
        varps: {},
        items: [], // bronze pickaxe is added by skipTutorial but not critical for nav
    };
}

async function navigationObstacles(bot: BotAPI): Promise<void> {
    await skipTutorial(bot);
    await bot.waitForTicks(2);

    bot.log('STATE', `Starting navigation obstacle tests at (${bot.player.x},${bot.player.z})`);

    const root = buildNavObstacleStates(bot);

    // Pre-create snapshots for all states so --state= works even if the full run
    // crashes on the first gated scenario. All states start from skipTutorial,
    // so they share the same snapshot.
    const snapshotDir = path.resolve(import.meta.dir, '..', 'test', 'snapshots');
    const snap = freshSnapshot();
    const snapshots: Record<string, StateSnapshot> = {};
    for (const scenario of SCENARIOS) {
        snapshots[`nav/${scenario.name}`] = snap;
    }
    saveSnapshots(snapshotDir, 'nav', snapshots);

    // Do NOT use captureSnapshots here — it would overwrite the pre-created
    // snapshot file with only the states actually entered, breaking --state=
    // for states that come after the first failure.
    await runStateMachine(bot, { root });
}

export const metadata: ScriptMeta = {
    name: 'navigation-obstacles',
    type: 'activity',
    maxTicks: 5000,
    run: navigationObstacles,
    buildStates: buildNavObstacleStates,
};
