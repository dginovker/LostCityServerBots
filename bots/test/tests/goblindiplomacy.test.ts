import fs from 'fs';
import path from 'path';

const startTime = Date.now();

// Change cwd to engine/ so that engine-relative paths resolve
const engineDir = path.resolve(import.meta.dir, '..', '..', '..');
process.chdir(engineDir);

// Import engine modules (must happen after chdir so dotenv and workers resolve)
const { default: World } = await import('../../../src/engine/World.ts');
const { default: BotManager } = await import('../../runtime/manager.ts');
const { goblinDiplomacy } = await import('../../scripts/goblin-diplomacy.ts');

// Goblin Diplomacy varp ID (from content/pack/varp.pack: 62=goblinquest)
const GOBLIN_QUEST_VARP = 62;
const STAGE_COMPLETE = 6;

console.log('Starting world for Goblin Diplomacy test...');
await World.start(false, false);

// Initialize nextTick so drift calculation works correctly
World.nextTick = Date.now() + 600;

console.log('World started. Spawning bot...');

let scriptDone = false;
let scriptError: Error | null = null;

const api = BotManager.spawnBot('gobdipbot1', async (bot) => {
    try {
        // Wait ticks for the bot to be logged in by processLogins
        await bot.waitForTick();
        await bot.waitForTick();

        await goblinDiplomacy(bot);
        scriptDone = true;
    } catch (err) {
        scriptError = err as Error;
        bot.log('ERROR', `Script error: ${(err as Error).message}`);
        scriptDone = true;
    }
});

// Run game ticks until script completes or timeout.
// This quest involves pickpocketing, combat (killing ~60-80 goblins for 3 goblin mails),
// walking across the map, dialog, shopping, and dye-making.
// Generous timeout for RNG-heavy goblin mail farming.
const TIMEOUT_TICKS = 80000;
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
    const questVarp = api.getQuestProgress(GOBLIN_QUEST_VARP);
    const crafting = api.getSkill('Crafting');
    const inv = api.getInventory().map(i => i.name).join(', ');
    console.error(`TIMEOUT after ${durationSeconds}s - pos=(${pos.x},${pos.z},${pos.level}) quest_varp=${questVarp} crafting_xp=${crafting.exp} inventory=[${inv}]`);
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} crafting_xp=${crafting.exp} error="TIMEOUT"`;
    console.log(resultLine);
    process.exit(1);
}

if (scriptError) {
    // Print error + last 30 log lines
    console.error(`Bot script error: ${scriptError.message}`);
    console.error(scriptError.stack);
    const logPath = path.resolve(import.meta.dir, '..', '..', 'logs', 'gobdipbot1.log');
    if (fs.existsSync(logPath)) {
        const lines = fs.readFileSync(logPath, 'utf-8').split('\n');
        const last30 = lines.slice(-31).join('\n');
        console.error('\nLast 30 log lines:');
        console.error(last30);
    }
    const questVarp = api.getQuestProgress(GOBLIN_QUEST_VARP);
    const crafting = api.getSkill('Crafting');
    const hasGoldBar = api.findItem('Gold bar') !== null;
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} crafting_xp=${crafting.exp} has_gold_bar=${hasGoldBar} error="${scriptError.message}"`;
    console.log(resultLine);
    process.exit(1);
}

// Validate quest completion
const questVarp = api.getQuestProgress(GOBLIN_QUEST_VARP);
const crafting = api.getSkill('Crafting');
const hasGoldBar = api.findItem('Gold bar') !== null;

if (questVarp !== STAGE_COMPLETE) {
    console.error(`INCOMPLETE: quest varp is ${questVarp}, expected ${STAGE_COMPLETE}`);
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} crafting_xp=${crafting.exp} has_gold_bar=${hasGoldBar} error="INCOMPLETE: quest varp is ${questVarp}, expected ${STAGE_COMPLETE}"`;
    console.log(resultLine);
    process.exit(1);
}

if (crafting.exp <= 0) {
    console.error('MISSING REWARD: No crafting XP gained');
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} crafting_xp=${crafting.exp} has_gold_bar=${hasGoldBar} error="MISSING REWARD: No crafting XP gained"`;
    console.log(resultLine);
    process.exit(1);
}

if (!hasGoldBar) {
    console.error('MISSING REWARD: Gold bar not in inventory');
    const resultLine = `[RESULT] status=FAIL duration=${durationSeconds}s quest_varp=${questVarp} crafting_xp=${crafting.exp} has_gold_bar=${hasGoldBar} error="MISSING REWARD: Gold bar not in inventory"`;
    console.log(resultLine);
    process.exit(1);
}

// Success!
console.log('');
console.log('=== Goblin Diplomacy Test Results ===');
console.log(`  Quest varp: ${questVarp} (complete)`);
console.log(`  Crafting XP: ${crafting.exp}`);
console.log(`  Has Gold Bar: ${hasGoldBar}`);
console.log(`  Duration: ${durationSeconds}s`);
console.log('');

const resultLine = `[RESULT] status=PASS duration=${durationSeconds}s quest_varp=${questVarp} crafting_xp=${crafting.exp} has_gold_bar=${hasGoldBar}`;
console.log(resultLine);

process.exit(0);
