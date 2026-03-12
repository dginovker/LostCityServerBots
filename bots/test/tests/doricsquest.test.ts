import fs from 'fs';
import path from 'path';

const startTime = Date.now();

// Change cwd to engine/ so that engine-relative paths resolve
const engineDir = path.resolve(import.meta.dir, '..', '..', '..');
process.chdir(engineDir);

// Import engine modules (must happen after chdir so dotenv and workers resolve)
const { default: World } = await import('../../../src/engine/World.ts');
const { default: BotManager } = await import('../../runtime/manager.ts');
const { doricsQuest } = await import('../../scripts/dorics-quest.ts');

// Doric's Quest varp ID (from content/pack/varp.pack: 31=doricquest)
const DORICS_QUEST_VARP = 31;
const STAGE_COMPLETE = 100;

console.log('Starting world for Doric\'s Quest test...');
await World.start(false, false);

// Initialize nextTick so drift calculation works correctly
World.nextTick = Date.now() + 600;

console.log('World started. Spawning bot...');

let scriptDone = false;
let scriptError: Error | null = null;

const api = BotManager.spawnBot('dorics-quest-1', async (bot) => {
    try {
        // Wait ticks for the bot to be logged in by processLogins
        await bot.waitForTick();
        await bot.waitForTick();

        await doricsQuest(bot);
        scriptDone = true;
    } catch (err) {
        scriptError = err as Error;
        bot.log('ERROR', `Script error: ${(err as Error).message}`);
        scriptDone = true;
    }
});

// Run game ticks until script completes or timeout.
// This quest involves walking long distances and mining many ores — generous timeout.
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
    const questVarp = api.getQuestProgress(DORICS_QUEST_VARP);
    const mining = api.getSkill('Mining');
    const inv = api.getInventory().map(i => i.name).join(', ');
    console.error(`TIMEOUT after ${durationSeconds}s - pos=(${pos.x},${pos.z},${pos.level}) quest_varp=${questVarp} mining_xp=${mining.exp} inventory=[${inv}]`);
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} mining_xp=${mining.exp} error="TIMEOUT"`;
    console.log(resultLine);
    process.exit(1);
}

if (scriptError) {
    // Print error + last 30 log lines
    console.error(`Bot script error: ${scriptError.message}`);
    console.error(scriptError.stack);
    const logPath = path.resolve(import.meta.dir, '..', '..', 'logs', 'dorics-quest-1.log');
    if (fs.existsSync(logPath)) {
        const lines = fs.readFileSync(logPath, 'utf-8').split('\n');
        const last30 = lines.slice(-31).join('\n');
        console.error('\nLast 30 log lines:');
        console.error(last30);
    }
    const questVarp = api.getQuestProgress(DORICS_QUEST_VARP);
    const mining = api.getSkill('Mining');
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} mining_xp=${mining.exp} error="${scriptError.message}"`;
    console.log(resultLine);
    process.exit(1);
}

// Validate quest completion
const questVarp = api.getQuestProgress(DORICS_QUEST_VARP);
const mining = api.getSkill('Mining');
const coins = api.findItem('Coins');

const assertions: { name: string; pass: boolean; actual: string }[] = [
    {
        name: 'Quest complete (varp=100)',
        pass: questVarp === STAGE_COMPLETE,
        actual: `${questVarp}`
    },
    {
        name: 'Mining XP > 0',
        pass: mining.exp > 0,
        actual: `${mining.exp}`
    },
    {
        name: 'Has coins (reward)',
        pass: coins !== null && coins.count >= 180,
        actual: coins ? `${coins.count}` : 'null'
    }
];

const allPassed = assertions.every(a => a.pass);

console.log('');
console.log('=== Doric\'s Quest Test Results ===');
for (const a of assertions) {
    console.log(`  ${a.pass ? 'PASS' : 'FAIL'}: ${a.name} (actual: ${a.actual})`);
}
console.log(`  Duration: ${durationSeconds}s`);
console.log('');

const failedAssertion = assertions.find(a => !a.pass);
const errorStr = failedAssertion ? ` error="${failedAssertion.name}: actual=${failedAssertion.actual}"` : '';
const resultLine = `[RESULT] status=${allPassed ? 'PASS' : 'FAIL'} duration=${durationSeconds}s quest_varp=${questVarp} mining_xp=${mining.exp} coins=${coins ? coins.count : 0}${errorStr}`;
console.log(resultLine);

process.exit(allPassed ? 0 : 1);
