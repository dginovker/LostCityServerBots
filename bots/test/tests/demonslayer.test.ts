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
const { demonSlayer } = await import('../../scripts/demon-slayer.ts');

// Demon Slayer varp ID (from content/pack/varp.pack: 222=demonstart)
const DEMON_SLAYER_VARP = 222;
const STAGE_COMPLETE = 30;

console.log('Starting world for Demon Slayer test...');
await World.start(false, false);

// Initialize nextTick so drift calculation works correctly
World.nextTick = Date.now() + 600;

console.log('World started. Spawning bot...');

let scriptDone = false;
let scriptError: Error | null = null;

const api = BotManager.spawnBot('demonslayerbot1', async (bot) => {
    try {
        // Wait ticks for the bot to be logged in by processLogins
        await bot.waitForTick();
        await bot.waitForTick();

        await demonSlayer(bot);
        scriptDone = true;
    } catch (err) {
        scriptError = err as Error;
        bot.log('ERROR', `Script error: ${(err as Error).message}`);
        scriptDone = true;
    }
});

// Run game ticks until script completes or timeout.
// This quest involves pickpocketing, extensive dialog, collecting 25 bones,
// combat with Delrith (possibly multiple attempts with death recovery),
// and travel across the map. Give a very generous timeout.
const DEFAULT_TIMEOUT_TICKS = 80000;
const { timedOut, ticksRun } = await runTickLoop({
    maxTicks: getEffectiveMaxTicks(DEFAULT_TIMEOUT_TICKS),
    world: World,
    isDone: () => scriptDone,
    getState: () => ({ x: api.player.x, z: api.player.z, totalXp: getTotalXp(api.player) }),
    getLabel: () => 'demonslayer',
    getHp: () => ({ current: api.player.levels[3]!, max: api.player.baseLevels[3]! }),
    getError: () => scriptError?.message ?? null,
    getQuestVarp: () => api.getQuestProgress(DEMON_SLAYER_VARP),
    getSkills: () => ({ Attack: api.getSkill('Attack').level, Hitpoints: api.getSkill('Hitpoints').level }),
    afkThreshold: 500
});

const durationSeconds = Math.round((Date.now() - startTime) / 1000);

if (timedOut || !scriptDone) {
    const pos = api.getPosition();
    const questVarp = api.getQuestProgress(DEMON_SLAYER_VARP);
    const attack = api.getSkill('Attack');
    const inv = api.getInventory().map(i => i.name).join(', ');
    console.error(`TIMEOUT after ${durationSeconds}s (${ticksRun} ticks) - pos=(${pos.x},${pos.z},${pos.level}) quest_varp=${questVarp} attack_xp=${attack.exp} inventory=[${inv}]`);
    emitFailureJson({
        error: 'TIMEOUT',
        x: pos.x,
        z: pos.z,
        level: pos.level,
        ticksRun,
        lastState: 'demonslayer',
        questVarp,
        skills: { Attack: attack.level }
    });
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} attack_xp=${attack.exp} error="TIMEOUT"`;
    console.log(resultLine);
    process.exit(1);
}

if (scriptError) {
    // Print error + last 30 log lines
    console.error(`Bot script error: ${scriptError.message}`);
    console.error(scriptError.stack);
    const logPath = path.resolve(import.meta.dir, '..', '..', 'logs', 'demonslayerbot1.log');
    if (fs.existsSync(logPath)) {
        const lines = fs.readFileSync(logPath, 'utf-8').split('\n');
        const last30 = lines.slice(-31).join('\n');
        console.error('\nLast 30 log lines:');
        console.error(last30);
    }
    const pos = api.getPosition();
    const questVarp = api.getQuestProgress(DEMON_SLAYER_VARP);
    const attack = api.getSkill('Attack');
    emitFailureJson({
        error: scriptError.message,
        x: pos.x,
        z: pos.z,
        level: pos.level,
        ticksRun,
        lastState: 'demonslayer',
        questVarp,
        skills: { Attack: attack.level }
    });
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} attack_xp=${attack.exp} error="${scriptError.message}"`;
    console.log(resultLine);
    process.exit(1);
}

// Validate quest completion
const questVarp = api.getQuestProgress(DEMON_SLAYER_VARP);
const attack = api.getSkill('Attack');

if (questVarp !== STAGE_COMPLETE) {
    console.error(`INCOMPLETE: quest varp is ${questVarp}, expected ${STAGE_COMPLETE}`);
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} attack_xp=${attack.exp} error="INCOMPLETE: quest varp is ${questVarp}, expected ${STAGE_COMPLETE}"`;
    console.log(resultLine);
    process.exit(1);
}

if (attack.exp <= 0) {
    console.error('MISSING XP: No attack XP gained during quest');
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} attack_xp=${attack.exp} error="MISSING XP: No attack XP gained"`;
    console.log(resultLine);
    process.exit(1);
}

// Success!
console.log('');
console.log('=== Demon Slayer Test Results ===');
console.log(`  Quest varp: ${questVarp} (complete)`);
console.log(`  Attack XP: ${attack.exp}`);
console.log(`  Duration: ${durationSeconds}s`);
console.log('');

const resultLine = `[RESULT] status=PASS duration=${durationSeconds}s quest_varp=${questVarp} attack_xp=${attack.exp}`;
console.log(resultLine);

process.exit(0);
