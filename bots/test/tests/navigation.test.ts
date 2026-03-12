import path from 'path';
import { runTickLoop, getTotalXp, getEffectiveMaxTicks, emitFailureJson } from '../util.ts';

const startTime = Date.now();

// Change cwd to engine/ so that engine-relative paths resolve
const engineDir = path.resolve(import.meta.dir, '..', '..', '..');
process.chdir(engineDir);

// Import engine modules (must happen after chdir so dotenv and workers resolve)
const { default: World } = await import('../../../src/engine/World.ts');
const { default: BotManager } = await import('../../runtime/manager.ts');
const { skipTutorial } = await import('../../scripts/skip-tutorial.ts');

console.log('Starting world for navigation smoke test...');
await World.start(false, false);

// Initialize nextTick so drift calculation works correctly
World.nextTick = Date.now() + 600;

console.log('World started. Spawning bot...');

let scriptDone = false;
let scriptError: Error | null = null;
let currentStep = 'init';

// Navigation waypoints in Lumbridge.
// Bot spawns at (3222, 3218) after skipTutorial.
// Phase 1: Open-air waypoints (outside the castle walls, west of x=3226).
// Phase 2: Walk through Lumbridge castle entrance door (auto-open required).
//   Castle entrance door (openbankdoor_l) is between x=3217 and x=3218.
//   Walking from spawn directly into the castle hall tests auto-door opening.
const WAYPOINTS = [
    { x: 3222, z: 3218, label: 'lumbridge-spawn' },
    { x: 3222, z: 3224, label: 'lumbridge-north' },
    { x: 3222, z: 3230, label: 'lumbridge-further-north' },
    { x: 3222, z: 3218, label: 'back-to-spawn' },
    // Phase 2: walk through Lumbridge castle entrance door (auto-open)
    // The castle door (openbankdoor_l) is at ~(3217,3218). Walking to (3215,3218)
    // from outside requires pathfinding through the door — auto-open should trigger.
    { x: 3215, z: 3218, label: 'lumbridge-castle-through-door' },
    // Walk back out through the same door
    { x: 3222, z: 3218, label: 'back-outside-castle' },
];

const api = BotManager.spawnBot('navbot0', async (bot) => {
    try {
        // Wait ticks for the bot to be logged in by processLogins
        await bot.waitForTick();
        await bot.waitForTick();

        await skipTutorial(bot);
        bot.log('STATE', `Starting navigation test at (${bot.player.x},${bot.player.z})`);

        for (const wp of WAYPOINTS) {
            currentStep = wp.label;
            bot.log('STATE', `Walking to ${wp.label} (${wp.x},${wp.z})`);
            await bot.walkToWithPathfinding(wp.x, wp.z);

            const pos = bot.getPosition();
            if (pos.x !== wp.x || pos.z !== wp.z) {
                throw new Error(`Navigation failed: expected (${wp.x},${wp.z}) but at (${pos.x},${pos.z}) during step '${wp.label}'`);
            }
            bot.log('STATE', `Arrived at ${wp.label} (${pos.x},${pos.z})`);
        }

        bot.log('SUCCESS', 'Navigation smoke test completed — all waypoints reached');
        scriptDone = true;
    } catch (err) {
        scriptError = err as Error;
        bot.log('ERROR', `Script error: ${(err as Error).message}`);
        scriptDone = true;
    }
});

// Run game ticks — navigation test should be fast (~10s)
const DEFAULT_TIMEOUT_TICKS = 3000;
const { timedOut, ticksRun } = await runTickLoop({
    maxTicks: getEffectiveMaxTicks(DEFAULT_TIMEOUT_TICKS),
    world: World,
    isDone: () => scriptDone,
    getState: () => ({ x: api.player.x, z: api.player.z, totalXp: getTotalXp(api.player) }),
    getLabel: () => currentStep,
    getHp: () => ({ current: api.player.levels[3]!, max: api.player.baseLevels[3]! }),
    getError: () => scriptError?.message ?? null,
    getSkills: () => ({ Attack: api.getSkill('Attack').level, Hitpoints: api.getSkill('Hitpoints').level }),
    afkThreshold: 500
});

const durationSeconds = Math.round((Date.now() - startTime) / 1000);

if (timedOut || !scriptDone) {
    const pos = api.getPosition();
    console.error(`TIMEOUT after ${durationSeconds}s (${ticksRun} ticks) at step '${currentStep}' - pos=(${pos.x},${pos.z},${pos.level})`);
    emitFailureJson({
        error: 'TIMEOUT',
        x: pos.x,
        z: pos.z,
        level: pos.level,
        ticksRun,
        lastState: currentStep
    });
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s step=${currentStep} error="TIMEOUT"`;
    console.log(resultLine);
    process.exit(1);
}

if (scriptError) {
    const pos = api.getPosition();
    console.error(`Navigation test failed at step '${currentStep}': ${scriptError.message}`);
    emitFailureJson({
        error: scriptError.message,
        x: pos.x,
        z: pos.z,
        level: pos.level,
        ticksRun,
        lastState: currentStep
    });
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s step=${currentStep} error="${scriptError.message}"`;
    console.log(resultLine);
    process.exit(1);
}

// Success!
console.log('');
console.log('=== Navigation Smoke Test Results ===');
console.log(`  All ${WAYPOINTS.length} waypoints reached successfully`);
console.log(`  Duration: ${durationSeconds}s (${ticksRun} ticks)`);
console.log('');

const resultLine = `[RESULT] status=PASS duration=${durationSeconds}s waypoints=${WAYPOINTS.length}`;
console.log(resultLine);

process.exit(0);
