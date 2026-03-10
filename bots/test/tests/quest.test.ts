import fs from 'fs';
import path from 'path';

const startTime = Date.now();

// Change cwd to engine/ so that engine-relative paths resolve
const engineDir = path.resolve(import.meta.dir, '..', '..', '..');
process.chdir(engineDir);

// Import engine modules (must happen after chdir so dotenv and workers resolve)
const { default: World } = await import('../../../src/engine/World.ts');
const { default: BotManager } = await import('../../runtime/manager.ts');
const { runeMysteries } = await import('../../scripts/rune-mysteries.ts');

// Rune Mysteries varp ID (from content/pack/varp.pack: 63=runemysteries)
const RUNE_MYSTERIES_VARP = 63;

console.log('Starting world for quest test...');
await World.start(false, false);

// Initialize nextTick so drift calculation works correctly
World.nextTick = Date.now() + 600;

console.log('World started. Spawning bot...');

let scriptDone = false;
let scriptError: Error | null = null;

const api = BotManager.spawnBot('questbot3', async (bot) => {
    try {
        // Wait ticks for the bot to be logged in by processLogins
        await bot.waitForTick();
        await bot.waitForTick();

        await runeMysteries(bot);
        scriptDone = true;
    } catch (err) {
        scriptError = err as Error;
        bot.log('ERROR', `Script error: ${(err as Error).message}`);
        scriptDone = true;
    }
});

// Run game ticks until script completes or timeout.
// 12000 seconds / 0.6 seconds per tick = 20000 ticks
const TIMEOUT_TICKS = 20000;
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
    const questVarp = api.getQuestProgress(RUNE_MYSTERIES_VARP);
    const inv = api.getInventory().map(i => i.name).join(', ');
    console.error(`TIMEOUT after ${durationSeconds}s - pos=(${pos.x},${pos.z},${pos.level}) quest_varp=${questVarp} inventory=[${inv}]`);
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} has_air_talisman=false error="TIMEOUT"`;
    console.log(resultLine);
    process.exit(1);
}

if (scriptError) {
    // Print error + last 30 log lines
    console.error(`Bot script error: ${scriptError.message}`);
    console.error(scriptError.stack);
    const logPath = path.resolve(import.meta.dir, '..', '..', 'logs', 'questbot3.log');
    if (fs.existsSync(logPath)) {
        const lines = fs.readFileSync(logPath, 'utf-8').split('\n');
        const last30 = lines.slice(-31).join('\n');
        console.error('\nLast 30 log lines:');
        console.error(last30);
    }
    const questVarp = api.getQuestProgress(RUNE_MYSTERIES_VARP);
    const hasAirTalisman = api.findItem('Air talisman') !== null;
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} has_air_talisman=${hasAirTalisman} error="${scriptError.message}"`;
    console.log(resultLine);
    process.exit(1);
}

// Validate quest completion
const questVarp = api.getQuestProgress(RUNE_MYSTERIES_VARP);
const hasAirTalisman = api.findItem('Air talisman') !== null;

if (questVarp !== 6) {
    console.error(`INCOMPLETE: quest varp is ${questVarp}, expected 6`);
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} has_air_talisman=${hasAirTalisman} error="INCOMPLETE: quest varp is ${questVarp}, expected 6"`;
    console.log(resultLine);
    process.exit(1);
}

if (!hasAirTalisman) {
    console.error('MISSING REWARD: Air talisman not in inventory');
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} has_air_talisman=${hasAirTalisman} error="MISSING REWARD: Air talisman not in inventory"`;
    console.log(resultLine);
    process.exit(1);
}

// Success!
console.log('');
console.log('=== Quest Test Results ===');
console.log(`  Quest varp: ${questVarp} (complete)`);
console.log(`  Air talisman: ${hasAirTalisman}`);
console.log(`  Duration: ${durationSeconds}s`);
console.log('');

const resultLine = `[RESULT] status=PASS duration=${durationSeconds}s quest_varp=${questVarp} has_air_talisman=${hasAirTalisman}`;
console.log(resultLine);

process.exit(0);
