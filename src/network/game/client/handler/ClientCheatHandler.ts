import v8 from 'node:v8';

import { Visibility } from '@2004scape/rsbuf';
import { LocAngle, LocShape } from '@2004scape/rsmod-pathfinder';

import Component from '#/cache/config/Component.js';
import IdkType from '#/cache/config/IdkType.js';
import InvType from '#/cache/config/InvType.js';
import LocType from '#/cache/config/LocType.js';
import NpcType from '#/cache/config/NpcType.js';
import ObjType from '#/cache/config/ObjType.js';
import ScriptVarType from '#/cache/config/ScriptVarType.js';
import SeqType from '#/cache/config/SeqType.js';
import SpotanimType from '#/cache/config/SpotanimType.js';
import VarBitType from '#/cache/config/VarBitType.js';
import VarPlayerType from '#/cache/config/VarPlayerType.js';

import { CoordGrid } from '#/engine/CoordGrid.js';
import World from '#/engine/World.js';
import { EntityLifeCycle } from '#/engine/entity/EntityLifeCycle.js';
import Loc from '#/engine/entity/Loc.js';
import { MoveStrategy } from '#/engine/entity/MoveStrategy.js';
import { isClientConnected } from '#/engine/entity/NetworkPlayer.js';
import Npc from '#/engine/entity/Npc.js';
import Player, { getExpByLevel } from '#/engine/entity/Player.js';
import { PlayerStat, PlayerStatEnabled, PlayerStatMap } from '#/engine/entity/PlayerStat.js';
import ScriptProvider from '#/engine/script/ScriptProvider.js';
import ScriptRunner from '#/engine/script/ScriptRunner.js';

import ClientGameMessageHandler from '#/network/game/client/ClientGameMessageHandler.js';
import ClientCheat from '#/network/game/client/model/ClientCheat.js';

import { LoggerEventType } from '#/server/logger/LoggerEventType.js';

import Environment from '#/util/Environment.js';
import { printDebug } from '#/util/Logger.js';
import { tryParseInt } from '#/util/TryParse.js';

import BotManager from '../../../../../bots/runtime/manager.js';
import { getScriptFn, listScriptNames, reloadRegistry, getRunHumanFight } from '../../../../../bots/runtime/registry.js';
import { skipTutorial } from '../../../../../bots/scripts/skip-tutorial.js';
// VALID_STRATEGIES is hardcoded here so ::pvpfight validation works without importing the bot script.
// runHumanFight is hot-imported at runtime (see ::pvpfight handler) so bot script changes
// take effect without restarting the server.
const VALID_STRATEGIES = ['alpha', 'echo'] as const;
import {
    RUNE_FULL_HELM_ID, BLACK_DHIDE_BODY_ID, RUNE_PLATELEGS_ID, RUNE_SCIMITAR_ID,
    CLIMBING_BOOTS_ID, CAPE_OF_LEGENDS_ID, RING_OF_RECOIL_ID, AMULET_OF_GLORY4_ID,
    DRAGON_DAGGER_ID, DRAGON_BATTLEAXE_ID, DRAGON_MACE_ID, MAGIC_SHORTBOW_ID,
    RUNE_ARROW_ID, PRAYER_RESTORE4_ID, SUPER_DEFENCE4_ID, SUPER_ATTACK4_ID,
    SUPER_STRENGTH4_ID, RANGING_POTION4_ID, CHOCOLATE_BOMB_ID, BLACK_DHIDE_VAMBS_ID, SHARK_ID, FIGHT_X, FIGHT_Z,
} from '../../../../../bots/scripts/pvp/pvp-shared.js';

export default class ClientCheatHandler extends ClientGameMessageHandler<ClientCheat> {
    handle(message: ClientCheat, player: Player): boolean {
        if (message.input.length > 80) {
            return false;
        }

        const { input: cheat } = message;

        const args: string[] = cheat.toLowerCase().split(' ');
        const cmd: string | undefined = args.shift();
        if (cmd === undefined || cmd.length <= 0) {
            return false;
        }

        if (player.staffModLevel >= 2) {
            player.addSessionLog(LoggerEventType.MODERATOR, 'Ran cheat', cheat);
        }

        if (!Environment.NODE_PRODUCTION && player.staffModLevel >= 4) {
            // developer commands

            if (cmd[0] === Environment.NODE_DEBUGPROC_CHAR) {
                // debugprocs are NOT allowed on live ;)
                const script = ScriptProvider.getByName(`[debugproc,${cmd.slice(1)}]`);
                if (!script) {
                    return false;
                }

                const params = new Array(script.info.parameterTypes.length).fill(-1);
                for (let i = 0; i < script.info.parameterTypes.length; i++) {
                    const type = script.info.parameterTypes[i];

                    try {
                        switch (type) {
                            case ScriptVarType.STRING: {
                                const value = args.shift();
                                params[i] = value ?? '';
                                break;
                            }
                            case ScriptVarType.INT: {
                                const value = args.shift();
                                params[i] = parseInt(value ?? '0', 10) | 0;
                                break;
                            }
                            case ScriptVarType.OBJ:
                            case ScriptVarType.NAMEDOBJ: {
                                const name = args.shift();
                                params[i] = ObjType.getId(name ?? '');
                                break;
                            }
                            case ScriptVarType.NPC: {
                                const name = args.shift();
                                params[i] = NpcType.getId(name ?? '');
                                break;
                            }
                            case ScriptVarType.LOC: {
                                const name = args.shift();
                                params[i] = LocType.getId(name ?? '');
                                break;
                            }
                            case ScriptVarType.SEQ: {
                                const name = args.shift();
                                params[i] = SeqType.getId(name ?? '');
                                break;
                            }
                            case ScriptVarType.STAT: {
                                const name = args.shift() ?? '';
                                params[i] = PlayerStatMap.get(name.toUpperCase());
                                break;
                            }
                            case ScriptVarType.INV: {
                                const name = args.shift();
                                params[i] = InvType.getId(name ?? '');
                                break;
                            }
                            case ScriptVarType.COORD: {
                                const args2 = cheat.split('_');

                                const level = parseInt(args2[0].slice(6));
                                const mx = parseInt(args2[1]);
                                const mz = parseInt(args2[2]);
                                const lx = parseInt(args2[3]);
                                const lz = parseInt(args2[4]);

                                params[i] = CoordGrid.packCoord(level, (mx << 6) + lx, (mz << 6) + lz);
                                break;
                            }
                            case ScriptVarType.INTERFACE: {
                                const name = args.shift();
                                params[i] = Component.getId(name ?? '');
                                break;
                            }
                            case ScriptVarType.SPOTANIM: {
                                const name = args.shift();
                                params[i] = SpotanimType.getId(name ?? '');
                                break;
                            }
                            case ScriptVarType.IDKIT: {
                                const name = args.shift();
                                params[i] = IdkType.getId(name ?? '');
                                break;
                            }
                        }
                    } catch (_) {
                         
                        // invalid arguments
                        return false;
                    }
                }

                player.executeScript(ScriptRunner.init(script, player, null, params), false);
            } else if (cmd === 'reload') {
                World.reload();
            } else if (cmd === 'rebuild') {
                player.messageGame('Rebuilding scripts...');
                World.rebuild();
            } else if (cmd === 'speed') {
                if (args.length < 1) {
                    player.messageGame('Usage: ::speed <ms>');
                    return false;
                }

                const speed: number = tryParseInt(args.shift(), 20);
                if (speed < 20) {
                    player.messageGame('::speed input was too low.');
                    return false;
                }

                player.messageGame(`World speed was changed to ${speed}ms`);
                World.tickRate = speed;
            } else if (cmd === 'fly') {
                if (player.moveStrategy === MoveStrategy.FLY) {
                    player.moveStrategy = MoveStrategy.SMART;
                } else {
                    player.moveStrategy = MoveStrategy.FLY;
                }

                player.messageGame(`Changed move strategy: ${player.moveStrategy === MoveStrategy.FLY ? 'fly' : 'smart'}`);
            } else if (cmd === 'naive') {
                if (player.moveStrategy === MoveStrategy.NAIVE) {
                    player.moveStrategy = MoveStrategy.SMART;
                } else {
                    player.moveStrategy = MoveStrategy.NAIVE;
                }

                player.messageGame(`Naive move strategy: ${player.moveStrategy === MoveStrategy.NAIVE ? 'naive' : 'smart'}`);
            } else if (cmd === 'random') {
                player.afkEventReady = true;
            }
        }

        if (player.staffModLevel >= 3) {
            // admin commands (potentially destructive for a live economy)

            if (cmd === 'setvar') {
                // authentic
                if (args.length < 2) {
                    // ::setvar <variable> <value>
                    // Sets variable to specified value
                    return false;
                }

                const debugname = args[0];
                const value = Math.max(-0x80000000, Math.min(tryParseInt(args[1], 0), 0x7fffffff));

                let varp: VarPlayerType | null = null;
                const varbit = VarBitType.getByName(debugname);
                if (varbit) {
                    varp = VarPlayerType.get(varbit.basevar);

                    if (varp.protect) {
                        player.closeModal();

                        if (!player.canAccess()) {
                            player.messageGame('Please finish what you are doing first.');
                            return false;
                        }

                        player.clearInteraction();
                        player.unsetMapFlag();
                    }
                } else {
                    varp = VarPlayerType.getByName(debugname);
                }

                if (!varp) {
                    return false;
                }

                if (varp.protect) {
                    player.closeModal();

                    if (!player.canAccess()) {
                        player.messageGame('Please finish what you are doing first.');
                        return false;
                    }

                    player.clearInteraction();
                    player.unsetMapFlag();
                }

                if (varbit) {
                    player.setVarBit(varbit.id, value);
                    player.messageGame('set ' + varbit.debugname + ': to ' + value);
                } else {
                    player.setVar(varp.id, value);
                    player.messageGame('set ' + varp.debugname + ': to ' + value);
                }
            } else if (cmd === 'setvarother' && Environment.NODE_PRODUCTION) {
                // custom
                if (args.length < 3) {
                    // ::setvarother <username> <name> <value>
                    return false;
                }

                const other = World.getPlayerByUsername(args[0]);
                if (!other) {
                    player.messageGame(`${args[0]} is not logged in.`);
                    return false;
                }

                const varp = VarPlayerType.getByName(args[1]);
                if (!varp) {
                    return false;
                }

                if (varp.protect) {
                    other.closeModal();

                    if (!other.canAccess()) {
                        player.messageGame(`${args[0]} is busy right now.`);
                        return false;
                    }

                    other.clearInteraction();
                    other.unsetMapFlag();
                }

                const value = Math.max(-0x80000000, Math.min(tryParseInt(args[2], 0), 0x7fffffff));
                other.setVar(varp.id, value);
                player.messageGame('set ' + args[1] + ': to ' + value + ' on ' + other.username);
            } else if (cmd === 'getvar') {
                // authentic
                if (args.length < 1) {
                    // ::getvar <variable>
                    // Displays value of specified variable
                    return false;
                }

                const debugname = args[0];

                let varp: VarPlayerType | null = null;
                const varbit = VarBitType.getByName(debugname);
                if (varbit) {
                    varp = VarPlayerType.get(varbit.basevar);

                    if (varp.protect) {
                        player.closeModal();

                        if (!player.canAccess()) {
                            player.messageGame('Please finish what you are doing first.');
                            return false;
                        }

                        player.clearInteraction();
                        player.unsetMapFlag();
                    }
                } else {
                    varp = VarPlayerType.getByName(debugname);
                }

                if (!varp) {
                    return false;
                }

                if (varbit) {
                    const value = player.getVarBit(varbit.id);
                    player.messageGame('get ' + varbit.debugname + ': ' + value);
                } else {
                    const value = player.getVar(varp.id);
                    player.messageGame('get ' + varp.debugname + ': ' + value);
                }
            } else if (cmd === 'getvarother' && Environment.NODE_PRODUCTION) {
                // custom
                if (args.length < 2) {
                    // ::getvarother <username> <variable>
                    return false;
                }

                const other = World.getPlayerByUsername(args[0]);
                if (!other) {
                    player.messageGame(`${args[0]} is not logged in.`);
                    return false;
                }

                const varp = VarPlayerType.getByName(args[1]);
                if (!varp) {
                    return false;
                }

                const value = other.getVar(varp.id);
                player.messageGame('get ' + varp.debugname + ': ' + value + ' on ' + other.username);
            } else if (cmd === 'give') {
                // authentic
                if (args.length < 1) {
                    // ::give <item> (amount)
                    // Adds the items(s) to your inventory
                    return false;
                }

                const obj = ObjType.getId(args[0]);
                if (obj === -1) {
                    return false;
                }

                const count = Math.max(1, Math.min(tryParseInt(args[1], 1), 0x7fffffff));
                player.invAdd(InvType.INV, obj, count, false);
            } else if (cmd === 'giveother' && Environment.NODE_PRODUCTION) {
                // custom
                if (args.length < 2) {
                    // ::giveother <username> <item> (amount)
                    return false;
                }

                const other = World.getPlayerByUsername(args[0]);
                if (!other) {
                    player.messageGame(`${args[0]} is not logged in.`);
                    return false;
                }

                const obj = ObjType.getId(args[1]);
                if (obj === -1) {
                    return false;
                }

                const count = Math.max(1, Math.min(tryParseInt(args[2], 1), 0x7fffffff));
                other.invAdd(InvType.INV, obj, count, false);
            } else if (cmd === 'givecrap') {
                // authentic (we don't know the exact specifics of this...)

                // Fills your inventory with random items
                for (let i = 0; i < 28; i++) {
                    let random = -1;
                    while (random === -1) {
                        random = Math.trunc(Math.random() * ObjType.count);
                        const obj = ObjType.get(random);
                        if ((!Environment.NODE_MEMBERS && obj.members) || obj.dummyitem !== 0 || obj.certtemplate !== -1) {
                            random = -1;
                        }
                    }

                    player.invAdd(InvType.INV, random, 1, false);
                }
            } else if (cmd === 'givemany') {
                // authentic
                if (args.length < 1) {
                    // ::givemany <item>
                    // Adds up to 1000 of the item to your inventory
                    return false;
                }

                const obj = ObjType.getId(args[0]);
                if (obj === -1) {
                    return false;
                }

                player.invAdd(InvType.INV, obj, 1000, false);
            } else if (cmd === 'broadcast' && Environment.NODE_PRODUCTION) {
                // custom
                if (args.length < 0) {
                    return false;
                }

                World.broadcastMes(cheat.substring(cmd.length + 1));
            } else if (cmd === 'reboot' && Environment.NODE_PRODUCTION) {
                // semi-authentic - we actually just shut down for maintenance

                // Reboots the game world, applying packed changes
                World.rebootTimer(0);
            } else if (cmd === 'slowreboot' && Environment.NODE_PRODUCTION) {
                // semi-authentic - we actually just shut down for maintenance
                if (args.length < 1) {
                    // ::slowreboot <seconds>
                    // Reboots the game world, with a timer
                    return false;
                }

                World.rebootTimer(Math.ceil(tryParseInt(args[0], 30) * 1000 / 600));
            } else if (cmd === 'serverdrop') {
                // testing reconnection behavior
                player.terminate();
            } else if (cmd === 'teleother' && Environment.NODE_PRODUCTION) {
                // custom
                if (args.length < 1) {
                    // ::teleother <username>
                    return false;
                }

                const other = World.getPlayerByUsername(args[0]);
                if (!other) {
                    player.messageGame(`${args[0]} is not logged in.`);
                    return false;
                }

                other.closeModal();

                if (!other.canAccess()) {
                    player.messageGame(`${args[0]} is busy right now.`);
                    return false;
                }

                other.clearInteraction();
                other.unsetMapFlag();

                other.teleJump(player.x, player.z, player.level);
            } else if (cmd === 'setstat') {
                // authentic
                if (args.length < 2) {
                    // ::setstat <skill> <level>
                    // Sets the skill to specified level
                    return false;
                }

                const stat = PlayerStatMap.get(args[0].toUpperCase());
                if (typeof stat === 'undefined') {
                    return false;
                }

                player.setLevel(stat, parseInt(args[1]));
            } else if (cmd === 'advancestat') {
                // authentic
                if (args.length < 1) {
                    // ::advancestat <skill> <level>
                    // Advances skill to specified level, generates level up message etc.
                    return false;
                }

                const stat = PlayerStatMap.get(args[0].toUpperCase());
                if (typeof stat === 'undefined') {
                    return false;
                }

                player.stats[stat] = 0;
                player.baseLevels[stat] = 1;
                player.levels[stat] = 1;
                player.addXp(stat, getExpByLevel(parseInt(args[1])), false);
            } else if (cmd === 'minme') {
                // like maxme debugproc, but in engine because xp goes down
                for (let i = 0; i < PlayerStatEnabled.length; i++) {
                    if (i === PlayerStat.HITPOINTS) {
                        player.setLevel(i, 10);
                    } else {
                        player.setLevel(i, 1);
                    }
                }
            } else if (cmd === 'locadd') {
                // authentic - https://youtu.be/E6tQ3b3vzro?t=3194
                if (args.length < 1) {
                    return false;
                }
                const name: string = args[0];
                const type: LocType | null = LocType.getByName(name);
                if (!type) {
                    return false;
                }
                World.addLoc(new Loc(player.level, player.x, player.z, type.width, type.length, EntityLifeCycle.DESPAWN, type.id, LocShape.CENTREPIECE_STRAIGHT, LocAngle.WEST), 500);
                player.messageGame(`Loc Added: ${name} (ID: ${type.id})`);
            } else if (cmd === 'npcadd') {
                // authentic - https://youtu.be/E6tQ3b3vzro?t=3412
                if (args.length < 1) {
                    return false;
                }
                const name: string = args[0];
                const type: NpcType | null = NpcType.getByName(name);
                if (!type) {
                    return false;
                }
                World.addNpc(new Npc(player.level, player.x, player.z, type.size, type.size, EntityLifeCycle.DESPAWN, World.getNextNid(), type.id, type.moverestrict, type.blockwalk), 500);
            } else if (cmd === 'openmain') {
                if (args.length < 1) {
                    return false;
                }

                const name: string = args[0];
                const type: Component | null = Component.getByName(name);

                if (!type || type.rootLayer !== type.id) {
                    return false;
                }

                player.openMainModal(type.id);
            } else if (cmd === 'openoverlay') {
                if (args.length < 1) {
                    return false;
                }

                const name: string = args[0];
                const type: Component | null = Component.getByName(name);

                if (!type || type.rootLayer !== type.id) {
                    return false;
                }

                player.openMainOverlay(type.id);
            } else if (cmd === 'closeoverlay') {
                player.openMainOverlay(-1);
            } else if (cmd === 'snapshot') {
                const heap = v8.writeHeapSnapshot();
                printDebug(`Heap snapshot written to: ${heap}`);
            } else if (cmd === 'bot') {
                const sub = args.shift();
                if (sub === 'spawn') {
                    const scriptName = args.shift();
                    if (!scriptName) {
                        player.messageGame('Usage: ::bot spawn <script> <count>');
                        player.messageGame(`Available scripts: ${listScriptNames().join(', ')}`);
                        return false;
                    }
                    const count = Math.max(1, tryParseInt(args.shift(), 1));

                    let scriptFn;
                    try {
                        scriptFn = getScriptFn(scriptName);
                    } catch (err) {
                        player.messageGame((err as Error).message);
                        return false;
                    }

                    const startNum = BotManager.nextBotNumber(scriptName);
                    for (let i = startNum; i < startNum + count; i++) {
                        const username = `${scriptName}-${i}`;
                        try {
                            BotManager.spawnBot(username, async (bot) => {
                                await bot.waitForTick();
                                await bot.waitForTick();
                                await skipTutorial(bot);
                                await scriptFn(bot);
                            });
                        } catch (err) {
                            player.messageGame(`Failed to spawn ${username}: ${(err as Error).message}`);
                            continue;
                        }
                    }
                    player.messageGame(`Spawned ${count} bot(s) running "${scriptName}"`);
                } else if (sub === 'list') {
                    const totalActive = BotManager.listBots().length;
                    player.messageGame(`=== Bot Scripts (${totalActive} active) ===`);
                    for (const scriptName2 of listScriptNames()) {
                        const count2 = BotManager.countBotsByPrefix(scriptName2);
                        player.messageGame(`  ${scriptName2} (${count2} active)`);
                    }
                } else if (sub === 'stop') {
                    const name = args.shift();
                    if (!name) {
                        player.messageGame('Usage: ::bot stop <name>');
                        return false;
                    }
                    try {
                        BotManager.stopBot(name);
                        player.messageGame(`Stopped bot "${name}".`);
                    } catch (err) {
                        player.messageGame((err as Error).message);
                    }
                } else {
                    player.messageGame('Usage: ::bot spawn|list|stop');
                }
            } else if (cmd === 'pvpfight') {
                // ::pvpfight <strategy>
                // Sets 99 combat stats, gives full PvP tournament gear, teleports to
                // wilderness, and spawns a bot that fights you.
                const strategy = args.shift();
                if (!strategy || !VALID_STRATEGIES.includes(strategy as any)) {
                    player.messageGame(`Usage: ::pvpfight <${VALID_STRATEGIES.join('|')}>`);
                    return false;
                }

                // Set 99 in all combat stats
                const combatStats = ['ATTACK', 'DEFENCE', 'STRENGTH', 'HITPOINTS', 'RANGED', 'PRAYER', 'MAGIC'];
                for (const statName of combatStats) {
                    const stat = PlayerStatMap.get(statName);
                    if (typeof stat !== 'undefined') {
                        player.setLevel(stat, 99);
                    }
                }
                player.combatLevel = player.getCombatLevel();

                // Set quest varps for gear requirements
                player.vars[147] = 6;   // Lost City complete
                player.vars[188] = 15;  // Heroes Quest complete
                player.vars[314] = 80;  // Death Plateau complete

                // Clear inventory and worn equipment
                player.invClear(InvType.INV);
                player.invClear(InvType.WORN);

                // Give tournament loadout (same as makeTournamentSnapshot)
                // Add arrows FIRST so they get slot 0, then everything else shifts by 1
                player.invAdd(InvType.INV, RUNE_ARROW_ID, 200, false);  // slot 0
                const items = [
                    // slot 1-7: armor to equip
                    RUNE_FULL_HELM_ID, BLACK_DHIDE_BODY_ID, RUNE_PLATELEGS_ID,
                    CLIMBING_BOOTS_ID, CAPE_OF_LEGENDS_ID, RING_OF_RECOIL_ID,
                    BLACK_DHIDE_VAMBS_ID,
                    // slot 8-9: weapons to equip
                    MAGIC_SHORTBOW_ID, AMULET_OF_GLORY4_ID,
                    // slot 10-13: weapons in inventory
                    RUNE_SCIMITAR_ID, DRAGON_DAGGER_ID, DRAGON_BATTLEAXE_ID, DRAGON_MACE_ID,
                    // slot 14-19: potions
                    PRAYER_RESTORE4_ID, PRAYER_RESTORE4_ID,
                    SUPER_DEFENCE4_ID, SUPER_ATTACK4_ID, SUPER_STRENGTH4_ID, RANGING_POTION4_ID,
                    // slot 20-23: chocolate bombs
                    CHOCOLATE_BOMB_ID, CHOCOLATE_BOMB_ID, CHOCOLATE_BOMB_ID, CHOCOLATE_BOMB_ID,
                    // slot 24: spare ring
                    RING_OF_RECOIL_ID,
                    // slot 25-27: sharks (lost 1 shark to make room for vambs)
                    SHARK_ID, SHARK_ID, SHARK_ID,
                ];
                for (const itemId of items) {
                    player.invAdd(InvType.INV, itemId, 1, false);
                }

                // Auto-equip gear from INV to WORN
                // slot 0=Rune arrows, 1=Rune full helm, 2=Black d'hide body, 3=Rune platelegs,
                // 4=Climbing boots, 5=Cape of legends, 6=Ring of recoil,
                // 7=Black d'hide vambs, 8=Magic shortbow, 9=Amulet of glory(4)
                const equipMap: [number, number][] = [
                    [0, 13],  // Rune arrows → quiver
                    [1, 0],   // Rune full helm → hat
                    [5, 1],   // Cape of legends → back
                    [9, 2],   // Amulet of glory(4) → front (amulet)
                    [8, 3],   // Magic shortbow → rhand
                    [2, 4],   // Black d'hide body → torso
                    [3, 7],   // Rune platelegs → legs
                    [7, 9],   // Black d'hide vambs → hands
                    [4, 10],  // Climbing boots → feet
                    [6, 12],  // Ring of recoil → ring
                ];
                for (const [invSlot, wornSlot] of equipMap) {
                    player.invMoveToSlot(InvType.INV, InvType.WORN, invSlot, wornSlot);
                }

                // Reset spec bar AFTER all equipping (earlier set can get cleared)
                player.vars[300] = 1000;

                // Trigger appearance update so the player's gear + combat level visually refresh
                player.buildAppearance(InvType.WORN);

                // Teleport to wilderness fight location
                player.closeModal();
                player.clearInteraction();
                player.unsetMapFlag();
                player.teleJump(FIGHT_X, FIGHT_Z, 0);

                // Spawn the bot
                const botUsername = `pvp-${strategy}`;
                try {
                    // Force-cleanup any existing bot with the same name (handles dead/stale bots)
                    BotManager.forceCleanup(botUsername);

                    BotManager.spawnBot(botUsername, async (bot) => {
                        await bot.waitForTick();

                        const runHumanFight = await getRunHumanFight();
                        await runHumanFight(bot, player.username, strategy as any);
                    });
                    player.messageGame(`PvP bot "${strategy}" spawned! Gear equipped — attack when ready.`);
                    player.messageGame('The bot will attack you once you are nearby.');
                } catch (err) {
                    player.messageGame(`Failed to spawn bot: ${(err as Error).message}`);
                }
            } else if (cmd === 'botreload') {
                // ::botreload — hot-reload changed bot scripts from disk
                player.messageGame('Scanning for changed bot scripts...');
                reloadRegistry().then(names => {
                    if (names.length === 0) {
                        player.messageGame('No changes detected.');
                    } else {
                        player.messageGame(`Reloaded ${names.length}: ${names.join(', ')}`);
                    }
                }).catch(err => {
                    console.error('::botreload failed:', err);
                    player.messageGame(`Bot reload failed: ${(err as Error).message}`);
                });
            }
        }

        if (player.staffModLevel >= 2) {
            // "super-moderator" commands (similar to a jmod but we don't know their command capabilities on live)

            if (cmd === 'getcoord') {
                // authentic

                // Displays current coordinate
                player.messageGame(CoordGrid.formatString(player.level, player.x, player.z, ','));
            } else if (cmd === 'tele') {
                // authentic - https://youtu.be/60Y3y375VYA?t=980
                if (args.length < 1) {
                    // ::tele x,xx,xx[,xx,xx]
                    // Teleports you to the coordinate. In order, the parts are level, horizontal map square, vertical map square, horizontal tile, vertical tile.
                    return false;
                }

                const coord = args[0].split(',');
                if (coord.length < 3) {
                    return false;
                }

                player.closeModal();

                if (!player.canAccess()) {
                    player.messageGame('Please finish what you are doing first.');
                    return false;
                }

                player.clearInteraction();
                player.unsetMapFlag();

                const level = tryParseInt(coord[0], 0);
                const mx = tryParseInt(coord[1], 50);
                const mz = tryParseInt(coord[2], 50);
                const lx = tryParseInt(coord[3], 32);
                const lz = tryParseInt(coord[4], 32);

                if (level < 0 || level > 3 || mx < 0 || mx > 255 || mz < 0 || mz > 255 || lx < 0 || lx > 63 || lz < 0 || lz > 63) {
                    return false;
                }

                player.teleJump((mx << 6) + lx, (mz << 6) + lz, level);
            } else if (cmd === 'teleto' && Environment.NODE_PRODUCTION) {
                // custom
                if (args.length < 1) {
                    return false;
                }

                // ::teleto <username>
                const other = World.getPlayerByUsername(args[0]);
                if (!other) {
                    player.messageGame(`${args[0]} is not logged in.`);
                    return false;
                }

                player.closeModal();

                if (!player.canAccess()) {
                    player.messageGame('Please finish what you are doing first.');
                    return false;
                }

                player.clearInteraction();
                player.unsetMapFlag();

                player.teleJump(other.x, other.z, other.level);
            } else if (cmd === 'setvis' && Environment.NODE_PRODUCTION) {
                // authentic
                if (args.length < 1) {
                    // ::setvis <level>
                    return false;
                }

                switch (args[0]) {
                    case '0':
                        player.setVisibility(Visibility.DEFAULT);
                        break;
                    case '1':
                        player.setVisibility(Visibility.SOFT);
                        break;
                    case '2':
                        player.setVisibility(Visibility.HARD);
                        break;
                    default:
                        return false;
                }
            } else if (cmd === 'ban' && Environment.NODE_PRODUCTION) {
                // custom
                if (args.length < 2) {
                    // ::ban <username> <minutes>
                    player.messageGame('Usage: ::ban <username> <minutes>');
                    return false;
                }

                const username = args[0];
                const minutes = Math.max(0, tryParseInt(args[1], 60));

                World.notifyPlayerBan(player.username, username, Date.now() + minutes * 60 * 1000);
                player.messageGame(`Player '${args[0]}' has been banned for ${minutes} minutes.`);
            } else if (cmd === 'mute' && Environment.NODE_PRODUCTION) {
                // custom
                if (args.length < 2) {
                    // ::mute <username> <minutes>
                    player.messageGame('Usage: ::mute <username> <minutes>');
                    return false;
                }

                const username = args[0];
                const minutes = Math.max(0, tryParseInt(args[1], 60));

                World.notifyPlayerMute(player.username, username, Date.now() + minutes * 60 * 1000);
                player.messageGame(`Player '${args[0]}' has been muted for ${minutes} minutes.`);
            } else if (cmd === 'kick' && Environment.NODE_PRODUCTION) {
                // custom
                if (args.length < 1) {
                    // ::kick <username>
                    player.messageGame('Usage: ::kick <username>');
                    return false;
                }

                const username = args[0];

                const other = World.getPlayerByUsername(username);
                if (other) {
                    other.loggingOut = true;
                    if (isClientConnected(other)) {
                        other.logout();
                        other.client.close();
                    }
                    player.messageGame(`Player '${args[0]}' has been kicked from the game.`);
                } else {
                    player.messageGame(`Player '${args[0]}' does not exist or is not logged in.`);
                }
            }
        }

        return true;
    }
}
