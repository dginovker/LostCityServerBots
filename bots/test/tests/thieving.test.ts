import fs from 'fs';
import path from 'path';

const startTime = Date.now();

// Change cwd to engine/ so that engine-relative paths resolve
const engineDir = path.resolve(import.meta.dir, '..', '..', '..');
process.chdir(engineDir);

// Import engine modules (must happen after chdir so dotenv and workers resolve)
const { default: World } = await import('../../../src/engine/World.ts');
const { default: BotManager } = await import('../../runtime/manager.ts');
const { thievingMen } = await import('../../scripts/thieving-men.ts');

console.log('Starting world for thieving test...');
await World.start(false, false);

// Initialize nextTick so drift calculation works correctly
World.nextTick = Date.now() + 600;

console.log('World started. Spawning bot...');

let scriptDone = false;
let scriptError: Error | null = null;

const api = BotManager.spawnBot('thiefbot1', async (bot) => {
    try {
        // Wait ticks for the bot to be logged in by processLogins
        await bot.waitForTick();
        await bot.waitForTick();

        await thievingMen(bot);
        scriptDone = true;
    } catch (err) {
        scriptError = err as Error;
        bot.log('ERROR', `Script error: ${(err as Error).message}`);
        scriptDone = true;
    }
});

// Run game ticks until script completes or timeout.
const TIMEOUT_TICKS = 4000; // 2400 seconds at 600ms/tick
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

const durationSeconds = Math.round((Date.now() - startTime) / 1000);

if (!scriptDone) {
    const pos = api.getPosition();
    const skill = api.getSkill('Thieving');
    console.error(`TIMEOUT after ${durationSeconds}s - pos=(${pos.x},${pos.z}) thieving_level=${skill.level} thieving_xp=${skill.exp}`);
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s thieving_level=${skill.level} thieving_xp=${skill.exp} error="TIMEOUT"`;
    console.log(resultLine);
    process.exit(1);
}

if (scriptError) {
    // Print error + last 20 log lines
    console.error(`Bot script error: ${scriptError.message}`);
    console.error(scriptError.stack);
    const logPath = path.resolve(import.meta.dir, '..', '..', 'logs', 'thiefbot1.log');
    if (fs.existsSync(logPath)) {
        const lines = fs.readFileSync(logPath, 'utf-8').split('\n');
        const last20 = lines.slice(-21).join('\n');
        console.error('\nLast 20 log lines:');
        console.error(last20);
    }
    const skill = api.getSkill('Thieving');
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s thieving_level=${skill.level} thieving_xp=${skill.exp} error="${scriptError.message}"`;
    console.log(resultLine);
    process.exit(1);
}

// Validate thieving level
const skill = api.getSkill('Thieving');
if (skill.level < 5) {
    console.error(`INCOMPLETE: Thieving level is ${skill.level}, expected >= 5`);
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s thieving_level=${skill.level} thieving_xp=${skill.exp} error="INCOMPLETE: Thieving level is ${skill.level}, expected >= 5"`;
    console.log(resultLine);
    process.exit(1);
}

// Success!
console.log('');
console.log('=== Thieving Test Results ===');
console.log(`  Thieving level: ${skill.level}`);
console.log(`  Thieving XP: ${skill.exp}`);
console.log(`  Duration: ${durationSeconds}s`);
console.log('');

const resultLine = `[RESULT] status=PASS duration=${durationSeconds}s thieving_level=${skill.level} thieving_xp=${skill.exp}`;
console.log(resultLine);

process.exit(0);
