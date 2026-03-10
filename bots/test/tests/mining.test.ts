import fs from 'fs';
import path from 'path';

const startTime = Date.now();

// Change cwd to engine/ so that engine-relative paths resolve
const engineDir = path.resolve(import.meta.dir, '..', '..', '..');
process.chdir(engineDir);

// Import engine modules (must happen after chdir so dotenv and workers resolve)
const { default: World } = await import('../../../src/engine/World.ts');
const { default: BotManager } = await import('../../runtime/manager.ts');
const { mineAndSmelt } = await import('../../scripts/mine-and-smelt.ts');

console.log('Starting world for mining test...');
await World.start(false, false);

// Initialize nextTick so drift calculation works correctly
World.nextTick = Date.now() + 600;

console.log('World started. Spawning bot...');

let scriptDone = false;
let scriptError: Error | null = null;

const api = BotManager.spawnBot('minebot2', async (bot) => {
    try {
        // Wait ticks for the bot to be logged in by processLogins
        await bot.waitForTick();
        await bot.waitForTick();

        await mineAndSmelt(bot);
        scriptDone = true;
    } catch (err) {
        scriptError = err as Error;
        bot.log('ERROR', `Script error: ${(err as Error).message}`);
        scriptDone = true;
    }
});

// Run game ticks until script completes or timeout.
const TIMEOUT_TICKS = 6000; // 3600 seconds at 600ms/tick
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
    const miningSkill = api.getSkill('Mining');
    const smithingSkill = api.getSkill('Smithing');
    const bronzeBar = api.findItem('Bronze bar');
    console.error(`TIMEOUT after ${durationSeconds}s - pos=(${pos.x},${pos.z}) mining_xp=${miningSkill.exp} smithing_xp=${smithingSkill.exp} has_bronze_bar=${bronzeBar !== null}`);
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s has_bronze_bar=${bronzeBar !== null} mining_xp=${miningSkill.exp} smithing_xp=${smithingSkill.exp} error="TIMEOUT"`;
    console.log(resultLine);
    process.exit(1);
}

if (scriptError) {
    // Print error + last 20 log lines
    console.error(`Bot script error: ${scriptError.message}`);
    console.error(scriptError.stack);
    const logPath = path.resolve(import.meta.dir, '..', '..', 'logs', 'minebot2.log');
    if (fs.existsSync(logPath)) {
        const lines = fs.readFileSync(logPath, 'utf-8').split('\n');
        const last20 = lines.slice(-21).join('\n');
        console.error('\nLast 20 log lines:');
        console.error(last20);
    }
    const miningSkill = api.getSkill('Mining');
    const smithingSkill = api.getSkill('Smithing');
    const bronzeBar = api.findItem('Bronze bar');
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s has_bronze_bar=${bronzeBar !== null} mining_xp=${miningSkill.exp} smithing_xp=${smithingSkill.exp} error="${scriptError.message}"`;
    console.log(resultLine);
    process.exit(1);
}

// Run assertions
const bronzeBar = api.findItem('Bronze bar');
const miningSkill = api.getSkill('Mining');
const smithingSkill = api.getSkill('Smithing');

const assertions: { name: string; pass: boolean; actual: string }[] = [
    {
        name: 'Bronze bar in inventory',
        pass: bronzeBar !== null,
        actual: bronzeBar ? `found (id=${bronzeBar.id})` : 'null'
    },
    {
        name: 'Mining XP > 0',
        pass: miningSkill.exp > 0,
        actual: `${miningSkill.exp}`
    },
    {
        name: 'Smithing XP > 0',
        pass: smithingSkill.exp > 0,
        actual: `${smithingSkill.exp}`
    }
];

const allPassed = assertions.every(a => a.pass);

console.log('');
console.log('=== Mining Test Results ===');
for (const a of assertions) {
    console.log(`  ${a.pass ? 'PASS' : 'FAIL'}: ${a.name} (actual: ${a.actual})`);
}
console.log(`  Duration: ${durationSeconds}s`);
console.log('');

const failedAssertion = assertions.find(a => !a.pass);
const errorStr = failedAssertion ? ` error="${failedAssertion.name}: actual=${failedAssertion.actual}"` : '';
const resultLine = `[RESULT] status=${allPassed ? 'PASS' : 'FAIL'} duration=${durationSeconds}s has_bronze_bar=${bronzeBar !== null} mining_xp=${miningSkill.exp} smithing_xp=${smithingSkill.exp}${errorStr}`;
console.log(resultLine);

process.exit(allPassed ? 0 : 1);
