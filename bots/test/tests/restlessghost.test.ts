import fs from 'fs';
import path from 'path';

const startTime = Date.now();

// Change cwd to engine/ so that engine-relative paths resolve
const engineDir = path.resolve(import.meta.dir, '..', '..', '..');
process.chdir(engineDir);

// Import engine modules (must happen after chdir so dotenv and workers resolve)
const { default: World } = await import('../../../src/engine/World.ts');
const { default: BotManager } = await import('../../runtime/manager.ts');
const { restlessGhost } = await import('../../scripts/restless-ghost.ts');

// The Restless Ghost varp ID (from content/pack/varp.pack: 107=prieststart)
const RESTLESS_GHOST_VARP = 107;
const STAGE_COMPLETE = 5;

console.log('Starting world for The Restless Ghost test...');
await World.start(false, false);

// Initialize nextTick so drift calculation works correctly
World.nextTick = Date.now() + 600;

console.log('World started. Spawning bot...');

let scriptDone = false;
let scriptError: Error | null = null;

const api = BotManager.spawnBot('restless-ghost-1', async (bot) => {
    try {
        // Wait ticks for the bot to be logged in by processLogins
        await bot.waitForTick();
        await bot.waitForTick();

        await restlessGhost(bot);
        scriptDone = true;
    } catch (err) {
        scriptError = err as Error;
        bot.log('ERROR', `Script error: ${(err as Error).message}`);
        scriptDone = true;
    }
});

// Run game ticks until script completes or timeout.
// This quest involves walking, dialog, and picking up an item — relatively fast.
const TIMEOUT_TICKS = 30000;
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
    const questVarp = api.getQuestProgress(RESTLESS_GHOST_VARP);
    const prayer = api.getSkill('Prayer');
    const inv = api.getInventory().map(i => i.name).join(', ');
    console.error(`TIMEOUT after ${durationSeconds}s - pos=(${pos.x},${pos.z},${pos.level}) quest_varp=${questVarp} prayer_xp=${prayer.exp} inventory=[${inv}]`);
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} prayer_xp=${prayer.exp} error="TIMEOUT"`;
    console.log(resultLine);
    process.exit(1);
}

if (scriptError) {
    // Print error + last 30 log lines
    console.error(`Bot script error: ${scriptError.message}`);
    console.error(scriptError.stack);
    const logPath = path.resolve(import.meta.dir, '..', '..', 'logs', 'restless-ghost-1.log');
    if (fs.existsSync(logPath)) {
        const lines = fs.readFileSync(logPath, 'utf-8').split('\n');
        const last30 = lines.slice(-31).join('\n');
        console.error('\nLast 30 log lines:');
        console.error(last30);
    }
    const questVarp = api.getQuestProgress(RESTLESS_GHOST_VARP);
    const prayer = api.getSkill('Prayer');
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} prayer_xp=${prayer.exp} error="${scriptError.message}"`;
    console.log(resultLine);
    process.exit(1);
}

// Validate quest completion
const questVarp = api.getQuestProgress(RESTLESS_GHOST_VARP);
const prayer = api.getSkill('Prayer');

if (questVarp !== STAGE_COMPLETE) {
    console.error(`INCOMPLETE: quest varp is ${questVarp}, expected ${STAGE_COMPLETE}`);
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} prayer_xp=${prayer.exp} error="INCOMPLETE: quest varp is ${questVarp}, expected ${STAGE_COMPLETE}"`;
    console.log(resultLine);
    process.exit(1);
}

if (prayer.exp <= 0) {
    console.error('MISSING REWARD: No prayer XP gained');
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} prayer_xp=${prayer.exp} error="MISSING REWARD: No prayer XP gained"`;
    console.log(resultLine);
    process.exit(1);
}

// Success!
console.log('');
console.log('=== The Restless Ghost Test Results ===');
console.log(`  Quest varp: ${questVarp} (complete)`);
console.log(`  Prayer XP: ${prayer.exp}`);
console.log(`  Duration: ${durationSeconds}s`);
console.log('');

const resultLine = `[RESULT] status=PASS duration=${durationSeconds}s quest_varp=${questVarp} prayer_xp=${prayer.exp}`;
console.log(resultLine);

process.exit(0);
