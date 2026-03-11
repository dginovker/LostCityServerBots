import fs from 'fs';
import path from 'path';

const startTime = Date.now();

// Change cwd to engine/ so that engine-relative paths resolve
const engineDir = path.resolve(import.meta.dir, '..', '..', '..');
process.chdir(engineDir);

// Import engine modules (must happen after chdir so dotenv and workers resolve)
const { default: World } = await import('../../../src/engine/World.ts');
const { default: BotManager } = await import('../../runtime/manager.ts');
const { f2pSkills } = await import('../../scripts/f2p-skills.ts');

console.log('Starting world for F2P skills test...');
await World.start(false, false);

// Initialize nextTick so drift calculation works correctly
World.nextTick = Date.now() + 600;

console.log('World started. Spawning bot...');

let scriptDone = false;
let scriptError: Error | null = null;

const api = BotManager.spawnBot('f2pskillsbot', async (bot) => {
    try {
        // Wait ticks for the bot to be logged in by processLogins
        await bot.waitForTick();
        await bot.waitForTick();

        await f2pSkills(bot);
        scriptDone = true;
    } catch (err) {
        scriptError = err as Error;
        bot.log('ERROR', `Script error: ${(err as Error).message}`);
        scriptDone = true;
    }
});

// Run game ticks until script completes or timeout.
// This is a long-running script (training 14 skills to level 10), so allow many ticks.
const TIMEOUT_TICKS = 200_000; // very generous timeout for all skills
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

// F2P skills to validate (Runecraft excluded — requires Rune Mysteries quest)
const f2pSkillsList = [
    'Attack', 'Strength', 'Defence', 'Ranged', 'Prayer',
    'Magic', 'Hitpoints', 'Mining', 'Smithing', 'Fishing',
    'Cooking', 'Woodcutting', 'Firemaking', 'Crafting'
];

function getSkillSummary(): string {
    return f2pSkillsList.map(s => {
        const info = api.getSkill(s);
        return `${s}=${info.baseLevel}`;
    }).join(' ');
}

if (!scriptDone) {
    const pos = api.getPosition();
    console.error(`TIMEOUT after ${durationSeconds}s - pos=(${pos.x},${pos.z}) ${getSkillSummary()}`);
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s ${getSkillSummary()} error="TIMEOUT"`;
    console.log(resultLine);
    process.exit(1);
}

if (scriptError) {
    // Print error + last 30 log lines
    console.error(`Bot script error: ${scriptError.message}`);
    console.error(scriptError.stack);
    const logPath = path.resolve(import.meta.dir, '..', '..', 'logs', 'f2pskillsbot.log');
    if (fs.existsSync(logPath)) {
        const lines = fs.readFileSync(logPath, 'utf-8').split('\n');
        const last30 = lines.slice(-31).join('\n');
        console.error('\nLast 30 log lines:');
        console.error(last30);
    }
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s ${getSkillSummary()} error="${scriptError.message}"`;
    console.log(resultLine);
    process.exit(1);
}

// Validate all F2P skills are >= 10
const failed: string[] = [];
for (const skillName of f2pSkillsList) {
    const info = api.getSkill(skillName);
    if (info.baseLevel < 10) {
        failed.push(`${skillName}(${info.baseLevel})`);
    }
}

if (failed.length > 0) {
    console.error(`INCOMPLETE: Skills below level 10: ${failed.join(', ')}`);
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s ${getSkillSummary()} error="INCOMPLETE: ${failed.join(', ')}"`;
    console.log(resultLine);
    process.exit(1);
}

// Success!
console.log('');
console.log('=== F2P Skills Test Results ===');
for (const skillName of f2pSkillsList) {
    const info = api.getSkill(skillName);
    console.log(`  ${skillName}: level ${info.baseLevel} (XP: ${info.exp})`);
}
const rcInfo = api.getSkill('Runecraft');
console.log(`  Runecraft: level ${rcInfo.baseLevel} (XP: ${rcInfo.exp}) [SKIPPED - requires quest]`);
console.log(`  Duration: ${durationSeconds}s`);
console.log('');

const resultLine = `[RESULT] status=PASS duration=${durationSeconds}s ${getSkillSummary()}`;
console.log(resultLine);

process.exit(0);
