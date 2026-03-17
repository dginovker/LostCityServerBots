import { BotAPI } from '../../runtime/api.js';
import { skipTutorial } from '../skip-tutorial.js';
import { type BotState, runStateMachine } from '../../runtime/state-machine.js';
import type { ScriptMeta } from '../../runtime/script-meta.js';
import { walkLumbridgeToVarrock } from '../shared-routes.js';

// Varp ID for The Knight's Sword (from content/pack/varp.pack: 122=squire)
const KNIGHTS_SWORD_VARP = 122;

// Quest stages (from content/scripts/quests/quest_squire/configs/quest_squire.constant)
const STAGE_NOT_STARTED = 0;
const STAGE_STARTED = 1;         // Talked to Squire, agreed to help
const STAGE_SPOKEN_RELDO = 2;    // Talked to Reldo about Imcando dwarves
const STAGE_GIVEN_PIE = 3;       // Gave redberry pie to Thurgo
const STAGE_SPOKEN_THURGO = 4;   // Thurgo agreed to help, needs portrait
const STAGE_LOOKING_PORTRAIT = 5; // Squire told about portrait in Vyvin's cupboard
const STAGE_LOOKING_BLURITE = 6; // Gave portrait to Thurgo, need materials
const STAGE_COMPLETE = 7;

// Stun/delay varps (for pickpocketing GP)
const VARP_ACTION_DELAY = 58;
const VARP_STUNNED = 103;

// ---- Key locations ----

const LUMBRIDGE_X = 3222;
const LUMBRIDGE_Z = 3218;

// Lumbridge General Store
const GENERAL_STORE_X = 3212;
const GENERAL_STORE_Z = 3247;

// Lumbridge furnace
const FURNACE_X = 3226;
const FURNACE_Z = 3255;

// Falador Castle entrance
const FALADOR_CASTLE_X = 2970;
const FALADOR_CASTLE_Z = 3343;

// Rimmington mine (NOT USED — rocks have collision flags blocking interaction)
const RIMMINGTON_MINE_X = 2978;
const RIMMINGTON_MINE_Z = 3235;

// Varrock SE mine — copper, tin, and iron rocks confirmed accessible (l51_51)
// copper: (3296,3314), (3297,3315), (3301,3318); tin: (3302,3316); iron: (3294-3304,3309-3311)
const VARROCK_MINE_X = 3298;
const VARROCK_MINE_Z = 3315;

// Champion's Guild clay mine — clay rocks confirmed accessible (l49_52)
// clayrock1: (3180,3372); clayrock2: (3179,3371), (3183,3377)
const _CLAY_MINE_X = 3183;
const _CLAY_MINE_Z = 3372;

// Barbarian Village pottery area
const BARB_POTTERY_X = 3085;
const BARB_POTTERY_Z = 3409;

// Port Sarim - Wydin's Food Store
const WYDIN_SHOP_X = 3013;
const WYDIN_SHOP_Z = 3204;

// Thurgo's peninsula (south of Port Sarim) — actual spawn at (3001, 3144) from n46_49 map data
const THURGO_AREA_X = 3001;
const THURGO_AREA_Z = 3144;

// Ice dungeon entrance (south of Thurgo, on peninsula cliffs)
const ICE_DUNGEON_ENTRANCE_X = 3007;
const ICE_DUNGEON_ENTRANCE_Z = 3150;

// Varrock Palace (Reldo is in the library)
const VARROCK_PALACE_X = 3210;
const VARROCK_PALACE_Z = 3475;

// Vyvin's cupboard (level 2 of Falador castle)
const VYVIN_CUPBOARD_X = 2984;
const VYVIN_CUPBOARD_Z = 3336;

// ---- Route waypoints ----

const ROUTE_LUMBRIDGE_TO_FALADOR = [
    { x: 3105, z: 3250 },   // West toward Draynor
    { x: 2970, z: 3240 },   // SW to Rimmington area
    { x: 2965, z: 3370 },   // North to south Falador
    { x: 2965, z: 3394 },   // Falador south gate
];

const ROUTE_FALADOR_TO_PORT_SARIM = [
    { x: 2965, z: 3370 },   // South of Falador
    { x: 2965, z: 3310 },   // Further south
    { x: 2965, z: 3250 },   // Near Rimmington
    { x: 3013, z: 3210 },   // Port Sarim dock area
];

const ROUTE_PORT_SARIM_TO_THURGO = [
    { x: 3013, z: 3210 },   // Port Sarim
    { x: 3005, z: 3175 },   // South along road
    { x: THURGO_AREA_X, z: THURGO_AREA_Z },  // Thurgo's hut (3001, 3144)
];

const _ROUTE_LUMBRIDGE_TO_RIMMINGTON = [
    { x: 3105, z: 3250 },   // West toward Draynor
    { x: 2970, z: 3240 },   // Rimmington area
    { x: RIMMINGTON_MINE_X, z: RIMMINGTON_MINE_Z },
];

// ---- Utility functions ----

async function walkRoute(bot: BotAPI, waypoints: { x: number; z: number }[]): Promise<void> {
    for (const wp of waypoints) {
        await bot.walking.walkToWithPathfinding(wp.x, wp.z);
    }
}

/**
 * Walk to Varrock SE mine from anywhere. Used for copper/tin/iron mining.
 */
async function _walkToVarrockMine(bot: BotAPI): Promise<void> {
    if ((bot.player.z > 3270 && bot.player.x > 3200) || (bot.player.z > 3450 && bot.player.x > 3150)) {
        // Already near Varrock east/mine area — go straight to mine
    } else if (bot.player.x < 3100) {
        // West side (Falador area) — go east via Varrock west gate
        await bot.walking.walkToWithPathfinding(3175, 3427);
    } else {
        // South or Lumbridge area — go north via Barbarian Village route
        await walkLumbridgeToVarrock(bot);
    }
    await bot.walking.walkToWithPathfinding(VARROCK_MINE_X, VARROCK_MINE_Z);
}

/**
 * Walk to Champion's Guild clay mine from anywhere.
 * Positions the bot at (3180,3371) — south of clayrock1 at (3180,3372) —
 * to ensure a valid south-face approach (east face is collision-blocked).
 */
async function walkToClayMine(bot: BotAPI): Promise<void> {
    // Champion's Guild is just south of Varrock west
    if (bot.player.z < 3350) {
        // From south — go through Lumbridge/Falador road
        await bot.walking.walkToWithPathfinding(3105, 3305);
        await bot.walking.walkToWithPathfinding(3175, 3427);
    } else if (bot.player.x > 3200) {
        // From Varrock east — go west
        await bot.walking.walkToWithPathfinding(3175, 3427);
    }
    // Walk to tile south of clayrock1 (3180,3372) — east face is collision-blocked
    await bot.walking.walkToWithPathfinding(3180, 3371);
}

/**
 * Pickpocket men in Lumbridge to earn GP.
 */
async function earnGp(bot: BotAPI, targetGp: number): Promise<void> {
    bot.log('STATE', `=== Earning ${targetGp}gp by pickpocketing men ===`);
    await bot.walking.walkToWithPathfinding(LUMBRIDGE_X, LUMBRIDGE_Z);

    let attempts = 0;
    const MAX_ATTEMPTS = 800;

    while (attempts < MAX_ATTEMPTS) {
        const coins = bot.inventory.find('Coins');
        const currentGp = coins ? coins.count : 0;
        if (currentGp >= targetGp) {
            bot.log('EVENT', `Earned ${currentGp}gp (target: ${targetGp}gp)`);
            return;
        }

        bot.dialog.dismissModals();

        // Wait for HP to regen if low (avoid dying and losing coins)
        const hp = bot.player.levels[3]!;
        if (hp <= 3) {
            bot.log('STATE', `Low HP (${hp}), waiting for regen...`);
            await bot.waitForTicks(50); // Wait for natural HP regen
            continue;
        }

        const stunnedUntil = bot.getVarp(VARP_STUNNED);
        const actionDelayUntil = bot.getVarp(VARP_ACTION_DELAY);
        const currentTick = bot.getCurrentTick();

        if (stunnedUntil > currentTick || actionDelayUntil > currentTick) {
            const waitUntil = Math.max(stunnedUntil, actionDelayUntil);
            await bot.waitForTicks(waitUntil - currentTick + 1);
        }

        if (bot.player.delayed) {
            await bot.waitForCondition(() => !bot.player.delayed, 20);
        }

        let man = bot.interaction.findNpc('Man');
        if (!man) {
            await bot.walking.walkTo(LUMBRIDGE_X, LUMBRIDGE_Z);
            await bot.waitForTicks(2);
            man = bot.interaction.findNpc('Man');
            if (!man) throw new Error('No Man NPC found near Lumbridge');
        }

        attempts++;
        await bot.interaction.npc(man, 3); // op3 = Pickpocket
        await bot.waitForTicks(6);
        bot.dialog.dismissModals();
    }

    const finalCoins = bot.inventory.find('Coins');
    throw new Error(`Failed to earn ${targetGp}gp after ${MAX_ATTEMPTS} attempts. Current: ${finalCoins ? finalCoins.count : 0}`);
}

/**
 * Mine a specific ore until we have the required amount.
 */
async function mineOre(bot: BotAPI, rockNames: string[], oreName: string, needed: number): Promise<void> {
    let mineAttempts = 0;
    const MAX_MINE_ATTEMPTS = 300;

    while (bot.inventory.count(oreName) < needed && mineAttempts < MAX_MINE_ATTEMPTS) {
        await bot.dialog.clearPendingState();

        let rock = null;
        for (const name of rockNames) {
            rock = bot.interaction.findLoc(name);
            if (rock) break;
        }

        if (!rock) {
            if (mineAttempts === 0) {
                const nearby = bot.interaction.findAllLocs(20);
                bot.log('STATE', `No ${rockNames.join('/')} found at (${bot.player.x},${bot.player.z}). Nearby locs: ${nearby.slice(0, 10).map(l => `${l.debugname}@(${l.x},${l.z})`).join(', ')}`);
            }
            await bot.waitForTicks(15);
            mineAttempts++;
            continue;
        }

        const countBefore = bot.inventory.count(oreName);
        await bot.interaction.loc(rock, 1);

        for (let i = 0; i < 30; i++) {
            await bot.waitForTick();
            if (bot.inventory.count(oreName) > countBefore) break;
        }

        await bot.waitForTicks(1);
        bot.dialog.dismissModals();
        mineAttempts = 0;

        const current = bot.inventory.count(oreName);
        if (current > countBefore) {
            bot.log('EVENT', `Mined ${oreName}: ${current}/${needed}`);
        }
    }

    if (bot.inventory.count(oreName) < needed) {
        throw new Error(`Failed to mine enough ${oreName}: got ${bot.inventory.count(oreName)}, needed ${needed}`);
    }
}

/**
 * Train mining by mining copper and tin at the current location.
 */
async function trainMiningToLevel(bot: BotAPI, targetLevel: number): Promise<void> {
    bot.log('STATE', `Training Mining to ${targetLevel} (currently ${bot.getSkill('Mining').baseLevel})`);

    while (bot.getSkill('Mining').baseLevel < targetLevel) {
        await bot.dialog.clearPendingState();

        // Drop excess ores to keep space
        if (bot.inventory.freeSlots() < 1) {
            for (const ore of ['Tin ore', 'Copper ore', 'Clay']) {
                if (bot.inventory.find(ore)) {
                    await bot.interaction.dropItem(ore);
                    await bot.waitForTicks(1);
                    break;
                }
            }
            if (bot.inventory.freeSlots() < 1) throw new Error('Inventory full during mining training');
        }

        const rock = bot.interaction.findLoc('copperrock1') ?? bot.interaction.findLoc('tinrock1')
            ?? bot.interaction.findLoc('copperrock2') ?? bot.interaction.findLoc('tinrock2');
        if (!rock) {
            await bot.waitForTicks(15);
            continue;
        }

        const xpBefore = bot.getSkill('Mining').exp;
        await bot.interaction.loc(rock, 1);

        for (let i = 0; i < 30; i++) {
            await bot.waitForTick();
            if (bot.getSkill('Mining').exp > xpBefore) break;
        }

        await bot.waitForTicks(1);
        bot.dialog.dismissModals();

        if (bot.getSkill('Mining').baseLevel % 3 === 0 || bot.getSkill('Mining').baseLevel >= targetLevel) {
            bot.log('STATE', `Mining: level ${bot.getSkill('Mining').baseLevel}`);
        }
    }

    bot.log('EVENT', `Mining trained to level ${bot.getSkill('Mining').baseLevel}`);
}

/**
 * Smelt bars at the Lumbridge furnace using useItemOnLoc.
 * For bronze: uses copper ore on furnace (auto-detects bronze with tin in inventory).
 * For iron: uses iron ore on furnace.
 */
async function smeltBars(bot: BotAPI, oreName: string, barName: string, count: number): Promise<void> {
    bot.log('STATE', `Smelting ${count} ${barName}s from ${oreName}`);

    await bot.walking.walkToWithPathfinding(FURNACE_X - 1, FURNACE_Z); // Furnace tile itself is blocked

    let attempts = 0;
    const MAX_ATTEMPTS = count * 5; // Extra for failures (iron has 50% rate)

    while (bot.inventory.count(barName) < count && attempts < MAX_ATTEMPTS) {
        if (!bot.inventory.find(oreName)) {
            throw new Error(`Ran out of ${oreName} while smelting. Have ${bot.inventory.count(barName)}/${count} ${barName}s`);
        }

        await bot.dialog.clearPendingState();
        const barsBefore = bot.inventory.count(barName);

        await bot.interaction.useItemOnLoc(oreName, 'furnace1');
        await bot.waitForTicks(8);
        bot.dialog.dismissModals();

        if (bot.inventory.count(barName) > barsBefore) {
            bot.log('EVENT', `Smelted ${barName}: ${bot.inventory.count(barName)}/${count}`);
        }
        attempts++;
    }

    if (bot.inventory.count(barName) < count) {
        throw new Error(`Failed to smelt enough ${barName}: got ${bot.inventory.count(barName)}, needed ${count}`);
    }
}

/**
 * Train smithing by smelting bronze bars at the Lumbridge furnace.
 */
async function trainSmithingToLevel(bot: BotAPI, targetLevel: number): Promise<void> {
    bot.log('STATE', `Training Smithing to ${targetLevel} (currently ${bot.getSkill('Smithing').baseLevel})`);

    while (bot.getSkill('Smithing').baseLevel < targetLevel) {
        // Mine copper and tin at Rimmington mine (west side — no routing barrier issues)
        bot.log('STATE', 'Mining copper and tin for smithing training...');
        await bot.walking.walkToWithPathfinding(RIMMINGTON_MINE_X, RIMMINGTON_MINE_Z);

        // Drop anything unnecessary to make room
        for (const junk of ['Clay', 'Tin ore', 'Copper ore', 'Bronze bar']) {
            while (bot.inventory.find(junk) && bot.inventory.freeSlots() < 5) {
                await bot.interaction.dropItem(junk);
                await bot.waitForTicks(1);
            }
        }

        // Mine equal amounts of copper and tin (fill ~half inventory with each)
        const slotsForOres = Math.min(Math.floor(bot.inventory.freeSlots() / 2), 10);
        if (slotsForOres < 2) {
            // Drop more stuff
            for (const item of ['Bronze bar', 'Clay', 'Soft clay']) {
                while (bot.inventory.find(item)) {
                    await bot.interaction.dropItem(item);
                    await bot.waitForTicks(1);
                }
            }
        }

        await mineOre(bot, ['copperrock1', 'copperrock2'], 'Copper ore', slotsForOres);
        await mineOre(bot, ['tinrock1', 'tinrock2'], 'Tin ore', slotsForOres);

        // Walk east to Lumbridge furnace
        await bot.walking.walkToWithPathfinding(FURNACE_X - 1, FURNACE_Z);

        while (bot.inventory.find('Copper ore') && bot.inventory.find('Tin ore')) {
            await bot.dialog.clearPendingState();
            const xpBefore = bot.getSkill('Smithing').exp;

            await bot.interaction.useItemOnLoc('Copper ore', 'furnace1');
            await bot.waitForTicks(8);
            bot.dialog.dismissModals();

            if (bot.getSkill('Smithing').exp > xpBefore) {
                bot.log('STATE', `Smithing: level ${bot.getSkill('Smithing').baseLevel}, XP: ${bot.getSkill('Smithing').exp}`);
            }

            if (bot.getSkill('Smithing').baseLevel >= targetLevel) break;
        }

        // Drop excess bronze bars
        while (bot.inventory.find('Bronze bar')) {
            await bot.interaction.dropItem('Bronze bar');
            await bot.waitForTicks(1);
        }
    }

    bot.log('EVENT', `Smithing trained to level ${bot.getSkill('Smithing').baseLevel}`);
}

/**
 * Navigate to Falador castle and climb to the specified floor level.
 * Uses the same stair patterns as the BKF script.
 */
async function walkToFaladorCastleFloor(bot: BotAPI, targetLevel: number): Promise<void> {
    const currentLevel = bot.player.level as number;

    if (currentLevel === 0 && targetLevel > 0) {
        await bot.walking.walkToWithPathfinding(FALADOR_CASTLE_X, FALADOR_CASTLE_Z);
        await bot.walking.walkToWithPathfinding(2960, 3339); // Near stairs

        // Climb level 0 → 1
        await bot.interaction.climbStairs('loc_1738', 1);
        await bot.waitForTicks(3);
        if ((bot.player.level as number) !== 1) {
            throw new Error(`Failed to climb to level 1: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
        }
    }

    if ((bot.player.level as number) === 1 && targetLevel === 2) {
        // Find staircase on level 1 to go up
        const l1Locs = bot.interaction.findAllLocs(20);
        const l1Stairs = l1Locs.filter(l => l.displayName === 'Staircase');

        let stairsUp = bot.interaction.findLoc('loc_1739', 20);
        if (stairsUp) {
            await bot.interaction.climbStairs('loc_1739', 2); // op2=Climb-up
        } else {
            stairsUp = bot.interaction.findLoc('loc_1738', 20);
            if (!stairsUp && l1Stairs.length > 0) {
                stairsUp = l1Stairs[0]!.loc;
            }
            if (!stairsUp) throw new Error('No staircase found on level 1');
            const info = l1Stairs.find(s => s.loc === stairsUp);
            await bot.interaction.climbStairs(info ? info.debugname : 'loc_1738', 1);
        }
        await bot.waitForTicks(3);
        if ((bot.player.level as number) !== 2) {
            throw new Error(`Failed to climb to level 2: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
        }
    }
}

/**
 * Climb down from current floor to ground level in Falador castle.
 */
async function descendFaladorCastle(bot: BotAPI): Promise<void> {
    while ((bot.player.level as number) > 0) {
        const currentLevel = bot.player.level as number;

        // loc_1739: op3=Climb-down; loc_1740/loc_1736/loc_1733/loc_1723: op1=Climb-down
        let downStairs = bot.interaction.findLoc('loc_1739', 20);
        if (downStairs) {
            await bot.interaction.climbStairs('loc_1739', 3);
        } else {
            downStairs = bot.interaction.findLoc('loc_1740', 20)
                ?? bot.interaction.findLoc('loc_1736', 20)
                ?? bot.interaction.findLoc('loc_1733', 20)
                ?? bot.interaction.findLoc('loc_1723', 20);
            if (!downStairs) {
                throw new Error(`No down staircase on level ${currentLevel} near (${bot.player.x},${bot.player.z})`);
            }
            await bot.interaction.loc(downStairs, 1); // op1=Climb-down
        }
        await bot.waitForTicks(5);

        if ((bot.player.level as number) >= currentLevel) {
            throw new Error(`Failed to descend from level ${currentLevel}: still at level ${bot.player.level}`);
        }
    }
}

/**
 * Walk from Lumbridge area to Port Sarim (Wydin's shop area).
 */
async function walkToPortSarim(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Walking to Port Sarim ===');
    await bot.walking.walkToWithPathfinding(3105, 3250); // West toward Draynor
    await bot.walking.walkToWithPathfinding(3020, 3240); // SW
    await bot.walking.walkToWithPathfinding(WYDIN_SHOP_X, WYDIN_SHOP_Z);
}

/**
 * Walk to Port Sarim shop area, skipping if already nearby.
 */
async function walkToPortSarimShops(bot: BotAPI): Promise<void> {
    const dist = Math.max(Math.abs(bot.player.x - WYDIN_SHOP_X), Math.abs(bot.player.z - WYDIN_SHOP_Z));
    if (dist <= 15) {
        await bot.walking.walkToWithPathfinding(WYDIN_SHOP_X, WYDIN_SHOP_Z);
        return;
    }
    await walkToPortSarim(bot);
}

/**
 * Walk to the Rimmington cooking range (loc_2728) inside Hetty's house.
 */
async function walkToRimmingtonRange(bot: BotAPI): Promise<void> {
    const dist = Math.max(Math.abs(bot.player.x - 2968), Math.abs(bot.player.z - 3205));
    if (dist <= 10) {
        await bot.walking.walkToWithPathfinding(2968, 3205);
        return;
    }
    // Walk to Rimmington area first
    if (bot.player.x > 3050) {
        await bot.walking.walkToWithPathfinding(3105, 3250);
        await bot.walking.walkToWithPathfinding(3020, 3240); // stop east of Melzar's Maze
    }
    await bot.walking.walkToWithPathfinding(2968, 3205);
}

/**
 * Walk from Port Sarim to Thurgo's hut on the southern peninsula.
 */
async function walkToThurgo(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Walking to Thurgo ===');
    // Ensure on ground level (not in a height-level dungeon, and not in underground z+6400 dungeon)
    if ((bot.player.level as number) > 0) {
        await descendFaladorCastle(bot);
    }
    if (bot.player.z > 6400) {
        throw new Error(`walkToThurgo called while underground: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    // If near Falador, go south to Port Sarim first
    if (bot.player.z > 3300) {
        await walkRoute(bot, ROUTE_FALADOR_TO_PORT_SARIM);
    } else if (bot.player.x > 3100) {
        // Near Lumbridge, go west
        await walkToPortSarim(bot);
    }
    await walkRoute(bot, ROUTE_PORT_SARIM_TO_THURGO);
}

/**
 * Walk from Thurgo's area back to Falador.
 */
async function walkThurgoToFalador(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Walking from Thurgo to Falador ===');
    await bot.walking.walkToWithPathfinding(3000, 3175);
    await bot.walking.walkToWithPathfinding(3013, 3210); // Port Sarim
    await bot.walking.walkToWithPathfinding(2965, 3250);
    await bot.walking.walkToWithPathfinding(2965, 3370);
    await bot.walking.walkToWithPathfinding(FALADOR_CASTLE_X, FALADOR_CASTLE_Z);
}

// ---- Quest dialog functions ----

/**
 * Talk to the Squire to start the quest (varp 0→1).
 * Dialog path: choice2→1, choice3→2, choice2→1, choice2→1
 */
async function talkToSquire_Start(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Talking to Squire to start quest ===');

    await bot.walking.walkToWithPathfinding(FALADOR_CASTLE_X, FALADOR_CASTLE_Z);
    await bot.walking.walkToWithPathfinding(2965, 3340); // Inside castle courtyard

    let squire = bot.interaction.findNpc('Squire');
    if (!squire) {
        // Try walking around the courtyard
        await bot.walking.walkToWithPathfinding(2960, 3336);
        squire = bot.interaction.findNpc('Squire');
        if (!squire) throw new Error(`Squire not found near (${bot.player.x},${bot.player.z})`);
    }

    await bot.interaction.npc(squire, 1); // Talk-to
    if (!await bot.dialog.waitFor(30)) throw new Error('No dialog from Squire');

    // chatnpc "Hello. I am the squire to Sir Vyvin."
    await bot.dialog.continue();

    // p_choice2: "And how is life as a squire?" (1) / "Wouldn't you prefer..." (2)
    if (!await bot.dialog.waitFor(10)) throw new Error('No choice dialog from Squire');
    await bot.dialog.selectOption(1);

    // chatplayer "And how is life as a squire?"
    if (!await bot.dialog.waitFor(10)) throw new Error('No dialog after choice');
    await bot.dialog.continue();

    // chatnpc about lost sword
    if (!await bot.dialog.waitFor(10)) throw new Error('No dialog about lost sword');
    await bot.dialog.continue();

    // p_choice3: "Do you know where..." (1), "I can make a new sword..." (2), "Is he angry?" (3)
    if (!await bot.dialog.waitFor(10)) throw new Error('No choice3 dialog');
    await bot.dialog.selectOption(2); // "I can make a new sword if you like..."

    // chatplayer "I can make a new sword if you like..."
    if (!await bot.dialog.waitFor(10)) throw new Error('No dialog after sword offer');
    await bot.dialog.continue();

    // chatnpc "Thanks for the offer. I'd be surprised if you could though."
    if (!await bot.dialog.waitFor(10)) throw new Error('No dialog: thanks for offer');
    await bot.dialog.continue();

    // chatnpc "The thing is, this sword is a family heirloom..." (squire_thing_is, page 1)
    if (!await bot.dialog.waitFor(10)) throw new Error('No dialog: heirloom');
    await bot.dialog.continue();

    // chatnpc "a particularly skilled tribe of dwarven smiths..." (squire_thing_is, page 2)
    if (!await bot.dialog.waitFor(10)) throw new Error('No dialog: dwarven smiths');
    await bot.dialog.continue();

    // p_choice2: "So would these dwarves make another one?" (1), "Well I hope..." (2)
    if (!await bot.dialog.waitFor(10)) throw new Error('No choice about dwarves');
    await bot.dialog.selectOption(1);

    // chatplayer "So would these dwarves make another one?"
    if (!await bot.dialog.waitFor(10)) throw new Error('No dialog after dwarf choice');
    await bot.dialog.continue();

    // chatnpc "I'm not a hundred percent sure..." about Reldo
    if (!await bot.dialog.waitFor(10)) throw new Error('No dialog about Reldo');
    await bot.dialog.continue();

    // chatnpc "I don't suppose you could try..." asking for help
    if (!await bot.dialog.waitFor(10)) throw new Error('No dialog asking for help');
    await bot.dialog.continue();

    // p_choice2: "Ok, I'll give it a go." (1), "No, I've got lots of mining work..." (2)
    if (!await bot.dialog.waitFor(10)) throw new Error('No acceptance choice');
    await bot.dialog.selectOption(1);

    // chatplayer "Ok, I'll give it a go." → varp set to 1
    if (!await bot.dialog.waitFor(10)) throw new Error('No dialog after accepting');
    await bot.dialog.continue();

    // chatnpc "Thank you very much!..."
    await bot.dialog.continueRemaining();
    await bot.waitForTicks(2);

    const varp = bot.getQuestProgress(KNIGHTS_SWORD_VARP);
    if (varp !== STAGE_STARTED) {
        throw new Error(`Quest varp after starting is ${varp}, expected ${STAGE_STARTED}`);
    }
    bot.log('EVENT', `Quest started: varp=${varp}`);
}

/**
 * Talk to Reldo in Varrock Palace library (varp 1→2).
 * With squire stage 1 and phoenixgang not started, Reldo shows multi4.
 * Option 4 = "What do you know about the Imcando dwarves?"
 */
async function talkToReldo(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Talking to Reldo ===');

    // Only walk to Varrock if we're not already near Varrock
    if (bot.player.x < 3150 || bot.player.z < 3400) {
        // If near Falador, go north then east to join the Varrock route
        if (bot.player.x < 3050 && bot.player.z > 3300) {
            await bot.walking.walkToWithPathfinding(2965, 3394); // North Falador area (proven waypoint)
            await bot.walking.walkToWithPathfinding(3080, 3400); // East to north of Barb Village
            await bot.walking.walkToWithPathfinding(3175, 3427); // Varrock west gate
        } else {
            await walkLumbridgeToVarrock(bot);
        }
    }
    // Walk into the palace
    await bot.walking.walkToWithPathfinding(VARROCK_PALACE_X, VARROCK_PALACE_Z);
    // Library is in the NW corner of the palace
    await bot.walking.walkToWithPathfinding(3209, 3492);

    let reldo = bot.interaction.findNpc('Reldo');
    if (!reldo) {
        await bot.walking.walkToWithPathfinding(3211, 3494);
        reldo = bot.interaction.findNpc('Reldo');
        if (!reldo) throw new Error(`Reldo not found near (${bot.player.x},${bot.player.z})`);
    }

    // Try option 4 first (multi4 when phoenixgang not started).
    // If that fails to advance the varp, retry with option 3.
    for (const optionToTry of [4, 3]) {
        if (bot.getQuestProgress(KNIGHTS_SWORD_VARP) >= STAGE_SPOKEN_RELDO) break;

        await bot.interaction.npc(reldo, 1); // Talk-to
        if (!await bot.dialog.waitFor(30)) throw new Error('No dialog from Reldo');

        // chatnpc "Hello stranger."
        await bot.dialog.continue();

        // multi4 or multi3: "Imcando dwarves?" is always the last option
        if (!await bot.dialog.waitFor(10)) throw new Error('No choice from Reldo');
        await bot.dialog.selectOption(optionToTry);

        // Continue through ALL remaining dialog pages before checking varp
        await bot.dialog.continueRemaining();
        await bot.waitForTicks(3);
    }

    const varp = bot.getQuestProgress(KNIGHTS_SWORD_VARP);
    if (varp !== STAGE_SPOKEN_RELDO) {
        throw new Error(`Quest varp after Reldo is ${varp}, expected ${STAGE_SPOKEN_RELDO}`);
    }
    bot.log('EVENT', `Spoken to Reldo: varp=${varp}`);
}

/**
 * Prepare a redberry pie from scratch.
 * Steps:
 * 1. Train crafting to 7 (make pots from clay at pottery)
 * 2. Craft a pie dish (pottery)
 * 3. Buy flour + redberries from Wydin
 * 4. Get water (fill bucket at well)
 * 5. Make dough (flour + water → choose pastry dough)
 * 6. Make pie shell (dough + pie dish)
 * 7. Train cooking to 10 if needed
 * 8. Make uncooked pie (redberries + pie shell, needs cooking 10)
 * 9. Cook pie at range
 */
async function prepareRedberryPie(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Preparing redberry pie ===');

    // Step 1: Get a pie dish via pottery crafting (skip if we already have downstream items)
    if (!bot.inventory.find('Pie dish') && !bot.inventory.find('Pie shell') && !bot.inventory.find('Uncooked berry pie') && !bot.inventory.find('Redberry pie')) {
        await craftPieDish(bot);
    }

    // Step 2: Get water while still near Lumbridge/Barb Village (before going to Port Sarim)
    if (!bot.inventory.find('Bucket of water') && !bot.inventory.find('Jug of water')) {
        await fillBucketWithWater(bot);
    }

    // Step 3: Buy flour and redberries from Wydin (skip if downstream items exist)
    if (!bot.inventory.find('Pot of flour') && !bot.inventory.find('Pastry dough') && !bot.inventory.find('Pie shell') && !bot.inventory.find('Uncooked berry pie') && !bot.inventory.find('Redberry pie')) {
        await buyFromWydin(bot, [{ name: 'Pot of flour', qty: 1 }]);
    }
    if (!bot.inventory.find('Redberries') && !bot.inventory.find('Uncooked berry pie') && !bot.inventory.find('Redberry pie')) {
        await buyFromWydin(bot, [{ name: 'Redberries', qty: 1 }]);
    }

    // Step 4: Make pastry dough (use flour on water → choose option 2)
    if (!bot.inventory.find('Pastry dough') && !bot.inventory.find('Pie shell') && !bot.inventory.find('Uncooked berry pie')) {
        bot.log('STATE', 'Making pastry dough...');
        await bot.interaction.useItemOnItem('Pot of flour', 'Bucket of water');
        // Dialog: p_choice4 "What sort of dough?" → option 2 = Pastry dough
        if (await bot.dialog.waitFor(10)) {
            await bot.dialog.selectOption(2); // Pastry dough
        }
        await bot.waitForTicks(5);
        bot.dialog.dismissModals();

        if (!bot.inventory.find('Pastry dough')) {
            throw new Error('Failed to make pastry dough');
        }
        bot.log('EVENT', 'Made pastry dough');
    }

    // Step 5: Make pie shell (use pastry dough on pie dish)
    if (!bot.inventory.find('Pie shell') && !bot.inventory.find('Uncooked berry pie')) {
        bot.log('STATE', 'Making pie shell...');
        await bot.interaction.useItemOnItem('Pastry dough', 'Pie dish');
        await bot.waitForTicks(5);
        bot.dialog.dismissModals();

        if (!bot.inventory.find('Pie shell')) {
            throw new Error('Failed to make pie shell');
        }
        bot.log('EVENT', 'Made pie shell');
    }

    // Step 6: Train cooking to 10 if needed
    if (bot.getSkill('Cooking').baseLevel < 10) {
        await trainCookingToLevel(bot, 10);
    }

    // Steps 7-8: Make and cook pie — retry on burns using spare pie dishes from pottery batch
    for (let attempt = 0; !bot.inventory.find('Redberry pie') && attempt < 20; attempt++) {
        if (attempt > 0) {
            bot.log('STATE', `Pie burned, retry attempt ${attempt}...`);
            while (bot.inventory.find('Burnt pie')) {
                await bot.interaction.dropItem('Burnt pie');
                await bot.waitForTicks(1);
            }
        }

        // Need a new pie shell (first attempt or previous burned)
        if (!bot.inventory.find('Pie shell') && !bot.inventory.find('Uncooked berry pie')) {
            if (!bot.inventory.find('Pie dish')) {
                await craftPieDish(bot); // crafting already >= 7, fast
            }
            if (!bot.inventory.find('Bucket of water') && !bot.inventory.find('Jug of water')) {
                await fillBucketWithWater(bot);
            }
            if (!bot.inventory.find('Pot of flour') && !bot.inventory.find('Pastry dough')) {
                await buyFromWydin(bot, [{ name: 'Pot of flour', qty: 1 }]);
            }
            if (!bot.inventory.find('Redberries')) {
                await buyFromWydin(bot, [{ name: 'Redberries', qty: 1 }]);
            }
            if (!bot.inventory.find('Pastry dough')) {
                await bot.interaction.useItemOnItem('Pot of flour', 'Bucket of water');
                if (await bot.dialog.waitFor(10)) await bot.dialog.selectOption(2);
                await bot.waitForTicks(5);
                bot.dialog.dismissModals();
                if (!bot.inventory.find('Pastry dough')) throw new Error('Failed to make pastry dough on pie retry');
            }
            await bot.interaction.useItemOnItem('Pastry dough', 'Pie dish');
            await bot.waitForTicks(5);
            bot.dialog.dismissModals();
            if (!bot.inventory.find('Pie shell')) throw new Error('Failed to make pie shell on pie retry');
        }

        // Make uncooked berry pie
        if (!bot.inventory.find('Uncooked berry pie')) {
            await bot.interaction.useItemOnItem('Redberries', 'Pie shell');
            await bot.waitForTicks(5);
            bot.dialog.dismissModals();
            if (!bot.inventory.find('Uncooked berry pie')) throw new Error('Failed to make uncooked berry pie');
        }

        // Cook — does NOT throw on burn, just drops burnt pie and returns
        await cookPieAtRange(bot);
    }

    if (!bot.inventory.find('Redberry pie')) {
        throw new Error('Failed to create Redberry pie after 20 cooking attempts');
    }
    bot.log('EVENT', 'Redberry pie ready!');
}

/**
 * Craft a pie dish through pottery.
 * Mine clay, make soft clay, train crafting to 7, then craft pie dish.
 */
async function craftPieDish(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Crafting pie dish via pottery ===');

    // Need bucket of water for making soft clay
    if (!bot.inventory.find('Bucket') && !bot.inventory.find('Bucket of water')) {
        // Buy bucket from Lumbridge general store
        await bot.walking.walkToWithPathfinding(GENERAL_STORE_X, GENERAL_STORE_Z);
        await bot.interaction.openDoor('poordooropen');
        const shopkeeper = bot.interaction.findNpc('Shop keeper');
        if (!shopkeeper) throw new Error('Shop keeper not found in Lumbridge');
        await bot.interaction.npc(shopkeeper, 3);
        await bot.waitForTicks(3);
        await bot.shop.buy('Bucket', 1);
        bot.dialog.dismissModals();
    }

    // Training loop: mine clay, make soft clay, craft pots until level 7
    while (bot.getSkill('Crafting').baseLevel < 7 || !bot.inventory.find('Pie dish')) {
        bot.log('STATE', `Crafting: level ${bot.getSkill('Crafting').baseLevel}, need 7`);

        // Drop ALL junk to free space (including leftover clay/soft clay from prior attempts)
        for (const junk of ['Pot', 'Pot of flour', 'Copper ore', 'Tin ore', 'Bronze bar', 'Clay', 'Soft clay', 'Unfired pot', 'Unfired pie dish']) {
            while (bot.inventory.find(junk)) {
                await bot.interaction.dropItem(junk);
                await bot.waitForTicks(1);
            }
        }

        // Mine clay at Champion's Guild (clay doesn't stack, so limit to ~8 per batch)
        await walkToClayMine(bot);
        const clayToMine = Math.min(bot.inventory.freeSlots() - 1, 8);
        if (clayToMine < 1) throw new Error('Not enough inventory space for clay');

        await mineOre(bot, ['clayrock1', 'clayrock2'], 'Clay', clayToMine);

        // Convert clay to soft clay — walk to Barbarian Village well (close to Varrock)
        await bot.walking.walkToWithPathfinding(3175, 3427); // Varrock west gate
        await bot.walking.walkToWithPathfinding(3080, 3400); // North of Barb Village
        await bot.walking.walkToWithPathfinding(2947, 3382); // Near Falador fountain

        while (bot.inventory.find('Clay')) {
            // Fill bucket at well/fountain
            if (!bot.inventory.find('Bucket of water')) {
                await fillBucketWithWater(bot);
            }

            // Convert 1 clay + bucket_water → soft clay
            await bot.interaction.useItemOnItem('Clay', 'Bucket of water');
            await bot.waitForTicks(5);
            bot.dialog.dismissModals();
        }

        bot.log('STATE', `Converted to ${bot.inventory.count('Soft clay')} soft clay`);

        // Walk to Barbarian Village pottery
        if (bot.player.x < 3000) {
            // Near Falador — exit via south gate, then go east along road to Barb Village
            await bot.walking.walkToWithPathfinding(2965, 3394); // Falador south gate area
            await bot.walking.walkToWithPathfinding(3080, 3400); // North of Barb Village
            await bot.walking.walkToWithPathfinding(3082, 3336); // Barbarian Village
        } else {
            // Near Lumbridge/Draynor — go north avoiding Draynor Manor fences
            await bot.walking.walkToWithPathfinding(3105, 3305);
            await bot.walking.walkToWithPathfinding(3082, 3336);
        }
        // Pottery building has fencing on south side — must enter through the north door
        await bot.walking.walkToWithPathfinding(3085, 3414); // North of pottery building
        await bot.walking.walkToWithPathfinding(BARB_POTTERY_X, BARB_POTTERY_Z); // Inside through north door

        // Shape and fire pottery
        while (bot.inventory.find('Soft clay')) {
            await bot.dialog.clearPendingState();

            // Choose what to make: pot (option 1) if level < 7, pie dish (option 2) if level >= 7
            const canMakePieDish = bot.getSkill('Crafting').baseLevel >= 7;
            const choiceOption = canMakePieDish ? 2 : 1; // Always make pie dish when level allows

            // Use soft clay on potters_wheel
            await bot.interaction.useItemOnLoc('Soft clay', 'potters_wheel');

            // Use continueUntilChoice to skip any level-up dialogs before multi3
            if (await bot.dialog.continueUntilChoice(15)) {
                await bot.dialog.selectOption(choiceOption);
            }
            await bot.waitForTicks(8);
            bot.dialog.dismissModals();
        }

        // Fire all unfired items in pottery oven
        const unfiredItems = ['Unfired pie dish', 'Unfired pot'];
        for (const itemName of unfiredItems) {
            while (bot.inventory.find(itemName)) {
                await bot.interaction.useItemOnLoc(itemName, 'pottery_oven');
                await bot.waitForTicks(8);
                bot.dialog.dismissModals();
            }
        }

        // Drop finished pots (not needed, just for XP)
        while (bot.inventory.find('Pot')) {
            await bot.interaction.dropItem('Pot');
            await bot.waitForTicks(1);
        }

        bot.log('STATE', `After pottery batch: Crafting level ${bot.getSkill('Crafting').baseLevel}`);

        if (bot.inventory.find('Pie dish')) {
            bot.log('EVENT', 'Pie dish crafted!');
            break;
        }
    }
}

/**
 * Fill a bucket with water at the nearest well or fountain.
 */
async function fillBucketWithWater(bot: BotAPI): Promise<void> {
    if (bot.inventory.find('Bucket of water')) return;
    if (!bot.inventory.find('Bucket')) throw new Error('No bucket to fill with water');

    bot.log('STATE', 'Filling bucket with water...');

    // Try nearby first, then walk to Falador fountain (avoids Port Sarim ship gangplank)
    const locations = [
        null, // check current position first
        { x: 2947, z: 3382 }, // Near Falador fountain (adjacent walkable tile)
    ];

    for (const dest of locations) {
        if (dest) {
            // Safe route to Falador fountain — big jumps let A* route around walls
            if (bot.player.z < 3350) {
                await bot.walking.walkToWithPathfinding(2970, 3240);
                await bot.walking.walkToWithPathfinding(2965, 3370);
            }
            await bot.walking.walkToWithPathfinding(dest.x, dest.z);
        }

        // Check for well first, then fountain
        for (const locName of ['well', 'fountain']) {
            const source = bot.interaction.findLoc(locName, 20);
            if (source) {
                bot.log('STATE', `Found ${locName} at (${source.x},${source.z})`);
                await bot.interaction.useItemOnLoc('Bucket', locName);
                await bot.waitForTicks(5);
                bot.dialog.dismissModals();
                if (bot.inventory.find('Bucket of water')) {
                    bot.log('EVENT', 'Filled bucket with water');
                    return;
                }
            }
        }
    }

    throw new Error(`No well or fountain found near (${bot.player.x},${bot.player.z})`);
}

/**
 * Buy items from Wydin's Food Store in Port Sarim.
 */
async function buyFromWydin(bot: BotAPI, items: { name: string; qty: number }[]): Promise<void> {
    bot.log('STATE', `Buying from Wydin: ${items.map(i => `${i.name}x${i.qty}`).join(', ')}`);

    const distToShop = Math.max(Math.abs(bot.player.x - WYDIN_SHOP_X), Math.abs(bot.player.z - WYDIN_SHOP_Z));
    if (distToShop > 15) {
        await walkToPortSarim(bot);
    }
    await bot.walking.walkToWithPathfinding(WYDIN_SHOP_X, WYDIN_SHOP_Z);

    // Open door if needed
    await bot.interaction.openDoor('poordooropen');
    await bot.waitForTicks(1);

    const wydin = bot.interaction.findNpc('Wydin');
    if (!wydin) throw new Error(`Wydin not found near (${bot.player.x},${bot.player.z})`);

    await bot.interaction.npc(wydin, 3); // op3 = Trade
    await bot.waitForTicks(3);

    for (const item of items) {
        await bot.shop.buy(item.name, item.qty);
        await bot.waitForTicks(1);
    }

    bot.dialog.dismissModals();

    for (const item of items) {
        if (!bot.inventory.find(item.name)) {
            throw new Error(`Failed to buy ${item.name} from Wydin`);
        }
    }
}

/**
 * Train cooking by buying raw sardines from Gerrant's fishing shop in Port Sarim
 * and cooking them on the Lumbridge kitchen range.
 */
async function trainCookingToLevel(bot: BotAPI, targetLevel: number): Promise<void> {
    bot.log('STATE', `Training Cooking to ${targetLevel} (currently ${bot.getSkill('Cooking').baseLevel})`);

    while (bot.getSkill('Cooking').baseLevel < targetLevel) {
        if (bot.inventory.count('Raw sardine') === 0) {
            // Drop junk to free slots
            for (const junk of ['Sardine', 'Burnt fish']) {
                while (bot.inventory.find(junk)) {
                    await bot.interaction.dropItem(junk);
                    await bot.waitForTicks(1);
                }
            }

            // Buy raw sardines from Gerrant in Port Sarim
            await walkToPortSarimShops(bot);

            const gerrant = bot.interaction.findNpc('Gerrant', 30);
            if (!gerrant) throw new Error(`Gerrant not found near (${bot.player.x},${bot.player.z})`);

            // Gerrant has no op3 Trade handler — must use Talk-to and select "Let's see what you've got"
            await bot.interaction.npc(gerrant, 1); // op1 = Talk-to
            await bot.dialog.waitFor(15);
            await bot.dialog.continue(); // chatnpc "Welcome!"
            await bot.dialog.waitFor(10);
            await bot.dialog.selectOption(1); // "Let's see what you've got then."
            await bot.dialog.waitFor(10);
            await bot.dialog.continue(); // chatplayer "Let's see what you've got then."
            await bot.waitForTicks(3);

            const qty = Math.min(bot.inventory.freeSlots(), 20);
            await bot.shop.buy('Raw sardine', qty);
            bot.dialog.dismissModals();

            if (!bot.inventory.find('Raw sardine')) {
                throw new Error('Failed to buy Raw sardine from Gerrant');
            }
            bot.log('STATE', `Bought ${bot.inventory.count('Raw sardine')} raw sardines`);
        }

        // Cook at Rimmington range (loc_2728) — no quest requirement
        await walkToRimmingtonRange(bot);

        while (bot.inventory.find('Raw sardine')) {
            await bot.dialog.clearPendingState();
            const xpBefore = bot.getSkill('Cooking').exp;

            await bot.interaction.useItemOnLoc('Raw sardine', 'loc_2728');
            await bot.waitForTicks(10);
            bot.dialog.dismissModals();

            if (bot.getSkill('Cooking').exp > xpBefore) {
                bot.log('STATE', `Cooking: level ${bot.getSkill('Cooking').baseLevel}`);
            }

            if (bot.getSkill('Cooking').baseLevel >= targetLevel) break;
        }

        // Drop cooked/burnt fish
        for (const junk of ['Sardine', 'Burnt fish']) {
            while (bot.inventory.find(junk)) {
                await bot.interaction.dropItem(junk);
                await bot.waitForTicks(1);
            }
        }
    }

    bot.log('EVENT', `Cooking trained to level ${bot.getSkill('Cooking').baseLevel}`);
}

/**
 * Cook the uncooked berry pie at a range (oven).
 */
async function cookPieAtRange(bot: BotAPI): Promise<void> {
    bot.log('STATE', 'Cooking pie at Rimmington range...');

    await walkToRimmingtonRange(bot);

    if (!bot.inventory.find('Uncooked berry pie')) return;

    await bot.dialog.clearPendingState();
    await bot.interaction.useItemOnLoc('Uncooked berry pie', 'loc_2728');
    await bot.waitForTicks(10);
    bot.dialog.dismissModals();

    if (bot.inventory.find('Burnt pie')) {
        bot.log('STATE', 'Pie burned — dropping and will retry with a new pie...');
        while (bot.inventory.find('Burnt pie')) {
            await bot.interaction.dropItem('Burnt pie');
            await bot.waitForTicks(1);
        }
        return; // Caller's retry loop handles making another pie
    }

    if (!bot.inventory.find('Redberry pie')) {
        throw new Error('Failed to cook redberry pie (no burn, no success)');
    }
    bot.log('EVENT', 'Cooked redberry pie!');
}

/**
 * Give the redberry pie to Thurgo (varp 2→3) and talk about the sword (varp 3→4).
 */
async function talkToThurgo_GivePieAndSword(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Talking to Thurgo ===');

    await walkToThurgo(bot);

    let thurgo = bot.interaction.findNpc('Thurgo');
    if (!thurgo) {
        await bot.walking.walkToWithPathfinding(THURGO_AREA_X, THURGO_AREA_Z);
        thurgo = bot.interaction.findNpc('Thurgo');
        if (!thurgo) throw new Error(`Thurgo not found near (${bot.player.x},${bot.player.z})`);
    }

    // Stage 2: thurgo_inquire → with pie → multi2 → "Would you like a redberry pie?" (2)
    if (bot.getQuestProgress(KNIGHTS_SWORD_VARP) === STAGE_SPOKEN_RELDO) {
        bot.log('STATE', 'Giving pie to Thurgo...');
        await bot.interaction.npc(thurgo, 1);
        if (!await bot.dialog.waitFor(30)) throw new Error('No dialog from Thurgo');

        // multi2: "Hello. Are you an Imcando dwarf?" (1), "Would you like a redberry pie?" (2)
        await bot.dialog.selectOption(2);

        // chatplayer "Would you like a redberry pie?"
        if (await bot.dialog.waitFor(10)) await bot.dialog.continue();
        // mesbox "You see Thurgo's eyes light up."
        if (await bot.dialog.waitFor(10)) await bot.dialog.continue();
        // chatnpc "I'd never say no..."
        if (await bot.dialog.waitFor(10)) await bot.dialog.continue();
        // mesbox "You hand over the pie..."
        if (await bot.dialog.waitFor(10)) await bot.dialog.continue();
        // chatnpc "By Guthix! THAT was good pie!..."
        if (await bot.dialog.waitFor(10)) await bot.dialog.continue();

        await bot.dialog.continueRemaining();
        await bot.waitForTicks(3);

        const varp = bot.getQuestProgress(KNIGHTS_SWORD_VARP);
        if (varp < STAGE_GIVEN_PIE) {
            throw new Error(`Varp after giving pie is ${varp}, expected >= ${STAGE_GIVEN_PIE}`);
        }
        bot.log('EVENT', `Gave pie to Thurgo: varp=${varp}`);
    }

    // Stage 3: thurgo_special_sword_post_pie → talk about special sword (varp 3→4)
    if (bot.getQuestProgress(KNIGHTS_SWORD_VARP) === STAGE_GIVEN_PIE) {
        bot.log('STATE', 'Asking Thurgo about sword...');
        // Re-find Thurgo
        thurgo = bot.interaction.findNpc('Thurgo');
        if (!thurgo) throw new Error('Thurgo not found for sword dialog');

        await bot.interaction.npc(thurgo, 1);
        if (!await bot.dialog.waitFor(30)) throw new Error('No dialog from Thurgo (sword)');

        // chatplayer "Can you make me a special sword?"
        if (await bot.dialog.waitFor(10)) await bot.dialog.continue();
        // chatnpc "Well, after bringing me my favorite food..."
        if (await bot.dialog.waitFor(10)) await bot.dialog.continue();
        // chatplayer about Falador knight's sword
        if (await bot.dialog.waitFor(10)) await bot.dialog.continue();
        // chatnpc "A Knight's sword eh?..."
        if (await bot.dialog.waitFor(10)) await bot.dialog.continue();
        // chatnpc "All the Faladian knights..."
        if (await bot.dialog.waitFor(10)) await bot.dialog.continue();
        // chatplayer "I'll go and ask his squire..."
        if (await bot.dialog.waitFor(10)) await bot.dialog.continue();

        await bot.dialog.continueRemaining();
        await bot.waitForTicks(3);

        const varp = bot.getQuestProgress(KNIGHTS_SWORD_VARP);
        if (varp < STAGE_SPOKEN_THURGO) {
            throw new Error(`Varp after sword talk is ${varp}, expected >= ${STAGE_SPOKEN_THURGO}`);
        }
        bot.log('EVENT', `Thurgo agreed to help: varp=${varp}`);
    }
}

/**
 * Talk to Squire for portrait info (varp 4→5).
 * At stage 4, squire_status_report tells about the portrait.
 */
async function talkToSquire_Portrait(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Talking to Squire about portrait ===');

    // Walk to Falador castle
    await walkThurgoToFalador(bot);
    await bot.walking.walkToWithPathfinding(2965, 3340);

    let squire = bot.interaction.findNpc('Squire');
    if (!squire) {
        await bot.walking.walkToWithPathfinding(2960, 3336);
        squire = bot.interaction.findNpc('Squire');
        if (!squire) throw new Error(`Squire not found near (${bot.player.x},${bot.player.z})`);
    }

    await bot.interaction.npc(squire, 1);
    if (!await bot.dialog.waitFor(30)) throw new Error('No dialog from Squire (portrait)');

    // chatplayer "I have found an Imcando dwarf but he needs a picture..."
    if (await bot.dialog.waitFor(10)) await bot.dialog.continue();
    // chatnpc "A picture eh?..." about portrait in Vyvin's cupboard
    if (await bot.dialog.waitFor(10)) await bot.dialog.continue();
    // %squire = ^squire_looking_portrait (5)
    // chatplayer "Ok, I'll try to get that then."
    if (await bot.dialog.waitFor(10)) await bot.dialog.continue();
    // chatnpc "Please don't let him catch you!..."
    if (await bot.dialog.waitFor(10)) await bot.dialog.continue();

    await bot.dialog.continueRemaining();
    await bot.waitForTicks(3);

    const varp = bot.getQuestProgress(KNIGHTS_SWORD_VARP);
    if (varp < STAGE_LOOKING_PORTRAIT) {
        throw new Error(`Varp after portrait talk is ${varp}, expected >= ${STAGE_LOOKING_PORTRAIT}`);
    }
    bot.log('EVENT', `Portrait info received: varp=${varp}`);
}

/**
 * Get the portrait from Vyvin's cupboard on level 2 of Falador castle.
 * Must wait for Sir Vyvin to wander away from the cupboard (wanderrange=8).
 * Cupboard at (2984, 3336, level 2): open (op1), then search (op1 on open cupboard).
 */
async function getPortrait(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Getting portrait from cupboard ===');

    // Navigate to Vyvin's room via the east staircase:
    // Route: ground → west staircase (loc_1738) → level 1 → walk to (2984,3335) → east staircase
    // (loc_1722) → level 2 at (2984,3340) → enter via open double door at (2982,3337)
    const currentLevel = bot.player.level as number;
    if (currentLevel < 2) {
        if (currentLevel === 0) {
            await walkToFaladorCastleFloor(bot, 1); // Ground → level 1
        }
        // Now at level 1: walk to east staircase, approaching from south to avoid walls
        await bot.walking.walkToWithPathfinding(2984, 3335);
        await bot.interaction.climbStairs('loc_1722', 1); // Climb up to (2984, 3340, level=2)
        await bot.waitForTicks(3);
        if ((bot.player.level as number) !== 2) {
            throw new Error(`Failed to reach level 2 via east staircase: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
        }
    }
    // At level 2: enter Vyvin's room through the open double door at (2982,3337)
    // Then walk to (2983,3336) to be adjacent to the cupboard at (2984,3336)
    await bot.walking.walkToWithPathfinding(2982, 3337);
    await bot.walking.walkToWithPathfinding(2983, 3336);

    // Try to search the cupboard. Sir Vyvin wanders (wanderrange=8) so we may need to wait.
    for (let attempt = 0; attempt < 30; attempt++) {
        await bot.dialog.clearPendingState();

        // Check if Vyvin is nearby (within 1 tile of cupboard triggers block)
        const vyvin = bot.interaction.findNpc('Sir Vyvin');
        if (vyvin) {
            const dist = Math.abs(vyvin.x - VYVIN_CUPBOARD_X) + Math.abs(vyvin.z - VYVIN_CUPBOARD_Z);
            if (dist <= 1) {
                bot.log('STATE', `Sir Vyvin too close (dist=${dist}), waiting...`);
                await bot.waitForTicks(20);
                continue;
            }
        }

        // Open the cupboard first
        const cupboard = bot.interaction.findLoc('vyvincupboardshut', 5);
        if (cupboard) {
            await bot.interaction.loc(cupboard, 1); // op1 = Open
            await bot.waitForTicks(5); // allow p_arrivedelay + p_delay(0) + loc_change
        }

        // Search the open cupboard
        const openCupboard = bot.interaction.findLoc('vyvincupboardopen', 5);
        if (openCupboard) {
            await bot.interaction.loc(openCupboard, 1); // op1 = Search
            await bot.waitForTicks(5);

            // Check for any dialog (success mesbox or Vyvin catching us)
            if (await bot.dialog.waitFor(5)) {
                await bot.dialog.continueRemaining();
                bot.dialog.dismissModals();
                // Check if we got the portrait from the success mesbox
                if (bot.inventory.find('Portrait')) {
                    bot.log('EVENT', 'Got the portrait!');
                    break;
                }
                // Vyvin caught us: "HEY! Just WHAT do you THINK you are DOING???"
                bot.log('STATE', 'Sir Vyvin caught us! Retrying...');
                await bot.waitForTicks(20);
                continue;
            }

            bot.dialog.dismissModals();

            if (bot.inventory.find('Portrait')) {
                bot.log('EVENT', 'Got the portrait!');
                break;
            }
        }

        await bot.waitForTicks(10);
    }

    if (!bot.inventory.find('Portrait')) {
        throw new Error('Failed to get portrait from cupboard after 30 attempts');
    }

    // Explicit descent: exit room → loc_1723 (level2→1) → walk west → loc_1740 (level1→0)
    await bot.walking.walkToWithPathfinding(2982, 3337); // Exit Vyvin's room through door
    await bot.interaction.climbStairs('loc_1723', 1); // East staircase: level 2 → level 1
    await bot.waitForTicks(5);
    if ((bot.player.level as number) !== 1) {
        throw new Error(`Failed to descend from level 2: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    // Walk to west staircase area on level 1: go north to clear east-wing walls, then west
    // loc_1740 at (2955,3339,level=1) and loc_1736 at (2968,3348,level=1)
    await bot.walking.walkToWithPathfinding(2984, 3342); // North to clear east-wing corridor walls
    await bot.walking.walkToWithPathfinding(2960, 3341); // West to main castle staircase area
    const downStair = bot.interaction.findLoc('loc_1740', 20) ?? bot.interaction.findLoc('loc_1736', 20);
    if (!downStair) throw new Error(`No level1→0 staircase near (${bot.player.x},${bot.player.z})`);
    await bot.interaction.loc(downStair, 1);
    await bot.waitForTicks(5);
    if ((bot.player.level as number) !== 0) {
        throw new Error(`Failed to descend from level 1: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    bot.log('STATE', `Descended to ground level: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
}

/**
 * Give portrait to Thurgo (varp 5→6).
 */
async function givePortraitToThurgo(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Giving portrait to Thurgo ===');

    await walkToThurgo(bot);

    let thurgo = bot.interaction.findNpc('Thurgo');
    if (!thurgo) {
        await bot.walking.walkToWithPathfinding(THURGO_AREA_X, THURGO_AREA_Z);
        thurgo = bot.interaction.findNpc('Thurgo');
        if (!thurgo) throw new Error(`Thurgo not found near (${bot.player.x},${bot.player.z})`);
    }

    // Stage 5 with portrait: thurgo_about_sword → shows portrait → varp 5→6
    await bot.interaction.npc(thurgo, 1);
    if (!await bot.dialog.waitFor(30)) throw new Error('No dialog from Thurgo (portrait)');

    // chatplayer "About that sword..."
    if (await bot.dialog.waitFor(10)) await bot.dialog.continue();
    // chatplayer "I have found a picture of the sword..."
    if (await bot.dialog.waitFor(10)) await bot.dialog.continue();
    // mesbox "You give the portrait to Thurgo..."
    if (await bot.dialog.waitFor(10)) await bot.dialog.continue();
    // chatnpc "Ok. You'll need to get me some stuff..."
    if (await bot.dialog.waitFor(10)) await bot.dialog.continue();
    // chatnpc "I'll need two iron bars..."
    if (await bot.dialog.waitFor(10)) await bot.dialog.continue();
    // chatnpc "It is fairly rare sort of ore..."
    if (await bot.dialog.waitFor(10)) await bot.dialog.continue();
    // chatnpc "But it is guarded by a very powerful ice giant."
    if (await bot.dialog.waitFor(10)) await bot.dialog.continue();
    // chatnpc "Most of the rocks..."
    if (await bot.dialog.waitFor(10)) await bot.dialog.continue();
    // chatnpc "You'll need a little bit of mining experience..."
    if (await bot.dialog.waitFor(10)) await bot.dialog.continue();
    // chatplayer "Ok. I'll go and find them then."
    if (await bot.dialog.waitFor(10)) await bot.dialog.continue();

    await bot.dialog.continueRemaining();
    await bot.waitForTicks(3);

    const varp = bot.getQuestProgress(KNIGHTS_SWORD_VARP);
    if (varp < STAGE_LOOKING_BLURITE) {
        throw new Error(`Varp after giving portrait is ${varp}, expected >= ${STAGE_LOOKING_BLURITE}`);
    }
    bot.log('EVENT', `Portrait given: varp=${varp}`);
}

/**
 * Gather materials: train skills, get 2 iron bars + 1 blurite ore.
 */
async function gatherMaterials(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Gathering materials (2 iron bars + 1 blurite ore) ===');

    // Step 1: Train mining to 15 (needed for iron ore) — use Rimmington mine (west side)
    if (bot.getSkill('Mining').baseLevel < 15) {
        await bot.walking.walkToWithPathfinding(RIMMINGTON_MINE_X, RIMMINGTON_MINE_Z);
        await trainMiningToLevel(bot, 15);
    }

    // Step 2: Train smithing to 15 (needed for smelting iron bars)
    if (bot.getSkill('Smithing').baseLevel < 15) {
        await trainSmithingToLevel(bot, 15);
    }

    // Step 3: Mine iron ore (need extra because 50% success rate at furnace)
    if (bot.inventory.count('Iron bar') < 2) {
        const ironOreNeeded = (2 - bot.inventory.count('Iron bar')) * 4; // 50% success, mine extra
        bot.log('STATE', `Mining ${ironOreNeeded} iron ore for smelting...`);

        // Drop unnecessary items
        for (const junk of ['Copper ore', 'Tin ore', 'Clay', 'Soft clay', 'Bronze bar', 'Pot', 'Bread']) {
            while (bot.inventory.find(junk)) {
                await bot.interaction.dropItem(junk);
                await bot.waitForTicks(1);
            }
        }

        await bot.walking.walkToWithPathfinding(RIMMINGTON_MINE_X, RIMMINGTON_MINE_Z);
        await mineOre(bot, ['ironrock1', 'ironrock2'], 'Iron ore', ironOreNeeded);

        // Smelt iron bars at Lumbridge furnace
        await smeltBars(bot, 'Iron ore', 'Iron bar', 2);
    }

    // Step 4: Mine blurite ore from ice dungeon
    if (!bot.inventory.find('Blurite ore')) {
        await mineBlurite(bot);
    }

    // Verify
    if (bot.inventory.count('Iron bar') < 2) throw new Error(`Not enough iron bars: ${bot.inventory.count('Iron bar')}/2`);
    if (!bot.inventory.find('Blurite ore')) throw new Error('No blurite ore');
    bot.log('EVENT', `Materials gathered: ${bot.inventory.count('Iron bar')} iron bars, ${bot.inventory.count('Blurite ore')} blurite ore`);
}

/**
 * Enter the ice dungeon south of Thurgo and mine blurite ore.
 */
async function mineBlurite(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Mining blurite ore from ice dungeon ===');

    // Walk to the ice dungeon entrance area
    await walkToThurgo(bot);
    await bot.walking.walkToWithPathfinding(ICE_DUNGEON_ENTRANCE_X, ICE_DUNGEON_ENTRANCE_Z);

    // Ice Dungeon uses z+6400 coordinate offset (not a height-level change).
    // loc_1759 (op1): climb_ladder(movecoord(coord(), 0, 0, 6400), false)  → surface → underground
    // loc_1755 (op1): climb_ladder(movecoord(coord(), 0, 0, -6400), true)  → underground → surface
    const entrance = bot.interaction.findLoc('loc_1759', 15);
    if (!entrance) {
        const allLocs = bot.interaction.findAllLocs(15);
        throw new Error(`Ice dungeon entrance (loc_1759) not found near (${bot.player.x},${bot.player.z}). Nearby: ${allLocs.map(l => l.debugname).join(', ')}`);
    }

    // Enter the dungeon
    await bot.interaction.loc(entrance, 1);
    await bot.waitForTicks(5);

    if (bot.player.z < 6400) {
        throw new Error(`Failed to enter Ice Dungeon: still on surface at (${bot.player.x},${bot.player.z})`);
    }
    bot.log('STATE', `After entering dungeon: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Mine blurite, then always exit the dungeon afterward.
    let mineError: Error | null = null;
    try {
        const bluriteRock = bot.interaction.findLoc('bluriterock', 80);
        if (!bluriteRock) {
            throw new Error(`Blurite rock not found in dungeon near (${bot.player.x},${bot.player.z})`);
        }
        bot.log('STATE', `Blurite rock found at (${bluriteRock.x},${bluriteRock.z})`);

        await bot.walking.walkToIgnoringNpcs(bluriteRock.x, bluriteRock.z + 1);
        await mineOre(bot, ['bluriterock'], 'Blurite ore', 1);

        if (!bot.inventory.find('Blurite ore')) {
            throw new Error('Failed to mine blurite ore');
        }
        bot.log('EVENT', 'Mined blurite ore!');
    } catch (e) {
        mineError = e as Error;
    }

    // Always exit the dungeon (prevents bot being stuck underground on retry)
    if (bot.player.z > 6400) {
        const DUNGEON_EXIT_Z = ICE_DUNGEON_ENTRANCE_Z + 6400; // 9550
        await bot.walking.walkToIgnoringNpcs(3009, DUNGEON_EXIT_Z);

        const exit = bot.interaction.findLoc('loc_1755', 15);
        if (!exit) {
            const allLocs = bot.interaction.findAllLocs(15);
            throw new Error(`Ice dungeon exit (loc_1755) not found near (${bot.player.x},${bot.player.z}). Nearby: ${allLocs.map(l => l.debugname).join(', ')}`);
        }

        await bot.interaction.loc(exit, 1);
        await bot.waitForTicks(5);

        if (bot.player.z > 6400) {
            throw new Error(`Failed to exit Ice Dungeon: still underground at (${bot.player.x},${bot.player.z})`);
        }
        bot.log('STATE', `After exiting dungeon: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }

    if (mineError) throw mineError;
}

/**
 * Give materials to Thurgo to get the blurite sword.
 */
async function giveMaterialsToThurgo(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Giving materials to Thurgo ===');

    await walkToThurgo(bot);

    let thurgo = bot.interaction.findNpc('Thurgo');
    if (!thurgo) {
        await bot.walking.walkToWithPathfinding(THURGO_AREA_X, THURGO_AREA_Z);
        thurgo = bot.interaction.findNpc('Thurgo');
        if (!thurgo) throw new Error(`Thurgo not found near (${bot.player.x},${bot.player.z})`);
    }

    // Stage 6: thurgo_check_blurite → with blurite_ore + 2 iron_bar → makes sword
    await bot.interaction.npc(thurgo, 1);
    if (!await bot.dialog.waitFor(30)) throw new Error('No dialog from Thurgo (materials)');

    // chatplayer "About that sword..."
    if (await bot.dialog.waitFor(10)) await bot.dialog.continue();
    // chatnpc "How are you doing finding those sword materials?"
    if (await bot.dialog.waitFor(10)) await bot.dialog.continue();
    // chatplayer "I have them right here."
    if (await bot.dialog.waitFor(10)) await bot.dialog.continue();
    // mesbox "You give the blurite ore and two iron bars to Thurgo..."
    if (await bot.dialog.waitFor(10)) await bot.dialog.continue();
    // chatplayer "Thank you very much!"
    if (await bot.dialog.waitFor(10)) await bot.dialog.continue();
    // chatnpc "Just remember to call in with more pie some time!"
    if (await bot.dialog.waitFor(10)) await bot.dialog.continue();

    await bot.dialog.continueRemaining();
    await bot.waitForTicks(3);
    bot.dialog.dismissModals();

    if (!bot.inventory.find('Blurite sword')) {
        throw new Error('Did not receive Blurite sword from Thurgo');
    }
    bot.log('EVENT', 'Received Blurite sword from Thurgo!');
}

/**
 * Deliver the sword to the Squire to complete the quest (varp 6→7).
 */
async function deliverSword(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Delivering sword to Squire ===');

    await walkThurgoToFalador(bot);
    await bot.walking.walkToWithPathfinding(2965, 3340);

    let squire = bot.interaction.findNpc('Squire');
    if (!squire) {
        await bot.walking.walkToWithPathfinding(2960, 3336);
        squire = bot.interaction.findNpc('Squire');
        if (!squire) throw new Error(`Squire not found near (${bot.player.x},${bot.player.z})`);
    }

    await bot.interaction.npc(squire, 1);
    if (!await bot.dialog.waitFor(30)) throw new Error('No dialog from Squire (delivery)');

    // chatplayer "I have retrieved your sword for you."
    if (await bot.dialog.waitFor(10)) await bot.dialog.continue();
    // chatnpc "Thank you, thank you, thank you!..."
    if (await bot.dialog.waitFor(10)) await bot.dialog.continue();
    // mesbox "You give the sword to the squire."
    if (await bot.dialog.waitFor(10)) await bot.dialog.continue();

    await bot.dialog.continueRemaining();

    // Wait for queued script (squire_complete) to fire
    await bot.waitForTicks(10);
    bot.dialog.dismissModals();
    await bot.waitForTicks(3);
    bot.dialog.dismissModals();

    const varp = bot.getQuestProgress(KNIGHTS_SWORD_VARP);
    if (varp !== STAGE_COMPLETE) {
        throw new Error(`Quest varp after delivery is ${varp}, expected ${STAGE_COMPLETE}`);
    }

    const smithingXp = bot.getSkill('Smithing').exp;
    bot.log('SUCCESS', `The Knight's Sword complete! varp=${varp}, smithing_xp=${smithingXp}`);
}

// ================================================================
// State machine builder
// ================================================================

export function buildKnightsSwordStates(bot: BotAPI): BotState {
    return {
        name: 'knights-sword',
        isComplete: () => bot.getQuestProgress(KNIGHTS_SWORD_VARP) === STAGE_COMPLETE,
        run: async () => { throw new Error('Composite state should not be called directly'); },
        entrySnapshot: {
            position: { x: 3222, z: 3218 },
            varps: { [KNIGHTS_SWORD_VARP]: 0 },
            items: ['Bronze pickaxe'],
        },
        children: [
            {
                name: 'earn-gp',
                entrySnapshot: {
                    position: { x: 3222, z: 3218 },
                    varps: { [KNIGHTS_SWORD_VARP]: 0 },
                    items: ['Bronze pickaxe'],
                },
                stuckThreshold: 3000,
                isComplete: () => {
                    const coins = bot.inventory.find('Coins');
                    return coins !== null && coins.count >= 700;
                },
                run: async () => {
                    await earnGp(bot, 800);
                }
            },
            {
                name: 'buy-initial-supplies',
                entrySnapshot: {
                    position: { x: 3237, z: 3220 },
                    skills: { THIEVING: 14 },
                    varps: { [KNIGHTS_SWORD_VARP]: 0 },
                    items: ['Bronze pickaxe', { name: 'Coins', count: 801 }],
                },
                isComplete: () => bot.inventory.find('Bucket') !== null || bot.inventory.find('Bucket of water') !== null,
                run: async () => {
                    await bot.walking.walkToWithPathfinding(GENERAL_STORE_X, GENERAL_STORE_Z);
                    await bot.interaction.openDoor('poordooropen');
                    const shopkeeper = bot.interaction.findNpc('Shop keeper');
                    if (!shopkeeper) throw new Error('Shop keeper not found');
                    await bot.interaction.npc(shopkeeper, 3);
                    await bot.waitForTicks(3);
                    await bot.shop.buy('Bucket', 1);
                    bot.dialog.dismissModals();
                }
            },
            {
                name: 'talk-to-squire',
                entrySnapshot: {
                    position: { x: 3212, z: 3249 },
                    skills: { THIEVING: 14 },
                    varps: { [KNIGHTS_SWORD_VARP]: 0 },
                    items: ['Bronze pickaxe', { name: 'Coins', count: 799 }, 'Bucket'],
                },
                isComplete: () => bot.getQuestProgress(KNIGHTS_SWORD_VARP) >= STAGE_STARTED,
                progressThreshold: 5000,
                run: async () => {
                    await walkRoute(bot, ROUTE_LUMBRIDGE_TO_FALADOR);
                    await talkToSquire_Start(bot);
                }
            },
            {
                name: 'talk-to-reldo',
                entrySnapshot: {
                    position: { x: 2977, z: 3343 },
                    skills: { THIEVING: 14 },
                    varps: { [KNIGHTS_SWORD_VARP]: 1 },
                    items: ['Bronze pickaxe', { name: 'Coins', count: 799 }, 'Bucket'],
                },
                isComplete: () => bot.getQuestProgress(KNIGHTS_SWORD_VARP) >= STAGE_SPOKEN_RELDO,
                progressThreshold: 5000,
                run: async () => {
                    await talkToReldo(bot);
                }
            },
            {
                name: 'prepare-pie',
                entrySnapshot: {
                    position: { x: 3212, z: 3497 },
                    skills: { THIEVING: 14 },
                    varps: { [KNIGHTS_SWORD_VARP]: 2 },
                    // Use explicit IDs: cert/noted versions share the same display name but are
                    // stackable, causing resolveObjByDisplayName to return the cert version.
                    items: [{ name: 'Bronze pickaxe', count: 1, id: 1265 }, { name: 'Coins', count: 799 }, { name: 'Bucket', count: 1, id: 1925 }],
                },
                isComplete: () => bot.inventory.find('Redberry pie') !== null,
                stuckThreshold: 5000,
                progressThreshold: 15000,
                run: async () => {
                    await prepareRedberryPie(bot);
                }
            },
            {
                name: 'give-pie-and-talk-sword',
                entrySnapshot: {
                    position: { x: 2969, z: 3210 },
                    skills: { COOKING: 10, CRAFTING: 8, MINING: 4, THIEVING: 14 },
                    varps: { [KNIGHTS_SWORD_VARP]: 2 },
                    items: [
                        'Bronze pickaxe', { name: 'Coins', count: 173 },
                        'Pot', { name: 'Redberry pie', count: 1, id: 2325 },
                        { name: 'Pie dish', count: 7 },
                        'Bucket',
                        { name: 'Raw sardine', count: 11 },
                    ],
                },
                isComplete: () => bot.getQuestProgress(KNIGHTS_SWORD_VARP) >= STAGE_SPOKEN_THURGO,
                progressThreshold: 5000,
                run: async () => {
                    await talkToThurgo_GivePieAndSword(bot);
                }
            },
            {
                name: 'talk-squire-portrait',
                entrySnapshot: {
                    position: { x: 2998, z: 3146 },
                    skills: { COOKING: 10, CRAFTING: 8, MINING: 4, THIEVING: 14 },
                    varps: { [KNIGHTS_SWORD_VARP]: 4 },
                    items: [
                        'Bronze pickaxe', { name: 'Coins', count: 173 },
                        'Pot',
                        { name: 'Pie dish', count: 7 },
                        'Bucket',
                        { name: 'Raw sardine', count: 11 },
                    ],
                },
                isComplete: () => bot.getQuestProgress(KNIGHTS_SWORD_VARP) >= STAGE_LOOKING_PORTRAIT,
                progressThreshold: 5000,
                run: async () => {
                    await talkToSquire_Portrait(bot);
                }
            },
            {
                name: 'get-portrait',
                entrySnapshot: {
                    position: { x: 2974, z: 3343 },
                    skills: { COOKING: 10, CRAFTING: 8, MINING: 4, THIEVING: 14 },
                    varps: { [KNIGHTS_SWORD_VARP]: 5 },
                    items: [
                        'Bronze pickaxe', { name: 'Coins', count: 173 },
                        'Pot',
                        { name: 'Pie dish', count: 7 },
                        'Bucket',
                        { name: 'Raw sardine', count: 11 },
                    ],
                },
                isComplete: () => bot.inventory.find('Portrait') !== null || bot.getQuestProgress(KNIGHTS_SWORD_VARP) >= STAGE_LOOKING_BLURITE,
                run: async () => {
                    await getPortrait(bot);
                }
            },
            {
                name: 'give-portrait-to-thurgo',
                entrySnapshot: {
                    position: { x: 3013, z: 3210 },
                    skills: { COOKING: 10, CRAFTING: 8, MINING: 4, THIEVING: 14 },
                    varps: { [KNIGHTS_SWORD_VARP]: 5 },
                    items: ['Bronze pickaxe', 'Portrait'],
                },
                isComplete: () => bot.getQuestProgress(KNIGHTS_SWORD_VARP) >= STAGE_LOOKING_BLURITE,
                progressThreshold: 5000,
                run: async () => {
                    await givePortraitToThurgo(bot);
                }
            },
            {
                name: 'gather-materials',
                entrySnapshot: {
                    position: { x: 3001, z: 3144 },
                    skills: { COOKING: 10, CRAFTING: 8, MINING: 15, SMITHING: 15, THIEVING: 14 },
                    varps: { [KNIGHTS_SWORD_VARP]: 6 },
                    items: [{ name: 'Bronze pickaxe', count: 1, id: 1265 }],
                },
                isComplete: () => {
                    return (bot.inventory.count('Iron bar') >= 2 && bot.inventory.find('Blurite ore') !== null)
                        || bot.inventory.find('Blurite sword') !== null;
                },
                stuckThreshold: 5000,
                progressThreshold: 20000,
                run: async () => {
                    await gatherMaterials(bot);
                }
            },
            {
                name: 'give-materials-to-thurgo',
                entrySnapshot: {
                    position: { x: 3001, z: 3144 },
                    skills: { COOKING: 10, CRAFTING: 8, SMITHING: 15, MINING: 10, THIEVING: 14 },
                    varps: { [KNIGHTS_SWORD_VARP]: 6 },
                    items: ['Bronze pickaxe', { name: 'Iron bar', count: 2, id: 2351 }, 'Blurite ore'],
                },
                isComplete: () => bot.inventory.find('Blurite sword') !== null,
                progressThreshold: 5000,
                run: async () => {
                    await giveMaterialsToThurgo(bot);
                }
            },
            {
                name: 'deliver-sword',
                entrySnapshot: {
                    position: { x: 3001, z: 3144 },
                    skills: { COOKING: 10, CRAFTING: 8, SMITHING: 15, MINING: 10, THIEVING: 14 },
                    varps: { [KNIGHTS_SWORD_VARP]: 6 },
                    items: ['Bronze pickaxe', 'Blurite sword'],
                },
                isComplete: () => bot.getQuestProgress(KNIGHTS_SWORD_VARP) === STAGE_COMPLETE,
                progressThreshold: 5000,
                run: async () => {
                    await deliverSword(bot);
                }
            }
        ]
    };
}

// ================================================================
// MAIN SCRIPT
// ================================================================

export async function knightsSword(bot: BotAPI): Promise<void> {
    await skipTutorial(bot);
    await bot.waitForTicks(2);

    bot.log('STATE', `Starting The Knight's Sword quest at (${bot.player.x},${bot.player.z},${bot.player.level})`);

    const initialVarp = bot.getQuestProgress(KNIGHTS_SWORD_VARP);
    if (initialVarp !== STAGE_NOT_STARTED) {
        throw new Error(`Quest varp is ${initialVarp}, expected ${STAGE_NOT_STARTED} (not started)`);
    }

    const root = buildKnightsSwordStates(bot);
    await runStateMachine(bot, { root, varpIds: [KNIGHTS_SWORD_VARP] });
}

export const metadata: ScriptMeta = {
    name: 'knightssword',
    type: 'quest',
    varpId: KNIGHTS_SWORD_VARP,
    varpComplete: STAGE_COMPLETE,
    maxTicks: 80000,
    run: knightsSword,
    buildStates: buildKnightsSwordStates,
};
