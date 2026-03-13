import fs from 'fs';
import path from 'path';

const startTime = Date.now();

// Change cwd to engine/ so that engine-relative paths resolve
const engineDir = path.resolve(import.meta.dir, '..', '..', '..');
process.chdir(engineDir);

// Import engine modules (must happen after chdir so dotenv and workers resolve)
const { default: World } = await import('../../../src/engine/World.ts');
const { default: BotManager } = await import('../../runtime/manager.ts');
const { witchsPotion } = await import('../../scripts/witchs-potion.ts');

// Witch's Potion varp ID (from content/pack/varp.pack: 67=hetty)
const HETTY_VARP = 67;
const STAGE_COMPLETE = 3;

console.log('Starting world for Witch\'s Potion test...');
await World.start(false, false);

// Initialize nextTick so drift calculation works correctly
World.nextTick = Date.now() + 600;

console.log('World started. Spawning bot...');

let scriptDone = false;
let scriptError: Error | null = null;

const api = BotManager.spawnBot('witchbot1', async (bot) => {
    try {
        await bot.waitForTick();
        await bot.waitForTick();

        await witchsPotion(bot);
        scriptDone = true;
    } catch (err) {
        scriptError = err as Error;
        bot.log('ERROR', `Script error: ${(err as Error).message}`);
        scriptDone = true;
    }
});

const TIMEOUT_TICKS = 20000;
for (let tick = 0; tick < TIMEOUT_TICKS; tick++) {
    World.cycle();
    await Promise.resolve();

    if (scriptDone) {
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
    const questVarp = api.getQuestProgress(HETTY_VARP);
    const magic = api.getSkill('Magic');
    const inv = api.getInventory().map(i => i.name).join(', ');
    console.error(`TIMEOUT after ${durationSeconds}s - pos=(${pos.x},${pos.z},${pos.level}) quest_varp=${questVarp} magic_xp=${magic.exp} inventory=[${inv}]`);
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} magic_xp=${magic.exp} error="TIMEOUT"`;
    console.log(resultLine);
    process.exit(1);
}

if (scriptError) {
    console.error(`Bot script error: ${scriptError.message}`);
    console.error(scriptError.stack);
    const logPath = path.resolve(import.meta.dir, '..', '..', 'logs', 'witchbot1.log');
    if (fs.existsSync(logPath)) {
        const lines = fs.readFileSync(logPath, 'utf-8').split('\n');
        const last30 = lines.slice(-31).join('\n');
        console.error('\nLast 30 log lines:');
        console.error(last30);
    }
    const questVarp = api.getQuestProgress(HETTY_VARP);
    const magic = api.getSkill('Magic');
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} magic_xp=${magic.exp} error="${scriptError.message}"`;
    console.log(resultLine);
    process.exit(1);
}

// Validate quest completion
const questVarp = api.getQuestProgress(HETTY_VARP);
const magic = api.getSkill('Magic');

if (questVarp !== STAGE_COMPLETE) {
    console.error(`INCOMPLETE: quest varp is ${questVarp}, expected ${STAGE_COMPLETE}`);
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} magic_xp=${magic.exp} error="INCOMPLETE: quest varp is ${questVarp}, expected ${STAGE_COMPLETE}"`;
    console.log(resultLine);
    process.exit(1);
}

if (magic.exp <= 0) {
    console.error('MISSING REWARD: No magic XP gained');
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} magic_xp=${magic.exp} error="MISSING REWARD: No magic XP gained"`;
    console.log(resultLine);
    process.exit(1);
}

// Success!
console.log('');
console.log('=== Witch\'s Potion Test Results ===');
console.log(`  Quest varp: ${questVarp} (complete)`);
console.log(`  Magic XP: ${magic.exp}`);
console.log(`  Duration: ${durationSeconds}s`);
console.log('');

const resultLine = `[RESULT] status=PASS duration=${durationSeconds}s quest_varp=${questVarp} magic_xp=${magic.exp}`;
console.log(resultLine);

process.exit(0);
