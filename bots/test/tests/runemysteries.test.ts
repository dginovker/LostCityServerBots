import fs from 'fs';
import path from 'path';
import { runTickLoop, getTotalXp, getEffectiveMaxTicks, emitFailureJson } from '../util.ts';

const startTime = Date.now();

// Change cwd to engine/ so that engine-relative paths resolve
const engineDir = path.resolve(import.meta.dir, '..', '..', '..');
process.chdir(engineDir);

// Import engine modules (must happen after chdir so dotenv and workers resolve)
const { default: World } = await import('../../../src/engine/World.ts');
const { default: BotManager } = await import('../../runtime/manager.ts');
const { runeMysteries } = await import('../../scripts/rune-mysteries.ts');

// Rune Mysteries varp ID (from content/pack/varp.pack: 63=runemysteries)
const RUNE_MYSTERIES_VARP = 63;
const STAGE_COMPLETE = 6;

console.log('Starting world for rune mysteries test...');
await World.start(false, false);

// Initialize nextTick so drift calculation works correctly
World.nextTick = Date.now() + 600;

console.log('World started. Spawning bot...');

let scriptDone = false;
let scriptError: Error | null = null;

const api = BotManager.spawnBot('runebot0', async (bot) => {
    try {
        // Wait ticks for the bot to be logged in by processLogins
        await bot.waitForTick();
        await bot.waitForTick();

        await runeMysteries(bot);
        scriptDone = true;
    } catch (err) {
        scriptError = err as Error;
        bot.log('ERROR', `Script error: ${(err as Error).message}`);
        scriptDone = true;
    }
});

// Run game ticks until script completes or timeout.
// This quest involves a long walk to Varrock and back — generous timeout.
const DEFAULT_TIMEOUT_TICKS = 25000;
const { timedOut, ticksRun } = await runTickLoop({
    maxTicks: getEffectiveMaxTicks(DEFAULT_TIMEOUT_TICKS),
    world: World,
    isDone: () => scriptDone,
    getState: () => ({ x: api.player.x, z: api.player.z, totalXp: getTotalXp(api.player) }),
    getLabel: () => 'runemysteries',
    getHp: () => ({ current: api.player.levels[3]!, max: api.player.baseLevels[3]! }),
    getError: () => scriptError?.message ?? null,
    getQuestVarp: () => api.getQuestProgress(RUNE_MYSTERIES_VARP),
    getSkills: () => ({ Attack: api.getSkill('Attack').level, Hitpoints: api.getSkill('Hitpoints').level }),
    afkThreshold: 500
});

const durationSeconds = Math.round((Date.now() - startTime) / 1000);

if (timedOut || !scriptDone) {
    const pos = api.getPosition();
    const questVarp = api.getQuestProgress(RUNE_MYSTERIES_VARP);
    const inv = api.getInventory().map(i => i.name).join(', ');
    console.error(`TIMEOUT after ${durationSeconds}s (${ticksRun} ticks) - pos=(${pos.x},${pos.z},${pos.level}) quest_varp=${questVarp} inventory=[${inv}]`);
    emitFailureJson({
        error: 'TIMEOUT',
        x: pos.x,
        z: pos.z,
        level: pos.level,
        ticksRun,
        lastState: 'runemysteries',
        questVarp
    });
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} error="TIMEOUT"`;
    console.log(resultLine);
    process.exit(1);
}

if (scriptError) {
    // Print error + last 30 log lines
    console.error(`Bot script error: ${scriptError.message}`);
    console.error(scriptError.stack);
    const logPath = path.resolve(import.meta.dir, '..', '..', 'logs', 'runebot0.log');
    if (fs.existsSync(logPath)) {
        const lines = fs.readFileSync(logPath, 'utf-8').split('\n');
        const last30 = lines.slice(-31).join('\n');
        console.error('\nLast 30 log lines:');
        console.error(last30);
    }
    const pos = api.getPosition();
    const questVarp = api.getQuestProgress(RUNE_MYSTERIES_VARP);
    emitFailureJson({
        error: scriptError.message,
        x: pos.x,
        z: pos.z,
        level: pos.level,
        ticksRun,
        lastState: 'runemysteries',
        questVarp
    });
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} error="${scriptError.message}"`;
    console.log(resultLine);
    process.exit(1);
}

// Validate quest completion
const questVarp = api.getQuestProgress(RUNE_MYSTERIES_VARP);

if (questVarp !== STAGE_COMPLETE) {
    console.error(`INCOMPLETE: quest varp is ${questVarp}, expected ${STAGE_COMPLETE}`);
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} error="INCOMPLETE: quest varp is ${questVarp}, expected ${STAGE_COMPLETE}"`;
    console.log(resultLine);
    process.exit(1);
}

// Verify Air talisman in inventory
const talisman = api.findItem('Air talisman');
if (!talisman) {
    console.error('MISSING REWARD: Air talisman not in inventory');
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} error="MISSING REWARD: Air talisman not in inventory"`;
    console.log(resultLine);
    process.exit(1);
}

// Success!
console.log('');
console.log('=== Rune Mysteries Test Results ===');
console.log(`  Quest varp: ${questVarp} (complete)`);
console.log('  Air talisman: in inventory');
console.log(`  Duration: ${durationSeconds}s`);
console.log('');

const resultLine = `[RESULT] status=PASS duration=${durationSeconds}s quest_varp=${questVarp}`;
console.log(resultLine);

process.exit(0);
