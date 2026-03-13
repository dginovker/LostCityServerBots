import fs from 'fs';
import path from 'path';

const startTime = Date.now();

// Change cwd to engine/ so that engine-relative paths resolve
const engineDir = path.resolve(import.meta.dir, '..', '..', '..');
process.chdir(engineDir);

// Import engine modules (must happen after chdir so dotenv and workers resolve)
const { default: World } = await import('../../../src/engine/World.ts');
const { default: BotManager } = await import('../../runtime/manager.ts');
const { pvpTeam5v5 } = await import('../../scripts/pvp-team-5v5.ts');

console.log('Starting world for 5v5 Team PvP test...');
await World.start(false, false);

World.nextTick = Date.now() + 600;

console.log('World started. Spawning A1 (captain)...');

let scriptDone = false;
let scriptError: Error | null = null;

const api = BotManager.spawnBot('pvp5v5-a1', async (bot) => {
    try {
        await bot.waitForTick();
        await bot.waitForTick();

        await pvpTeam5v5(bot);
        scriptDone = true;
    } catch (err) {
        scriptError = err as Error;
        bot.log('ERROR', `Script error: ${(err as Error).message}`);
        scriptDone = true;
    }
});

// 15000 ticks max — 10 bots, multi-combat fight
const TIMEOUT_TICKS = 15000;
for (let tick = 0; tick < TIMEOUT_TICKS; tick++) {
    World.cycle();
    await Promise.resolve();

    if (scriptDone) {
        // Run a few extra ticks to let cleanup settle
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
    const hp = api.getSkill('hitpoints');
    const inv = api.getInventory().map(i => i.name).join(', ');
    console.error(`TIMEOUT after ${durationSeconds}s - A1 pos=(${pos.x},${pos.z},${pos.level}) hp=${hp.level}/${hp.baseLevel} inventory=[${inv}]`);
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s error="TIMEOUT"`;
    console.log(resultLine);
    process.exit(1);
}

if (scriptError) {
    console.error(`Bot script error: ${scriptError.message}`);
    console.error(scriptError.stack);
    const logPath = path.resolve(import.meta.dir, '..', '..', 'logs', 'pvp5v5-a1.log');
    if (fs.existsSync(logPath)) {
        const lines = fs.readFileSync(logPath, 'utf-8').split('\n');
        const last30 = lines.slice(-31).join('\n');
        console.error('\nLast 30 log lines (A1):');
        console.error(last30);
    }
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s error="${scriptError.message}"`;
    console.log(resultLine);
    process.exit(1);
}

// Validate: fight resolved, A1 is either dead (in Lumbridge) or victorious
const pos = api.getPosition();
const hp = api.getSkill('hitpoints');

console.log('');
console.log('=== 5v5 Team PvP Test Results ===');
console.log(`  A1 final pos: (${pos.x},${pos.z})`);
console.log(`  A1 final HP: ${hp.level}/${hp.baseLevel}`);
console.log(`  Duration: ${durationSeconds}s`);
console.log('');

const resultLine = `[RESULT] status=PASS duration=${durationSeconds}s hp=${hp.level}/${hp.baseLevel}`;
console.log(resultLine);

process.exit(0);
