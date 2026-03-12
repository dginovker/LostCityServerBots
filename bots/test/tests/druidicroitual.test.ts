import fs from 'fs';
import path from 'path';

const startTime = Date.now();

// Change cwd to engine/ so that engine-relative paths resolve
const engineDir = path.resolve(import.meta.dir, '..', '..', '..');
process.chdir(engineDir);

// Import engine modules (must happen after chdir so dotenv and workers resolve)
const { default: World } = await import('../../../src/engine/World.ts');
const { default: BotManager } = await import('../../runtime/manager.ts');
const { druidicRitual } = await import('../../scripts/druidic-ritual.ts');

// Druidic Ritual varp ID (from content/pack/varp.pack: 80=druidquest)
const DRUIDIC_RITUAL_VARP = 80;
const STAGE_COMPLETE = 4;

console.log('Starting world for Druidic Ritual test...');
await World.start(false, false);

// Initialize nextTick so drift calculation works correctly
World.nextTick = Date.now() + 600;

console.log('World started. Spawning bot...');

let scriptDone = false;
let scriptError: Error | null = null;

const api = BotManager.spawnBot('druidic-ritual-1', async (bot) => {
    try {
        // Wait ticks for the bot to be logged in by processLogins
        await bot.waitForTick();
        await bot.waitForTick();

        await druidicRitual(bot);
        scriptDone = true;
    } catch (err) {
        scriptError = err as Error;
        bot.log('ERROR', `Script error: ${(err as Error).message}`);
        scriptDone = true;
    }
});

// Run game ticks until script completes or timeout.
// This quest involves combat training, long-distance walking, and dungeon exploration.
const TIMEOUT_TICKS = 60000;
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
    const questVarp = api.getQuestProgress(DRUIDIC_RITUAL_VARP);
    const herblore = api.getSkill('Herblore');
    const inv = api.getInventory().map(i => i.name).join(', ');
    console.error(`TIMEOUT after ${durationSeconds}s - pos=(${pos.x},${pos.z},${pos.level}) quest_varp=${questVarp} herblore_xp=${herblore.exp} inventory=[${inv}]`);
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} herblore_xp=${herblore.exp} error="TIMEOUT"`;
    console.log(resultLine);
    process.exit(1);
}

if (scriptError) {
    // Print error + last 30 log lines
    console.error(`Bot script error: ${scriptError.message}`);
    console.error(scriptError.stack);
    const logPath = path.resolve(import.meta.dir, '..', '..', 'logs', 'druidic-ritual-1.log');
    if (fs.existsSync(logPath)) {
        const lines = fs.readFileSync(logPath, 'utf-8').split('\n');
        const last30 = lines.slice(-31).join('\n');
        console.error('\nLast 30 log lines:');
        console.error(last30);
    }
    const questVarp = api.getQuestProgress(DRUIDIC_RITUAL_VARP);
    const herblore = api.getSkill('Herblore');
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} herblore_xp=${herblore.exp} error="${scriptError.message}"`;
    console.log(resultLine);
    process.exit(1);
}

// Validate quest completion
const questVarp = api.getQuestProgress(DRUIDIC_RITUAL_VARP);
const herblore = api.getSkill('Herblore');

const assertions: { name: string; pass: boolean; actual: string }[] = [
    {
        name: 'Quest complete (varp=4)',
        pass: questVarp === STAGE_COMPLETE,
        actual: `${questVarp}`
    },
    {
        name: 'Herblore XP > 0 (quest reward)',
        pass: herblore.exp > 0,
        actual: `${herblore.exp}`
    }
];

const allPassed = assertions.every(a => a.pass);

console.log('');
console.log('=== Druidic Ritual Test Results ===');
for (const a of assertions) {
    console.log(`  ${a.pass ? 'PASS' : 'FAIL'}: ${a.name} (actual: ${a.actual})`);
}
console.log(`  Duration: ${durationSeconds}s`);
console.log('');

const failedAssertion = assertions.find(a => !a.pass);
const errorStr = failedAssertion ? ` error="${failedAssertion.name}: actual=${failedAssertion.actual}"` : '';
const resultLine = `[RESULT] status=${allPassed ? 'PASS' : 'FAIL'} duration=${durationSeconds}s quest_varp=${questVarp} herblore_xp=${herblore.exp}${errorStr}`;
console.log(resultLine);

process.exit(allPassed ? 0 : 1);
