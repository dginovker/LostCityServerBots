import fs from 'fs';
import path from 'path';
import { runTickLoop, getTotalXp, emitFailureJson } from '../util.ts';

const startTime = Date.now();

// Change cwd to engine/ so that engine-relative paths resolve
const engineDir = path.resolve(import.meta.dir, '..', '..', '..');
process.chdir(engineDir);

// Import engine modules (must happen after chdir so dotenv and workers resolve)
const { default: World } = await import('../../../src/engine/World.ts');
const { default: BotManager } = await import('../../runtime/manager.ts');
const { gertrudesCat } = await import('../../scripts/gertrudes-cat.ts');

// Gertrude's Cat varp ID (from content/pack/varp.pack: 180=fluffs)
const FLUFFS_VARP = 180;
const STAGE_COMPLETE = 6;

console.log("Starting world for Gertrude's Cat test...");
await World.start(false, false);

// Initialize nextTick so drift calculation works correctly
World.nextTick = Date.now() + 600;

console.log('World started. Spawning bot...');

let scriptDone = false;
let scriptError: Error | null = null;

const api = BotManager.spawnBot('gertrudescatbot1', async (bot) => {
    try {
        // Wait ticks for the bot to be logged in by processLogins
        await bot.waitForTick();
        await bot.waitForTick();

        await gertrudesCat(bot);
        scriptDone = true;
    } catch (err) {
        scriptError = err as Error;
        bot.log('ERROR', `Script error: ${(err as Error).message}`);
        scriptDone = true;
    }
});

const DEFAULT_TIMEOUT_TICKS = 30000;
const { timedOut, ticksRun } = await runTickLoop({
    maxTicks: DEFAULT_TIMEOUT_TICKS,
    world: World,
    isDone: () => scriptDone,
    getState: () => ({ x: api.player.x, z: api.player.z, totalXp: getTotalXp(api.player) }),
    getLabel: () => 'gertrudescat',
    getHp: () => ({ current: api.player.levels[3]!, max: api.player.baseLevels[3]! }),
    getError: () => scriptError?.message ?? null,
    getQuestVarp: () => api.getQuestProgress(FLUFFS_VARP),
    getSkills: () => ({ Cooking: api.getSkill('Cooking').level }),
    afkThreshold: 500
});

const durationSeconds = Math.round((Date.now() - startTime) / 1000);

if (timedOut || !scriptDone) {
    const pos = api.getPosition();
    const questVarp = api.getQuestProgress(FLUFFS_VARP);
    const inv = api.getInventory().map(i => i.name).join(', ');
    console.error(`TIMEOUT after ${durationSeconds}s (${ticksRun} ticks) - pos=(${pos.x},${pos.z},${pos.level}) quest_varp=${questVarp} inventory=[${inv}]`);
    emitFailureJson({
        error: 'TIMEOUT',
        x: pos.x,
        z: pos.z,
        level: pos.level,
        ticksRun,
        lastState: 'gertrudescat',
        questVarp
    });
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} error="TIMEOUT"`;
    console.log(resultLine);
    process.exit(1);
}

if (scriptError) {
    console.error(`Bot script error: ${scriptError.message}`);
    console.error(scriptError.stack);
    const logPath = path.resolve(import.meta.dir, '..', '..', 'logs', 'gertrudescatbot1.log');
    if (fs.existsSync(logPath)) {
        const lines = fs.readFileSync(logPath, 'utf-8').split('\n');
        const last50 = lines.slice(-51).join('\n');
        console.error('\nLast 50 log lines:');
        console.error(last50);
    }
    const pos = api.getPosition();
    const questVarp = api.getQuestProgress(FLUFFS_VARP);
    emitFailureJson({
        error: scriptError.message,
        x: pos.x,
        z: pos.z,
        level: pos.level,
        ticksRun,
        lastState: 'gertrudescat',
        questVarp
    });
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} error="${scriptError.message}"`;
    console.log(resultLine);
    process.exit(1);
}

// Validate quest completion
const questVarp = api.getQuestProgress(FLUFFS_VARP);
const cooking = api.getSkill('Cooking');

if (questVarp !== STAGE_COMPLETE) {
    console.error(`INCOMPLETE: quest varp is ${questVarp}, expected ${STAGE_COMPLETE}`);
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} error="INCOMPLETE: quest varp is ${questVarp}, expected ${STAGE_COMPLETE}"`;
    console.log(resultLine);
    process.exit(1);
}

if (cooking.exp <= 0) {
    console.error('MISSING REWARD: No Cooking XP gained');
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} cooking_xp=${cooking.exp} error="MISSING REWARD: No Cooking XP gained"`;
    console.log(resultLine);
    process.exit(1);
}

// Success!
console.log('');
console.log("=== Gertrude's Cat Test Results ===");
console.log(`  Quest varp: ${questVarp} (complete)`);
console.log(`  Cooking XP: ${cooking.exp}`);
console.log(`  Duration: ${durationSeconds}s`);
console.log('');

const resultLine = `[RESULT] status=PASS duration=${durationSeconds}s quest_varp=${questVarp} cooking_xp=${cooking.exp}`;
console.log(resultLine);

process.exit(0);
