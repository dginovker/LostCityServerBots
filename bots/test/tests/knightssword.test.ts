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
const { knightsSword } = await import('../../scripts/knights-sword.ts');

// The Knight's Sword varp ID (from content/pack/varp.pack: 122=squire)
const KNIGHTS_SWORD_VARP = 122;
const STAGE_COMPLETE = 7;

console.log('Starting world for Knight\'s Sword test...');
await World.start(false, false);

// Initialize nextTick so drift calculation works correctly
World.nextTick = Date.now() + 600;

console.log('World started. Spawning bot...');

let scriptDone = false;
let scriptError: Error | null = null;

const api = BotManager.spawnBot('ks-1', async (bot) => {
    try {
        // Wait ticks for the bot to be logged in by processLogins
        await bot.waitForTick();
        await bot.waitForTick();

        await knightsSword(bot);
        scriptDone = true;
    } catch (err) {
        scriptError = err as Error;
        bot.log('ERROR', `Script error: ${(err as Error).message}`);
        scriptDone = true;
    }
});

// Run game ticks until script completes or timeout.
// This quest involves significant skill training (mining, smithing, crafting, cooking),
// pottery crafting, pie making, dungeon navigation, and extensive dialog.
const DEFAULT_TIMEOUT_TICKS = 80000;
const { timedOut, ticksRun } = await runTickLoop({
    maxTicks: DEFAULT_TIMEOUT_TICKS,
    world: World,
    isDone: () => scriptDone,
    getState: () => ({ x: api.player.x, z: api.player.z, totalXp: getTotalXp(api.player) }),
    getLabel: () => 'knightssword',
    getHp: () => ({ current: api.player.levels[3]!, max: api.player.baseLevels[3]! }),
    getError: () => scriptError?.message ?? null,
    getQuestVarp: () => api.getQuestProgress(KNIGHTS_SWORD_VARP),
    getSkills: () => ({
        Mining: api.getSkill('Mining').level,
        Smithing: api.getSkill('Smithing').level,
        Crafting: api.getSkill('Crafting').level,
        Cooking: api.getSkill('Cooking').level,
    }),
    afkThreshold: 500
});

const durationSeconds = Math.round((Date.now() - startTime) / 1000);

if (timedOut || !scriptDone) {
    const pos = api.getPosition();
    const questVarp = api.getQuestProgress(KNIGHTS_SWORD_VARP);
    const smithing = api.getSkill('Smithing');
    const inv = api.getInventory().map(i => i.name).join(', ');
    console.error(`TIMEOUT after ${durationSeconds}s (${ticksRun} ticks) - pos=(${pos.x},${pos.z},${pos.level}) quest_varp=${questVarp} smithing_xp=${smithing.exp} inventory=[${inv}]`);
    emitFailureJson({
        error: 'TIMEOUT',
        x: pos.x,
        z: pos.z,
        level: pos.level,
        ticksRun,
        lastState: 'knightssword',
        questVarp,
        skills: { Smithing: smithing.level }
    });
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} smithing_xp=${smithing.exp} error="TIMEOUT"`;
    console.log(resultLine);
    process.exit(1);
}

if (scriptError) {
    // Print error + last 50 log lines
    console.error(`Bot script error: ${scriptError.message}`);
    console.error(scriptError.stack);
    const logPath = path.resolve(import.meta.dir, '..', '..', 'logs', 'ks-1.log');
    if (fs.existsSync(logPath)) {
        const lines = fs.readFileSync(logPath, 'utf-8').split('\n');
        const last50 = lines.slice(-51).join('\n');
        console.error('\nLast 50 log lines:');
        console.error(last50);
    }
    const pos = api.getPosition();
    const questVarp = api.getQuestProgress(KNIGHTS_SWORD_VARP);
    const smithing = api.getSkill('Smithing');
    emitFailureJson({
        error: scriptError.message,
        x: pos.x,
        z: pos.z,
        level: pos.level,
        ticksRun,
        lastState: 'knightssword',
        questVarp,
        skills: { Smithing: smithing.level }
    });
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} smithing_xp=${smithing.exp} error="${scriptError.message}"`;
    console.log(resultLine);
    process.exit(1);
}

// Validate quest completion
const questVarp = api.getQuestProgress(KNIGHTS_SWORD_VARP);
const smithing = api.getSkill('Smithing');

if (questVarp !== STAGE_COMPLETE) {
    console.error(`INCOMPLETE: quest varp is ${questVarp}, expected ${STAGE_COMPLETE}`);
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} smithing_xp=${smithing.exp} error="INCOMPLETE: quest varp is ${questVarp}, expected ${STAGE_COMPLETE}"`;
    console.log(resultLine);
    process.exit(1);
}

// Quest gives 12,725 Smithing XP reward
if (smithing.exp <= 0) {
    console.error('MISSING REWARD: No smithing XP gained');
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} smithing_xp=${smithing.exp} error="MISSING REWARD: No smithing XP gained"`;
    console.log(resultLine);
    process.exit(1);
}

// Success!
console.log('');
console.log('=== The Knight\'s Sword Test Results ===');
console.log(`  Quest varp: ${questVarp} (complete)`);
console.log(`  Smithing XP: ${smithing.exp}`);
console.log(`  Duration: ${durationSeconds}s`);
console.log('');

const resultLine = `[RESULT] status=PASS duration=${durationSeconds}s quest_varp=${questVarp} smithing_xp=${smithing.exp}`;
console.log(resultLine);

process.exit(0);
