import path from 'path';
import { BotAPI } from '../runtime/api.js';
import { type BotState, runStateMachine } from '../runtime/state-machine.js';
import type { ScriptMeta } from '../runtime/script-meta.js';
import { skipTutorial } from './skip-tutorial.js';
import { buildF2pSkillsStates } from './f2p-skills.js';
import { buildRuneMysteriesStates } from './rune-mysteries.js';

// Varp IDs
const RUNE_MYSTERIES_VARP = 63;

// All 15 F2P skills that must reach level 10
const ALL_SKILLS = [
    'Attack', 'Strength', 'Defence', 'Ranged', 'Prayer',
    'Magic', 'Hitpoints', 'Mining', 'Smithing', 'Fishing',
    'Cooking', 'Woodcutting', 'Firemaking', 'Crafting',
    'Runecraft',
];

// --- Location constants ---
const AUBURY_X = 3253;
const AUBURY_Z = 3401;
// Air altar mysterious ruins (overworld, south of Falador)
const AIR_RUINS_X = 2983;
const AIR_RUINS_Z = 3288;

// Waypoints from Aubury → Air altar ruins (avoid Falador walls, Draynor Manor, Champion's Guild)
const VARROCK_TO_AIR_RUINS = [
    { x: 3222, z: 3427 },  // North along Varrock road (stay on road, avoid Draynor Manor)
    { x: 3175, z: 3427 },  // Varrock west gate
    { x: 3080, z: 3400 },  // West of Varrock
    { x: 3082, z: 3336 },  // South past Barbarian Village
    { x: 3105, z: 3250 },  // South to Draynor road
    { x: 3047, z: 3237 },  // Port Sarim approach (proven route)
    { x: 3016, z: 3215 },  // Port Sarim
    { x: 2985, z: 3240 },  // West from Port Sarim
    { x: 2983, z: 3288 },  // North to Air altar ruins
];

async function walkToAirRuins(bot: BotAPI): Promise<void> {
    // Walk each waypoint in sequence; walkToWithPathfinding handles intermediate routing
    for (const wp of VARROCK_TO_AIR_RUINS) {
        await bot.walkToWithPathfinding(wp.x, wp.z);
    }
}

async function walkToAubury(bot: BotAPI): Promise<void> {
    // Reverse the route: Air ruins → Port Sarim → Draynor → Varrock → Aubury
    // Must go via (3175,3427) to avoid Champion's Guild invisible walls
    for (const wp of [...VARROCK_TO_AIR_RUINS].reverse()) {
        await bot.walkToWithPathfinding(wp.x, wp.z);
    }
    // East to Varrock via west gate, then to Aubury
    await bot.walkToWithPathfinding(3175, 3427);
    await bot.walkToWithPathfinding(AUBURY_X, AUBURY_Z);
}

// ---- Runecraft ----

async function trainRunecraft(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Training Runecraft ===');

    if (!bot.findItem('Air talisman')) {
        throw new Error('Need Air talisman from Rune Mysteries quest');
    }

    while (bot.getSkill('Runecraft').baseLevel < 10) {
        // Phase 1: Mine essence via Aubury teleport
        if (!bot.findItem('Rune essence')) {
            // Only walk to Aubury if we're not already nearby
            const curPos = bot.getPosition();
            if (Math.abs(curPos.x - AUBURY_X) + Math.abs(curPos.z - AUBURY_Z) > 30) {
                await walkToAubury(bot);
            }
            await bot.openDoor('poordooropen');

            const aubury = bot.findNearbyNpc('Aubury', 16);
            if (!aubury) throw new Error('Aubury not found near Varrock rune shop');
            await bot.interactNpc(aubury, 4); // Teleport to essence mine
            await bot.waitForTicks(5);
            bot.log('EVENT', `After Aubury teleport: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

            // Mine essence until inventory is nearly full (keep 1 slot for talisman)
            let mineTicks = 0;
            while (bot.freeSlots() > 1 && mineTicks < 2000) {
                const rock = bot.findNearbyLoc('blankrunestone', 16);
                if (!rock) {
                    bot.log('STATE', 'No blankrunestone found, searching wider area');
                    break;
                }
                await bot.interactLoc(rock, 1); // Mine
                await bot.waitForTicks(8);
                mineTicks += 8;
                bot.dismissModals();
            }

            // Exit essence mine via portal
            const portal = bot.findNearbyLoc('essencemine_portal', 16);
            if (!portal) throw new Error('essencemine_portal not found');
            await bot.interactLoc(portal, 1); // Use
            await bot.waitForTicks(5);

            bot.log('EVENT', `Mined essence, have ${27 - bot.freeSlots()} items. Pos: (${bot.player.x},${bot.player.z})`);
        }

        // Phase 2: Walk to Air altar ruins (avoiding Falador walls)
        const pos = bot.getPosition();
        if (pos.z < 4800) {
            // On overworld - walk to air ruins
            if (Math.abs(pos.x - AIR_RUINS_X) + Math.abs(pos.z - AIR_RUINS_Z) > 30) {
                await walkToAirRuins(bot);
            }

            // Enter ruins using Air talisman
            const ruins = bot.findNearbyLoc('airtemple_ruined', 16);
            if (!ruins) throw new Error('airtemple_ruined not found near Air altar entrance');
            await bot.useItemOnLoc('Air talisman', 'airtemple_ruined');
            await bot.waitForTicks(5);
        }

        // Phase 3: Craft at altar (inside altar dimension)
        const altar = bot.findNearbyLoc('air_altar', 16);
        if (altar) {
            await bot.interactLoc(altar, 1); // Craft-rune
            await bot.waitForTicks(5);
            bot.dismissModals();
            bot.log('EVENT', `Crafted air runes. RC level: ${bot.getSkill('Runecraft').baseLevel}, XP: ${bot.getSkill('Runecraft').exp}`);
        }

        // Phase 4: Exit altar via portal
        const exitPortal = bot.findNearbyLoc('airtemple_exit_portal', 16);
        if (exitPortal) {
            await bot.interactLoc(exitPortal, 1); // Use
            await bot.waitForTicks(5);
        }

        // Drop crafted air runes to make room for next batch of essence
        while (bot.findItem('Air rune') && bot.getSkill('Runecraft').baseLevel < 10) {
            await bot.dropItem('Air rune');
            await bot.waitForTicks(1);
        }
    }

    bot.log('EVENT', `Runecraft trained to ${bot.getSkill('Runecraft').baseLevel}`);
}

// ---- State machine builder ----

export function buildAllSkillsStates(bot: BotAPI): BotState {
    return {
        name: 'all-skills',
        isComplete: () => ALL_SKILLS.every(s => bot.getSkill(s).baseLevel >= 10),
        run: async () => { throw new Error('Composite state should not be called directly'); },
        children: [
            // Phase 1: Core F2P skills to level 10 (fishing, cooking, woodcutting,
            // firemaking, mining, smithing, crafting, attack, strength, defence,
            // prayer, ranged, magic, hitpoints)
            buildF2pSkillsStates(bot),

            // Phase 2: Rune Mysteries quest (prerequisite for runecrafting)
            // Starts from Lumbridge Castle (talk to Duke), visits Wizard Tower
            // and Varrock (Aubury). Bot should be near Lumbridge after combat/magic.
            buildRuneMysteriesStates(bot),

            // Phase 3: Runecraft (mine essence via Aubury, craft air runes)
            {
                name: 'runecrafting',
                stuckThreshold: 10000,
                maxRetries: 5,
                isComplete: () => bot.getSkill('Runecraft').baseLevel >= 10,
                run: async () => {
                    await trainRunecraft(bot);
                },
            },
        ],
    };
}

export async function allSkills(bot: BotAPI): Promise<void> {
    await skipTutorial(bot);
    await bot.waitForTicks(2);

    bot.log('STATE', `All Skills bot starting at (${bot.player.x},${bot.player.z},${bot.player.level})`);

    const root = buildAllSkillsStates(bot);
    const snapshotDir = path.resolve(import.meta.dir, '..', 'test', 'snapshots');
    await runStateMachine(bot, {
        root,
        varpIds: [RUNE_MYSTERIES_VARP],
        captureSnapshots: true,
        snapshotDir,
    });

    // Final validation
    const failedSkills: string[] = [];
    for (const skill of ALL_SKILLS) {
        const level = bot.getSkill(skill).baseLevel;
        if (level < 10) {
            failedSkills.push(`${skill}(${level})`);
        }
    }

    if (failedSkills.length > 0) {
        throw new Error(`Not all skills at level 10: ${failedSkills.join(', ')}`);
    }

    bot.log('SUCCESS', 'All 15 F2P skills trained to level 10!');
}

export const metadata: ScriptMeta = {
    name: 'allskills',
    type: 'activity',
    maxTicks: 500000,
    run: allSkills,
    buildStates: buildAllSkillsStates,
    extraAssertions: (api: BotAPI) => ALL_SKILLS.map(s => ({
        name: `${s} >= 10`,
        pass: api.getSkill(s).baseLevel >= 10,
    })),
};
