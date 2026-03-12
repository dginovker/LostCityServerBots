import fs from 'fs';
import path from 'path';

const startTime = Date.now();

// Change cwd to engine/ so that engine-relative paths resolve
const engineDir = path.resolve(import.meta.dir, '..', '..', '..');
process.chdir(engineDir);

// Import engine modules (must happen after chdir so dotenv and workers resolve)
const { default: World } = await import('../../../src/engine/World.ts');
const { default: BotManager } = await import('../../runtime/manager.ts');
const { blackKnightsFortress } = await import('../../scripts/black-knights-fortress.ts');

// Black Knights' Fortress varp ID (from content/pack/varp.pack: 130=spy)
const BKF_VARP = 130;
const STAGE_COMPLETE = 4;

console.log('Starting world for Black Knights\' Fortress test...');
await World.start(false, false);

// Initialize nextTick so drift calculation works correctly
World.nextTick = Date.now() + 600;

console.log('World started. Spawning bot...');

let scriptDone = false;
let scriptError: Error | null = null;

const api = BotManager.spawnBot('bkf-1', async (bot) => {
    try {
        // Wait ticks for the bot to be logged in by processLogins
        await bot.waitForTick();
        await bot.waitForTick();

        await blackKnightsFortress(bot);
        scriptDone = true;
    } catch (err) {
        scriptError = err as Error;
        bot.log('ERROR', `Script error: ${(err as Error).message}`);
        scriptDone = true;
    }
});

// Run game ticks until script completes or timeout.
// This test runs 6 prerequisite quests plus the BKF quest itself,
// including combat (imp catcher), pickpocketing, crafting, and extensive
// navigation. Needs a very generous timeout.
const TIMEOUT_TICKS = 200000;
for (let tick = 0; tick < TIMEOUT_TICKS; tick++) {
    World.cycle();

    // Yield to microtask queue so bot async scripts can advance
    await Promise.resolve();

    if (scriptDone) {
        // Run a few more ticks to let things settle
        for (let i = 0; i < 5; i++) {
            World.cycle();
            await Promise.resolve();
        }
        break;
    }
}

const durationSeconds = Math.round((Date.now() - startTime) / 1000);

if (!scriptDone) {
    const pos = api.getPosition();
    const questVarp = api.getQuestProgress(BKF_VARP);
    const inv = api.getInventory().map(i => i.name).join(', ');
    const qp = api.getVarp(101);
    console.error(`TIMEOUT after ${durationSeconds}s - pos=(${pos.x},${pos.z},${pos.level}) quest_varp=${questVarp} qp=${qp} inventory=[${inv}]`);
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} qp=${qp} error="TIMEOUT"`;
    console.log(resultLine);
    process.exit(1);
}

if (scriptError) {
    // Print error + last 50 log lines (more lines since this is a long multi-quest test)
    console.error(`Bot script error: ${scriptError.message}`);
    console.error(scriptError.stack);
    const logPath = path.resolve(import.meta.dir, '..', '..', 'logs', 'bkf-1.log');
    if (fs.existsSync(logPath)) {
        const lines = fs.readFileSync(logPath, 'utf-8').split('\n');
        const last50 = lines.slice(-51).join('\n');
        console.error('\nLast 50 log lines:');
        console.error(last50);
    }
    const questVarp = api.getQuestProgress(BKF_VARP);
    const qp = api.getVarp(101);
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} qp=${qp} error="${scriptError.message}"`;
    console.log(resultLine);
    process.exit(1);
}

// Validate quest completion
const questVarp = api.getQuestProgress(BKF_VARP);
const qp = api.getVarp(101);
const coins = api.findItem('Coins');
const coinsAmount = coins ? coins.count : 0;

if (questVarp !== STAGE_COMPLETE) {
    console.error(`INCOMPLETE: quest varp is ${questVarp}, expected ${STAGE_COMPLETE}`);
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} qp=${qp} coins=${coinsAmount} error="INCOMPLETE: quest varp is ${questVarp}, expected ${STAGE_COMPLETE}"`;
    console.log(resultLine);
    process.exit(1);
}

// Black Knights' Fortress gives 3 QP. With 12 QP from prerequisites, total should be >= 15.
if (qp < 15) {
    console.error(`QP too low: ${qp}, expected >= 15 (12 prereqs + 3 BKF)`);
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} qp=${qp} coins=${coinsAmount} error="QP too low: ${qp}, expected >= 15"`;
    console.log(resultLine);
    process.exit(1);
}

// Success!
console.log('');
console.log('=== Black Knights\' Fortress Test Results ===');
console.log(`  Quest varp: ${questVarp} (complete)`);
console.log(`  Quest Points: ${qp}`);
console.log(`  Coins: ${coinsAmount}`);
console.log(`  Duration: ${durationSeconds}s`);
console.log('');

const resultLine = `[RESULT] status=PASS duration=${durationSeconds}s quest_varp=${questVarp} qp=${qp} coins=${coinsAmount}`;
console.log(resultLine);

process.exit(0);
