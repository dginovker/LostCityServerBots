import fs from 'fs';
import path from 'path';

const startTime = Date.now();

// Change cwd to engine/ so that engine-relative paths resolve
const engineDir = path.resolve(import.meta.dir, '..', '..', '..');
process.chdir(engineDir);

// Import engine modules (must happen after chdir so dotenv and workers resolve)
const { default: World } = await import('../../../src/engine/World.ts');
const { default: BotManager } = await import('../../runtime/manager.ts');
const { getScriptFn } = await import('../../runtime/registry.ts');
const { skipTutorial } = await import('../../scripts/skip-tutorial.ts');

console.log('Starting world for botcommand test...');
await World.start(false, false);

// Initialize nextTick so drift calculation works correctly
World.nextTick = Date.now() + 600;

console.log('World started. Spawning 3 bots of same script via registry...');

const SCRIPT_NAME = 'thieving-men';
const scriptFn = getScriptFn(SCRIPT_NAME);

// Spawn 3 bots of the same script
const botNames: string[] = [];
const apis = [];
for (let i = 0; i < 3; i++) {
    const num = BotManager.nextBotNumber(SCRIPT_NAME);
    const username = `${SCRIPT_NAME}-${num}`;
    botNames.push(username);

    const api = BotManager.spawnBot(username, async (bot) => {
        try {
            await bot.waitForTick();
            await bot.waitForTick();
            await skipTutorial(bot);
            await scriptFn(bot);
        } catch (err) {
            bot.log('ERROR', `Script error: ${(err as Error).message}`);
        }
    });
    apis.push(api);
}

// Run 50 ticks to let the bots start acting
const TICK_COUNT = 50;
for (let tick = 0; tick < TICK_COUNT; tick++) {
    World.cycle();
    await Promise.resolve();
}

const durationSeconds = Math.round((Date.now() - startTime) / 1000);

// === Assertions ===
const assertions: { name: string; pass: boolean }[] = [];

// 1. All 3 bots appear in listBots()
const botList = BotManager.listBots();
for (const name of botNames) {
    assertions.push({
        name: `BotManager.listBots() contains "${name}" (got [${botList.join(', ')}])`,
        pass: botList.includes(name)
    });
}

// 2. Auto-numbering is correct (1, 2, 3)
assertions.push({
    name: `Bot names are ${SCRIPT_NAME}-1, -2, -3 (got ${botNames.join(', ')})`,
    pass: botNames[0] === `${SCRIPT_NAME}-1` && botNames[1] === `${SCRIPT_NAME}-2` && botNames[2] === `${SCRIPT_NAME}-3`
});

// 3. countBotsByPrefix returns 3
const prefixCount = BotManager.countBotsByPrefix(SCRIPT_NAME);
assertions.push({
    name: `countBotsByPrefix("${SCRIPT_NAME}") === 3 (got ${prefixCount})`,
    pass: prefixCount === 3
});

// 4. nextBotNumber returns 4 (next after 3 existing)
const nextNum = BotManager.nextBotNumber(SCRIPT_NAME);
assertions.push({
    name: `nextBotNumber("${SCRIPT_NAME}") === 4 (got ${nextNum})`,
    pass: nextNum === 4
});

// 5. At least one bot has a log file with ACTION lines
const logPath = path.resolve(import.meta.dir, '..', '..', 'logs', `${botNames[0]}.log`);
const logExists = fs.existsSync(logPath);
let hasActionLine = false;
if (logExists) {
    const logContent = fs.readFileSync(logPath, 'utf-8');
    hasActionLine = logContent.split('\n').some(line => line.includes('[ACTION]'));
}
assertions.push({
    name: `Log file for ${botNames[0]} exists with ACTION line (exists=${logExists}, hasAction=${hasActionLine})`,
    pass: logExists && hasActionLine
});

// 6. Stop middle bot, verify list updates and next number fills gap correctly
BotManager.stopBot(botNames[1]); // stop thieving-men-2
for (let i = 0; i < 3; i++) {
    World.cycle();
    await Promise.resolve();
}

const botListAfterStop = BotManager.listBots();
assertions.push({
    name: `After stopping ${botNames[1]}, listBots() does not contain it (got [${botListAfterStop.join(', ')}])`,
    pass: !botListAfterStop.includes(botNames[1])
});

// 7. countBotsByPrefix is now 2
const prefixCountAfter = BotManager.countBotsByPrefix(SCRIPT_NAME);
assertions.push({
    name: `countBotsByPrefix after stop === 2 (got ${prefixCountAfter})`,
    pass: prefixCountAfter === 2
});

// 8. Spawning another bot gets number 4 (next after max=3), not 2 (the gap)
const nextNum2 = BotManager.nextBotNumber(SCRIPT_NAME);
assertions.push({
    name: `Next bot number after stop is 4, not 2 (got ${nextNum2})`,
    pass: nextNum2 === 4
});

// Clean up remaining bots
BotManager.stopBot(botNames[0]);
BotManager.stopBot(botNames[2]);
for (let i = 0; i < 3; i++) {
    World.cycle();
    await Promise.resolve();
}

// Report results
const passed = assertions.filter(a => a.pass).length;
const total = assertions.length;
const allPassed = passed === total;

const firstFailed = assertions.find(a => !a.pass);

console.log('');
console.log('=== Bot Command Test Results ===');
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
