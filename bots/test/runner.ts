import fs from 'fs';
import path from 'path';
import { dlopen, FFIType } from 'bun:ffi';
import type { ScriptMeta } from '../runtime/script-meta.ts';

// The test runner starts the server in-process, spawns a bot, and validates assertions.

// --- flock-based slot system: prevent too many concurrent tests (each uses ~6GB RAM) ---
const MAX_TEST_SLOTS = 6;

const libc = dlopen('libc.so.6', {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});
const LOCK_EX = 2;
const LOCK_NB = 4;

function acquireTestSlot(): number {
    for (let i = 0; i < MAX_TEST_SLOTS; i++) {
        const lockPath = `/tmp/bot-test-slot-${i}.lock`;
        const fd = fs.openSync(lockPath, 'w');
        const result = libc.symbols.flock(fd, LOCK_EX | LOCK_NB);
        if (result === 0) {
            console.log(`[SLOT] Acquired test slot ${i}/${MAX_TEST_SLOTS}`);
            return i;
        }
        fs.closeSync(fd);
    }
    throw new Error(`All ${MAX_TEST_SLOTS} test slots in use (~${MAX_TEST_SLOTS * 3}GB RAM). Wait for a test to finish.`);
}

const _testSlot = acquireTestSlot();

// Skip worker threads in test mode — saves ~1-2GB RAM per test
process.env.BOT_TEST_MODE = 'true';

const testName = process.argv[2];
if (!testName) {
    console.error('Usage: bun engine/bots/test/runner.ts <test-name> [--timeout=<seconds>] [--state="quest/state"]');
    console.error('Available tests: foundation, thieving, mining, quest, princeali, f2pskills, botcommand, autostart, live, blackknightsfortress, navigation, + any script with metadata');
    process.exit(1);
}

// Parse --timeout=<seconds> and --state= flags from remaining args
let timeoutTicks: number | null = null;
let stateFlag: string | null = null;
for (const arg of process.argv.slice(3)) {
    const timeoutMatch = arg.match(/^--timeout=(\d+)$/);
    if (timeoutMatch) {
        const seconds = parseInt(timeoutMatch[1]!, 10);
        timeoutTicks = Math.ceil(seconds * 1000 / 600);
    }
    const stateMatch = arg.match(/^--state=(.+)$/);
    if (stateMatch) {
        stateFlag = stateMatch[1]!;
    }
}
// Store on globalThis so test files and util.ts can access it
(globalThis as any).__testTimeoutTicks = timeoutTicks;
// Store state flag on globalThis so test files can access it
(globalThis as any).__testStateFlag = stateFlag;

// --- Special tests that need custom setup (hardcoded test files) ---
const hardcodedTests: Record<string, string> = {
    foundation: 'SPECIAL', // handled by runFoundationTest()
    thieving: './tests/thieving.test.ts',
    mining: './tests/mining.test.ts',
    quest: './tests/quest.test.ts',
    princeali: './tests/princealirrescue.test.ts',
    f2pskills: './tests/f2pskills.test.ts',
    botcommand: './tests/botcommand.test.ts',
    autostart: './tests/autostart.test.ts',
    live: './tests/live.test.ts',
    blackknightsfortress: './tests/blackknightsfortress.test.ts',
    navigation: './tests/navigation.test.ts',
};

// If --state= is provided, run the single-state runner instead of the normal test
if (stateFlag) {
    await runSingleStateTest(testName, stateFlag);
} else if (testName === 'foundation') {
    await runFoundationTest();
} else if (hardcodedTests[testName] && hardcodedTests[testName] !== 'SPECIAL') {
    await import(hardcodedTests[testName]!);
} else {
    // Auto-discovery: try to run as a metadata-based test.
    // Script imports must happen after chdir, so runMetadataTest handles discovery internally.
    await runMetadataTest(testName);
}

/**
 * Find a ScriptMeta by name from the scripts directory.
 */
async function findScriptMeta(name: string): Promise<ScriptMeta | null> {
    const scriptsDir = path.resolve(import.meta.dir, '..', 'scripts');
    const scriptFiles = fs.readdirSync(scriptsDir).filter(f => f.endsWith('.ts'));
    for (const file of scriptFiles) {
        const modulePath = path.join(scriptsDir, file);
        const mod = await import(modulePath);
        if (mod.metadata && typeof mod.metadata === 'object' && mod.metadata.name === name) {
            return mod.metadata as ScriptMeta;
        }
    }
    return null;
}

/**
 * Run a test using ScriptMeta — generic harness that works for any metadata-equipped script.
 * Mirrors the logic of the persistent test server.
 * Discovery must happen after chdir so engine module imports resolve correctly.
 */
async function runMetadataTest(testName: string): Promise<void> {
    const startTime = Date.now();

    // Change cwd to engine/ so that engine-relative paths resolve
    const engineDir = path.resolve(import.meta.dir, '..', '..');
    process.chdir(engineDir);

    // Import engine modules FIRST (must happen before script imports to avoid
    // circular dependency issues with engine entity classes)
    const { default: World } = await import('../../src/engine/World.ts');
    const { default: BotManager } = await import('../runtime/manager.ts');

    // Now it's safe to import scripts (engine modules already initialized)
    const meta = await findScriptMeta(testName);
    if (!meta) {
        // Collect all available test names for the error message
        const scriptsDir = path.resolve(import.meta.dir, '..', 'scripts');
        const scriptFiles = fs.readdirSync(scriptsDir).filter(f => f.endsWith('.ts'));
        const metaNames: string[] = [];
        for (const file of scriptFiles) {
            const modulePath = path.join(scriptsDir, file);
            const mod = await import(modulePath);
            if (mod.metadata && typeof mod.metadata === 'object' && typeof mod.metadata.name === 'string') {
                metaNames.push(mod.metadata.name);
            }
        }
        const allTests = [...Object.keys(hardcodedTests), ...metaNames].sort();
        throw new Error(`Unknown test: "${testName}". Available: ${allTests.join(', ')}`);
    }

    console.log(`Starting world for ${meta.name} test...`);
    await World.start(false, false);
    World.nextTick = Date.now() + 600;

    console.log('World started. Spawning bot...');

    let scriptDone = false;
    let scriptError: Error | null = null;

    const botName = `metabot_${meta.name}`;
    const api = BotManager.spawnBot(botName, async (bot) => {
        try {
            await bot.waitForTick();
            await bot.waitForTick();
            await meta.run(bot);
            scriptDone = true;
        } catch (err) {
            scriptError = err as Error;
            bot.log('ERROR', `Script error: ${(err as Error).message}`);
            scriptDone = true;
        }
    });

    const DEFAULT_TIMEOUT_TICKS = meta.maxTicks;
    const maxTicks = timeoutTicks != null ? timeoutTicks : DEFAULT_TIMEOUT_TICKS;

    for (let tick = 0; tick < maxTicks; tick++) {
        World.cycle();
        await Promise.resolve();

        if (scriptDone) {
            for (let i = 0; i < 5; i++) {
                World.cycle();
                await Promise.resolve();
            }
            break;
        }

        if (tick > 0 && tick % 1000 === 0) {
            const pos = api.getPosition();
            console.log(`[HEARTBEAT] ${meta.name} tick=${tick} pos=(${pos.x},${pos.z})`);
        }
    }

    const durationSeconds = Math.round((Date.now() - startTime) / 1000);

    if (!scriptDone) {
        const pos = api.getPosition();
        const varpInfo = meta.varpId !== undefined ? ` quest_varp=${api.getQuestProgress(meta.varpId)}` : '';
        console.error(`TIMEOUT after ${durationSeconds}s - pos=(${pos.x},${pos.z},${pos.level})${varpInfo}`);
        console.log(`[RESULT] status=FAIL duration=${durationSeconds}s${varpInfo} error="TIMEOUT"`);
        process.exit(1);
    }

    if (scriptError) {
        console.error(`Bot script error: ${scriptError.message}`);
        console.error(scriptError.stack);
        // Print last 30 log lines
        const logPath = path.resolve(import.meta.dir, '..', 'logs', `${botName}.log`);
        if (fs.existsSync(logPath)) {
            const lines = fs.readFileSync(logPath, 'utf-8').split('\n');
            const last30 = lines.slice(-31).join('\n');
            console.error('\nLast 30 log lines:');
            console.error(last30);
        }
        const varpInfo = meta.varpId !== undefined ? ` quest_varp=${api.getQuestProgress(meta.varpId)}` : '';
        console.log(`[RESULT] status=FAIL duration=${durationSeconds}s${varpInfo} error="${scriptError.message}"`);
        process.exit(1);
    }

    // Validate quest completion if applicable
    if (meta.varpId !== undefined && meta.varpComplete !== undefined) {
        const questVarp = api.getQuestProgress(meta.varpId);
        if (questVarp !== meta.varpComplete) {
            console.error(`INCOMPLETE: quest varp is ${questVarp}, expected ${meta.varpComplete}`);
            console.log(`[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} error="INCOMPLETE: quest varp is ${questVarp}, expected ${meta.varpComplete}"`);
            process.exit(1);
        }

        if (meta.extraAssertions) {
            for (const a of meta.extraAssertions(api)) {
                if (!a.pass) {
                    console.error(`Assertion failed: ${a.name}`);
                    console.log(`[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} error="Assertion failed: ${a.name}"`);
                    process.exit(1);
                }
            }
        }

        console.log('');
        console.log(`=== ${meta.name} Test Results ===`);
        console.log(`  Quest varp: ${questVarp} (complete)`);
        console.log(`  Duration: ${durationSeconds}s`);
        console.log('');
        console.log(`[RESULT] status=PASS duration=${durationSeconds}s quest_varp=${questVarp}`);
    } else {
        console.log('');
        console.log(`=== ${meta.name} Test Results ===`);
        console.log(`  Duration: ${durationSeconds}s`);
        console.log('');
        console.log(`[RESULT] status=PASS duration=${durationSeconds}s`);
    }

    process.exit(0);
}

async function runFoundationTest(): Promise<void> {
    const startTime = Date.now();

    // Change cwd to engine/ so that engine-relative paths resolve
    const engineDir = path.resolve(import.meta.dir, '..', '..');
    process.chdir(engineDir);

    // Import engine modules (must happen after chdir so dotenv and workers resolve)
    const { default: World } = await import('../../src/engine/World.ts');
    const { default: BotManager } = await import('../runtime/manager.ts');
    const { skipTutorial } = await import('../scripts/skip-tutorial.ts');

    console.log('Starting world for foundation test...');
    await World.start(false, false);

    // Initialize nextTick so drift calculation works correctly
    World.nextTick = Date.now() + 600;

    console.log('World started. Spawning bot...');

    let scriptDone = false;
    let scriptError: Error | null = null;

    const api = BotManager.spawnBot('testbot0', async (bot) => {
        try {
            // Wait ticks for the bot to be logged in by processLogins
            await bot.waitForTick();
            await bot.waitForTick();

            // Skip tutorial
            await skipTutorial(bot);

            bot.log('STATE', `pos=(${bot.getPosition().x},${bot.getPosition().z}) slot=${bot.player.slot}`);
            bot.log('SUCCESS', 'Foundation script completed');
            scriptDone = true;
        } catch (err) {
            scriptError = err as Error;
            bot.log('ERROR', `Script error: ${(err as Error).message}`);
            scriptDone = true;
        }
    });

    // Run game ticks until script completes or timeout.
    // We must yield to the microtask queue between cycles so that
    // resolved bot promises (from processBotInput) actually execute.
    const TIMEOUT_TICKS = 100;
    for (let tick = 0; tick < TIMEOUT_TICKS; tick++) {
        World.cycle();

        // Yield to microtask queue so bot async scripts can advance
        await Promise.resolve();

        if (scriptDone) {
            // Run a few more ticks to let things settle
            for (let i = 0; i < 3; i++) {
                World.cycle();
                await Promise.resolve();
            }
            break;
        }
    }

    if (scriptError) {
        console.error(`Bot script error: ${scriptError.message}`);
        console.error(scriptError.stack);
    }

    // Run assertions
    const assertions: { name: string; pass: boolean }[] = [];

    // 1. Position check
    const pos = api.getPosition();
    assertions.push({
        name: `bot.getPosition() returns {x:3222, z:3218, level:0} (got {x:${pos.x}, z:${pos.z}, level:${pos.level}})`,
        pass: pos.x === 3222 && pos.z === 3218 && pos.level === 0
    });

    // 2. Skill check
    const attack = api.getSkill('Attack');
    assertions.push({
        name: `bot.getSkill('Attack').level === 1 (got ${attack.level})`,
        pass: attack.level === 1
    });

    // 3. Inventory check
    const pickaxe = api.findItem('Bronze pickaxe');
    assertions.push({
        name: `bot.findItem('Bronze pickaxe') !== null (got ${pickaxe ? pickaxe.name : 'null'})`,
        pass: pickaxe !== null
    });

    // 4. Slot check
    assertions.push({
        name: `bot.player.slot >= 1 (got ${api.player.slot})`,
        pass: api.player.slot >= 1
    });

    // 5. Log file check
    const logPath = path.resolve(import.meta.dir, '..', 'logs', 'testbot0.log');
    const logExists = fs.existsSync(logPath) && fs.statSync(logPath).size > 0;
    assertions.push({
        name: `Log file bots/logs/testbot0.log exists and is non-empty (exists=${fs.existsSync(logPath)}, size=${fs.existsSync(logPath) ? fs.statSync(logPath).size : 0})`,
        pass: logExists
    });

    // Report results
    const passed = assertions.filter(a => a.pass).length;
    const total = assertions.length;
    const allPassed = passed === total;
    const durationSeconds = Math.round((Date.now() - startTime) / 1000);

    const firstFailed = assertions.find(a => !a.pass);

    // Write RESULT line to log
    const logger = api.logger;
    logger.result(
        allPassed ? 'PASS' : 'FAIL',
        durationSeconds,
        passed,
        total,
        firstFailed?.name
    );

    // Print results to stdout
    console.log('');
    console.log('=== Foundation Test Results ===');
    for (const a of assertions) {
        console.log(`  ${a.pass ? 'PASS' : 'FAIL'}: ${a.name}`);
    }
    console.log('');

    const resultLine = `[RESULT] status=${allPassed ? 'PASS' : 'FAIL'} duration=${durationSeconds}s assertions_passed=${passed}/${total}${firstFailed ? ` failed="${firstFailed.name}"` : ''}`;
    console.log(resultLine);

    if (!allPassed && firstFailed) {
        console.log(`\nFirst failing assertion: ${firstFailed.name}`);
    }

    process.exit(allPassed ? 0 : 1);
}

/**
 * Run a single state from a snapshot file.
 * Usage: bun engine/bots/test/runner.ts sheepshearer --state="sheep-shearer/deliver-wool"
 *
 * Spawns a bot, restores from snapshot, runs only the target state, validates isComplete().
 */
async function runSingleStateTest(testName: string, statePath: string): Promise<void> {
    const startTime = Date.now();

    // Change cwd to engine/ so that engine-relative paths resolve
    const engineDir = path.resolve(import.meta.dir, '..', '..');
    process.chdir(engineDir);

    // Snapshot file lives in engine/bots/test/snapshots/<testname>.json
    // The snapshot file uses the root state name (e.g. "sheep-shearer") not the test name
    const rootName = statePath.split('/')[0]!;
    const snapshotDir = path.resolve(import.meta.dir, 'snapshots');
    const snapshotFilePath = path.join(snapshotDir, `${rootName}.json`);

    if (!fs.existsSync(snapshotFilePath)) {
        console.error(`No snapshot file found at ${snapshotFilePath}. Run a full E2E first.`);
        process.exit(1);
    }

    // Import engine modules
    const { default: World } = await import('../../src/engine/World.ts');
    const { default: BotManager } = await import('../runtime/manager.ts');
    const { skipTutorial } = await import('../scripts/skip-tutorial.ts');
    const { loadAndRunFromState } = await import('../runtime/state-machine.ts');

    // Dynamically import the state builder for the test
    const { root, varpIds } = await getStateBuilder(testName);

    console.log(`Starting world for single-state test: ${statePath}...`);
    await World.start(false, false);
    World.nextTick = Date.now() + 600;

    console.log('World started. Spawning bot...');

    let scriptDone = false;
    let scriptError: Error | null = null;

    const api = BotManager.spawnBot('statebot0', async (bot) => {
        try {
            await bot.waitForTick();
            await bot.waitForTick();

            // Skip tutorial first (sets up base player state)
            await skipTutorial(bot);
            await bot.waitForTicks(2);

            // Build the state tree with this bot's closures
            const stateRoot = root(bot);

            // Load snapshot, restore bot state, run only the target state
            await loadAndRunFromState(statePath, snapshotFilePath, bot, stateRoot, varpIds);

            bot.log('SUCCESS', `Single state "${statePath}" completed`);
            scriptDone = true;
        } catch (err) {
            scriptError = err as Error;
            bot.log('ERROR', `Script error: ${(err as Error).message}`);
            scriptDone = true;
        }
    });

    // Run game ticks until script completes or timeout
    const DEFAULT_TIMEOUT_TICKS = 10000;
    const maxTicks = timeoutTicks != null ? Math.min(DEFAULT_TIMEOUT_TICKS, timeoutTicks) : DEFAULT_TIMEOUT_TICKS;

    for (let tick = 0; tick < maxTicks; tick++) {
        World.cycle();
        await Promise.resolve();

        if (scriptDone) {
            for (let i = 0; i < 5; i++) {
                World.cycle();
                await Promise.resolve();
            }
            break;
        }

        if (tick > 0 && tick % 1000 === 0) {
            const pos = api.getPosition();
            console.log(`[HEARTBEAT] tick=${tick} pos=(${pos.x},${pos.z},${pos.level})`);
        }
    }

    const durationSeconds = Math.round((Date.now() - startTime) / 1000);

    if (!scriptDone) {
        console.error(`TIMEOUT after ${durationSeconds}s`);
        process.exit(1);
    }

    if (scriptError) {
        console.error(`FAIL: ${scriptError.message}`);
        console.error(scriptError.stack);
        process.exit(1);
    }

    console.log('');
    console.log(`=== Single State Test: ${statePath} ===`);
    console.log(`  Duration: ${durationSeconds}s`);
    console.log('  Status: PASS');
    console.log('');
    console.log(`[RESULT] status=PASS duration=${durationSeconds}s state="${statePath}"`);

    process.exit(0);
}

/**
 * Get the state builder function and varp IDs for a given test name.
 * First checks metadata for buildStates, then falls back to legacy hardcoded imports.
 */
async function getStateBuilder(testName: string): Promise<{ root: (bot: any) => any; varpIds: number[] }> {
    // Try auto-discovery via metadata first
    const meta = await findScriptMeta(testName);
    if (meta && meta.buildStates) {
        const varpIds = meta.varpId !== undefined ? [meta.varpId] : [];
        return { root: (bot: any) => meta.buildStates!(bot), varpIds };
    }

    throw new Error(`Test "${testName}" does not support --state= (no buildStates in metadata). Scripts with buildStates: ${await listStateBuilderScripts()}`);
}

/**
 * List all scripts that have buildStates in their metadata.
 */
async function listStateBuilderScripts(): Promise<string> {
    const scriptsDir = path.resolve(import.meta.dir, '..', 'scripts');
    const scriptFiles = fs.readdirSync(scriptsDir).filter(f => f.endsWith('.ts'));
    const names: string[] = [];
    for (const file of scriptFiles) {
        const modulePath = path.join(scriptsDir, file);
        const mod = await import(modulePath);
        if (mod.metadata && typeof mod.metadata === 'object' && mod.metadata.buildStates) {
            names.push(mod.metadata.name);
        }
    }
    return names.join(', ');
}
