import fs from 'fs';
import path from 'path';

const startTime = Date.now();

// Change cwd to engine/ so that engine-relative paths resolve
const engineDir = path.resolve(import.meta.dir, '..', '..', '..');
process.chdir(engineDir);

// Set BOT_AUTOSTART env var BEFORE importing Environment
process.env.BOT_AUTOSTART = 'thieving-men:1';

// Import engine modules (must happen after chdir so dotenv and workers resolve)
const { default: World } = await import('../../../src/engine/World.ts');
const { default: BotManager } = await import('../../runtime/manager.ts');
const { autostartBots } = await import('../../runtime/autostart.ts');

console.log('Starting world for live test (real tick loop)...');
await World.start(false, true);

// Initialize nextTick so drift calculation works correctly
World.nextTick = Date.now() + 600;

console.log('World started with real tick loop. Calling autostartBots()...');
autostartBots();

// Poll every 2 seconds for up to 60 seconds
const POLL_INTERVAL_MS = 2000;
const TIMEOUT_MS = 60000;
const XP_TARGET = 25;

let passed = false;
let lastExp = 0;

while (Date.now() - startTime < TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

    const bot = BotManager.getBot('thieving-men-1');
    if (!bot) {
        console.log(`  [${Math.round((Date.now() - startTime) / 1000)}s] Bot not yet available...`);
        continue;
    }

    const skill = bot.getSkill('Thieving');
    lastExp = skill.exp;
    console.log(`  [${Math.round((Date.now() - startTime) / 1000)}s] Thieving XP: ${skill.exp} (target: ${XP_TARGET})`);

    if (skill.exp >= XP_TARGET) {
        passed = true;
        break;
    }
}

const durationSeconds = Math.round((Date.now() - startTime) / 1000);

// === Assertions ===
const assertions: { name: string; pass: boolean }[] = [];

// 1. Thieving XP >= 25
assertions.push({
    name: `Thieving XP >= ${XP_TARGET} (got ${lastExp})`,
    pass: passed
});

// 2. Bot log file exists and contains at least 1 ACTION line
const logPath = path.resolve(import.meta.dir, '..', '..', 'logs', 'thieving-men-1.log');
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
const passedCount = assertions.filter(a => a.pass).length;
const total = assertions.length;
const allPassed = passedCount === total;

const firstFailed = assertions.find(a => !a.pass);

console.log('');
console.log('=== Live Test Results ===');
for (const a of assertions) {
    console.log(`  ${a.pass ? 'PASS' : 'FAIL'}: ${a.name}`);
}
console.log('');

const resultLine = `[RESULT] status=${allPassed ? 'PASS' : 'FAIL'} duration=${durationSeconds}s assertions_passed=${passedCount}/${total}${firstFailed ? ` failed="${firstFailed.name}"` : ''}`;
console.log(resultLine);

if (!allPassed && firstFailed) {
    console.log(`\nFirst failing assertion: ${firstFailed.name}`);
}

process.exit(allPassed ? 0 : 1);
