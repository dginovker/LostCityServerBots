import path from 'path';
import { BotAPI } from '../runtime/api.js';
import { type BotState, runStateMachine } from '../runtime/state-machine.js';
import type { ScriptMeta } from '../runtime/script-meta.js';
import { skipTutorial } from './skip-tutorial.js';
import { buildF2pSkillsStates } from './f2p-skills.js';
import { buildDruidicRitualStates, DRUIDIC_RITUAL_VARP } from './druidic-ritual.js';
import { buildRuneMysteriesStates } from './rune-mysteries.js';

// Varp IDs
const RUNE_MYSTERIES_VARP = 63;
const _RM_COMPLETE = 6;
const _DR_COMPLETE = 4;

// All 19 skills that must reach level 10
const ALL_SKILLS = [
    'Attack', 'Strength', 'Defence', 'Ranged', 'Prayer',
    'Magic', 'Hitpoints', 'Mining', 'Smithing', 'Fishing',
    'Cooking', 'Woodcutting', 'Firemaking', 'Crafting',
    'Thieving', 'Agility', 'Herblore', 'Fletching', 'Runecrafting',
];

// --- Location constants ---
const LUMBRIDGE_X = 3222;
const LUMBRIDGE_Z = 3218;
const AUBURY_X = 3253;
const AUBURY_Z = 3401;
// Air altar mysterious ruins (overworld, south of Falador)
const AIR_RUINS_X = 2983;
const AIR_RUINS_Z = 3288;
// Taverley
const _TAVERLEY_X = 2895;
const _TAVERLEY_Z = 3440;
// Gnome Stronghold agility start
const GNOME_COURSE_START_X = 2474;
const GNOME_COURSE_START_Z = 3438;

// Stun/delay varps for pickpocketing
const VARP_ACTION_DELAY = 58;
const VARP_STUNNED = 103;

// ---- Thieving ----

async function trainThieving(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Training Thieving via pickpocketing ===');

    let attempts = 0;
    while (bot.getSkill('Thieving').baseLevel < 10 && attempts < 1500) {
        bot.dismissModals();

        // Wait for stun/action delay to expire
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

        let npc = bot.findNearbyNpc('Man');
        if (!npc) {
            await bot.walkToWithPathfinding(LUMBRIDGE_X, LUMBRIDGE_Z);
            await bot.waitForTicks(2);
            npc = bot.findNearbyNpc('Man');
            if (!npc) {
                await bot.waitForTicks(5);
                continue;
            }
        }

        attempts++;
        await bot.interactNpc(npc, 3); // Pickpocket
        await bot.waitForTicks(5);
        await bot.waitForTicks(1);
        bot.dismissModals();
    }

    bot.log('EVENT', `Thieving trained to ${bot.getSkill('Thieving').baseLevel} in ${attempts} attempts`);
}

// ---- Runecrafting ----

async function trainRunecrafting(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Training Runecrafting ===');

    if (!bot.findItem('Air talisman')) {
        throw new Error('Need Air talisman from Rune Mysteries quest');
    }

    while (bot.getSkill('Runecrafting').baseLevel < 10) {
        // Phase 1: Mine essence via Aubury teleport
        if (!bot.findItem('Rune essence')) {
            // Walk to Aubury in Varrock
            await bot.walkToWithPathfinding(AUBURY_X, AUBURY_Z);

            const aubury = bot.findNearbyNpc('Aubury', 16);
            if (!aubury) throw new Error('Aubury not found near Varrock rune shop');
            await bot.interactNpc(aubury, 4); // Teleport to essence mine
            await bot.waitForTicks(5);

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
            if (portal) {
                await bot.interactLoc(portal, 1); // Use
                await bot.waitForTicks(5);
            } else {
                throw new Error('essencemine_portal not found');
            }

            bot.log('EVENT', `Mined essence, have ${27 - bot.freeSlots()} items. Pos: (${bot.player.x},${bot.player.z})`);
        }

        // Phase 2: Walk to Air altar ruins
        const pos = bot.getPosition();
        if (pos.z < 4800) {
            // On overworld - walk to air ruins
            if (Math.abs(pos.x - AIR_RUINS_X) + Math.abs(pos.z - AIR_RUINS_Z) > 30) {
                // Route from Varrock/Aubury area to Air ruins (south of Falador)
                if (pos.x > 3100) {
                    await bot.walkToWithPathfinding(3080, 3400);
                    await bot.walkToWithPathfinding(3006, 3360);
                }
                await bot.walkToWithPathfinding(2966, 3310);
                await bot.walkToWithPathfinding(AIR_RUINS_X, AIR_RUINS_Z);
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
            bot.log('EVENT', `Crafted air runes. RC level: ${bot.getSkill('Runecrafting').baseLevel}, XP: ${bot.getSkill('Runecrafting').exp}`);
        }

        // Phase 4: Exit altar via portal
        const exitPortal = bot.findNearbyLoc('airtemple_exit_portal', 16);
        if (exitPortal) {
            await bot.interactLoc(exitPortal, 1); // Use
            await bot.waitForTicks(5);
        }
    }

    bot.log('EVENT', `Runecrafting trained to ${bot.getSkill('Runecrafting').baseLevel}`);
}

// ---- Herblore ----

async function trainHerblore(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Training Herblore ===');

    // After Druidic Ritual, we have ~250 XP (level 3).
    // Strategy: kill druids at Taverley stone circle for herb drops,
    // clean guam, make attack potions (25 XP each).

    // Buy supplies from Jatix's Herblore Shop in Taverley
    await bot.walkToWithPathfinding(2899, 3429);
    const jatix = bot.findNearbyNpc('Jatix', 16);
    if (jatix) {
        await bot.interactNpc(jatix, 3); // Trade
        await bot.waitForTicks(3);
        await bot.buyFromShop('Eye of newt', 50);
        await bot.buyFromShop('Vial of water', 50);
        bot.dismissModals();
        await bot.waitForTicks(2);
    } else {
        bot.log('STATE', 'Jatix not found, trying to walk closer');
        await bot.walkToWithPathfinding(2900, 3428);
        const jatix2 = bot.findNearbyNpc('Jatix', 20);
        if (jatix2) {
            await bot.interactNpc(jatix2, 3);
            await bot.waitForTicks(3);
            await bot.buyFromShop('Eye of newt', 50);
            await bot.buyFromShop('Vial of water', 50);
            bot.dismissModals();
            await bot.waitForTicks(2);
        }
    }

    // Kill druids near Taverley stone circle for herb drops
    // Druids spawn around (2925, 3480) area
    let killAttempts = 0;
    while (bot.getSkill('Herblore').baseLevel < 10 && killAttempts < 500) {
        // First: process any herbs in inventory
        // Clean unidentified herbs (opheld1 trigger)
        for (const herbName of ['Guam leaf', 'Marrentill', 'Tarromin', 'Harralander', 'Ranarr weed']) {
            while (bot.findItem(herbName)) {
                // These are already identified names — cleaning uses unidentified names
                break;
            }
        }

        // Try cleaning any "Unidentified herb" items (generic name)
        while (bot.findItem('Unidentified herb')) {
            await bot.useItemOp1('Unidentified herb');
            await bot.waitForTicks(2);
            bot.dismissModals();
        }

        // Make guam potion (unf): clean guam + vial of water
        while (bot.findItem('Guam leaf') && bot.findItem('Vial of water')) {
            await bot.useItemOnItem('Guam leaf', 'Vial of water');
            await bot.waitForTicks(3);
            bot.dismissModals();
        }

        // Make attack potion: guam potion (unf) + eye of newt
        while (bot.findItem('Guam potion (unf)') && bot.findItem('Eye of newt')) {
            await bot.useItemOnItem('Guam potion (unf)', 'Eye of newt');
            await bot.waitForTicks(3);
            bot.dismissModals();
        }

        if (bot.getSkill('Herblore').baseLevel >= 10) break;

        // Drop non-essential items to make room
        for (const junk of ['Attack potion(3)', 'Bones']) {
            while (bot.findItem(junk) && bot.freeSlots() < 5) {
                await bot.dropItem(junk);
                await bot.waitForTicks(1);
            }
        }

        // Kill druids for herb drops
        await bot.walkToWithPathfinding(2925, 3480);
        const druid = bot.findNearbyNpc('Druid', 20);
        if (druid) {
            killAttempts++;
            try {
                await bot.attackNpcUntilDead('Druid', { maxTicks: 300 });
            } catch {
                bot.log('STATE', 'Failed to kill druid, trying again');
                await bot.waitForTicks(5);
                continue;
            }
            await bot.waitForTicks(5);

            // Pick up herb drops and bones
            for (let i = 0; i < 3; i++) {
                const herb = bot.findNearbyGroundItem('Unidentified herb', 10);
                if (herb) {
                    await bot.takeGroundItem('Unidentified herb', herb.x, herb.z);
                    await bot.waitForTicks(2);
                }
            }
        } else {
            bot.log('STATE', 'No druid found, waiting');
            await bot.waitForTicks(10);
        }
    }

    bot.log('EVENT', `Herblore trained to ${bot.getSkill('Herblore').baseLevel}`);
}

// ---- Agility (Gnome Stronghold Course) ----

async function runGnomeCourse(bot: BotAPI): Promise<void> {
    // Obstacle 1: Log Balance (2474, 3435) - Walk-across (op1)
    await bot.walkToWithPathfinding(2474, 3436);
    const log = bot.findNearbyLoc('gnome_log_balance', 16);
    if (!log) throw new Error('gnome_log_balance not found');
    await bot.interactLoc(log, 1);
    await bot.waitForTicks(12);

    // Obstacle 2: Obstacle Net 1 (2473, 3425) - Climb-over (op1)
    // Bot is at south end of log, walk to net
    await bot.walkToWithPathfinding(2473, 3426);
    const net1 = bot.findNearbyLoc('gnome_obstacle_net_1', 16);
    if (!net1) throw new Error('gnome_obstacle_net_1 not found');
    await bot.interactLoc(net1, 1);
    await bot.waitForTicks(5);

    // Obstacle 3: Tree Branch 1 (2473, 3422) - Climb (op1)
    const branch1 = bot.findNearbyLoc('gnome_tree_branch_1', 16);
    if (!branch1) throw new Error('gnome_tree_branch_1 not found');
    await bot.interactLoc(branch1, 1);
    await bot.waitForTicks(5);

    // Obstacle 4: Balancing Rope - Walk-on (op1)
    const rope = bot.findNearbyLoc('gnome_balancing_rope', 16);
    if (!rope) throw new Error('gnome_balancing_rope not found');
    await bot.interactLoc(rope, 1);
    await bot.waitForTicks(12);

    // Obstacle 5: Tree Branch 2 - Climb-down (op1)
    let branch2 = bot.findNearbyLoc('gnome_tree_branch_2', 16);
    if (!branch2) {
        branch2 = bot.findNearbyLoc('gnome_tree_branch_3', 16);
    }
    if (!branch2) throw new Error('gnome_tree_branch_2/3 not found');
    await bot.interactLoc(branch2, 1);
    await bot.waitForTicks(5);

    // Obstacle 6: Obstacle Net 2 (2485, 3426) - Climb-over (op1)
    await bot.walkToWithPathfinding(2485, 3425);
    const net2 = bot.findNearbyLoc('gnome_obstacle_net_2', 16);
    if (!net2) throw new Error('gnome_obstacle_net_2 not found');
    await bot.interactLoc(net2, 1);
    await bot.waitForTicks(5);

    // Obstacle 7: Obstacle Pipe (2484, 3431) - Squeeze-through (op1)
    await bot.walkToWithPathfinding(2484, 3430);
    let pipe = bot.findNearbyLoc('gnome_obstacle_pipe', 16);
    if (!pipe) {
        pipe = bot.findNearbyLoc('loc_154', 16);
    }
    if (!pipe) throw new Error('gnome_obstacle_pipe not found');
    await bot.interactLoc(pipe, 1);
    await bot.waitForTicks(12);

    bot.log('EVENT', `Gnome course lap done. Agility: level=${bot.getSkill('Agility').baseLevel} xp=${bot.getSkill('Agility').exp}`);
}

async function trainAgility(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Training Agility at Gnome Course ===');
    let laps = 0;
    while (bot.getSkill('Agility').baseLevel < 10) {
        await runGnomeCourse(bot);
        laps++;
    }
    bot.log('EVENT', `Agility trained to ${bot.getSkill('Agility').baseLevel} in ${laps} laps`);
}

// ---- Fletching ----

async function trainFletching(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Training Fletching ===');

    if (!bot.findItem('Knife')) {
        throw new Error('Need a knife for fletching');
    }

    // Need a bronze axe for cutting trees
    const hasAxe = bot.findItem('Bronze axe') || bot.findItem('Iron axe') ||
                   bot.findItem('Steel axe') || bot.findItem('Mithril axe');

    while (bot.getSkill('Fletching').baseLevel < 10) {
        // Get logs if we don't have any
        if (!bot.findItem('Logs')) {
            if (!hasAxe) {
                throw new Error('Need an axe for cutting trees');
            }
            // Find and cut a tree nearby
            const tree = bot.findNearbyLoc('tree', 20);
            if (!tree) {
                // Walk to an area with trees
                await bot.walkToWithPathfinding(GNOME_COURSE_START_X - 20, GNOME_COURSE_START_Z);
                await bot.waitForTicks(2);
                continue;
            }
            await bot.interactLoc(tree, 1); // Chop down
            // Wait for log to appear in inventory
            for (let i = 0; i < 30; i++) {
                await bot.waitForTick();
                if (bot.findItem('Logs')) break;
            }
            bot.dismissModals();
            continue;
        }

        // Use knife on logs to make arrow shafts
        await bot.useItemOnItem('Knife', 'Logs');
        await bot.waitForTicks(2);

        // Handle the multi-choice dialog (arrow shafts, shortbow, longbow)
        if (bot.isMultiChoiceOpen()) {
            await bot.selectDialogOption(1); // Arrow shafts
        }
        await bot.waitForTicks(5);
        bot.dismissModals();
    }

    bot.log('EVENT', `Fletching trained to ${bot.getSkill('Fletching').baseLevel}`);
}

// ---- Route helpers ----

async function walkToGnomeStronghold(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Walking to Gnome Stronghold ===');
    const pos = bot.getPosition();

    // From Taverley area, go over White Wolf Mountain to Gnome Stronghold
    if (pos.x > 2860) {
        // Start from Taverley side
        await bot.walkToWithPathfinding(2870, 3470);
        await bot.walkToWithPathfinding(2860, 3495);
    }
    // Over White Wolf Mountain
    await bot.walkToWithPathfinding(2845, 3515);
    await bot.walkToWithPathfinding(2820, 3515);
    await bot.walkToWithPathfinding(2805, 3480);
    // Down to Catherby side
    await bot.walkToWithPathfinding(2800, 3440);
    // West through Seers Village / McGrubor's area
    await bot.walkToWithPathfinding(2750, 3440);
    await bot.walkToWithPathfinding(2700, 3435);
    await bot.walkToWithPathfinding(2650, 3435);
    await bot.walkToWithPathfinding(2600, 3435);
    await bot.walkToWithPathfinding(2550, 3435);
    await bot.walkToWithPathfinding(2500, 3435);
    // Approach Gnome Stronghold gate
    await bot.walkToWithPathfinding(2462, 3385);

    // Open the gnome gate to enter
    try {
        await bot.openGate(5);
        await bot.waitForTicks(2);
    } catch {
        bot.log('STATE', 'Gnome gate may already be open');
    }

    // Walk inside to agility course area
    await bot.walkToWithPathfinding(GNOME_COURSE_START_X, GNOME_COURSE_START_Z);
    bot.log('EVENT', `Arrived at Gnome Stronghold: (${bot.player.x},${bot.player.z})`);
}

// ---- State machine builder ----

export function buildAllSkillsStates(bot: BotAPI): BotState {
    return {
        name: 'all-skills',
        isComplete: () => ALL_SKILLS.every(s => bot.getSkill(s).baseLevel >= 10),
        run: async () => { throw new Error('Composite state should not be called directly'); },
        children: [
            // Phase 1: All F2P skills to level 10 (fishing, cooking, woodcutting,
            // firemaking, mining, smithing, crafting, attack, strength, defence,
            // prayer, ranged, magic, hitpoints)
            buildF2pSkillsStates(bot),

            // Phase 2: Thieving (pickpocket men at Lumbridge)
            {
                name: 'thieving',
                stuckThreshold: 5000,
                maxRetries: 3,
                isComplete: () => bot.getSkill('Thieving').baseLevel >= 10,
                run: async () => {
                    await bot.walkToWithPathfinding(LUMBRIDGE_X, LUMBRIDGE_Z);
                    await trainThieving(bot);
                },
            },

            // Phase 3: Rune Mysteries quest (prerequisite for runecrafting)
            // Starts from Lumbridge Castle (talk to Duke), visits Wizard Tower
            // and Varrock (Aubury). Bot should be near Lumbridge after thieving.
            buildRuneMysteriesStates(bot),

            // Phase 4: Runecrafting (mine essence via Aubury, craft air runes)
            {
                name: 'runecrafting',
                stuckThreshold: 10000,
                maxRetries: 5,
                isComplete: () => bot.getSkill('Runecrafting').baseLevel >= 10,
                run: async () => {
                    await trainRunecrafting(bot);
                },
            },

            // Phase 5: Druidic Ritual quest (prerequisite for herblore)
            // Starts by collecting meats near Lumbridge, then walks to Taverley.
            // After quest, bot is in Taverley with ~250 herblore XP (level 3).
            buildDruidicRitualStates(bot),

            // Phase 6: Herblore (at Taverley — buy supplies, kill druids for herbs)
            {
                name: 'herblore',
                stuckThreshold: 20000,
                maxRetries: 5,
                isComplete: () => bot.getSkill('Herblore').baseLevel >= 10,
                run: async () => {
                    await trainHerblore(bot);
                },
            },

            // Phase 7: Walk to Gnome Stronghold (long walk from Taverley)
            {
                name: 'walk-to-gnome',
                isComplete: () => {
                    const p = bot.getPosition();
                    return Math.abs(p.x - GNOME_COURSE_START_X) + Math.abs(p.z - GNOME_COURSE_START_Z) < 30;
                },
                maxRetries: 5,
                run: async () => {
                    await walkToGnomeStronghold(bot);
                },
            },

            // Phase 8: Buy knife at Gnome Stronghold (for fletching)
            {
                name: 'buy-knife',
                isComplete: () => bot.findItem('Knife') !== null,
                maxRetries: 3,
                run: async () => {
                    // Gnome general stores sell knives
                    // Try to find a shopkeeper NPC nearby
                    await bot.walkToWithPathfinding(2470, 3420);
                    let shopkeeper = bot.findNearbyNpc('Gnome shopkeeper', 20);
                    if (!shopkeeper) {
                        // Try Hudo — the gnome cook/shopkeeper
                        shopkeeper = bot.findNearbyNpc('Hudo', 20);
                    }
                    if (!shopkeeper) {
                        // Try generic approach — find any NPC with Trade option nearby
                        shopkeeper = bot.findNearbyNpc('Rometti', 20);
                    }
                    if (!shopkeeper) {
                        // Walk to the Grand Tree area where shops are
                        await bot.walkToWithPathfinding(2467, 3418);
                        shopkeeper = bot.findNearbyNpc('Gnome shopkeeper', 30);
                        if (!shopkeeper) {
                            throw new Error('Could not find any shopkeeper at Gnome Stronghold');
                        }
                    }
                    await bot.interactNpc(shopkeeper, 3); // Trade
                    await bot.waitForTicks(3);
                    await bot.buyFromShop('Knife', 1);
                    bot.dismissModals();
                    await bot.waitForTicks(2);
                    if (!bot.findItem('Knife')) {
                        throw new Error('Failed to buy knife from shop');
                    }
                    bot.log('EVENT', 'Bought knife from Gnome shop');
                },
            },

            // Phase 9: Agility (Gnome Stronghold course — ~2 laps for level 10)
            {
                name: 'agility',
                stuckThreshold: 3000,
                maxRetries: 5,
                isComplete: () => bot.getSkill('Agility').baseLevel >= 10,
                run: async () => {
                    // Walk to course start if not nearby
                    const p = bot.getPosition();
                    if (Math.abs(p.x - GNOME_COURSE_START_X) + Math.abs(p.z - GNOME_COURSE_START_Z) > 30) {
                        await bot.walkToWithPathfinding(GNOME_COURSE_START_X, GNOME_COURSE_START_Z);
                    }
                    await trainAgility(bot);
                },
            },

            // Phase 10: Fletching (cut logs into arrow shafts with knife)
            {
                name: 'fletching',
                stuckThreshold: 5000,
                maxRetries: 5,
                isComplete: () => bot.getSkill('Fletching').baseLevel >= 10,
                run: async () => {
                    await trainFletching(bot);
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
        varpIds: [DRUIDIC_RITUAL_VARP, RUNE_MYSTERIES_VARP],
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

    bot.log('SUCCESS', 'All 19 skills trained to level 10!');
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
