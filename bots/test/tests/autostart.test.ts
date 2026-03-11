import fs from 'fs';
import path from 'path';

const startTime = Date.now();

// Change cwd to engine/ so that engine-relative paths resolve
const engineDir = path.resolve(import.meta.dir, '..', '..', '..');
process.chdir(engineDir);

// Set BOT_AUTOSTART env var BEFORE importing Environment
process.env.BOT_AUTOSTART = 'sheepshearer:1';

// Import engine modules (must happen after chdir so dotenv and workers resolve)
const { default: World } = await import('../../../src/engine/World.ts');
const { default: BotManager } = await import('../../runtime/manager.ts');
const { autostartBots } = await import('../../runtime/autostart.ts');

console.log('Starting world for autostart test...');
await World.start(false, false);

// Initialize nextTick so drift calculation works correctly
World.nextTick = Date.now() + 600;

console.log('World started. Calling autostartBots()...');
autostartBots();

// Run 50 ticks to let the bot start acting
const TICK_COUNT = 50;
for (let tick = 0; tick < TICK_COUNT; tick++) {
    World.cycle();
    await Promise.resolve();
}

const durationSeconds = Math.round((Date.now() - startTime) / 1000);

// === Assertions ===
const assertions: { name: string; pass: boolean }[] = [];

// 1. listBots() contains 'sheepshearer-1'
const botList = BotManager.listBots();
assertions.push({
    name: `BotManager.listBots() contains "sheepshearer-1" (got [${botList.join(', ')}])`,
    pass: botList.includes('sheepshearer-1')
});

// 2. Bot log file exists and contains at least 1 ACTION line
const logPath = path.resolve(import.meta.dir, '..', '..', 'logs', 'sheepshearer-1.log');
const logExists = fs.existsSync(logPath);
let hasActionLine = false;
if (logExists) {
    const logContent = fs.readFileSync(logPath, 'utf-8');
    hasActionLine = logContent.split('\n').some(line => line.includes('[ACTION]'));
}
assertions.push({
    name: `Log file exists and contains ACTION line (exists=${logExists}, hasAction=${hasActionLine})`,
    pass: logExists && hasActionLine
});

// Report results
const passed = assertions.filter(a => a.pass).length;
const total = assertions.length;
const allPassed = passed === total;

const firstFailed = assertions.find(a => !a.pass);

console.log('');
console.log('=== Autostart Test Results ===');
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
