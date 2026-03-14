import { BotAPI } from '../runtime/api.js';
import { skipTutorial } from './skip-tutorial.js';
import { type BotState, runStateMachine } from '../runtime/state-machine.js';
import type { ScriptMeta } from '../runtime/script-meta.js';

// Varp ID for Monk's Friend progress (from content/pack/varp.pack: 30=drunkmonkquest)
const MONKS_FRIEND_VARP = 30;

// Quest stages (from content/scripts/areas/area_ardougne_east/scripts/brother_omad.rs2
//               and content/scripts/areas/area_ardougne_east/scripts/brother_cedric.rs2)
const STAGE_NOT_STARTED = 0;
const STAGE_SPOKEN_TO_OMAD = 10;    // blanket_ladder timer started
const STAGE_RETRIEVED_BLANKET = 20; // blanket given to Omad
const STAGE_LOOKING_CEDRIC = 30;    // Omad asked us to find Cedric
const STAGE_FINDING_WATER = 40;     // Cedric asked for jug of water
// stage 50 (drunkmonk_given_water) is a transitional stage inside the same Cedric dialog
const STAGE_FIXING_CART = 60;       // agreed to fix Cedric's cart
const STAGE_FIXED_CART = 70;        // gave logs to Cedric
const STAGE_COMPLETE = 80;          // party complete, quest done

// ---- Key coordinates ----

// Brother Omad: inside the monastery south of East Ardougne
const MONASTERY_X = 2604;
const MONASTERY_Z = 3209;

// Brother Cedric: drunk in the forest north of the monastery
const CEDRIC_X = 2614;
const CEDRIC_Z = 3259;

// Blanket cave ladder surface entry: the blanket_ladder timer dynamically adds loc_1765 here
// when the player is within 2 tiles and drunkmonkquest varp == 10.
const BLANKET_LADDER_X = 2561;
const BLANKET_LADDER_Z = 3222;

// Child's blanket: static floor item in the underground cave (z = surface z + 6400)
// Decoded from binary map file o40_150: obj_id=90 (childs_blanket) at coord (2570, 9604)
// Approach from (2570,9607) — cave walls block all tiles at z<=9606 directly adjacent.
const CAVE_BLANKET_X = 2570;
const CAVE_BLANKET_Z = 9604;

// Exit ladder from the cave: loc_1755 at (2561, 9622)
const _CAVE_EXIT_X = 2561;
const _CAVE_EXIT_Z = 9622;

// Fountain (watersource loc, debugname "fountain") at (2629, 3311)
// Decoded from binary map file l41_51. Used to fill jug_empty → jug_water.
const FOUNTAIN_X = 2629;
const FOUNTAIN_Z = 3311;

// Approach point for woodcutting trees: west of Cedric's position.
// Regular trees confirmed at (2609,3262), (2610,3260), (2612,3256) via l40_50 map decode.
// The east route is blocked by water/timberwalls at x=2639+.
const TREE_X = 2609;
const TREE_Z = 3255; // west of the fenced garden, near accessible regular trees

// Lumbridge General Store (sells jug_empty)
const GENERAL_STORE_X = 3212;
const GENERAL_STORE_Z = 3247;

// Bob's Brilliant Axes, Lumbridge (sells bronze_axe)
const BOB_X = 3232;
const BOB_Z = 3203;

// ---- Boat route: Lumbridge → Port Sarim → Karamja → Brimhaven → Ardougne ----

// White Wolf Mountain is impassable (troll_climbingrocks require Agility 15 +
// Troll Stronghold quest started). The only viable route is by boat:
//   Port Sarim → Karamja (30gp) → walk to Brimhaven → Ardougne (30gp).
//
// Port Sarim dock (sailors: Captain Tobias, Seaman Lorris, Seaman Thresnor)
const PORT_SARIM_DOCK_X = 3029;
const PORT_SARIM_DOCK_Z = 3217;

// Karamja ship disembark gangplank (sarimshipplank_off at level 1)
// After crossing it the bot is at ground level ~(2956,3144)
const KARAMJA_GROUND_X = 2925;
const KARAMJA_GROUND_Z = 3143;

// Brimhaven customs officer spawns (n43_50 binary data):
// (2772,3225), (2772,3231), (2773,3229) – all at x<2815 (Brimhaven side)
const _BRIMHAVEN_CUSTOMS_X = 2772;
const _BRIMHAVEN_CUSTOMS_Z = 3229;

// Ardougne ship arrival: set_sail coord 1_41_51_59_4 →
// level=1, world_x=41*64+59=2683, world_z=51*64+4=3268
// After brimhavenshipplank_off (at (2683,3269,1)) the bot is at ground level
const _ARDOUGNE_DOCK_X = 2683;
const _ARDOUGNE_DOCK_Z = 3268;

// Waypoints from Lumbridge to Port Sarim dock
const ROUTE_TO_PORT_SARIM = [
    { x: 3105, z: 3250 }, // Draynor road
    { x: 3046, z: 3236 }, // West of Draynor Village
    { x: PORT_SARIM_DOCK_X, z: PORT_SARIM_DOCK_Z },
];

// Waypoints from Karamja dock to Brimhaven customs officer.
// The direct west path has multiple blocked tiles (volcano/dungeon lava zone at
// x~2855-2890 z~3160-3176, and fences/cliffs further west). Waypoints below are
// confirmed reachable from tests; exact target coords that fail are adjusted by
// 1-2 tiles to nearest confirmed accessible position.
const ROUTE_KARAMJA_TO_BRIMHAVEN = [
    { x: 2855, z: 3177 },  // Confirmed reachable — north of volcanic lava barrier
    { x: 2822, z: 3198 },  // Confirmed reachable — closest tile west of dungeon area
    { x: 2793, z: 3213 },  // Confirmed reachable (3214 is blocked by cliff/wall)
    { x: 2770, z: 3220 },  // West of the cliff wall at (2780,3222), near customs dock
];

// Waypoints from Ardougne dock to monastery
const ROUTE_ARDOUGNE_TO_MONASTERY = [
    { x: 2643, z: 3238 },
    { x: MONASTERY_X, z: MONASTERY_Z },
];

// ---- Helpers ----

/**
 * Sail from Port Sarim to Karamja (30gp).
 * Dialog mirrors pirates-treasure.ts sailToKaramja().
 */
async function sailPortSarimToKaramja(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Sailing Port Sarim → Karamja ===');

    for (const wp of ROUTE_TO_PORT_SARIM) {
        await bot.walking.walkToWithPathfinding(wp.x, wp.z);
    }
    bot.log('STATE', `At Port Sarim dock: pos=(${bot.player.x},${bot.player.z})`);

    let sailor = bot.interaction.findNpc('Captain Tobias', 16);
    if (!sailor) sailor = bot.interaction.findNpc('Seaman Lorris', 16);
    if (!sailor) sailor = bot.interaction.findNpc('Seaman Thresnor', 16);
    if (!sailor) throw new Error(`No sailor found near (${bot.player.x},${bot.player.z})`);

    await bot.interaction.npc(sailor, 1); // Talk-to

    const d1 = await bot.dialog.waitFor(30);
    if (!d1) throw new Error('sailPortSarim: no dialog from sailor');
    await bot.dialog.continue(); // chatnpc "Do you want to go on a trip to Karamja?"

    const d2 = await bot.dialog.waitFor(10);
    if (!d2) throw new Error('sailPortSarim: no cost dialog');
    await bot.dialog.continue(); // chatnpc "The trip will cost you 30 coins."

    const d3 = await bot.dialog.waitFor(10);
    if (!d3) throw new Error('sailPortSarim: no yes/no choice');
    await bot.dialog.selectOption(1); // "Yes please."

    const d4 = await bot.dialog.waitFor(10);
    if (!d4) throw new Error('sailPortSarim: no confirm dialog');
    await bot.dialog.continue(); // chatplayer "Yes please."

    const prevX = bot.player.x;
    const prevZ = bot.player.z;
    await bot.waitForTicks(12); // wait for 7-tick set_sail + buffer

    if (bot.dialog.isOpen()) await bot.dialog.continue();
    await bot.waitForTicks(2);
    bot.dialog.dismissModals();

    if (bot.player.x === prevX && bot.player.z === prevZ) {
        throw new Error(`sailPortSarim: teleport did not occur — still at (${bot.player.x},${bot.player.z})`);
    }

    bot.log('STATE', `Arrived at Karamja ship: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Cross gangplank from ship (level 1) to ground
    const plank = bot.interaction.findLoc('sarimshipplank_off', 16);
    if (!plank) throw new Error(`sailPortSarim: sarimshipplank_off not found near (${bot.player.x},${bot.player.z},${bot.player.level})`);
    await bot.interaction.loc(plank, 1);
    await bot.waitForTicks(5);

    bot.log('STATE', `On Karamja ground: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
}

/**
 * Sail from Brimhaven to Ardougne via customs officer (30gp).
 * Dialog from content/scripts/areas/area_karamja/scripts/customs_officer.rs2.
 */
async function sailBrimhavenToArdougne(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Sailing Brimhaven → Ardougne ===');

    // Walk to Brimhaven customs officer area via waypoints
    await bot.walking.walkToWithPathfinding(KARAMJA_GROUND_X, KARAMJA_GROUND_Z);
    for (const wp of ROUTE_KARAMJA_TO_BRIMHAVEN) {
        await bot.walking.walkToWithPathfinding(wp.x, wp.z);
    }

    const officer = bot.interaction.findNpc('Customs officer', 32);
    if (!officer) throw new Error(`sailBrimhaven: Customs officer not found near (${bot.player.x},${bot.player.z})`);

    bot.log('STATE', `Found Customs officer at (${officer.x},${officer.z})`);
    await bot.interaction.npc(officer, 1); // Talk-to

    const d1 = await bot.dialog.waitFor(30);
    if (!d1) throw new Error('sailBrimhaven: no dialog from customs officer');
    await bot.dialog.continue(); // chatnpc "Can I help you?"

    const d2 = await bot.dialog.waitFor(10);
    if (!d2) throw new Error('sailBrimhaven: no multi2 choice');
    await bot.dialog.selectOption(1); // "Can I journey on this ship?"

    const d3 = await bot.dialog.waitFor(10);
    if (!d3) throw new Error('sailBrimhaven: no chatplayer journey dialog');
    await bot.dialog.continue(); // chatplayer "Can I journey on this ship?"

    const d4 = await bot.dialog.waitFor(10);
    if (!d4) throw new Error('sailBrimhaven: no searched dialog');
    await bot.dialog.continue(); // chatnpc "You need to be searched before you can board."

    const d5 = await bot.dialog.waitFor(10);
    if (!d5) throw new Error('sailBrimhaven: no multi3 search choice');
    await bot.dialog.selectOption(2); // "Search away, I have nothing to hide."

    const d6 = await bot.dialog.waitFor(10);
    if (!d6) throw new Error('sailBrimhaven: no chatplayer search dialog');
    await bot.dialog.continue(); // chatplayer "Search away, I have nothing to hide."

    const d7 = await bot.dialog.waitFor(10);
    if (!d7) throw new Error('sailBrimhaven: no cost dialog after search');
    await bot.dialog.continue(); // chatnpc "Well you've got some odd stuff... pay 30 coins."

    const d8 = await bot.dialog.waitFor(10);
    if (!d8) throw new Error('sailBrimhaven: no ok/cancel choice');
    await bot.dialog.selectOption(1); // "Ok."

    const d9 = await bot.dialog.waitFor(10);
    if (!d9) throw new Error('sailBrimhaven: no chatplayer ok dialog');
    await bot.dialog.continue(); // chatplayer "Ok."

    const prevX = bot.player.x;
    const prevZ = bot.player.z;
    await bot.waitForTicks(12); // wait for 7-tick set_sail + buffer

    if (bot.dialog.isOpen()) await bot.dialog.continue();
    await bot.waitForTicks(2);
    bot.dialog.dismissModals();

    if (bot.player.x === prevX && bot.player.z === prevZ) {
        throw new Error(`sailBrimhaven: teleport did not occur — still at (${bot.player.x},${bot.player.z})`);
    }

    bot.log('STATE', `Arrived at Ardougne ship: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Cross gangplank from ship (level 1) to ground.
    // The Ardougne-side gangplank is named brimhavenshipplank_off (from the Brimhaven ship)
    const plank = bot.interaction.findLoc('brimhavenshipplank_off', 16);
    if (!plank) throw new Error(`sailBrimhaven: brimhavenshipplank_off not found near (${bot.player.x},${bot.player.z},${bot.player.level})`);
    await bot.interaction.loc(plank, 1);
    await bot.waitForTicks(5);

    bot.log('STATE', `On Ardougne dock ground: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
}

async function walkToMonastery(bot: BotAPI): Promise<void> {
    // Already at monastery?
    const dx = bot.player.x - MONASTERY_X;
    const dz = bot.player.z - MONASTERY_Z;
    if (Math.sqrt(dx * dx + dz * dz) < 30) {
        bot.log('STATE', `Already near monastery: pos=(${bot.player.x},${bot.player.z})`);
        return;
    }

    // Determine sailing needed based on current x position:
    //   x >= 2960 → mainland east (Lumbridge/Asgarnia) → full sail: Port Sarim → Karamja → Brimhaven → Ardougne
    //   2760 <= x < 2960 → Karamja/Brimhaven island → sail only: Brimhaven → Ardougne
    //   x < 2760 → already west (Ardougne area) → just walk to monastery
    if (bot.player.x >= 2960) {
        bot.log('STATE', '=== Walking to monastery (via Port Sarim → Karamja → Brimhaven → Ardougne boats) ===');
        await sailPortSarimToKaramja(bot);
        await sailBrimhavenToArdougne(bot);
    } else if (bot.player.x >= 2760) {
        bot.log('STATE', '=== Walking to monastery (on Karamja/Brimhaven, sailing Brimhaven → Ardougne) ===');
        await sailBrimhavenToArdougne(bot);
    }

    // Walk from Ardougne dock area to monastery
    for (const wp of ROUTE_ARDOUGNE_TO_MONASTERY) {
        await bot.walking.walkToWithPathfinding(wp.x, wp.z);
    }

    bot.log('STATE', `Near monastery: pos=(${bot.player.x},${bot.player.z})`);
}

/**
 * Walk near Brother Omad and initiate interaction.
 * Omad wanders inside the monastery building.
 */
async function approachAndTalkToOmad(bot: BotAPI, stateName: string): Promise<void> {
    await bot.walking.walkToWithPathfinding(MONASTERY_X, MONASTERY_Z);

    let omad = bot.interaction.findNpc('Brother Omad');
    if (!omad) {
        throw new Error(`${stateName}: Brother Omad not found near (${bot.player.x},${bot.player.z})`);
    }

    bot.log('STATE', `Found Brother Omad at (${omad.x},${omad.z}), walking closer...`);
    await bot.walking.walkToWithPathfinding(omad.x, omad.z);
    await bot.waitForTicks(1);

    // Re-find after walking — he may have wandered
    omad = bot.interaction.findNpc('Brother Omad');
    if (!omad) {
        throw new Error(`${stateName}: Brother Omad not found after walking close`);
    }

    bot.log('STATE', `Talking to Brother Omad at (${omad.x},${omad.z})`);
    await bot.interaction.npc(omad, 1);
}

/**
 * Walk near Brother Cedric and initiate interaction.
 * Cedric is in the forest at (2614, 3259).
 */
async function approachAndTalkToCedric(bot: BotAPI, stateName: string): Promise<void> {
    await bot.walking.walkToWithPathfinding(CEDRIC_X, CEDRIC_Z);

    let cedric = bot.interaction.findNpc('Brother Cedric');
    if (!cedric) {
        throw new Error(`${stateName}: Brother Cedric not found near (${bot.player.x},${bot.player.z})`);
    }

    bot.log('STATE', `Found Brother Cedric at (${cedric.x},${cedric.z}), walking closer...`);
    await bot.walking.walkToWithPathfinding(cedric.x, cedric.z);
    await bot.waitForTicks(1);

    cedric = bot.interaction.findNpc('Brother Cedric');
    if (!cedric) {
        throw new Error(`${stateName}: Brother Cedric not found after walking close`);
    }

    bot.log('STATE', `Talking to Brother Cedric at (${cedric.x},${cedric.z})`);
    await bot.interaction.npc(cedric, 1);
}

// ---- State machine ----

export function buildMonksFriendStates(bot: BotAPI): BotState {
    return {
        name: 'monks-friend',
        entrySnapshot: {
            position: { x: 3222, z: 3218 },
            varps: { [MONKS_FRIEND_VARP]: 0 },
            items: ['Bronze pickaxe'],
        },
        isComplete: () => bot.getQuestProgress(MONKS_FRIEND_VARP) === STAGE_COMPLETE,
        run: async () => { throw new Error('Composite state should not be called directly'); },
        children: [

            // ----------------------------------------------------------------
            // State 1: start-quest (varp 0 → 10)
            // Buy supplies in Lumbridge, walk to monastery, talk to Brother Omad
            // ----------------------------------------------------------------
            {
                name: 'start-quest',
                entrySnapshot: {
                    position: { x: 3222, z: 3218 },
                    varps: { [MONKS_FRIEND_VARP]: 0 },
                    items: ['Bronze pickaxe'],
                },
                isComplete: () => bot.getQuestProgress(MONKS_FRIEND_VARP) >= STAGE_SPOKEN_TO_OMAD,
                stuckThreshold: 5000,
                run: async () => {
                    const hasJug = !!bot.inventory.find('Jug');
                    const hasAxe = !!bot.inventory.find('Bronze axe');

                    // ---- Earn coins for items + boat fees (30gp Port Sarim + 30gp Brimhaven) ----
                    // Only pickpocket on mainland — Karamja/Brimhaven has no Men and bot
                    // should still have enough coins from initial earn for the Brimhaven boat.
                    const coins = bot.inventory.count('Coins');
                    if (coins < 100 && bot.player.x >= 2960) {
                        await bot.earnCoinsViaPickpocket(100);
                    }

                    // ---- Buy Jug from Lumbridge General Store ----
                    if (!hasJug) {
                        bot.log('STATE', '=== Buying Jug from General Store ===');
                        await bot.walking.walkToWithPathfinding(GENERAL_STORE_X, GENERAL_STORE_Z);
                        await bot.interaction.openDoor('poordooropen');

                        const shopkeeper = bot.interaction.findNpc('Shop keeper');
                        if (!shopkeeper) {
                            throw new Error(`start-quest: Shop keeper not found near (${bot.player.x},${bot.player.z})`);
                        }
                        await bot.interaction.npc(shopkeeper, 3); // op3 = Trade
                        await bot.waitForTicks(3);
                        await bot.shop.buy('Jug', 1);
                        await bot.waitForTicks(1);
                        bot.dialog.dismissModals();

                        if (!bot.inventory.find('Jug')) {
                            throw new Error('start-quest: Failed to buy Jug from General Store');
                        }
                        bot.log('EVENT', 'Bought Jug');
                    }

                    // ---- Buy Bronze axe from Bob's Brilliant Axes ----
                    if (!hasAxe) {
                        bot.log('STATE', "=== Buying Bronze axe from Bob's ===");
                        await bot.walking.walkToWithPathfinding(BOB_X, BOB_Z);
                        await bot.dialog.clearPendingState();

                        const bob = bot.interaction.findNpc('Bob');
                        if (!bob) {
                            throw new Error(`start-quest: Bob not found near (${bot.player.x},${bot.player.z})`);
                        }
                        await bot.interaction.npc(bob, 1); // op1 = Talk to

                        // chatnpc "Hello. How can I help you?"
                        const b1 = await bot.dialog.waitFor(30);
                        if (!b1) throw new Error('start-quest: No dialog from Bob');
                        await bot.dialog.continue();

                        // p_choice3 → option 2 "Have you anything to sell?"
                        const b2 = await bot.dialog.waitFor(10);
                        if (!b2) throw new Error('start-quest: No choice dialog from Bob');
                        await bot.dialog.selectOption(2);

                        // chatplayer "Have you anything to sell?"
                        const b3 = await bot.dialog.waitFor(10);
                        if (!b3) throw new Error('start-quest: No chatplayer after Bob choice');
                        await bot.dialog.continue();

                        // chatnpc "Yes! I buy and sell axes! Take your pick (or axe)!"
                        const b4 = await bot.dialog.waitFor(10);
                        if (!b4) throw new Error('start-quest: No chatnpc after Bob chatplayer');
                        await bot.dialog.continue();

                        // Shop now open
                        await bot.waitForTicks(1);
                        await bot.shop.buy('Bronze axe', 1);
                        await bot.waitForTicks(1);
                        bot.dialog.dismissModals();

                        if (!bot.inventory.find('Bronze axe')) {
                            throw new Error('start-quest: Failed to buy Bronze axe from Bob');
                        }
                        bot.log('EVENT', 'Bought Bronze axe');
                    }

                    // ---- Walk to monastery ----
                    await walkToMonastery(bot);

                    // ---- Talk to Brother Omad (omad_whats_wrong) ----
                    await approachAndTalkToOmad(bot, 'start-quest');

                    // 1. chatplayer "Hello there, What's wrong?"
                    const d1 = await bot.dialog.waitFor(30);
                    if (!d1) throw new Error('start-quest: No dialog from Brother Omad');
                    await bot.dialog.continue();

                    // 2. chatnpc "*yawn*...oh, hello...*yawn*..."
                    const d2 = await bot.dialog.waitFor(10);
                    if (!d2) throw new Error('start-quest: No chatnpc *yawn* dialog');
                    await bot.dialog.continue();

                    // 3. p_choice2 → option 1 "Why can't you sleep, what's wrong?"
                    const d3 = await bot.dialog.waitFor(10);
                    if (!d3) throw new Error('start-quest: No p_choice2 (why sleep)');
                    await bot.dialog.selectOption(1);

                    // 4. chatplayer "Why can't you sleep, what's wrong?"
                    const d4 = await bot.dialog.waitFor(10);
                    if (!d4) throw new Error("start-quest: No chatplayer \"Why can't you sleep\"");
                    await bot.dialog.continue();

                    // 5. chatnpc "It's brother Androe's son!..."
                    const d5 = await bot.dialog.waitFor(10);
                    if (!d5) throw new Error("start-quest: No chatnpc about Androe's son");
                    await bot.dialog.continue();

                    // 6. chatplayer "I suppose that's what kids do."
                    const d6 = await bot.dialog.waitFor(10);
                    if (!d6) throw new Error('start-quest: No chatplayer "I suppose"');
                    await bot.dialog.continue();

                    // 7. chatnpc "He was fine, up until last week!..."
                    const d7 = await bot.dialog.waitFor(10);
                    if (!d7) throw new Error('start-quest: No chatnpc "He was fine"');
                    await bot.dialog.continue();

                    // 8. chatnpc "Now he won't rest until it's returned..."
                    const d8 = await bot.dialog.waitFor(10);
                    if (!d8) throw new Error("start-quest: No chatnpc \"Now he won't rest\"");
                    await bot.dialog.continue();

                    // 9. p_choice2 → option 1 "Can I help at all?"
                    const d9 = await bot.dialog.waitFor(10);
                    if (!d9) throw new Error('start-quest: No p_choice2 (can I help)');
                    await bot.dialog.selectOption(1);

                    // 10. chatplayer "Can I help at all?"
                    const d10 = await bot.dialog.waitFor(10);
                    if (!d10) throw new Error('start-quest: No chatplayer "Can I help"');
                    await bot.dialog.continue();

                    // 11. chatnpc "Please do. We won't be able to help..."
                    const d11 = await bot.dialog.waitFor(10);
                    if (!d11) throw new Error('start-quest: No chatnpc "Please do"');
                    await bot.dialog.continue();

                    // 12. chatplayer "Where are they?" [varp set to 10 before next dialog]
                    const d12 = await bot.dialog.waitFor(10);
                    if (!d12) throw new Error('start-quest: No chatplayer "Where are they"');
                    await bot.dialog.continue();

                    // 13. chatnpc "They hide in a secret cave in the forest..."
                    const d13 = await bot.dialog.waitFor(10);
                    if (!d13) throw new Error('start-quest: No chatnpc "secret cave"');
                    await bot.dialog.continue();

                    await bot.dialog.continueRemaining();
                    await bot.waitForTicks(2);
                    bot.dialog.dismissModals();

                    const varp = bot.getQuestProgress(MONKS_FRIEND_VARP);
                    if (varp !== STAGE_SPOKEN_TO_OMAD) {
                        throw new Error(`start-quest: Quest varp is ${varp}, expected ${STAGE_SPOKEN_TO_OMAD}`);
                    }
                    bot.log('EVENT', `Quest started! varp=${varp} (blanket_ladder timer now running)`);
                }
            },

            // ----------------------------------------------------------------
            // State 2: get-blanket (varp 10 → 20)
            // Enter cave, grab Child's blanket, return and give it to Omad.
            //
            // NOTE: This state depends on the blanket_ladder player timer being
            // active (started by the Omad dialog in start-quest). When testing
            // via --state=, run after a full E2E that has already placed the
            // ladder (loc_1765 persists for 200 ticks after placement).
            // ----------------------------------------------------------------
            {
                name: 'get-blanket',
                entrySnapshot: {
                    position: { x: 2603, z: 3207 },
                    skills: { THIEVING: 3 },
                    varps: { [MONKS_FRIEND_VARP]: 10 },
                    items: ['Bronze pickaxe', { name: 'Coins', count: 25 }, 'Jug', 'Bronze axe'],
                },
                isComplete: () => bot.getQuestProgress(MONKS_FRIEND_VARP) >= STAGE_RETRIEVED_BLANKET,
                stuckThreshold: 3000,
                run: async () => {
                    const inCave = bot.player.z > 9000;
                    const hasBlank = !!bot.inventory.find("Child's blanket");

                    if (!inCave) {
                        // Walk within 2 tiles of the blanket ladder location.
                        // The tile at (2561,3222) itself is blocked by the loc;
                        // (2563,3222) satisfies the timer's distance<=2 trigger range.
                        bot.log('STATE', '=== Walking to blanket ladder location ===');
                        await bot.walking.walkToWithPathfinding(BLANKET_LADDER_X + 2, BLANKET_LADDER_Z);

                        // Wait for loc_1765 to appear (blanket_ladder timer adds it)
                        bot.log('STATE', 'Waiting for blanket_ladder (loc_1765) to appear...');
                        let ladderFound = false;
                        for (let i = 0; i < 20; i++) {
                            await bot.waitForTick();
                            if (bot.interaction.findLoc('loc_1765')) {
                                ladderFound = true;
                                break;
                            }
                        }
                        if (!ladderFound) {
                            throw new Error(
                                'get-blanket: loc_1765 (blanket ladder) did not appear at ' +
                                `(${BLANKET_LADDER_X},${BLANKET_LADDER_Z}) after 20 ticks. ` +
                                'The blanket_ladder timer must be active (requires start-quest to have run first).'
                            );
                        }
                        bot.log('EVENT', 'Blanket ladder (loc_1765) appeared');

                        // Climb down into the thieves' cave (z → 3222 + 6400 = 9622)
                        await bot.interaction.climbStairs('loc_1765', 1);
                        await bot.waitForTicks(2);

                        if (Math.abs(bot.player.z - 9621) > 20) {
                            throw new Error(`get-blanket: Failed to enter cave: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
                        }
                    }
                    bot.log('STATE', `In cave: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

                    if (!hasBlank) {
                        // Walk to (2570,9607) — the closest reachable tile north of the blanket.
                        // Cave walls block direct approach at z<=9606; the engine's APOBJ3
                        // handler navigates the final step to pick up from (2570,9604).
                        await bot.walking.walkToWithPathfinding(2570, 9607);

                        bot.log('ACTION', "Taking Child's blanket from cave floor");
                        await bot.interaction.takeGroundItem("Child's blanket", CAVE_BLANKET_X, CAVE_BLANKET_Z);
                        await bot.waitForTicks(3);

                        if (!bot.inventory.find("Child's blanket")) {
                            throw new Error("get-blanket: Failed to pick up Child's blanket from cave floor");
                        }
                        bot.log('EVENT', "Got Child's blanket");
                    }

                    // Climb out via loc_1755. The exit tile itself may be blocked, so skip
                    // walkToWithPathfinding and let interactLoc handle approach pathfinding.
                    // Use radius=20 since blanket pickup leaves bot ~18 tiles from exit.
                    const exitLadder = bot.interaction.findLoc('loc_1755', 20);
                    if (!exitLadder) throw new Error(`get-blanket: loc_1755 (cave exit) not found near (${bot.player.x},${bot.player.z})`);
                    await bot.interaction.loc(exitLadder, 1);
                    await bot.waitForTicks(5);

                    if (Math.abs(bot.player.z - 3222) > 20) {
                        throw new Error(`get-blanket: Failed to exit cave: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
                    }
                    bot.log('STATE', `Back on surface: pos=(${bot.player.x},${bot.player.z})`);

                    // Return to monastery and give the blanket to Omad (omad_have_blanket)
                    await approachAndTalkToOmad(bot, 'get-blanket');

                    // 1. chatplayer "Hello."
                    const d1 = await bot.dialog.waitFor(30);
                    if (!d1) throw new Error('get-blanket: No dialog when returning blanket to Omad');
                    await bot.dialog.continue();

                    // 2. chatnpc "*yawn*...oh, hello again...*yawn*"
                    const d2 = await bot.dialog.waitFor(10);
                    if (!d2) throw new Error('get-blanket: No chatnpc hello again');
                    await bot.dialog.continue();

                    // 3. chatnpc "Please tell me you have the blanket."
                    const d3 = await bot.dialog.waitFor(10);
                    if (!d3) throw new Error('get-blanket: No chatnpc "Please tell me"');
                    await bot.dialog.continue();

                    // 4. chatplayer "Yes! I've recovered it from the clutches of the evil thieves!"
                    const d4 = await bot.dialog.waitFor(10);
                    if (!d4) throw new Error("get-blanket: No chatplayer \"Yes! I've recovered it\"");
                    await bot.dialog.continue();

                    // 5. objbox "You hand the monk the childs blanket."
                    const d5 = await bot.dialog.waitFor(10);
                    if (!d5) throw new Error('get-blanket: No objbox for blanket handover');
                    await bot.dialog.continue();

                    // 6. chatnpc "Really, that's excellent, well done!..."
                    const d6 = await bot.dialog.waitFor(10);
                    if (!d6) throw new Error("get-blanket: No chatnpc \"Really, that's excellent\"");
                    await bot.dialog.continue();

                    // 7. chatnpc "*yawn*..I'm off to bed! Farewell..." [varp = 20]
                    const d7 = await bot.dialog.waitFor(10);
                    if (!d7) throw new Error('get-blanket: No chatnpc "off to bed"');
                    await bot.dialog.continue();

                    await bot.dialog.continueRemaining();
                    await bot.waitForTicks(3);
                    bot.dialog.dismissModals();

                    const varp = bot.getQuestProgress(MONKS_FRIEND_VARP);
                    if (varp !== STAGE_RETRIEVED_BLANKET) {
                        throw new Error(`get-blanket: Quest varp is ${varp}, expected ${STAGE_RETRIEVED_BLANKET}`);
                    }
                    bot.log('EVENT', `Blanket delivered! varp=${varp}`);
                }
            },

            // ----------------------------------------------------------------
            // State 3: organize-party (varp 20 → 30)
            // Talk to Omad about organizing the party; he asks us to find Cedric.
            // ----------------------------------------------------------------
            {
                name: 'organize-party',
                entrySnapshot: {
                    position: { x: 2606, z: 3210 },
                    skills: { THIEVING: 3 },
                    varps: { [MONKS_FRIEND_VARP]: 20 },
                    items: ['Bronze pickaxe', { name: 'Coins', count: 25 }, 'Jug', 'Bronze axe'],
                },
                isComplete: () => bot.getQuestProgress(MONKS_FRIEND_VARP) >= STAGE_LOOKING_CEDRIC,
                run: async () => {
                    await approachAndTalkToOmad(bot, 'organize-party');

                    // omad_organize_party dialog:
                    // 1. chatplayer "Hello, how are you?"
                    const d1 = await bot.dialog.waitFor(30);
                    if (!d1) throw new Error('organize-party: No dialog from Omad');
                    await bot.dialog.continue();

                    // 2. chatnpc "Much better now I'm sleeping well!..."
                    const d2 = await bot.dialog.waitFor(10);
                    if (!d2) throw new Error('organize-party: No chatnpc "Much better"');
                    await bot.dialog.continue();

                    // 3. chatplayer "Ooh! What party?"
                    const d3 = await bot.dialog.waitFor(10);
                    if (!d3) throw new Error('organize-party: No chatplayer "What party"');
                    await bot.dialog.continue();

                    // 4. chatnpc "The son of Brother Androe's birthday party..."
                    const d4 = await bot.dialog.waitFor(10);
                    if (!d4) throw new Error('organize-party: No chatnpc birthday');
                    await bot.dialog.continue();

                    // 5. chatplayer "That's sweet!"
                    const d5 = await bot.dialog.waitFor(10);
                    if (!d5) throw new Error("organize-party: No chatplayer \"That's sweet!\"");
                    await bot.dialog.continue();

                    // 6. chatnpc "It's also a great excuse for a drink!"
                    const d6 = await bot.dialog.waitFor(10);
                    if (!d6) throw new Error('organize-party: No chatnpc "great excuse"');
                    await bot.dialog.continue();

                    // 7. chatnpc "We just need Brother Cedric to return with the wine."
                    const d7 = await bot.dialog.waitFor(10);
                    if (!d7) throw new Error('organize-party: No chatnpc "Brother Cedric"');
                    await bot.dialog.continue();

                    // 8. p_choice2 → option 1 "Who's Brother Cedric?"
                    const d8 = await bot.dialog.waitFor(10);
                    if (!d8) throw new Error("organize-party: No p_choice2 \"Who's Brother Cedric?\"");
                    await bot.dialog.selectOption(1);

                    // 9. chatplayer "Who's Brother Cedric?"
                    const d9 = await bot.dialog.waitFor(10);
                    if (!d9) throw new Error("organize-party: No chatplayer \"Who's Brother Cedric?\"");
                    await bot.dialog.continue();

                    // 10. chatnpc "Cedric is a member of the order too..."
                    const d10 = await bot.dialog.waitFor(10);
                    if (!d10) throw new Error('organize-party: No chatnpc "Cedric is a member"');
                    await bot.dialog.continue();

                    // 11. chatnpc "He most probably got drunk and lost in the forest!"
                    const d11 = await bot.dialog.waitFor(10);
                    if (!d11) throw new Error('organize-party: No chatnpc "got drunk"');
                    await bot.dialog.continue();

                    // 12. chatnpc "I don't suppose you could look for him?"
                    const d12 = await bot.dialog.waitFor(10);
                    if (!d12) throw new Error('organize-party: No chatnpc "look for him"');
                    await bot.dialog.continue();

                    // 13. multi3 → option 2 "Where should I look?"
                    const d13 = await bot.dialog.waitFor(10);
                    if (!d13) throw new Error('organize-party: No multi3 dialog');
                    await bot.dialog.selectOption(2);

                    // 14. chatplayer "Where should I look?"
                    const d14 = await bot.dialog.waitFor(10);
                    if (!d14) throw new Error('organize-party: No chatplayer "Where should I look?"');
                    await bot.dialog.continue();

                    // 15. chatnpc "Oh, he won't be far. Probably out in the forest."
                    const d15 = await bot.dialog.waitFor(10);
                    if (!d15) throw new Error("organize-party: No chatnpc \"he won't be far\"");
                    await bot.dialog.continue();

                    // 16. chatplayer "Ok, I'll go and find him." [varp = 30]
                    const d16 = await bot.dialog.waitFor(10);
                    if (!d16) throw new Error("organize-party: No chatplayer \"Ok, I'll go and find him\"");
                    await bot.dialog.continue();

                    await bot.dialog.continueRemaining();
                    await bot.waitForTicks(2);
                    bot.dialog.dismissModals();

                    const varp = bot.getQuestProgress(MONKS_FRIEND_VARP);
                    if (varp !== STAGE_LOOKING_CEDRIC) {
                        throw new Error(`organize-party: Quest varp is ${varp}, expected ${STAGE_LOOKING_CEDRIC}`);
                    }
                    bot.log('EVENT', `Now looking for Cedric! varp=${varp}`);
                }
            },

            // ----------------------------------------------------------------
            // State 4: find-cedric (varp 30 → 40)
            // Walk to Cedric in the forest; he asks for a jug of water.
            // ----------------------------------------------------------------
            {
                name: 'find-cedric',
                entrySnapshot: {
                    position: { x: 2605, z: 3211 },
                    skills: { THIEVING: 3 },
                    varps: { [MONKS_FRIEND_VARP]: 30 },
                    items: ['Bronze pickaxe', { name: 'Coins', count: 25 }, 'Jug', 'Bronze axe'],
                },
                isComplete: () => bot.getQuestProgress(MONKS_FRIEND_VARP) >= STAGE_FINDING_WATER,
                run: async () => {
                    bot.log('STATE', '=== Walking to Brother Cedric in the forest ===');
                    await approachAndTalkToCedric(bot, 'find-cedric');

                    // cedric_okay dialog:
                    // 1. chatplayer "Brother Cedric are you okay?"
                    const d1 = await bot.dialog.waitFor(30);
                    if (!d1) throw new Error('find-cedric: No dialog from Cedric');
                    await bot.dialog.continue();

                    // 2. chatnpc "Yeesshhh, I'm very, very drunk..hic..up.."
                    const d2 = await bot.dialog.waitFor(10);
                    if (!d2) throw new Error('find-cedric: No chatnpc drunk response');
                    await bot.dialog.continue();

                    // 3. chatplayer "Brother Omad needs the wine for the party."
                    const d3 = await bot.dialog.waitFor(10);
                    if (!d3) throw new Error('find-cedric: No chatplayer "needs the wine"');
                    await bot.dialog.continue();

                    // 4. chatnpc "Oh dear, oh dear, I knew I had to do something!"
                    const d4 = await bot.dialog.waitFor(10);
                    if (!d4) throw new Error('find-cedric: No chatnpc "Oh dear"');
                    await bot.dialog.continue();

                    // 5. chatnpc "Pleashhh, find me a jug of water..." [varp = 40]
                    const d5 = await bot.dialog.waitFor(10);
                    if (!d5) throw new Error('find-cedric: No chatnpc "jug of water"');
                    await bot.dialog.continue();

                    await bot.dialog.continueRemaining();
                    await bot.waitForTicks(2);
                    bot.dialog.dismissModals();

                    const varp = bot.getQuestProgress(MONKS_FRIEND_VARP);
                    if (varp !== STAGE_FINDING_WATER) {
                        throw new Error(`find-cedric: Quest varp is ${varp}, expected ${STAGE_FINDING_WATER}`);
                    }
                    bot.log('EVENT', `Found Cedric! He needs water. varp=${varp}`);
                }
            },

            // ----------------------------------------------------------------
            // State 5: get-water (varp 40 → 60)
            // Fill jug at fountain, give water to Cedric, agree to fix his cart.
            // Covers stages 40 → 50 (given_water, transitional) → 60 (fixing_cart).
            // ----------------------------------------------------------------
            {
                name: 'get-water',
                entrySnapshot: {
                    position: { x: 2617, z: 3259 },
                    skills: { THIEVING: 3 },
                    varps: { [MONKS_FRIEND_VARP]: 40 },
                    items: ['Bronze pickaxe', { name: 'Coins', count: 25 }, 'Jug', 'Bronze axe'],
                },
                isComplete: () => bot.getQuestProgress(MONKS_FRIEND_VARP) >= STAGE_FIXING_CART,
                run: async () => {
                    if (!bot.inventory.find('Jug')) {
                        throw new Error('get-water: No Jug in inventory — required to fill with water at fountain');
                    }

                    // Walk to one tile south of the fountain — the fountain loc itself
                    // blocks the tile at (2629,3311), so we stop at (2629,3310) and let
                    // useItemOnLoc compute the correct approach tile via findPathToLocSegment.
                    bot.log('STATE', '=== Walking to fountain to fill Jug ===');
                    await bot.walking.walkToWithPathfinding(FOUNTAIN_X, FOUNTAIN_Z - 1);
                    await bot.waitForTick();

                    // Use Jug on the fountain (triggers [oplocu,_watersource])
                    bot.log('ACTION', 'Using Jug on fountain');
                    await bot.interaction.useItemOnLoc('Jug', 'fountain');
                    await bot.waitForTicks(3);

                    if (!bot.inventory.find('Jug of water')) {
                        throw new Error('get-water: Failed to fill Jug — no "Jug of water" in inventory after using fountain');
                    }
                    bot.log('EVENT', 'Jug of water obtained');

                    // Walk back to Cedric
                    await approachAndTalkToCedric(bot, 'get-water');

                    // cedric_need_water dialog (with jug_water in inventory):
                    // 1. chatplayer "Are you okay?"
                    const d1 = await bot.dialog.waitFor(30);
                    if (!d1) throw new Error('get-water: No dialog from Cedric (give water)');
                    await bot.dialog.continue();

                    // 2. chatnpc "Hic up! Oh my head! I need a jug of water."
                    const d2 = await bot.dialog.waitFor(10);
                    if (!d2) throw new Error('get-water: No chatnpc "Hic up!"');
                    await bot.dialog.continue();

                    // 3. chatplayer "Cedric! Here, drink! I have some water."
                    const d3 = await bot.dialog.waitFor(10);
                    if (!d3) throw new Error('get-water: No chatplayer "Here, drink!"');
                    await bot.dialog.continue();

                    // 4. chatnpc "Good stuff, my head's spinning!"
                    const d4 = await bot.dialog.waitFor(10);
                    if (!d4) throw new Error('get-water: No chatnpc "Good stuff"');
                    await bot.dialog.continue();

                    // 5. objbox "You hand the monk a jug of water." [varp → 50]
                    const d5 = await bot.dialog.waitFor(10);
                    if (!d5) throw new Error('get-water: No objbox for water handover');
                    await bot.dialog.continue();

                    // 6. chatnpc "Aah! That's better!" [script falls to cedric_fix_cart]
                    const d6 = await bot.dialog.waitFor(10);
                    if (!d6) throw new Error("get-water: No chatnpc \"Aah! That's better!\"");
                    await bot.dialog.continue();

                    // cedric_fix_cart dialog (flows directly from cedric_need_water):
                    // 7. chatnpc "Now I just need to fix this cart and we can go party."
                    const d7 = await bot.dialog.waitFor(10);
                    if (!d7) throw new Error('get-water: No chatnpc "fix this cart"');
                    await bot.dialog.continue();

                    // 8. chatnpc "Could you help?"
                    const d8 = await bot.dialog.waitFor(10);
                    if (!d8) throw new Error('get-water: No chatnpc "Could you help?"');
                    await bot.dialog.continue();

                    // 9. p_choice2 → option 2 "Yes, I'd be happy to!"
                    const d9 = await bot.dialog.waitFor(10);
                    if (!d9) throw new Error('get-water: No p_choice2 for cart help');
                    await bot.dialog.selectOption(2);

                    // 10. chatplayer "Yes, I'd be happy to!" [varp = 60]
                    const d10 = await bot.dialog.waitFor(10);
                    if (!d10) throw new Error("get-water: No chatplayer \"Yes, I'd be happy to!\"");
                    await bot.dialog.continue();

                    // 11. chatnpc "Excellent, I just need some wood."
                    const d11 = await bot.dialog.waitFor(10);
                    if (!d11) throw new Error('get-water: No chatnpc "some wood"');
                    await bot.dialog.continue();

                    // 12. chatplayer "OK, I'll see what I can find."
                    const d12 = await bot.dialog.waitFor(10);
                    if (!d12) throw new Error("get-water: No chatplayer \"OK, I'll see what I can find\"");
                    await bot.dialog.continue();

                    await bot.dialog.continueRemaining();
                    await bot.waitForTicks(2);
                    bot.dialog.dismissModals();

                    const varp = bot.getQuestProgress(MONKS_FRIEND_VARP);
                    if (varp !== STAGE_FIXING_CART) {
                        throw new Error(`get-water: Quest varp is ${varp}, expected ${STAGE_FIXING_CART}`);
                    }
                    bot.log('EVENT', `Agreed to fix the cart! varp=${varp}`);
                }
            },

            // ----------------------------------------------------------------
            // State 6: get-wood (varp 60 → 70)
            // Chop a tree for logs, give them to Cedric to fix the cart.
            // ----------------------------------------------------------------
            {
                name: 'get-wood',
                entrySnapshot: {
                    position: { x: 2614, z: 3260 },
                    skills: { THIEVING: 3 },
                    varps: { [MONKS_FRIEND_VARP]: 60 },
                    items: ['Bronze pickaxe', { name: 'Coins', count: 25 }, 'Bronze axe'],
                },
                isComplete: () => bot.getQuestProgress(MONKS_FRIEND_VARP) >= STAGE_FIXED_CART,
                stuckThreshold: 2000,
                run: async () => {
                    if (!bot.inventory.find('Bronze axe')) {
                        throw new Error('get-wood: No Bronze axe in inventory — required for woodcutting');
                    }

                    // Walk west of Cedric to reach regular trees confirmed at (2609,3262) etc.
                    // East route blocked by water/timberwalls at x=2639+.
                    bot.log('STATE', '=== Walking to chop a tree for logs ===');
                    await bot.walking.walkToWithPathfinding(TREE_X, TREE_Z);

                    // Chop until we have at least one log
                    let chopAttempts = 0;
                    const MAX_CHOP_ATTEMPTS = 100;

                    while (!bot.inventory.find('Logs') && chopAttempts < MAX_CHOP_ATTEMPTS) {
                        await bot.dialog.clearPendingState();

                        const tree = bot.interaction.findLoc('tree') ?? bot.interaction.findLoc('tree2') ?? bot.interaction.findLoc('lighttree');
                        if (!tree) {
                            // Tree depleted; wait for respawn
                            await bot.waitForTicks(5);
                            chopAttempts++;
                            continue;
                        }

                        const xpBefore = bot.getSkill('Woodcutting').exp;
                        await bot.interaction.loc(tree, 1);

                        // Wait for logs or XP gain (up to 30 ticks)
                        for (let i = 0; i < 30; i++) {
                            await bot.waitForTick();
                            if (bot.inventory.find('Logs') || bot.getSkill('Woodcutting').exp > xpBefore) break;
                        }

                        await bot.waitForTicks(1);
                        bot.dialog.dismissModals();
                        chopAttempts++;
                    }

                    if (!bot.inventory.find('Logs')) {
                        throw new Error(`get-wood: Failed to obtain Logs after ${MAX_CHOP_ATTEMPTS} attempts`);
                    }
                    bot.log('EVENT', 'Got logs');

                    // Walk back to Cedric and give him the logs
                    await approachAndTalkToCedric(bot, 'get-wood');

                    // cedric_get_wood dialog (with logs in inventory):
                    // 1. chatnpc "Did you manage to get some wood?"
                    const d1 = await bot.dialog.waitFor(30);
                    if (!d1) throw new Error('get-wood: No dialog from Cedric (give logs)');
                    await bot.dialog.continue();

                    // 2. objbox "You hand Cedric some logs."
                    const d2 = await bot.dialog.waitFor(10);
                    if (!d2) throw new Error('get-wood: No objbox for logs handover');
                    await bot.dialog.continue();

                    // 3. chatplayer "Here you go!"
                    const d3 = await bot.dialog.waitFor(10);
                    if (!d3) throw new Error('get-wood: No chatplayer "Here you go!"');
                    await bot.dialog.continue();

                    // 4. chatnpc "Well done! Now I'll fix this cart..." [varp = 70]
                    const d4 = await bot.dialog.waitFor(10);
                    if (!d4) throw new Error('get-wood: No chatnpc "Well done!"');
                    await bot.dialog.continue();

                    // 5. chatplayer "Ok! I'll see you later!"
                    const d5 = await bot.dialog.waitFor(10);
                    if (!d5) throw new Error("get-wood: No chatplayer \"Ok! I'll see you later!\"");
                    await bot.dialog.continue();

                    await bot.dialog.continueRemaining();
                    await bot.waitForTicks(2);
                    bot.dialog.dismissModals();

                    const varp = bot.getQuestProgress(MONKS_FRIEND_VARP);
                    if (varp !== STAGE_FIXED_CART) {
                        throw new Error(`get-wood: Quest varp is ${varp}, expected ${STAGE_FIXED_CART}`);
                    }
                    bot.log('EVENT', `Cart fixed! Returning to Omad. varp=${varp}`);
                }
            },

            // ----------------------------------------------------------------
            // State 7: complete-quest (varp 70 → 80)
            // Tell Omad the good news; the party runs and the quest completes.
            // Rewards: 8 Law runes + 20000 Woodcutting XP (via drunkmonk_complete queue).
            // ----------------------------------------------------------------
            {
                name: 'complete-quest',
                entrySnapshot: {
                    position: { x: 2611, z: 3257 },
                    skills: { THIEVING: 3 },
                    varps: { [MONKS_FRIEND_VARP]: 70 },
                    items: ['Bronze pickaxe', { name: 'Coins', count: 25 }, 'Bronze axe'],
                },
                isComplete: () => bot.getQuestProgress(MONKS_FRIEND_VARP) === STAGE_COMPLETE,
                run: async () => {
                    bot.log('STATE', '=== Returning to Brother Omad for the party ===');
                    await approachAndTalkToOmad(bot, 'complete-quest');

                    // omad_party dialog:
                    // 1. chatplayer "Hi Omad, Brother Cedric is on his way!"
                    const d1 = await bot.dialog.waitFor(30);
                    if (!d1) throw new Error('complete-quest: No dialog from Omad');
                    await bot.dialog.continue();

                    // 2. chatnpc "Good! Good! Now we can party!"
                    const d2 = await bot.dialog.waitFor(10);
                    if (!d2) throw new Error('complete-quest: No chatnpc "Now we can party!"');
                    await bot.dialog.continue();

                    // 3. chatnpc "I have little to repay you with but please! Take these Rune Stones."
                    const d3 = await bot.dialog.waitFor(10);
                    if (!d3) throw new Error('complete-quest: No chatnpc "repay you"');
                    await bot.dialog.continue();

                    // 4. objbox "Brother Omad gives you 8 Law Runes."
                    const d4 = await bot.dialog.waitFor(10);
                    if (!d4) throw new Error('complete-quest: No objbox for law runes');
                    await bot.dialog.continue();

                    // 5. chatplayer "Thanks Brother Omad!"
                    const d5 = await bot.dialog.waitFor(10);
                    if (!d5) throw new Error('complete-quest: No chatplayer "Thanks"');
                    await bot.dialog.continue();

                    // 6. chatnpc "OK, let's party!" [drunkmonk_party label runs]
                    const d6 = await bot.dialog.waitFor(10);
                    if (!d6) throw new Error("complete-quest: No chatnpc \"let's party!\"");
                    await bot.dialog.continue();

                    await bot.dialog.continueRemaining();

                    // Wait for the party animation (multiple p_delay(2) calls) and
                    // drunkmonk_complete queue to fire (sets varp=80, gives law runes + WC xp).
                    bot.log('STATE', 'Waiting for party to complete (drunkmonk_complete queue)...');
                    let questDone = false;
                    for (let i = 0; i < 60; i++) {
                        await bot.waitForTick();
                        bot.dialog.dismissModals();
                        if (bot.getQuestProgress(MONKS_FRIEND_VARP) === STAGE_COMPLETE) {
                            questDone = true;
                            break;
                        }
                    }

                    if (!questDone) {
                        throw new Error(
                            `complete-quest: Quest not complete after 60 ticks: varp=${bot.getQuestProgress(MONKS_FRIEND_VARP)}`
                        );
                    }

                    await bot.waitForTicks(3);
                    bot.dialog.dismissModals();

                    const varp = bot.getQuestProgress(MONKS_FRIEND_VARP);
                    const wcSkill = bot.getSkill('Woodcutting');
                    const lawRunes = bot.inventory.find('Law rune');

                    bot.log(
                        'SUCCESS',
                        `Monk's Friend complete! varp=${varp} wc_xp=${wcSkill.exp} law_runes=${lawRunes?.count ?? 0}`
                    );
                }
            }
        ]
    };
}

export async function monksFriend(bot: BotAPI): Promise<void> {
    await skipTutorial(bot);
    await bot.waitForTicks(2);

    bot.log('STATE', `Starting Monk's Friend at (${bot.player.x},${bot.player.z},${bot.player.level})`);

    const initialVarp = bot.getQuestProgress(MONKS_FRIEND_VARP);
    if (initialVarp !== STAGE_NOT_STARTED) {
        throw new Error(`monksFriend: Quest varp is ${initialVarp}, expected ${STAGE_NOT_STARTED} (not started)`);
    }

    const root = buildMonksFriendStates(bot);
    await runStateMachine(bot, { root, varpIds: [MONKS_FRIEND_VARP] });
}

export const metadata: ScriptMeta = {
    name: 'monksfriend',
    type: 'quest',
    varpId: MONKS_FRIEND_VARP,
    varpComplete: STAGE_COMPLETE,
    maxTicks: 30000,
    run: monksFriend,
    buildStates: buildMonksFriendStates,
};
