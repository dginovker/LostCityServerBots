import fs from 'fs';
import path from 'path';

// The test runner starts the server in-process, spawns a bot, and validates assertions.

const testName = process.argv[2];
if (!testName) {
    console.error('Usage: bun engine/bots/test/runner.ts <test-name>');
    console.error('Available tests: foundation, thieving, mining, quest, sheepshearer, princeali, impcatcher');
    process.exit(1);
}

if (testName === 'foundation') {
    await runFoundationTest();
} else if (testName === 'thieving') {
    await import('./tests/thieving.test.ts');
} else if (testName === 'mining') {
    await import('./tests/mining.test.ts');
} else if (testName === 'quest') {
    await import('./tests/quest.test.ts');
} else if (testName === 'sheepshearer') {
    await import('./tests/sheepshearer.test.ts');
} else if (testName === 'princeali') {
    await import('./tests/princealirrescue.test.ts');
} else if (testName === 'impcatcher') {
    await import('./tests/impcatcher.test.ts');
} else {
    console.error(`Unknown test: ${testName}`);
    process.exit(1);
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
