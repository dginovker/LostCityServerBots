import fs from 'fs';
import path from 'path';

const startTime = Date.now();

// Change cwd to engine/ so that engine-relative paths resolve
const engineDir = path.resolve(import.meta.dir, '..', '..', '..');
process.chdir(engineDir);

// Import engine modules (must happen after chdir so dotenv and workers resolve)
const { default: World } = await import('../../../src/engine/World.ts');
const { default: BotManager } = await import('../../runtime/manager.ts');
const { impCatcher } = await import('../../scripts/imp-catcher.ts');

// Imp Catcher varp ID (from content/pack/varp.pack: 160=imp)
const IMP_CATCHER_VARP = 160;
const STAGE_COMPLETE = 2;

console.log('Starting world for Imp Catcher test...');
await World.start(false, false);

// Initialize nextTick so drift calculation works correctly
World.nextTick = Date.now() + 600;

console.log('World started. Spawning bot...');

let scriptDone = false;
let scriptError: Error | null = null;

const api = BotManager.spawnBot('impcatcherbot6', async (bot) => {
    try {
        // Wait ticks for the bot to be logged in by processLogins
        await bot.waitForTick();
        await bot.waitForTick();

        await impCatcher(bot);
        scriptDone = true;
    } catch (err) {
        scriptError = err as Error;
        bot.log('ERROR', `Script error: ${(err as Error).message}`);
        scriptDone = true;
    }
});

// Run game ticks until script completes or timeout.
// This quest involves combat with RNG-based drops, so it could take a while.
// Each bead has ~5/128 (~3.9%) drop rate, so on average ~26 kills per bead.
// With 4 beads needed, expect ~80-130 kills total (with some overlap).
// At ~15 ticks per kill, that's ~1200-1950 ticks for combat alone, plus travel.
// Use a generous timeout.
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
    const questVarp = api.getQuestProgress(IMP_CATCHER_VARP);
    const magic = api.getSkill('Magic');
    const inv = api.getInventory().map(i => i.name).join(', ');
    console.error(`TIMEOUT after ${durationSeconds}s - pos=(${pos.x},${pos.z},${pos.level}) quest_varp=${questVarp} magic_xp=${magic.exp} inventory=[${inv}]`);
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} magic_xp=${magic.exp} error="TIMEOUT"`;
    console.log(resultLine);
    process.exit(1);
}

if (scriptError) {
    // Print error + last 30 log lines
    console.error(`Bot script error: ${scriptError.message}`);
    console.error(scriptError.stack);
    const logPath = path.resolve(import.meta.dir, '..', '..', 'logs', 'impcatcherbot6.log');
    if (fs.existsSync(logPath)) {
        const lines = fs.readFileSync(logPath, 'utf-8').split('\n');
        const last30 = lines.slice(-31).join('\n');
        console.error('\nLast 30 log lines:');
        console.error(last30);
    }
    const questVarp = api.getQuestProgress(IMP_CATCHER_VARP);
    const magic = api.getSkill('Magic');
    const hasAmulet = api.findItem('Amulet of accuracy') !== null;
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} magic_xp=${magic.exp} has_amulet=${hasAmulet} error="${scriptError.message}"`;
    console.log(resultLine);
    process.exit(1);
}

// Validate quest completion
const questVarp = api.getQuestProgress(IMP_CATCHER_VARP);
const magic = api.getSkill('Magic');
const hasAmulet = api.findItem('Amulet of accuracy') !== null;

if (questVarp !== STAGE_COMPLETE) {
    console.error(`INCOMPLETE: quest varp is ${questVarp}, expected ${STAGE_COMPLETE}`);
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} magic_xp=${magic.exp} has_amulet=${hasAmulet} error="INCOMPLETE: quest varp is ${questVarp}, expected ${STAGE_COMPLETE}"`;
    console.log(resultLine);
    process.exit(1);
}

if (magic.exp <= 0) {
    console.error('MISSING REWARD: No magic XP gained');
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} magic_xp=${magic.exp} has_amulet=${hasAmulet} error="MISSING REWARD: No magic XP gained"`;
    console.log(resultLine);
    process.exit(1);
}

if (!hasAmulet) {
    console.error('MISSING REWARD: Amulet of accuracy not in inventory');
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} magic_xp=${magic.exp} has_amulet=${hasAmulet} error="MISSING REWARD: Amulet of accuracy not in inventory"`;
    console.log(resultLine);
    process.exit(1);
}

// Success!
console.log('');
console.log('=== Imp Catcher Test Results ===');
console.log(`  Quest varp: ${questVarp} (complete)`);
console.log(`  Magic XP: ${magic.exp}`);
console.log(`  Has Amulet: ${hasAmulet}`);
console.log(`  Duration: ${durationSeconds}s`);
console.log('');

const resultLine = `[RESULT] status=PASS duration=${durationSeconds}s quest_varp=${questVarp} magic_xp=${magic.exp} has_amulet=${hasAmulet}`;
console.log(resultLine);

process.exit(0);
