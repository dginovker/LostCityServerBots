import fs from 'fs';
import path from 'path';

const startTime = Date.now();

// Change cwd to engine/ so that engine-relative paths resolve
const engineDir = path.resolve(import.meta.dir, '..', '..', '..');
process.chdir(engineDir);

// Import engine modules (must happen after chdir so dotenv and workers resolve)
const { default: World } = await import('../../../src/engine/World.ts');
const { default: BotManager } = await import('../../runtime/manager.ts');
const { vampireSlayer } = await import('../../scripts/vampire-slayer.ts');

// Vampire Slayer varp ID (from content/pack/varp.pack: 178=vampire)
const VAMPIRE_SLAYER_VARP = 178;
const STAGE_COMPLETE = 3;

console.log('Starting world for Vampire Slayer test...');
await World.start(false, false);

// Initialize nextTick so drift calculation works correctly
World.nextTick = Date.now() + 600;

console.log('World started. Spawning bot...');

let scriptDone = false;
let scriptError: Error | null = null;

const api = BotManager.spawnBot('vampirebot1', async (bot) => {
    try {
        // Wait ticks for the bot to be logged in by processLogins
        await bot.waitForTick();
        await bot.waitForTick();

        await vampireSlayer(bot);
        scriptDone = true;
    } catch (err) {
        scriptError = err as Error;
        bot.log('ERROR', `Script error: ${(err as Error).message}`);
        scriptDone = true;
    }
});

// Run game ticks until script completes or timeout.
// This quest involves pickpocketing, combat training (killing chickens),
// travel across the map, dialog, and a boss fight — needs generous timeout.
const TIMEOUT_TICKS = 60000;
for (let tick = 0; tick < TIMEOUT_TICKS; tick++) {
    World.cycle();

    // Yield to microtask queue so bot async scripts can advance
    await Promise.resolve();

    if (scriptDone) {
        // Run a few more ticks to let things settle
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
    const questVarp = api.getQuestProgress(VAMPIRE_SLAYER_VARP);
    const attack = api.getSkill('Attack');
    const hitpoints = api.getSkill('Hitpoints');
    const inv = api.getInventory().map(i => i.name).join(', ');
    console.error(`TIMEOUT after ${durationSeconds}s - pos=(${pos.x},${pos.z},${pos.level}) quest_varp=${questVarp} attack_xp=${attack.exp} hp_level=${hitpoints.baseLevel} inventory=[${inv}]`);
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} attack_xp=${attack.exp} error="TIMEOUT"`;
    console.log(resultLine);
    process.exit(1);
}

if (scriptError) {
    // Print error + last 30 log lines
    console.error(`Bot script error: ${scriptError.message}`);
    console.error(scriptError.stack);
    const logPath = path.resolve(import.meta.dir, '..', '..', 'logs', 'vampirebot1.log');
    if (fs.existsSync(logPath)) {
        const lines = fs.readFileSync(logPath, 'utf-8').split('\n');
        const last30 = lines.slice(-31).join('\n');
        console.error('\nLast 30 log lines:');
        console.error(last30);
    }
    const questVarp = api.getQuestProgress(VAMPIRE_SLAYER_VARP);
    const attack = api.getSkill('Attack');
    const hitpoints = api.getSkill('Hitpoints');
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} attack_xp=${attack.exp} hp_level=${hitpoints.baseLevel} error="${scriptError.message}"`;
    console.log(resultLine);
    process.exit(1);
}

// Validate quest completion
const questVarp = api.getQuestProgress(VAMPIRE_SLAYER_VARP);
const attack = api.getSkill('Attack');
const hitpoints = api.getSkill('Hitpoints');

if (questVarp !== STAGE_COMPLETE) {
    console.error(`INCOMPLETE: quest varp is ${questVarp}, expected ${STAGE_COMPLETE}`);
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} attack_xp=${attack.exp} hp_level=${hitpoints.baseLevel} error="INCOMPLETE: quest varp is ${questVarp}, expected ${STAGE_COMPLETE}"`;
    console.log(resultLine);
    process.exit(1);
}

if (attack.exp <= 0) {
    console.error('MISSING REWARD: No attack XP gained');
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} attack_xp=${attack.exp} hp_level=${hitpoints.baseLevel} error="MISSING REWARD: No attack XP gained"`;
    console.log(resultLine);
    process.exit(1);
}

// Success!
console.log('');
console.log('=== Vampire Slayer Test Results ===');
console.log(`  Quest varp: ${questVarp} (complete)`);
console.log(`  Attack XP: ${attack.exp}`);
console.log(`  Hitpoints level: ${hitpoints.baseLevel}`);
console.log(`  Duration: ${durationSeconds}s`);
console.log('');

const resultLine = `[RESULT] status=PASS duration=${durationSeconds}s quest_varp=${questVarp} attack_xp=${attack.exp} hp_level=${hitpoints.baseLevel}`;
console.log(resultLine);

process.exit(0);
