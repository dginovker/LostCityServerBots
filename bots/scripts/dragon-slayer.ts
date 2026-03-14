import { BotAPI } from '../runtime/api.js';
import { skipTutorial } from './skip-tutorial.js';
import { type BotState, runStateMachine } from '../runtime/state-machine.js';
import type { ScriptMeta } from '../runtime/script-meta.js';
import ObjType from '../../src/cache/config/ObjType.js';
import CategoryType from '../../src/cache/config/CategoryType.js';
import ScriptProvider from '../../src/engine/script/ScriptProvider.js';
import ScriptRunner from '../../src/engine/script/ScriptRunner.js';
import ServerTriggerType from '../../src/engine/script/ServerTriggerType.js';

// Varp IDs (from content/pack/varp.pack)
const DRAGON_QUEST_VARP = 176;     // dragonquest - main quest stage
const DRAGON_QUEST_VAR = 177;      // dragonquestvar - ship repair counter (0-3)
const DRAGON_NED_HIRED = 183;      // dragon_ned_hired
const DRAGON_ORACLE = 184;         // dragon_oracle (0=unknown, 1=knows, 2=spoken, 3=opened door)
const DRAGON_SHIELD = 186;         // dragon_shield (0=unknown, 1=knows)
const DRAGON_GOBLIN = 187;         // dragon_goblin (0=unknown, 1=knows)
const QP_VARP = 101;               // quest points

// Quest stages (from content/scripts/quests/quest_dragon/configs/quest_dragon.constant + quest.constant)
const STAGE_SPOKEN_TO_GUILDMASTER = 1;
const STAGE_SPOKEN_TO_OZIACH = 2;
const STAGE_BOUGHT_SHIP = 3;
const STAGE_REPAIRED_SHIP = 7;
const STAGE_NED_GIVEN_MAP = 8;
const STAGE_SAILED_TO_CRANDOR = 9;
const STAGE_COMPLETE = 10;       // ^dragon_complete from quest.constant

const REQUIRED_QP = 32;

// ---- Key locations ----
// Champions' Guild (south of Varrock)
const CHAMPIONS_GUILD_DOOR_X = 3191;
const CHAMPIONS_GUILD_DOOR_Z = 3355;

// Port Sarim
const PORT_SARIM_DOCK_X = 3046;
const PORT_SARIM_DOCK_Z = 3205;

// Draynor Village (Ned)
const DRAYNOR_NED_X = 3098;
const DRAYNOR_NED_Z = 3257;

// Oracle on Ice Mountain
const ORACLE_AREA_X = 3013;
const ORACLE_AREA_Z = 3501;


// ---- Utility functions ----


/**
 * Eat food if HP is below threshold. Returns true if food was eaten.
 */
async function eatIfNeeded(bot: BotAPI, threshold: number = 0.7): Promise<boolean> {
    const health = bot.getHealth();
    if (health.current >= Math.floor(health.max * threshold)) return false;

    // Try various food items
    const foods = ['Lobster', 'Swordfish', 'Tuna', 'Salmon', 'Trout', 'Meat', 'Bread'];
    for (const food of foods) {
        if (bot.inventory.find(food)) {
            bot.log('ACTION', `Eating ${food} (HP=${health.current}/${health.max})`);
            await bot.interaction.useItemOp1(food);
            await bot.waitForTicks(3);
            return true;
        }
    }
    return false;
}

/**
 * Attack an NPC and wait for it to die. Eat food if HP drops.
 */
async function killNpc(bot: BotAPI, npcName: string, maxTicks: number = 500): Promise<void> {
    const npc = bot.interaction.findNpc(npcName, 16);
    if (!npc) {
        throw new Error(`killNpc: "${npcName}" not found near (${bot.player.x},${bot.player.z})`);
    }

    bot.log('ACTION', `Attacking ${npcName} at (${npc.x},${npc.z}), bot at (${bot.player.x},${bot.player.z})`);

    // IMPORTANT: Once combat starts, do NOT re-engage. The engine's
    // player_melee_attack script ends with p_opnpc(2) which self-sustains
    // the combat loop. Calling interactNpc again triggers p_stopaction
    // which cancels the pending p_opnpc(2), breaking combat.
    let combatStarted = false;

    for (let tick = 0; tick < maxTicks; tick++) {
        await bot.waitForTick();

        if (!npc.isActive) {
            bot.log('EVENT', `${npcName} killed`);
            await bot.waitForTicks(3);
            return;
        }

        await eatIfNeeded(bot, 0.5);
        bot.dialog.dismissModals();

        if (!combatStarted) {
            // Check if combat has started (engine set our target)
            if (bot.player.target !== null) {
                combatStarted = true;
                bot.log('ACTION', `Combat started with ${npcName}`);
            } else if (tick % 5 === 0) {
                // Walk toward NPC's current position and try to attack.
                // NPC wanders (wanderrange 6-9), so eventually it will be
                // reachable via the engine's local pathfinder.
                bot.player.queueWaypoint(npc.x, npc.z);
                try {
                    await bot.interaction.npc(npc, 2);
                    // Do NOT set combatStarted here — interactNpc can return
                    // even when the engine fails to reach the NPC (silent failure).
                    // Only combatStarted=true via the target check above, which
                    // confirms the engine actually engaged the NPC.
                } catch {
                    // Pathfinding failed — NPC unreachable from current position.
                    // Will retry next cycle after NPC wanders.
                }
            }
        }
    }

    throw new Error(`killNpc: failed to kill "${npcName}" in ${maxTicks} ticks`);
}

/**
 * Pick up a ground item near the player's current position.
 */
async function pickupItem(bot: BotAPI, itemName: string): Promise<void> {
    const groundItem = bot.interaction.findGroundItem(itemName, 10);
    if (!groundItem) {
        throw new Error(`pickupItem: "${itemName}" not found on ground near (${bot.player.x},${bot.player.z})`);
    }
    await bot.interaction.takeGroundItem(itemName, groundItem.x, groundItem.z);
    await bot.waitForTicks(3);
}

// ================================================================
// Quest state implementations
// ================================================================

/**
 * Enter Champions' Guild and talk to Guildmaster.
 * Dialog: "What is this place?" -> "Do you know where I could get a Rune Plate mail body?"
 * -> Guildmaster mentions Oziach -> varp becomes 1
 */
async function talkToGuildmaster(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Talking to Guildmaster at Champions\' Guild ===');

    // Walk to Champions' Guild
    await bot.walking.walkToWithPathfinding(CHAMPIONS_GUILD_DOOR_X, CHAMPIONS_GUILD_DOOR_Z);

    // The championdoor checks %qp >= 32, so it should open for us
    // Walk through the door (op1 on championdoor)
    const door = bot.interaction.findLoc('championdoor', 5);
    if (door) {
        await bot.interaction.loc(door, 1);
        await bot.waitForTicks(5);
        await bot.dialog.clearPendingState();
    }

    // Walk inside to find the Guildmaster
    await bot.walking.walkTo(3190, 3361);
    await bot.waitForTicks(2);

    const gm = bot.interaction.findNpc('Guild master', 16);
    if (!gm) {
        throw new Error(`Guildmaster not found near (${bot.player.x},${bot.player.z})`);
    }

    await bot.interaction.talkToNpc('Guild master');

    // chatnpc "Greetings!"
    await bot.dialog.waitFor(15);
    await bot.dialog.continue();

    // p_choice2: "What is this place?" (1) or "Do you know where I could get a Rune Plate mail body?" (2)
    await bot.dialog.waitFor(10);
    await bot.dialog.selectOption(2); // "Do you know where I could get a Rune Plate mail body?"

    // chatplayer "Do you know where I could get a Rune Plate mail body?"
    await bot.dialog.waitFor(10);
    await bot.dialog.continue();

    // chatnpc "I have a friend called Oziach..."
    await bot.dialog.waitFor(10);
    await bot.dialog.continue();

    // chatnpc "Oziach lives in a hut, by the cliffs to the west of Edgeville..."
    await bot.dialog.waitFor(10);
    await bot.dialog.continue();

    await bot.waitForTicks(3);
    await bot.dialog.clearPendingState();

    const varp = bot.getQuestProgress(DRAGON_QUEST_VARP);
    if (varp < STAGE_SPOKEN_TO_GUILDMASTER) {
        throw new Error(`Quest varp after Guildmaster is ${varp}, expected >= ${STAGE_SPOKEN_TO_GUILDMASTER}`);
    }
    bot.log('EVENT', `Talked to Guildmaster: varp=${varp}`);
}

/**
 * Talk to Oziach in Edgeville. Navigate the dialog tree to get:
 * - Quest info (map pieces, shield, dragon location)
 * - Melzar's Maze key
 * Sets varp to 2 (spoken_to_oziach)
 */
async function talkToOziach(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Talking to Oziach in Edgeville ===');

    // Navigate to hut if Oziach isn't nearby (e.g. full E2E flow from Guildmaster)
    if (!bot.interaction.findNpc('Oziach', 16)) {
        await bot.walking.walkToWithPathfinding(3070, 3514);
        const hutDoor = bot.interaction.findLoc('inaccastledoubledoorropen', 5);
        if (!hutDoor) throw new Error(`Oziach hut door not found near (${bot.player.x},${bot.player.z})`);
        await bot.interaction.loc(hutDoor, 1); // opens door, teleports player inside
        await bot.waitForTicks(3);
        await bot.dialog.clearPendingState();
    }

    // Execute Oziach's opnpc1 script directly — avoids AP-walk pathfinding issues
    // when the bot is already inside the hut (snapshot starts at 3067,3516).
    const oziach = bot.interaction.findNpc('Oziach', 16);
    if (!oziach) throw new Error(`Oziach not found near (${bot.player.x},${bot.player.z})`);
    bot.player.clearPendingAction();
    const ozScript = ScriptProvider.getByTriggerSpecific(ServerTriggerType.OPNPC1, oziach.type, -1);
    if (!ozScript) throw new Error(`No [opnpc1] script for Oziach (type=${oziach.type})`);
    bot.player.executeScript(ScriptRunner.init(ozScript, bot.player, oziach), true);
    await bot.waitForTick();

    // RS2 flow for varp=1: chatnpc → multi3
    let hasChoice = await bot.dialog.continueUntilChoice(5);
    if (!hasChoice) throw new Error('No multi3 from Oziach initial greeting');
    await bot.dialog.selectOption(1); // "Can you sell me some Rune plate mail?"

    // chatplayer → chatnpc → multi2
    hasChoice = await bot.dialog.continueUntilChoice(5);
    if (!hasChoice) throw new Error('No multi2 from Oziach after rune plate');
    await bot.dialog.selectOption(1); // "The guildmaster of the Champions' Guild told me."

    // chatplayer → 4x chatnpc → p_choice2
    hasChoice = await bot.dialog.continueUntilChoice(10);
    if (!hasChoice) throw new Error('No p_choice2 from Oziach after guildmaster');
    await bot.dialog.selectOption(1); // "So how am I meant to prove that?"

    // chatplayer → chatnpc about Elvarg → p_choice3
    hasChoice = await bot.dialog.continueUntilChoice(5);
    if (!hasChoice) throw new Error('No p_choice3 from Oziach after prove');
    await bot.dialog.selectOption(1); // "A dragon, that sounds like fun!"

    // chatplayer → 3x chatnpc about equipment/shield → varp=2 → multi2
    hasChoice = await bot.dialog.continueUntilChoice(10);
    if (!hasChoice) throw new Error('No multi2 from Oziach after dragon info');

    // multi2: "So where can I find this dragon?" (1), "Where can I get an antidragon shield?" (2)
    await bot.dialog.selectOption(2); // "Where can I get an antidragon shield?"

    // chatplayer → chatnpc about Duke → sets dragon_shield → multi2
    hasChoice = await bot.dialog.continueUntilChoice(5);
    if (!hasChoice) throw new Error('No multi2 from Oziach after shield question');

    // multi2: "So where can I find this dragon?" (1), "Ok I'll try..." (2)
    await bot.dialog.selectOption(1); // "So where can I find this dragon?"

    // chatplayer → 3x chatnpc about map torn up → multi4
    hasChoice = await bot.dialog.continueUntilChoice(10);
    if (!hasChoice) throw new Error('No multi4 from Oziach after dragon question');

    // multi4: first/second/third piece, shield
    await bot.dialog.selectOption(1); // "Where is the first piece of the map?" → gives maze key

    // chatplayer → chatnpc about Melzar's maze → chatnpc about key → objbox → multi4
    hasChoice = await bot.dialog.continueUntilChoice(10);
    if (!hasChoice) throw new Error('No multi4 from Oziach after first piece');

    // multi4 changed: shield/second/third/farewell
    await bot.dialog.selectOption(4); // "Ok I'll try and get everything together."

    // chatplayer → chatnpc "Fare ye well."
    await bot.dialog.continueRemaining(5);

    await bot.waitForTicks(3);
    await bot.dialog.clearPendingState();

    const varp = bot.getQuestProgress(DRAGON_QUEST_VARP);
    if (varp < STAGE_SPOKEN_TO_OZIACH) {
        throw new Error(`Quest varp after Oziach is ${varp}, expected >= ${STAGE_SPOKEN_TO_OZIACH}`);
    }

    // Verify we got the maze key
    if (!bot.inventory.find('Maze key')) {
        throw new Error('Did not receive Maze key from Oziach');
    }

    bot.log('EVENT', `Talked to Oziach: varp=${varp}, have maze key`);
}

/**
 * Get anti-dragon shield from Duke Horacia in Lumbridge Castle.
 * Need to climb stairs to level 1, talk to Duke.
 */
async function getAntiDragonShield(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Getting anti-dragon shield from Duke Horacia ===');

    // Walk to Lumbridge Castle
    await bot.walking.walkToWithPathfinding(3210, 3220);

    // Climb stairs to level 1 if on ground floor
    if ((bot.player.level as number) === 0) {
        // Castle stairs are loc_1738 or similar
        await bot.interaction.climbStairs('loc_1738', 1);
        await bot.waitForTicks(3);
        if ((bot.player.level as number) !== 1) {
            throw new Error(`Failed to climb to level 1: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
        }
    }

    // Walk to Duke on level 1 (use walkTo since no pathfinding on upper floors)
    await bot.walking.walkTo(3210, 3221);

    await bot.interaction.talkToNpc('Duke Horacia');

    // chatnpc "Greetings. Welcome to my castle."
    await bot.dialog.waitFor(15);
    await bot.dialog.continue();

    // multi3: "I seek a shield..." (1), "Have you any quests..." (2), "Where can I find money?" (3)
    // Only shows "I seek a shield" if dragon_shield >= 1 and we don't already have one
    await bot.dialog.waitFor(10);
    if (bot.dialog.isMultiChoiceOpen()) {
        await bot.dialog.selectOption(1); // "I seek a shield that will protect me from the dragon's breath."
    }

    // chatplayer + chatnpc + shield given
    for (let i = 0; i < 5; i++) {
        const d = await bot.dialog.waitFor(10);
        if (!d) break;
        if (bot.dialog.isMultiChoiceOpen()) break;
        await bot.dialog.continue();
    }

    await bot.waitForTicks(3);
    await bot.dialog.clearPendingState();

    if (!bot.inventory.find('Dragonfire shield')) {
        throw new Error('Failed to get anti-dragon shield from Duke');
    }
    bot.log('EVENT', 'Got anti-dragon shield');

    // Climb back down to ground floor
    if ((bot.player.level as number) > 0) {
        await bot.interaction.climbStairs('loc_1739', 3); // op3=Climb-down
        await bot.waitForTicks(3);
    }
}

/**
 * Navigate Melzar's Maze to get map piece 1.
 * Kill: Giant Rat -> Red key, Ghost -> Orange key, Skeleton -> Yellow key,
 *       Zombie -> Blue key, Melzar the Mad -> Magenta key, Lesser Demon -> Green key
 * Open colored doors with keys, open chest for map piece.
 */
async function navigateMelzarsMaze(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Navigating Melzar\'s Maze ===');

    // Equip weapon for maze combat
    const scim = bot.inventory.find('Rune scimitar');
    if (scim) {
        bot.log('STATE', `Equipping Rune scimitar (slot=${scim.slot})`);
        await bot.interaction.equipItem('Rune scimitar');
        await bot.waitForTicks(2);
    } else {
        bot.log('STATE', 'WARNING: No Rune scimitar in inventory');
    }

    // Log starting position and nearby locs before searching for door
    bot.log('STATE', `Start: pos=(${bot.player.x},${bot.player.z},level=${bot.player.level})`);
    bot.log('STATE', `Nearby locs at start:\n${bot.interaction.describeNearbyLocs(bot.player.x, bot.player.z, bot.player.level, 10)}`);

    // Find the melzar door and log its position
    const melzarDoor = bot.interaction.findLoc('melzardoor', 30);
    if (!melzarDoor) throw new Error(`Melzar door not found near (${bot.player.x},${bot.player.z})`);
    bot.log('STATE', `Melzar door at (${melzarDoor.x},${melzarDoor.z}), bot at (${bot.player.x},${bot.player.z})`);

    // Walk to approach position at the SAME z as the door (east side).
    // The door script's check_axis_locactive requires player z == door z
    // for north/south-facing doors to trigger the "entering" teleport.
    await bot.walking.walkTo(melzarDoor.x + 1, melzarDoor.z);
    await bot.waitForTicks(3);

    // Use maze key on the door — the door script will teleport us through
    await bot.interaction.useItemOnLoc('Maze key', 'melzardoor');
    await bot.waitForTicks(5);
    await bot.dialog.clearPendingState();
    bot.log('STATE', `Inside maze: pos=(${bot.player.x},${bot.player.z})`);

    bot.log('STATE', '--- Room 1: Giant Rat (Red key) ---');

    // Kill the nearest rat from entry position
    await killNpc(bot, 'Giant rat');
    await bot.waitForTicks(3);
    await pickupItem(bot, 'Key');
    if (!bot.inventory.find('Key')) throw new Error('Failed to get key from Giant Rat');
    bot.log('STATE', `After rat kill: pos=(${bot.player.x},${bot.player.z})`);

    // Navigate north to ghost room staircase at (2928,3256).
    // The direct path to (2929,3256) is blocked by a terrain wall at x=2929/2930, z=3256.
    // Walk to (2930,3256) instead (confirmed reachable from east section), then
    // let climbStairs' findPathToLocSegment approach the staircase from an adjacent tile.
    bot.log('STATE', '--- Navigating to ghost staircase area ---');
    try {
        await bot.walking.walkToWithPathfinding(2930, 3256);
    } catch (e) {
        bot.log('STATE', `walkToWithPathfinding(2930,3256) ERROR: ${(e as Error).message}`);
        throw e;
    }
    bot.log('STATE', `Near ghost staircase area: pos=(${bot.player.x},${bot.player.z})`);
    bot.log('STATE', `Nearby locs:\n${bot.interaction.describeNearbyLocs(bot.player.x, bot.player.z, bot.player.level, 6)}`);

    // Use red key on reddoor before climbing (nearest reddoor from here is at 2926,3253)
    await bot.interaction.useItemOnLoc('Key', 'reddoor');
    await bot.waitForTicks(5);
    await bot.dialog.clearPendingState();
    bot.log('STATE', `After red door use: pos=(${bot.player.x},${bot.player.z},level=${bot.player.level})`);

    // After reddoor use, walk through the west section north corridor to (2929,3256).
    // (2929,3256) is adjacent to staircase loc_1747 at (2928,3256) — confirmed reachable from west section.
    bot.log('STATE', 'Walking to (2929,3256) via west section corridor');
    try {
        await bot.walking.walkToWithPathfinding(2929, 3256);
    } catch (e) {
        bot.log('STATE', `walkToWithPathfinding(2929,3256) ERROR: ${(e as Error).message}`);
        throw e;
    }
    bot.log('STATE', `At staircase approach: pos=(${bot.player.x},${bot.player.z})`);

    // climbStairs from (2929,3256) — staircase loc_1747 at (2928,3256) is 1 tile west (adjacent).
    // interactLoc's findPathToLocSegment will find the approach immediately.
    bot.log('STATE', '--- Climbing to ghost room (level 1) ---');

    // Climb loc_1747 at (2923,3248) to go up to level 1 ghost room
    await bot.interaction.climbStairs('loc_1747', 1);
    await bot.waitForTicks(3);
    await bot.dialog.clearPendingState();
    bot.log('STATE', `Inside ghost room: pos=(${bot.player.x},${bot.player.z},level=${bot.player.level}), nearby:\n${bot.interaction.describeNearbyLocs(bot.player.x, bot.player.z, bot.player.level, 12)}`);

    // Room 2: Kill Ghost for Orange key
    bot.log('STATE', '--- Room 2: Ghost (Orange key) ---');
    // Debug: search wide radius to find ghost position
    const ghostSearch = bot.interaction.findNpc('Ghost', 32);
    bot.log('STATE', ghostSearch
        ? `Ghost found at (${ghostSearch.x},${ghostSearch.z},level=${ghostSearch.level}), bot at (${bot.player.x},${bot.player.z},level=${bot.player.level})`
        : `Ghost NOT found within 32 tiles of (${bot.player.x},${bot.player.z},level=${bot.player.level})`);
    await killNpc(bot, 'Ghost');
    await bot.waitForTicks(3);
    await pickupItem(bot, 'Key');
    if (!bot.inventory.find('Key')) throw new Error('Failed to get key from Ghost');

    // Orange door wall at x=2931. Walk to (2930,3253) west of the door at z=3253, use key, then
    // immediately walk east through the briefly-opened gap (door changes to inviswall for ~3 ticks).
    // The z=3247 door leads to a dead-end room blocked by spookywardrobe north and terrain walls east.
    // The z=3253 door gives access to the L1 staircase at (2934,3254).
    // entering=false puts bot at door tile (2931,3253); door is passable for 3 ticks so walkTo east.
    bot.log('STATE', `After ghost kill: pos=(${bot.player.x},${bot.player.z})`);
    await bot.walking.walkToWithPathfinding(2930, 3253);
    bot.log('STATE', `Near orange door (z=3253): pos=(${bot.player.x},${bot.player.z})`);
    await bot.interaction.useItemOnLoc('Key', 'orangedoor');
    await bot.dialog.clearPendingState();
    // Walk east through the open door gap immediately (door is in inviswall state for ~3 ticks)
    await bot.walking.walkTo(2933, 3253);
    bot.log('STATE', `After orange door east walk: pos=(${bot.player.x},${bot.player.z})`);
    bot.log('STATE', `Nearby locs east of orange wall:\n${bot.interaction.describeNearbyLocs(bot.player.x, bot.player.z, bot.player.level, 10)}`);

    // Climb stairs to level 2 for skeleton room.
    // loc_1747 at (2934,3254,L1) — climbStairs handles its own approach via interactLoc.
    bot.log('STATE', '--- Climbing stairs to level 2 ---');
    bot.log('STATE', `At L1 staircase approach: pos=(${bot.player.x},${bot.player.z}), locs:\n${bot.interaction.describeNearbyLocs(bot.player.x, bot.player.z, bot.player.level, 6)}`);
    await bot.interaction.climbStairs('loc_1747', 1);
    await bot.waitForTicks(3);
    await bot.dialog.clearPendingState();
    bot.log('STATE', `After stairs to L2: pos=(${bot.player.x},${bot.player.z},level=${bot.player.level})`);

    // Room 3: Kill Skeleton
    bot.log('STATE', '--- Room 3: Skeleton ---');
    await killNpc(bot, 'Skeleton');
    await bot.waitForTicks(3);
    await pickupItem(bot, 'Key');
    if (!bot.inventory.find('Key')) throw new Error('Failed to get yellow key from Skeleton');

    // Use yellow key on yellow door at (2936,3256,L2).
    // There are 4 yellowdoors on L2: inner doors at (2924,3249), (2928,3249), (2931,3249)
    // and the exit door at (2936,3256). findNearbyLoc returns the CLOSEST one.
    // Walk to (2935,3256) — 1 tile west of the exit door — so it wins by distance.
    // open_and_close_door with entering=false: bot teleported to door tile (2936,3256),
    // door becomes inviswall for 3 ticks. MUST immediately walkTo east to pass through.
    bot.log('STATE', '--- Opening yellow door to L2 east section ---');
    bot.log('STATE', `After skeleton kill: pos=(${bot.player.x},${bot.player.z},L${bot.player.level})`);
    // Walk to (2934,3254) — east end of skeleton corridor, z=3256 area blocked by walls.
    // Chebyshev distance to exit door (2936,3256)=2, nearest inner door (2931,3249)=5.
    await bot.walking.walkTo(2934, 3254);
    bot.log('STATE', `Approached exit yellowdoor: pos=(${bot.player.x},${bot.player.z},L${bot.player.level})`);
    await bot.interaction.useItemOnLoc('Key', 'yellowdoor');
    bot.log('STATE', `After useItemOnLoc yellowdoor: pos=(${bot.player.x},${bot.player.z},L${bot.player.level}) delayed=${(bot.player as any).delayed}`);
    await bot.dialog.clearPendingState();
    bot.log('STATE', `After clearPendingState yellowdoor: pos=(${bot.player.x},${bot.player.z},L${bot.player.level})`);
    // Immediately walk east through the 3-tick inviswall window (same pattern as orange door)
    await bot.walking.walkTo(2937, 3256);
    bot.log('STATE', `After yellow door east walk: pos=(${bot.player.x},${bot.player.z},L${bot.player.level})`);
    bot.log('STATE', `L2 east locs:\n${bot.interaction.describeNearbyLocs(bot.player.x, bot.player.z, bot.player.level, 8)}`);

    // Descend L2→L1 via loc_1746 in L2 east section.
    // Walk south to (2937,3254) then east to (2938,3254) [avoiding brickwalls at x=2938,z>=3255]
    // to approach loc_1746 at (2938,3255) from south.
    bot.log('STATE', '--- Descending L2→L1 via east-section ladder at (2938,3255) ---');
    await bot.walking.walkTo(2937, 3254);
    await bot.walking.walkTo(2938, 3254);
    bot.log('STATE', `At L2 south approach to loc_1746: pos=(${bot.player.x},${bot.player.z},L${bot.player.level})`);
    await bot.interaction.climbStairs('loc_1746', 1);
    await bot.waitForTicks(3);
    await bot.dialog.clearPendingState();
    if (bot.player.level !== 1) throw new Error(`Expected L1 after L2→L1 descent, still at L${bot.player.level}, pos=(${bot.player.x},${bot.player.z})`);
    bot.log('STATE', `At L1 after L2 descent: pos=(${bot.player.x},${bot.player.z},L${bot.player.level})`);
    bot.log('STATE', `L1 locs:\n${bot.interaction.describeNearbyLocs(bot.player.x, bot.player.z, bot.player.level, 12)}`);

    // Descend L1→L0 via loc_1746 at (2928,3256,L1).
    // The orange door at (2931,3253,L1) blocks direct westward movement at z=3253.
    // BUT the ghost room corridor at z=3256 is open (no door there on L1).
    // Walk north to z=3256, then west to (2929,3256,L1) — bypassing the orange door wall.
    bot.log('STATE', '--- Descending L1→L0 ---');
    await bot.walking.walkTo(2929, 3256);
    bot.log('STATE', `At ghost corridor (L1→L0 approach): pos=(${bot.player.x},${bot.player.z},L${bot.player.level})`);
    await bot.interaction.climbStairs('loc_1746', 1);
    await bot.waitForTicks(3);
    await bot.dialog.clearPendingState();
    if (bot.player.level !== 0) throw new Error(`Expected L0 after L1→L0 descent, still at L${bot.player.level}, pos=(${bot.player.x},${bot.player.z})`);
    bot.log('STATE', `At L0: pos=(${bot.player.x},${bot.player.z},L${bot.player.level})`);

    // funladdertop at (2932,3240,L0) goes to z+6400 (underground).
    bot.log('STATE', '--- Taking funladdertop underground ---');
    await bot.walking.walkToWithPathfinding(2932, 3240);
    await bot.interaction.climbStairs('funladdertop', 1);
    await bot.waitForTicks(5);
    await bot.dialog.clearPendingState();
    if (bot.player.z < 6000) throw new Error(`Expected underground (z>6000) after funladdertop, at z=${bot.player.z}`);
    bot.log('STATE', `Underground: pos=(${bot.player.x},${bot.player.z},L${bot.player.level})`);

    // Room 4: Kill Zombie for Blue key (underground)
    bot.log('STATE', '--- Room 4: Zombie (Blue key) ---');
    await killNpc(bot, 'Zombie');
    await bot.waitForTicks(3);
    await pickupItem(bot, 'Key');
    if (!bot.inventory.find('Key')) throw new Error('Failed to get key from Zombie');

    await bot.interaction.useItemOnLoc('Key', 'bluedoor');
    await bot.waitForTicks(5);
    await bot.dialog.clearPendingState();

    // Room 5: Kill Melzar the Mad for Magenta key
    bot.log('STATE', '--- Room 5: Melzar the Mad (Magenta key) ---');
    await killNpc(bot, 'Melzar the Mad');
    await bot.waitForTicks(3);
    await pickupItem(bot, 'Key');
    if (!bot.inventory.find('Key')) throw new Error('Failed to get key from Melzar');

    await bot.interaction.useItemOnLoc('Key', 'magentadoor');
    await bot.waitForTicks(5);
    await bot.dialog.clearPendingState();

    // Room 6: Kill Lesser Demon for Green key
    bot.log('STATE', '--- Room 6: Lesser Demon (Green key) ---');
    await killNpc(bot, 'Lesser Demon');
    await bot.waitForTicks(3);
    await pickupItem(bot, 'Key');
    if (!bot.inventory.find('Key')) throw new Error('Failed to get key from Lesser Demon');

    await bot.interaction.useItemOnLoc('Key', 'greendoor');
    await bot.waitForTicks(5);
    await bot.dialog.clearPendingState();

    // Open chest to get map piece 1
    bot.log('STATE', '--- Opening chest for map piece 1 ---');
    const chestShut = bot.interaction.findLoc('funchestshut', 16);
    if (chestShut) {
        await bot.interaction.loc(chestShut, 1); // Open chest
        await bot.waitForTicks(3);
        await bot.dialog.clearPendingState();
    }

    // Search open chest
    const chestOpen = bot.interaction.findLoc('funchestopen', 16);
    if (chestOpen) {
        await bot.interaction.loc(chestOpen, 1); // Search
        await bot.waitForTicks(3);
        await bot.dialog.clearPendingState();
    }

    if (!bot.inventory.find('Map part')) {
        throw new Error('Failed to get map piece 1 from Melzar\'s Maze chest');
    }
    bot.log('EVENT', 'Got map piece 1 from Melzar\'s Maze');

    // Exit through the exit door
    const exitDoor = bot.interaction.findLoc('funexit', 10);
    if (exitDoor) {
        await bot.interaction.loc(exitDoor, 1);
        await bot.waitForTicks(3);
    }
}

/**
 * Talk to Oracle, get the riddle, use items on magic door, get map piece 2.
 * Required items: Wizard's Mind Bomb, Silk, Lobster Pot, Unfired Bowl
 */
async function getOracleMapPiece(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Getting map piece from Oracle ===');

    // Verify we have the required items
    const requiredItems = ["Wizard's mind bomb", 'Silk', 'Lobster pot', 'Unfired bowl'];
    for (const item of requiredItems) {
        if (!bot.inventory.find(item)) {
            throw new Error(`Missing Oracle item: ${item}`);
        }
    }

    // Talk to Oracle if we haven't already (dragon_oracle < 2)
    const oracleVarp = bot.getQuestProgress(DRAGON_ORACLE);
    if (oracleVarp < 2) {
        // Walk to Oracle on Ice Mountain
        await bot.walking.walkToWithPathfinding(ORACLE_AREA_X, ORACLE_AREA_Z);

        await bot.interaction.talkToNpc('Oracle');

        // multi2: "I seek a piece of the map..." (1), "Can you impart your wise knowledge..." (2)
        const hasChoice = await bot.dialog.continueUntilChoice(5);
        if (hasChoice) {
            await bot.dialog.selectOption(1); // "I seek a piece of the map to the island of Crandor."
        }

        // chatplayer + chatnpc riddle (2 pages)
        for (let i = 0; i < 4; i++) {
            const d = await bot.dialog.waitFor(10);
            if (!d) break;
            if (bot.dialog.isMultiChoiceOpen()) break;
            await bot.dialog.continue();
        }

        await bot.waitForTicks(3);
        await bot.dialog.clearPendingState();
        bot.log('EVENT', 'Got Oracle riddle');
    } else {
        bot.log('STATE', 'Already spoken to Oracle (dragon_oracle >= 2)');
    }

    // Walk to the Dwarven Mine trapdoor entrance near Ice Mountain (3019, 3450)
    await bot.walking.walkToWithPathfinding(3019, 3450);

    // The mine entrance is a trapdoor — may be open or closed
    let trapdoor = bot.interaction.findLoc('trapdoor_open', 10);
    if (!trapdoor) {
        // Trapdoor is closed — open it first (op1 on trapdoor opens it)
        trapdoor = bot.interaction.findLoc('trapdoor', 10);
        if (!trapdoor) {
            throw new Error(`Mine trapdoor not found near (${bot.player.x},${bot.player.z})`);
        }
        await bot.interaction.loc(trapdoor, 1); // Opens the trapdoor
        await bot.waitForTicks(3);
        trapdoor = bot.interaction.findLoc('trapdoor_open', 10);
        if (!trapdoor) {
            throw new Error(`Trapdoor didn't open near (${bot.player.x},${bot.player.z})`);
        }
    }
    bot.log('STATE', `Found trapdoor at (${trapdoor.x},${trapdoor.z})`);
    await bot.interaction.loc(trapdoor, 1); // Climb-down
    await bot.waitForTicks(5);
    bot.log('STATE', `In mine: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Navigate toward the magic door in the dwarven mine (search with large radius)
    const door = bot.interaction.findLoc('dragon_slayer_magic_door', 50);
    if (!door) {
        throw new Error(`Magic door not found near (${bot.player.x},${bot.player.z})`);
    }

    // Let interactLoc handle approach via findPathToLocSegment (loc-aware, avoids door tile collision)
    bot.log('STATE', `Magic door at (${door.x},${door.z}), interacting...`);
    await bot.interaction.loc(door, 1); // op1 on the door - checks for items
    await bot.waitForTicks(5);
    await bot.dialog.clearPendingState();
    bot.log('STATE', `After magic door: pos=(${bot.player.x},${bot.player.z})`);

    // Open the chest behind the door
    const oracleChest = bot.interaction.findLoc('oraclechestshut', 16);
    if (oracleChest) {
        await bot.interaction.loc(oracleChest, 1); // Open
        await bot.waitForTicks(3);
        await bot.dialog.clearPendingState();
    }

    const oracleChestOpen = bot.interaction.findLoc('oraclechestopen', 16);
    if (oracleChestOpen) {
        await bot.interaction.loc(oracleChestOpen, 1); // Search
        await bot.waitForTicks(3);
        await bot.dialog.clearPendingState();
    }

    // Check for map piece
    const mapPieceCount = bot.inventory.count('Map part');
    if (mapPieceCount < 1) {
        throw new Error('Failed to get map piece from Oracle chest');
    }
    bot.log('EVENT', `Got map piece from Oracle chest (total map parts: ${mapPieceCount})`);
}

/**
 * Buy map piece 3 from Wormbrain in Port Sarim jail for 10,000 coins.
 */
async function getWormbrainMapPiece(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Getting map piece from Wormbrain ===');

    const coins = bot.inventory.find('Coins');
    if (!coins || coins.count < 10000) {
        throw new Error(`Need 10,000 coins for Wormbrain, have ${coins ? coins.count : 0}`);
    }

    // Walk to the area near Port Sarim jail (avoid brick walls around the jail exterior)
    await bot.walking.walkToWithPathfinding(3014, 3182);

    // Wormbrain is inside the jail behind bars. The engine's approach pathfinding
    // can't reach him (CollisionFlag.PLAYER blocks through bars), so directly
    // execute his [opnpc1] script which skips the LOS check.
    const wormbrain = bot.interaction.findNpc('Wormbrain');
    if (!wormbrain) {
        throw new Error(`Wormbrain not found near (${bot.player.x},${bot.player.z})`);
    }
    bot.player.clearPendingAction();
    const wormbrainScript = ScriptProvider.getByTriggerSpecific(ServerTriggerType.OPNPC1, wormbrain.type, -1);
    if (!wormbrainScript) {
        throw new Error(`No [opnpc1] script found for Wormbrain (type=${wormbrain.type})`);
    }
    bot.player.executeScript(ScriptRunner.init(wormbrainScript, bot.player, wormbrain), true);
    await bot.waitForTick();

    // Wormbrain goes directly to multi3 (no chatnpc first):
    // "I believe you've got a piece of map that I need." (1), "What are you in for?" (2), "Sorry, thought this was a zoo." (3)
    const hasDialog = await bot.dialog.waitFor(30);
    if (!hasDialog) {
        throw new Error(`No dialog from Wormbrain, bot at (${bot.player.x},${bot.player.z})`);
    }
    if (!bot.dialog.isMultiChoiceOpen()) {
        throw new Error('Expected multi-choice from Wormbrain');
    }
    await bot.dialog.selectOption(1); // "I believe you've got a piece of map that I need."

    // chatplayer → chatnpc "So? Why should I be giving it to you?" → multi4
    const hasChoice2 = await bot.dialog.continueUntilChoice(5);
    if (!hasChoice2) {
        throw new Error('No multi4 from Wormbrain after asking about map');
    }

    // multi4: "I'm not going to do anything..." (1), "I'll let you live..." (2), "I suppose I could pay..." (3), "Where did you get..." (4)
    await bot.dialog.selectOption(3); // "I suppose I could pay you for the map piece..."

    // chatplayer about paying → chatnpc about price → multi2
    const hasChoice3 = await bot.dialog.continueUntilChoice(5);
    if (!hasChoice3) {
        throw new Error('No payment multi2 from Wormbrain');
    }

    // multi2: "You must be joking! Forget it." (1), "Alright then, 10,000 it is." (2)
    await bot.dialog.selectOption(2); // "Alright then, 10,000 it is."

    // chatplayer "Alright then, 10,000 coins it is." → payment → mesbox → chatnpc
    await bot.dialog.continueRemaining(5);

    await bot.waitForTicks(3);
    await bot.dialog.clearPendingState();

    const mapPieceCount = bot.inventory.count('Map part');
    if (mapPieceCount < 1) {
        throw new Error('Failed to get map piece from Wormbrain');
    }
    bot.log('EVENT', `Got map piece from Wormbrain (total map parts: ${mapPieceCount})`);
}

/**
 * Combine the 3 map pieces into the complete Crandor map.
 * All 3 map parts have display name "Map part" so useItemOnItem can't
 * distinguish them. We manually find two items at different slots and
 * set up the opheldu interaction directly.
 */
async function combineMapPieces(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Combining map pieces ===');

    const inv = bot.inventory.getAll();
    const mapParts = inv.filter(i => i.name === 'Map part');
    if (mapParts.length < 2) {
        throw new Error(`Need at least 2 map parts to combine, have ${mapParts.length}`);
    }

    // Find two map parts with DIFFERENT obj IDs
    const partA = mapParts[0];
    const partB = mapParts.find(p => p.id !== partA.id);
    if (!partB) {
        throw new Error(`All map parts have the same obj ID (${partA.id}), expected different IDs`);
    }

    bot.log('ACTION', `Combining map parts: id=${partA.id} slot=${partA.slot} on id=${partB.id} slot=${partB.slot}`);

    // Set up the opheldu interaction manually (same logic as api.useItemOnItem)
    bot.player.lastItem = partB.id;       // target
    bot.player.lastSlot = partB.slot;
    bot.player.lastUseItem = partA.id;    // source
    bot.player.lastUseSlot = partA.slot;

    bot.player.clearPendingAction();

    const objType = ObjType.get(bot.player.lastItem);
    let script = ScriptProvider.getByTriggerSpecific(ServerTriggerType.OPHELDU, objType.id, -1);

    if (!script) {
        const useObjType = ObjType.get(bot.player.lastUseItem);
        script = ScriptProvider.getByTriggerSpecific(ServerTriggerType.OPHELDU, useObjType.id, -1);
        if (script) {
            [bot.player.lastItem, bot.player.lastUseItem] = [bot.player.lastUseItem, bot.player.lastItem];
            [bot.player.lastSlot, bot.player.lastUseSlot] = [bot.player.lastUseSlot, bot.player.lastSlot];
        }
    }

    if (!script) {
        const objCategory = objType.category !== -1 ? CategoryType.get(objType.category) : null;
        if (objCategory) {
            script = ScriptProvider.getByTriggerSpecific(ServerTriggerType.OPHELDU, -1, objCategory.id);
        }
    }

    if (!script) {
        throw new Error(`No [opheldu] script found for map parts (ids: ${partA.id}, ${partB.id})`);
    }

    bot.player.executeScript(ScriptRunner.init(script, bot.player), true);
    await bot.waitForTick();

    // The combine script shows a mesbox - continue through it
    await bot.dialog.waitFor(10);
    if (bot.dialog.isOpen()) {
        await bot.dialog.continue();
    }
    await bot.waitForTicks(3);
    await bot.dialog.clearPendingState();

    if (!bot.inventory.find('Crandor map')) {
        throw new Error('Failed to combine map pieces into Crandor map');
    }
    bot.log('EVENT', 'Combined map pieces into Crandor map');
}

/**
 * Buy the Lady Lumbridge ship from Klarense for 2,000 coins.
 */
async function buyShip(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Buying ship from Klarense ===');

    const coins = bot.inventory.find('Coins');
    if (!coins || coins.count < 2000) {
        throw new Error(`Need 2,000 coins for ship, have ${coins ? coins.count : 0}`);
    }

    // Walk to Port Sarim docks
    await bot.walking.walkToWithPathfinding(PORT_SARIM_DOCK_X, PORT_SARIM_DOCK_Z);

    // Klarense is on the ship deck, separated from the dock by collision barriers.
    // The gangplank blocks boarding until the ship is bought (chicken-and-egg).
    // Directly execute Klarense's [opnpc1] script, like the combine-map workaround.
    const klarense = bot.interaction.findNpc('Klarense');
    if (!klarense) {
        throw new Error(`Klarense not found near (${bot.player.x},${bot.player.z})`);
    }
    bot.player.clearPendingAction();
    const klarenseScript = ScriptProvider.getByTriggerSpecific(ServerTriggerType.OPNPC1, klarense.type, -1);
    if (!klarenseScript) {
        throw new Error(`No [opnpc1] script found for Klarense (type=${klarense.type})`);
    }
    bot.player.executeScript(ScriptRunner.init(klarenseScript, bot.player, klarense), true);
    await bot.waitForTick();

    // chatnpc "You're interested in a trip on the Lady Lumbridge..." → multi4
    const hasDialog = await bot.dialog.waitFor(10);
    if (!hasDialog) {
        throw new Error('No dialog from Klarense after direct script execution');
    }

    if (bot.dialog.isMultiChoiceOpen()) {
        // Already at multi4
    } else {
        await bot.dialog.continue();
        const hasChoice1 = await bot.dialog.waitFor(10);
        if (!hasChoice1 || !bot.dialog.isMultiChoiceOpen()) {
            throw new Error('Expected multi4 from Klarense');
        }
    }

    // multi4: "Do you know when..." (1), "Would you take me..." (2), "I don't suppose I could buy it?" (3), "Ah well, nevermind." (4)
    await bot.dialog.selectOption(3); // "I don't suppose I could buy it?"

    // chatplayer "I don't suppose I could buy it?"
    // chatnpc about price (2000gp) → "How does 2000 gold sound?"
    // chatnpc about cabin boy → multi2
    const hasChoice2 = await bot.dialog.continueUntilChoice(5);
    if (!hasChoice2) {
        throw new Error('No price dialog from Klarense');
    }

    // multi2 (p_choice2): "Yep, sounds good." (1), "I'm not paying that much..." (2)
    await bot.dialog.selectOption(1); // "Yep, sounds good."

    // chatplayer "Yep, sounds good." → payment → chatnpc "Okey dokey, she's all yours!"
    await bot.dialog.continueRemaining(5);

    await bot.waitForTicks(3);
    await bot.dialog.clearPendingState();

    const varp = bot.getQuestProgress(DRAGON_QUEST_VARP);
    if (varp < STAGE_BOUGHT_SHIP) {
        throw new Error(`Quest varp after buying ship is ${varp}, expected >= ${STAGE_BOUGHT_SHIP}`);
    }
    bot.log('EVENT', `Bought ship: varp=${varp}`);
}

/**
 * Repair the ship by using 3 wooden planks + 12 steel nails on the ship hole.
 * Each plank uses 4 nails. Need a hammer in inventory.
 */
async function repairShip(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Repairing ship ===');

    // Verify we have repair materials
    if (!bot.inventory.find('Hammer')) throw new Error('Missing Hammer for ship repair');
    if (bot.inventory.count('Plank') < 3) throw new Error(`Need 3 planks, have ${bot.inventory.count('Plank')}`);
    if (!bot.inventory.find('Nails') || bot.inventory.find('Nails')!.count < 12) {
        throw new Error(`Need 12 nails, have ${bot.inventory.find('Nails')?.count ?? 0}`);
    }

    // Walk to ship docks and board
    await bot.walking.walkToWithPathfinding(PORT_SARIM_DOCK_X, PORT_SARIM_DOCK_Z);

    // Board the ship via gangplank
    const gangplank = bot.interaction.findLoc('dragonshipgangplank_on', 10);
    if (!gangplank) {
        throw new Error(`Gangplank not found near (${bot.player.x},${bot.player.z})`);
    }
    await bot.interaction.loc(gangplank, 1);
    await bot.waitForTicks(5);
    bot.log('STATE', `On ship: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Climb down ladder to ship hold
    const ladderTop = bot.interaction.findLoc('dragonshipladdertop', 10);
    if (ladderTop) {
        await bot.interaction.loc(ladderTop, 1);
        await bot.waitForTicks(5);
        bot.log('STATE', `In ship hold: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }

    // Use planks on the hole 3 times
    bot.log('STATE', `Before repair loop: pos=(${bot.player.x},${bot.player.z},level=${bot.player.level})`);
    for (let i = 0; i < 3; i++) {
        const hole = bot.interaction.findLoc('shiphole', 40);
        if (!hole) {
            if (bot.getQuestProgress(DRAGON_QUEST_VARP) >= STAGE_REPAIRED_SHIP) break;
            throw new Error(`Ship hole not found (plank ${i + 1}/3)`);
        }
        bot.log('ACTION', `Applying plank ${i + 1}/3 at (${hole.x},${hole.z}) from (${bot.player.x},${bot.player.z})`);
        await bot.interaction.useItemOnLoc('Plank', 'shiphole');
        await bot.waitForTicks(5);
        await bot.dialog.clearPendingState();
        bot.log('STATE', `After repair ${i + 1}: planks=${bot.inventory.count('Plank')} dragonquest=${bot.getQuestProgress(DRAGON_QUEST_VARP)}`);
    }

    const varp = bot.getQuestProgress(DRAGON_QUEST_VARP);
    if (varp < STAGE_REPAIRED_SHIP) {
        throw new Error(`Quest varp after repairing ship is ${varp}, expected >= ${STAGE_REPAIRED_SHIP}`);
    }
    bot.log('EVENT', `Ship repaired: varp=${varp}`);
}

/**
 * Hire Ned and give him the Crandor map.
 * Talk to Ned in Draynor, then use map on him.
 */
async function hireNedAndGiveMap(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Hiring Ned and giving map ===');

    // Make sure we're on ground level first
    if ((bot.player.level as number) !== 0) {
        // Find ladder/stairs to go down
        const ladder = bot.interaction.findLoc('dragonshipladder', 10);
        if (ladder) {
            await bot.interaction.loc(ladder, 1);
            await bot.waitForTicks(5);
        }
        const gangplank = bot.interaction.findLoc('dragonshipgangplank_off', 10);
        if (gangplank) {
            await bot.interaction.loc(gangplank, 1);
            await bot.waitForTicks(5);
        }
    }

    // Walk to Ned in Draynor Village
    await bot.walking.walkToWithPathfinding(DRAYNOR_NED_X, DRAYNOR_NED_Z);

    await bot.interaction.talkToNpc('Ned');

    // Standard Ned dialog includes Dragon Slayer option if quest is active
    // chatnpc "Why hello there..."
    await bot.dialog.waitFor(15);
    await bot.dialog.continue();

    // multi3 or multi4 with "You're a sailor? Could you take me to the island of Crandor?" as option 1
    await bot.dialog.waitFor(10);
    if (bot.dialog.isMultiChoiceOpen()) {
        await bot.dialog.selectOption(1); // "You're a sailor? Could you take me to Crandor?"
    }

    // Multiple dialog pages about Ned being old, missing the sea, etc.
    // He says "If you could get me a ship I would take you anywhere."
    for (let i = 0; i < 6; i++) {
        const d = await bot.dialog.waitFor(10);
        if (!d) break;
        if (bot.dialog.isMultiChoiceOpen()) break;
        await bot.dialog.continue();
    }

    await bot.waitForTicks(3);
    await bot.dialog.clearPendingState();

    // Ned should now be hired (dragon_ned_hired = 1)
    // If ship is repaired and we have the map, talk to him again to give map
    if (bot.inventory.find('Crandor map') && bot.getQuestProgress(DRAGON_QUEST_VARP) >= STAGE_REPAIRED_SHIP) {
        // Need to talk to Ned again to give him the map
        // or use map on Ned
        await bot.interaction.useItemOnNpc('Crandor map', 'Ned');

        // Dialog: "You give the map to Ned." -> mesbox -> chatplayer -> chatnpc
        for (let i = 0; i < 5; i++) {
            const d = await bot.dialog.waitFor(10);
            if (!d) break;
            if (bot.dialog.isMultiChoiceOpen()) break;
            await bot.dialog.continue();
        }

        await bot.waitForTicks(3);
        await bot.dialog.clearPendingState();

        const varp = bot.getQuestProgress(DRAGON_QUEST_VARP);
        if (varp < STAGE_NED_GIVEN_MAP) {
            throw new Error(`Quest varp after giving map to Ned is ${varp}, expected >= ${STAGE_NED_GIVEN_MAP}`);
        }
        bot.log('EVENT', `Gave map to Ned: varp=${varp}`);
    }
}

/**
 * Board the ship and sail to Crandor with Ned.
 */
async function sailToCrandor(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Sailing to Crandor ===');

    // Equip anti-dragon shield
    if (bot.inventory.find('Dragonfire shield')) {
        await bot.interaction.equipItem('Dragonfire shield');
        await bot.waitForTicks(2);
    }

    // Walk to Port Sarim docks (only if on ground level)
    if ((bot.player.level as number) === 0) {
        await bot.walking.walkToWithPathfinding(PORT_SARIM_DOCK_X, PORT_SARIM_DOCK_Z);

        // Board ship via gangplank → teleports to (x, z+2, level+1)
        const gangplank = bot.interaction.findLoc('dragonshipgangplank_on', 10);
        if (!gangplank) {
            throw new Error(`Ship gangplank not found near (${bot.player.x},${bot.player.z})`);
        }
        await bot.interaction.loc(gangplank, 1);
        await bot.waitForTicks(5);
    }
    bot.log('STATE', `On ship deck: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Climb down ladder to ship interior (underground map)
    // With ned_hired=true and dragonquestvar=3, ladder goes to level 3
    const ladderTop = bot.interaction.findLoc('dragonshipladdertop', 10);
    if (ladderTop) {
        await bot.interaction.loc(ladderTop, 1);
        await bot.waitForTicks(5);
        bot.log('STATE', `Ship interior: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
    }

    // dragonslayer_ned checks coordy(coord) = 3 (player on level 3)
    // Directly execute his [opnpc1] script since he's in the underground ship area
    const ned = bot.interaction.findNpc('Ned', 16);
    if (!ned) {
        throw new Error(`Ned not found on ship near (${bot.player.x},${bot.player.z},${bot.player.level})`);
    }

    bot.player.clearPendingAction();
    const nedScript = ScriptProvider.getByTriggerSpecific(ServerTriggerType.OPNPC1, ned.type, -1);
    if (!nedScript) {
        throw new Error(`No [opnpc1] script for Ned (type=${ned.type})`);
    }
    bot.player.executeScript(ScriptRunner.init(nedScript, bot.player, ned), true);
    await bot.waitForTick();

    // chatnpc "Ah! There you are! Ready to go?" → p_choice2
    const hasChoice = await bot.dialog.continueUntilChoice(5);
    if (!hasChoice) {
        throw new Error(`No sailing dialog from Ned at (${bot.player.x},${bot.player.z},${bot.player.level})`);
    }
    await bot.dialog.selectOption(1); // "Yep lets go!"

    // Sailing sequence: mes → journey interface → p_telejump to Crandor → mesbox → dialog
    for (let i = 0; i < 15; i++) {
        const d = await bot.dialog.waitFor(15);
        if (!d) {
            await bot.waitForTicks(5);
            continue;
        }
        if (bot.dialog.isMultiChoiceOpen()) break;
        await bot.dialog.continue();
    }

    await bot.waitForTicks(5);
    await bot.dialog.clearPendingState();

    const varp = bot.getQuestProgress(DRAGON_QUEST_VARP);
    if (varp < STAGE_SAILED_TO_CRANDOR) {
        throw new Error(`Quest varp after sailing is ${varp}, expected >= ${STAGE_SAILED_TO_CRANDOR}`);
    }
    bot.log('EVENT', `Sailed to Crandor: varp=${varp}, pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);
}

/**
 * Navigate Crandor and kill Elvarg.
 * - Find crandor_rock_opening to enter Elvarg's underground lair
 * - Open elvarg_gate_right/left
 * - Fight and kill Elvarg
 */
async function killElvarg(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Killing Elvarg ===');

    // Equip weapon and anti-dragon shield
    if (bot.inventory.find('Rune scimitar')) {
        await bot.interaction.equipItem('Rune scimitar');
        await bot.waitForTicks(2);
    }
    if (bot.inventory.find('Dragonfire shield')) {
        await bot.interaction.equipItem('Dragonfire shield');
        await bot.waitForTicks(2);
    }

    // Eat to full HP before the fight
    while (bot.getHealth().current < bot.getHealth().max) {
        const ate = await eatIfNeeded(bot, 0.99);
        if (!ate) break;
    }

    // We should be on Crandor now. Navigate to the rock opening.
    bot.log('STATE', `On Crandor: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Check if we're already underground (from a previous state retry)
    const isUnderground = bot.player.z > 6400;
    if (!isUnderground) {
        // Walk to rock opening area on Crandor surface (landing is at ~2851, 3235)
        // The rock opening is near (2834, 3258). Always walk adjacent before interacting —
        // Walk to the south approach position first (reachable from any Crandor surface spot).
        // p_teleport fires when the bot is adjacent — calling interactLoc from 20+ tiles away
        // with a short wait causes the teleport to miss before the bot arrives.
        await bot.walking.walkToWithPathfinding(2834, 3258);
        const rockOpening = bot.interaction.findLoc('crandor_rock_opening', 15);
        if (!rockOpening) {
            throw new Error(`Rock opening not found near (${bot.player.x},${bot.player.z})`);
        }
        bot.log('STATE', `Rock opening found at (${rockOpening.x},${rockOpening.z})`);
        await bot.interaction.loc(rockOpening, 1);
        await bot.waitForTicks(10); // wait for p_teleport to fire
    }
    bot.log('STATE', `Underground: pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Open the gate to Elvarg's chamber and walk through it
    const gate = bot.interaction.findLoc('elvarg_gate_right', 30) ?? bot.interaction.findLoc('elvarg_gate_left', 30);
    if (gate) {
        bot.log('STATE', `Gate found at (${gate.x},${gate.z})`);
        await bot.interaction.loc(gate, 1);
        await bot.waitForTicks(3);
        // Walk through the gate into Elvarg's chamber
        try { await bot.walking.walkToWithPathfinding(gate.x + 4, gate.z); } catch { /* best-effort */ }
        await bot.waitForTicks(3);
    }

    // Use killNpc for reliable combat — retries attack every 5 ticks until combat starts,
    // then the engine's self-sustaining loop takes over.
    await killNpc(bot, 'Elvarg', 500);

    // Quest completes via queue when Elvarg dies
    const varp = bot.getQuestProgress(DRAGON_QUEST_VARP);
    if (varp >= STAGE_COMPLETE) {
        bot.log('EVENT', `Quest completed after killing Elvarg! varp=${varp}`);
    }
}

/**
 * Return to Oziach after killing Elvarg to complete the quest.
 * The quest actually completes when Elvarg dies (via queue), but talking
 * to Oziach is the traditional final step.
 */
async function returnToOziach(bot: BotAPI): Promise<void> {
    bot.log('STATE', '=== Returning to Oziach ===');

    // After Elvarg dies, we might be teleported out of the lair
    // or we need to find our way out via the secret door
    bot.log('STATE', `Post-Elvarg pos=(${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Check if quest is already complete
    if (bot.getQuestProgress(DRAGON_QUEST_VARP) >= STAGE_COMPLETE) {
        bot.log('EVENT', 'Quest already complete! Checking for completion interface...');
        // Dismiss quest complete interface
        await bot.waitForTicks(5);
        await bot.dialog.clearPendingState();
    }

    // If we're underground, find the secret door to escape to Karamja dungeon
    // then climb rope to surface
    if (bot.player.z > 6000) {
        // We're in the underground area
        const secretDoor = bot.interaction.findLoc('dragonsecretdoor', 20);
        if (secretDoor) {
            await bot.interaction.loc(secretDoor, 1);
            await bot.waitForTicks(5);
            await bot.dialog.clearPendingState();
        }

        // Look for climbing rope to surface
        const rope = bot.interaction.findLoc('crandor_climbing_rope', 20);
        if (rope) {
            await bot.interaction.loc(rope, 1);
            await bot.waitForTicks(5);
        }
    }

    // Navigate to Oziach in Edgeville
    // First get to the mainland
    if (bot.player.x < 2900) {
        // We're probably on Karamja or Crandor
        // Walk to Port Sarim area (south of Falador)
        await bot.walking.walkToWithPathfinding(3000, 3200);
    }

    // Enter Oziach's hut via the door (same approach as talkToOziach)
    await bot.walking.walkToWithPathfinding(3070, 3514);
    const returnHutDoor = bot.interaction.findLoc('inaccastledoubledoorropen', 5);
    if (!returnHutDoor) throw new Error(`Oziach hut door not found near (${bot.player.x},${bot.player.z})`);
    await bot.interaction.loc(returnHutDoor, 1);
    await bot.waitForTicks(3);
    await bot.dialog.clearPendingState();
    await bot.interaction.talkToNpc('Oziach');

    // "I have slain the dragon!" -> "Well done!" -> choice about buying rune plate
    for (let i = 0; i < 5; i++) {
        const d = await bot.dialog.waitFor(10);
        if (!d) break;
        if (bot.dialog.isMultiChoiceOpen()) {
            await bot.dialog.selectOption(2); // "Thank you." (option 2)
            break;
        }
        await bot.dialog.continue();
    }

    await bot.waitForTicks(3);
    await bot.dialog.clearPendingState();

    const varp = bot.getQuestProgress(DRAGON_QUEST_VARP);
    bot.log('EVENT', `Quest complete! varp=${varp}`);
}

// ================================================================
// State machine builder
// ================================================================

// All skills at 99 — used by dragon slayer states (account is maxed before starting)
const ALL_SKILLS_99: Record<string, number> = {
    ATTACK: 99, DEFENCE: 99, STRENGTH: 99, HITPOINTS: 99,
    RANGED: 99, PRAYER: 99, MAGIC: 99, COOKING: 99,
    WOODCUTTING: 99, FLETCHING: 99, FISHING: 99, FIREMAKING: 99,
    CRAFTING: 99, SMITHING: 99, MINING: 99, HERBLORE: 99,
    AGILITY: 99, THIEVING: 99, STAT18: 99, STAT19: 99,
    RUNECRAFT: 99,
};

export function buildDragonSlayerStates(bot: BotAPI): BotState {
    return {
        name: 'dragon-slayer',
        isComplete: () => bot.getQuestProgress(DRAGON_QUEST_VARP) >= STAGE_COMPLETE,
        run: async () => { throw new Error('Composite state should not be called directly'); },
        children: [
            {
                name: 'talk-to-guildmaster',
                entrySnapshot: {
                    position: { x: 3189, z: 3353 },
                    skills: ALL_SKILLS_99,
                    varps: { [DRAGON_QUEST_VARP]: 0, [QP_VARP]: 44 },
                    items: [{ name: 'Lobster', count: 10 }],
                },
                isComplete: () => bot.getQuestProgress(DRAGON_QUEST_VARP) >= STAGE_SPOKEN_TO_GUILDMASTER,
                run: async () => { await talkToGuildmaster(bot); }
            },
            {
                name: 'talk-to-oziach',
                entrySnapshot: {
                    position: { x: 3067, z: 3516 },
                    skills: ALL_SKILLS_99,
                    varps: { [DRAGON_QUEST_VARP]: 1, [QP_VARP]: 44 },
                    items: [{ name: 'Lobster', count: 10 }],
                },
                isComplete: () => bot.getQuestProgress(DRAGON_QUEST_VARP) >= STAGE_SPOKEN_TO_OZIACH,
                run: async () => { await talkToOziach(bot); }
            },
            {
                name: 'get-shield',
                entrySnapshot: {
                    position: { x: 3210, z: 3220 },
                    skills: ALL_SKILLS_99,
                    varps: { [DRAGON_QUEST_VARP]: 2, [DRAGON_SHIELD]: 1, [QP_VARP]: 44 },
                    items: ['Maze key', { name: 'Lobster', count: 10 }],
                },
                isComplete: () => {
                    return bot.inventory.find('Dragonfire shield') !== null ||
                           bot.getVarp(DRAGON_SHIELD) >= 1;
                },
                run: async () => { await getAntiDragonShield(bot); }
            },
            {
                name: 'melzar-maze',
                entrySnapshot: {
                    position: { x: 2945, z: 3238, level: 0 },
                    skills: ALL_SKILLS_99,
                    varps: { [DRAGON_QUEST_VARP]: 2, [DRAGON_SHIELD]: 1, [QP_VARP]: 44 },
                    items: ['Maze key', { name: 'Rune scimitar', count: 1, id: 1333 }, { name: 'Dragonfire shield', count: 1, id: 1540 }, { name: 'Lobster', count: 20, id: 379 }],
                },
                maxRetries: 10,
                isComplete: () => {
                    return bot.inventory.find('Map part') !== null || bot.inventory.find('Crandor map') !== null;
                },
                stuckThreshold: 3000,
                progressThreshold: 6000,
                run: async () => { await navigateMelzarsMaze(bot); }
            },
            {
                name: 'oracle-map',
                entrySnapshot: {
                    position: { x: 3019, z: 3450 },
                    skills: ALL_SKILLS_99,
                    varps: { [DRAGON_QUEST_VARP]: 2, [DRAGON_ORACLE]: 2, [DRAGON_SHIELD]: 1, [QP_VARP]: 44 },
                    items: [
                        { name: 'Map part', count: 1, id: 1535 },
                        'Dragonfire shield', "Wizard's mind bomb",
                        'Silk', 'Lobster pot', 'Unfired bowl',
                        { name: 'Lobster', count: 10 },
                    ],
                },
                isComplete: () => {
                    // Have at least 2 map parts or the combined map
                    return bot.inventory.count('Map part') >= 2 || bot.inventory.find('Crandor map') !== null;
                },
                run: async () => { await getOracleMapPiece(bot); }
            },
            {
                name: 'wormbrain-map',
                entrySnapshot: {
                    position: { x: 3014, z: 3178 },
                    skills: ALL_SKILLS_99,
                    varps: { [DRAGON_QUEST_VARP]: 2, [DRAGON_SHIELD]: 1, [DRAGON_GOBLIN]: 1, [QP_VARP]: 44 },
                    items: [
                        { name: 'Map part', count: 1, id: 1535 },
                        { name: 'Map part', count: 1, id: 1537 },
                        'Dragonfire shield',
                        { name: 'Coins', count: 10000 },
                        { name: 'Lobster', count: 10 },
                    ],
                },
                isComplete: () => {
                    return bot.inventory.count('Map part') >= 3 || bot.inventory.find('Crandor map') !== null;
                },
                stuckThreshold: 3000,
                run: async () => { await getWormbrainMapPiece(bot); }
            },
            {
                name: 'combine-map',
                entrySnapshot: {
                    position: { x: 3014, z: 3178 },
                    skills: ALL_SKILLS_99,
                    varps: { [DRAGON_QUEST_VARP]: 2, [DRAGON_SHIELD]: 1, [QP_VARP]: 44 },
                    items: [
                        { name: 'Map part', count: 1, id: 1535 },
                        { name: 'Map part', count: 1, id: 1536 },
                        { name: 'Map part', count: 1, id: 1537 },
                        'Dragonfire shield',
                        { name: 'Coins', count: 12000 },
                        { name: 'Lobster', count: 10 },
                    ],
                },
                isComplete: () => {
                    return bot.inventory.find('Crandor map') !== null ||
                           bot.getQuestProgress(DRAGON_QUEST_VARP) >= STAGE_NED_GIVEN_MAP;
                },
                run: async () => { await combineMapPieces(bot); }
            },
            {
                name: 'buy-ship',
                entrySnapshot: {
                    position: { x: 3046, z: 3205 },
                    skills: ALL_SKILLS_99,
                    varps: { [DRAGON_QUEST_VARP]: 2, [DRAGON_SHIELD]: 1, [QP_VARP]: 44 },
                    items: [
                        'Crandor map', 'Dragonfire shield',
                        { name: 'Coins', count: 12000 },
                        { name: 'Plank', count: 3 },
                        { name: 'Nails', count: 30 },
                        'Hammer',
                        { name: 'Lobster', count: 10 },
                    ],
                },
                isComplete: () => bot.getQuestProgress(DRAGON_QUEST_VARP) >= STAGE_BOUGHT_SHIP,
                run: async () => { await buyShip(bot); }
            },
            {
                name: 'repair-ship',
                entrySnapshot: {
                    position: { x: 3046, z: 3205 },
                    skills: ALL_SKILLS_99,
                    varps: { [DRAGON_QUEST_VARP]: 3, [DRAGON_SHIELD]: 1, [QP_VARP]: 44 },
                    items: [
                        'Crandor map', 'Dragonfire shield',
                        { name: 'Plank', count: 3, id: 960 },  // woodplank (unnoted), not cert_woodplank (961)
                        { name: 'Nails', count: 30, id: 1539 }, // nails (unnoted), not cert_nails
                        { name: 'Hammer', count: 1, id: 2347 }, // hammer (unnoted) - cert_hammer (2348) is stackable and gets incorrectly preferred
                        { name: 'Lobster', count: 10 },
                    ],
                },
                isComplete: () => bot.getQuestProgress(DRAGON_QUEST_VARP) >= STAGE_REPAIRED_SHIP,
                run: async () => { await repairShip(bot); }
            },
            {
                name: 'hire-ned',
                entrySnapshot: {
                    position: { x: 3098, z: 3257 },
                    skills: ALL_SKILLS_99,
                    varps: { [DRAGON_QUEST_VARP]: 7, [DRAGON_SHIELD]: 1, [QP_VARP]: 44 },
                    items: [
                        'Crandor map', 'Dragonfire shield',
                        { name: 'Lobster', count: 20 },
                    ],
                },
                isComplete: () => bot.getQuestProgress(DRAGON_QUEST_VARP) >= STAGE_NED_GIVEN_MAP,
                run: async () => { await hireNedAndGiveMap(bot); }
            },
            {
                name: 'sail-to-crandor',
                entrySnapshot: {
                    position: { x: 3046, z: 3205 },
                    skills: ALL_SKILLS_99,
                    varps: { [DRAGON_QUEST_VARP]: 8, [DRAGON_QUEST_VAR]: 3, [DRAGON_NED_HIRED]: 1, [DRAGON_SHIELD]: 1, [QP_VARP]: 44 },
                    items: [
                        'Dragonfire shield',
                        { name: 'Lobster', count: 25 },
                    ],
                },
                isComplete: () => bot.getQuestProgress(DRAGON_QUEST_VARP) >= STAGE_SAILED_TO_CRANDOR,
                stuckThreshold: 3000,
                run: async () => { await sailToCrandor(bot); }
            },
            {
                name: 'kill-elvarg',
                entrySnapshot: {
                    position: { x: 2853, z: 3238 },
                    skills: ALL_SKILLS_99,
                    varps: { [DRAGON_QUEST_VARP]: 9, [DRAGON_SHIELD]: 1, [QP_VARP]: 44 },
                    items: [
                        { name: 'Rune scimitar', count: 1, id: 1333 }, { name: 'Dragonfire shield', count: 1, id: 1540 },
                        { name: 'Lobster', count: 25, id: 379 },
                    ],
                },
                isComplete: () => bot.getQuestProgress(DRAGON_QUEST_VARP) >= STAGE_COMPLETE,
                stuckThreshold: 3000,
                progressThreshold: 6000,
                run: async () => { await killElvarg(bot); }
            },
            {
                name: 'complete-quest',
                entrySnapshot: {
                    position: { x: 3067, z: 3516 },
                    skills: ALL_SKILLS_99,
                    varps: { [DRAGON_QUEST_VARP]: 10, [QP_VARP]: 46 },
                    items: [
                        'Rune platebody',
                        { name: 'Lobster', count: 10 },
                    ],
                },
                isComplete: () => bot.getQuestProgress(DRAGON_QUEST_VARP) >= STAGE_COMPLETE,
                run: async () => { await returnToOziach(bot); }
            }
        ]
    };
}

// ================================================================
// MAIN SCRIPT
// ================================================================

export async function dragonSlayer(bot: BotAPI): Promise<void> {
    await skipTutorial(bot);
    await bot.waitForTicks(2);

    bot.log('STATE', `Starting Dragon Slayer at (${bot.player.x},${bot.player.z},${bot.player.level})`);

    // Check QP requirement
    const qp = bot.getVarp(QP_VARP);
    if (qp < REQUIRED_QP) {
        throw new Error(`Need ${REQUIRED_QP} Quest Points to start Dragon Slayer, have ${qp}. Use --state= with a handcrafted snapshot.`);
    }

    const initialVarp = bot.getQuestProgress(DRAGON_QUEST_VARP);
    if (initialVarp >= STAGE_COMPLETE) {
        bot.log('EVENT', 'Dragon Slayer already complete');
        return;
    }

    const root = buildDragonSlayerStates(bot);
    await runStateMachine(bot, {
        root,
        varpIds: [DRAGON_QUEST_VARP, QP_VARP, DRAGON_QUEST_VAR, DRAGON_NED_HIRED, DRAGON_ORACLE, DRAGON_SHIELD, DRAGON_GOBLIN],
    });
}

export const metadata: ScriptMeta = {
    name: 'dragonslayer',
    type: 'quest',
    varpId: DRAGON_QUEST_VARP,
    varpComplete: STAGE_COMPLETE,
    maxTicks: 150000,
    run: dragonSlayer,
    buildStates: buildDragonSlayerStates,
};
