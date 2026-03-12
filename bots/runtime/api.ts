import CategoryType from '../../src/cache/config/CategoryType.js';
import Component from '../../src/cache/config/Component.js';
import InvType from '../../src/cache/config/InvType.js';
import LocType from '../../src/cache/config/LocType.js';
import NpcType from '../../src/cache/config/NpcType.js';
import ObjType from '../../src/cache/config/ObjType.js';
import VarPlayerType from '../../src/cache/config/VarPlayerType.js';
import { changeNpcCollision } from '../../src/engine/GameMap.js';
import World from '../../src/engine/World.js';
import { Interaction } from '../../src/engine/entity/Interaction.js';
import type Loc from '../../src/engine/entity/Loc.js';
import type Npc from '../../src/engine/entity/Npc.js';
import type Obj from '../../src/engine/entity/Obj.js';
import { PlayerStatMap } from '../../src/engine/entity/PlayerStat.js';
import ScriptProvider from '../../src/engine/script/ScriptProvider.js';
import ScriptRunner from '../../src/engine/script/ScriptRunner.js';
import ScriptState from '../../src/engine/script/ScriptState.js';
import ServerTriggerType from '../../src/engine/script/ServerTriggerType.js';
import { BotPlayer } from '../integration/bot-player.js';
import { BotController } from './controller.js';
import { BotLogger, type LogLevel } from './logger.js';
import { findPathSegment, findPathToLocSegment } from './pathfinding.js';
import { findPathToEntity } from '../../src/engine/GameMap.js';
import { doorRegistry } from './door-registry.js';
import type { StateSnapshot } from './state-machine.js';

export interface SkillInfo {
    level: number;
    baseLevel: number;
    exp: number;
}

export interface ItemInfo {
    id: number;
    name: string;
    count: number;
    slot: number;
}

export class BotAPI {
    readonly player: BotPlayer;
    readonly controller: BotController;
    readonly logger: BotLogger;
    /** Current state path in the state machine (set by runStateMachine) */
    currentStatePath: string = '';
    /** Optional callback for streaming log events externally */
    onLog: ((level: LogLevel, message: string) => void) | null = null;

    constructor(player: BotPlayer, controller: BotController, logger: BotLogger) {
        this.player = player;
        this.controller = controller;
        this.logger = logger;
    }

    getPosition(): { x: number; z: number; level: number } {
        return { x: this.player.x, z: this.player.z, level: this.player.level };
    }

    getSkill(name: string): SkillInfo {
        const statId = PlayerStatMap.get(name.toUpperCase());
        if (statId === undefined) {
            throw new Error(`Unknown skill: ${name}`);
        }
        return {
            level: this.player.levels[statId]!,
            baseLevel: this.player.baseLevels[statId]!,
            exp: this.player.stats[statId]!
        };
    }

    getInventory(): ItemInfo[] {
        const inv = this.player.getInventory(InvType.INV);
        if (!inv) {
            return [];
        }

        const items: ItemInfo[] = [];
        for (let slot = 0; slot < inv.capacity; slot++) {
            const item = inv.items[slot];
            if (item) {
                const objType = ObjType.get(item.id);
                items.push({
                    id: item.id,
                    name: objType.name ?? `obj_${item.id}`,
                    count: item.count,
                    slot
                });
            }
        }
        return items;
    }

    findItem(name: string): ItemInfo | null {
        const items = this.getInventory();
        const lowerName = name.toLowerCase();
        return items.find(item => item.name.toLowerCase() === lowerName) ?? null;
    }

    getVarp(id: number): number {
        return this.player.vars[id]!;
    }

    getCurrentTick(): number {
        return World.currentTick;
    }

    getHealth(): { current: number; max: number } {
        // Hitpoints stat index is 3 (PlayerStat.HITPOINTS)
        const statId = PlayerStatMap.get('HITPOINTS')!;
        return {
            current: this.player.levels[statId]!,
            max: this.player.baseLevels[statId]!
        };
    }

    /**
     * Dismiss any open modal interface (e.g. level-up dialog).
     * Resumes scripts waiting on p_pausebutton so they complete naturally,
     * then closes any remaining modal only if the script is done.
     *
     * IMPORTANT: closeModal() kills paused scripts (sets activeScript=null).
     * If the resumed script paused on a NEW dialog, we must NOT call closeModal()
     * or the script will be aborted before reaching critical actions like inv_add.
     * The caller should call dismissModals()/continueDialog() again for the next page.
     */
    dismissModals(): void {
        // Resume the paused script first so it can run to completion.
        // This matches what the client does when the player clicks the button.
        if (this.player.activeScript?.execution === ScriptState.PAUSEBUTTON) {
            this.player.executeScript(this.player.activeScript, true, true);
        }
        // Only close modal if the script is NOT paused on a new dialog.
        // closeModal() sets activeScript=null for PAUSEBUTTON scripts,
        // which would abort multi-page dialogs before they finish.
        if (this.player.containsModalInterface() &&
            this.player.activeScript?.execution !== ScriptState.PAUSEBUTTON) {
            this.player.closeModal();
        }
    }

    log(level: LogLevel, message: string): void {
        this.logger.log(level, message);
        if (this.onLog) this.onLog(level, message);
    }

    // Delegate tick-waiting to controller
    waitForTick(): Promise<void> {
        return this.controller.waitForTick();
    }

    waitForTicks(n: number): Promise<void> {
        return this.controller.waitForTicks(n);
    }

    waitForCondition(predicate: () => boolean, timeoutTicks: number): Promise<void> {
        return this.controller.waitForCondition(predicate, timeoutTicks);
    }

    findNearbyNpc(name: string, maxDist: number = 16): Npc | null {
        const lowerName = name.toLowerCase();
        const px = this.player.x;
        const pz = this.player.z;
        const level = this.player.level;

        let closest: Npc | null = null;
        let closestDist = maxDist + 1;

        // Search zones in a radius around the player
        // Each zone is 8x8 tiles, search enough zones to cover maxDist
        const zoneRadius = Math.ceil(maxDist / 8) + 1;
        const playerZoneX = px >> 3;
        const playerZoneZ = pz >> 3;

        for (let dx = -zoneRadius; dx <= zoneRadius; dx++) {
            for (let dz = -zoneRadius; dz <= zoneRadius; dz++) {
                const zoneX = playerZoneX + dx;
                const zoneZ = playerZoneZ + dz;
                const zone = World.gameMap.getZone(zoneX << 3, zoneZ << 3, level);
                for (const npc of zone.getAllNpcsSafe()) {
                    const npcType = NpcType.get(npc.type);
                    if (npcType.name?.toLowerCase() !== lowerName) {
                        continue;
                    }
                    const dist = Math.max(Math.abs(npc.x - px), Math.abs(npc.z - pz));
                    if (dist < closestDist) {
                        closest = npc;
                        closestDist = dist;
                    }
                }
            }
        }

        return closest;
    }

    async interactNpc(npc: Npc, op: number): Promise<void> {
        if (op < 1 || op > 5) {
            throw new Error(`Invalid NPC op: ${op}. Must be 1-5.`);
        }

        // The engine expects the AP trigger type as targetOp.
        // getOpTrigger() adds +7 to get the corresponding OP trigger.
        // This matches how OpNpcHandler works: ServerTriggerType.APNPC1 + (op - 1)
        const trigger: ServerTriggerType = ServerTriggerType.APNPC1 + (op - 1);

        const npcType = NpcType.get(npc.type);
        this.log('ACTION', `interactNpc: ${npcType.name} (op=${op}) at (${npc.x},${npc.z})`);

        const success = this.player.setInteraction(Interaction.SCRIPT, npc, trigger);
        if (!success) {
            throw new Error(`setInteraction failed for NPC ${npcType.name} at (${npc.x},${npc.z}) npc.delayed=${npc.delayed} npc.isActive=${npc.isActive}`);
        }

        // Wait for the engine to process the interaction.
        // The engine will auto-walk to the NPC if needed, then execute the RS2 script.
        // We wait until target is cleared OR we've waited enough ticks for the engine
        // to have fully processed it (whichever comes first).
        for (let i = 0; i < 15; i++) {
            await this.waitForTick();
            if (this.player.target === null) {
                return;
            }
        }
        // Even if target didn't clear (e.g. engine holds it for continued script execution),
        // the interaction has been dispatched. The caller should wait additional ticks
        // for the full action to complete (stun, xp gain, etc.).
    }

    async walkTo(x: number, z: number): Promise<void> {
        this.log('ACTION', `walkTo: (${x},${z}) from (${this.player.x},${this.player.z})`);
        this.player.queueWaypoint(x, z);

        // Wait until player reaches destination (tolerance of 1 tile) or timeout
        await this.waitForCondition(() => {
            return Math.abs(this.player.x - x) <= 1 && Math.abs(this.player.z - z) <= 1;
        }, 50);
    }

    async waitForSkillChange(skill: string, timeoutTicks: number = 30): Promise<boolean> {
        const statId = PlayerStatMap.get(skill.toUpperCase());
        if (statId === undefined) {
            throw new Error(`Unknown skill: ${skill}`);
        }
        const startExp = this.player.stats[statId]!;

        for (let i = 0; i < timeoutTicks; i++) {
            await this.waitForTick();
            if (this.player.stats[statId]! !== startExp) {
                return true;
            }
        }
        return false;
    }

    /**
     * Search zones around the player for a Loc matching the given debugname.
     * Returns the closest active loc within maxDist tiles, or null.
     */
    findNearbyLoc(debugname: string, maxDist: number = 16): Loc | null {
        const lowerName = debugname.toLowerCase();
        const px = this.player.x;
        const pz = this.player.z;
        const level = this.player.level;

        let closest: Loc | null = null;
        let closestDist = maxDist + 1;

        const zoneRadius = Math.ceil(maxDist / 8) + 1;
        const playerZoneX = px >> 3;
        const playerZoneZ = pz >> 3;

        for (let dx = -zoneRadius; dx <= zoneRadius; dx++) {
            for (let dz = -zoneRadius; dz <= zoneRadius; dz++) {
                const zoneX = playerZoneX + dx;
                const zoneZ = playerZoneZ + dz;
                const zone = World.gameMap.getZone(zoneX << 3, zoneZ << 3, level);
                for (const loc of zone.getAllLocsSafe()) {
                    const locType = LocType.get(loc.type);
                    if (locType.debugname?.toLowerCase() !== lowerName) {
                        continue;
                    }
                    const dist = Math.max(Math.abs(loc.x - px), Math.abs(loc.z - pz));
                    if (dist < closestDist) {
                        closest = loc;
                        closestDist = dist;
                    }
                }
            }
        }

        return closest;
    }

    /**
     * Find a nearby Loc by its display name (the name= field, not the debugname).
     * For example, gates are named "Gate" regardless of their debugname (loc_1596, fencegate_l, etc.).
     * Returns the closest matching loc within maxDist tiles.
     */
    findNearbyLocByDisplayName(displayName: string, maxDist: number = 16): Loc | null {
        const lowerName = displayName.toLowerCase();
        const px = this.player.x;
        const pz = this.player.z;
        const level = this.player.level;

        let closest: Loc | null = null;
        let closestDist = maxDist + 1;

        const zoneRadius = Math.ceil(maxDist / 8) + 1;
        const playerZoneX = px >> 3;
        const playerZoneZ = pz >> 3;

        for (let dx = -zoneRadius; dx <= zoneRadius; dx++) {
            for (let dz = -zoneRadius; dz <= zoneRadius; dz++) {
                const zoneX = playerZoneX + dx;
                const zoneZ = playerZoneZ + dz;
                const zone = World.gameMap.getZone(zoneX << 3, zoneZ << 3, level);
                for (const loc of zone.getAllLocsSafe()) {
                    const locType = LocType.get(loc.type);
                    if (locType.name?.toLowerCase() !== lowerName) {
                        continue;
                    }
                    const dist = Math.max(Math.abs(loc.x - px), Math.abs(loc.z - pz));
                    if (dist < closestDist) {
                        closest = loc;
                        closestDist = dist;
                    }
                }
            }
        }

        return closest;
    }

    /**
     * Find all locs near the player within maxDist tiles.
     * Returns an array of { loc, debugname, displayName, dist } sorted by distance.
     * Useful for debugging what locs exist in an area.
     */
    findAllNearbyLocs(maxDist: number = 16): Array<{ loc: Loc; debugname: string; displayName: string; dist: number; x: number; z: number }> {
        const px = this.player.x;
        const pz = this.player.z;
        const level = this.player.level;

        const results: Array<{ loc: Loc; debugname: string; displayName: string; dist: number; x: number; z: number }> = [];

        const zoneRadius = Math.ceil(maxDist / 8) + 1;
        const playerZoneX = px >> 3;
        const playerZoneZ = pz >> 3;

        for (let dx = -zoneRadius; dx <= zoneRadius; dx++) {
            for (let dz = -zoneRadius; dz <= zoneRadius; dz++) {
                const zoneX = playerZoneX + dx;
                const zoneZ = playerZoneZ + dz;
                const zone = World.gameMap.getZone(zoneX << 3, zoneZ << 3, level);
                for (const loc of zone.getAllLocsSafe()) {
                    const dist = Math.max(Math.abs(loc.x - px), Math.abs(loc.z - pz));
                    if (dist <= maxDist) {
                        const locType = LocType.get(loc.type);
                        results.push({
                            loc,
                            debugname: locType.debugname ?? `loc_${loc.type}`,
                            displayName: locType.name ?? '',
                            dist,
                            x: loc.x,
                            z: loc.z
                        });
                    }
                }
            }
        }

        results.sort((a, b) => a.dist - b.dist);
        return results;
    }

    /**
     * Open a gate by display name. Searches for a nearby loc with name="Gate" and op1=Open.
     * This handles all gate types (fence gates, wooden gates, etc.) regardless of their debugname.
     * If no gate is found nearby, this is a no-op (the gate may already be open).
     */
    async openGate(maxDist: number = 16): Promise<void> {
        const px = this.player.x;
        const pz = this.player.z;
        const level = this.player.level;

        let closestGate: Loc | null = null;
        let closestDist = maxDist + 1;

        const zoneRadius = Math.ceil(maxDist / 8) + 1;
        const playerZoneX = px >> 3;
        const playerZoneZ = pz >> 3;

        for (let dx = -zoneRadius; dx <= zoneRadius; dx++) {
            for (let dz = -zoneRadius; dz <= zoneRadius; dz++) {
                const zoneX = playerZoneX + dx;
                const zoneZ = playerZoneZ + dz;
                const zone = World.gameMap.getZone(zoneX << 3, zoneZ << 3, level);
                for (const loc of zone.getAllLocsSafe()) {
                    const locType = LocType.get(loc.type);
                    if (locType.name?.toLowerCase() !== 'gate') {
                        continue;
                    }
                    // Only match gates that have op1=Open (closed gates)
                    if (locType.op?.[0]?.toLowerCase() !== 'open') {
                        continue;
                    }
                    const dist = Math.max(Math.abs(loc.x - px), Math.abs(loc.z - pz));
                    if (dist < closestDist) {
                        closestGate = loc;
                        closestDist = dist;
                    }
                }
            }
        }

        if (!closestGate) {
            this.log('STATE', 'openGate: no closed gate found nearby — may already be open');
            return;
        }

        const locType = LocType.get(closestGate.type);
        this.log('ACTION', `openGate: ${locType.debugname} at (${closestGate.x},${closestGate.z}), dist=${closestDist}`);
        await this.interactLoc(closestGate, 1);
        await this.waitForTicks(1);
    }

    /**
     * Interact with a Loc using the given op (1-5).
     * The engine handles approach walking and trigger execution.
     */
    async interactLoc(loc: Loc, op: number): Promise<void> {
        if (op < 1 || op > 5) {
            throw new Error(`Invalid loc op: ${op}. Must be 1-5.`);
        }

        // Use AP trigger — the engine's getOpTrigger() adds +7 to get the OP trigger.
        // This matches how OpLocHandler works: ServerTriggerType.APLOC1 + (op - 1)
        const trigger: ServerTriggerType = ServerTriggerType.APLOC1 + (op - 1);

        const locType = LocType.get(loc.type);
        this.log('ACTION', `interactLoc: ${locType.debugname} (op=${op}) at (${loc.x},${loc.z})`);

        // The engine's Player.pathToPathingTarget() does NOT compute paths for Locs —
        // it expects the client to have already computed and queued the path.
        // We must simulate client-side pathfinding: compute a path to the loc
        // and queue waypoints before setting the interaction.
        const forceapproach = locType.forceapproach;
        const waypoints = findPathToLocSegment(
            this.player.level, this.player.x, this.player.z,
            loc.x, loc.z, this.player.width,
            loc.width, loc.length, loc.angle, loc.shape, forceapproach
        );
        if (waypoints.length > 0) {
            this.player.queueWaypoints(waypoints);
        }

        const success = this.player.setInteraction(Interaction.SCRIPT, loc, trigger);
        if (!success) {
            throw new Error(`setInteraction failed for Loc ${locType.debugname} at (${loc.x},${loc.z}) loc.isActive=${loc.isActive}`);
        }

        // Wait for the engine to process the interaction (approach + trigger).
        for (let i = 0; i < 30; i++) {
            await this.waitForTick();
            if (this.player.target === null) {
                return;
            }
        }
    }

    /**
     * Use an item from inventory on a nearby loc.
     * Sets player.lastUseItem and player.lastUseSlot, then triggers APLOCU.
     */
    async useItemOnLoc(itemName: string, locDebugname: string): Promise<void> {
        const item = this.findItem(itemName);
        if (!item) {
            throw new Error(`useItemOnLoc: item "${itemName}" not found in inventory`);
        }

        const loc = this.findNearbyLoc(locDebugname);
        if (!loc) {
            throw new Error(`useItemOnLoc: loc "${locDebugname}" not found nearby`);
        }

        const locType = LocType.get(loc.type);
        this.log('ACTION', `useItemOnLoc: ${itemName} (id=${item.id}, slot=${item.slot}) on ${locType.debugname} at (${loc.x},${loc.z})`);

        // Set the use-item fields that the RS2 smelting script reads
        this.player.lastUseItem = item.id;
        this.player.lastUseSlot = item.slot;

        // Compute path to the loc (same as interactLoc — engine doesn't path to locs for us)
        const forceapproach = locType.forceapproach;
        const waypoints = findPathToLocSegment(
            this.player.level, this.player.x, this.player.z,
            loc.x, loc.z, this.player.width,
            loc.width, loc.length, loc.angle, loc.shape, forceapproach
        );
        if (waypoints.length > 0) {
            this.player.queueWaypoints(waypoints);
        }

        const success = this.player.setInteraction(Interaction.SCRIPT, loc, ServerTriggerType.APLOCU);
        if (!success) {
            throw new Error(`setInteraction APLOCU failed for Loc ${locType.debugname} at (${loc.x},${loc.z}) loc.isActive=${loc.isActive}`);
        }

        // Wait for interaction to complete
        for (let i = 0; i < 30; i++) {
            await this.waitForTick();
            if (this.player.target === null) {
                return;
            }
        }
    }

    /**
     * Snapshot the inventory and wait until its contents change, or timeout.
     */
    async waitForInventoryChange(timeoutTicks: number = 30): Promise<boolean> {
        const snapshot = this.getInventory().map(i => `${i.id}:${i.count}`).join(',');

        for (let i = 0; i < timeoutTicks; i++) {
            await this.waitForTick();
            const current = this.getInventory().map(i => `${i.id}:${i.count}`).join(',');
            if (current !== snapshot) {
                return true;
            }
        }
        return false;
    }

    /**
     * Search for a loc with op[0] === 'Open' (a closed door or gate) near the given coordinates.
     * Uses the pre-computed door registry for fast lookup, then resolves to live Loc objects.
     * Returns the closest matching loc within `maxDist` tiles, or null.
     */
    private findOpenableLocNear(centerX: number, centerZ: number, level: number, maxDist: number): Loc | null {
        const doors = doorRegistry.findDoorsNear(centerX, centerZ, level, maxDist);
        return doors.length > 0 ? doors[0]! : null;
    }

    /**
     * Gather debug info about all locs within `maxDist` tiles of a coordinate.
     * Returns a formatted string listing each loc's debugname, coords, and ops.
     */
    private describeNearbyLocs(centerX: number, centerZ: number, level: number, maxDist: number): string {
        const locs: { debugname: string; x: number; z: number; ops: string }[] = [];

        const zoneRadius = Math.ceil(maxDist / 8) + 1;
        const centerZoneX = centerX >> 3;
        const centerZoneZ = centerZ >> 3;

        for (let dx = -zoneRadius; dx <= zoneRadius; dx++) {
            for (let dz = -zoneRadius; dz <= zoneRadius; dz++) {
                const zoneX = centerZoneX + dx;
                const zoneZ = centerZoneZ + dz;
                const zone = World.gameMap.getZone(zoneX << 3, zoneZ << 3, level);
                for (const loc of zone.getAllLocsSafe()) {
                    const dist = Math.max(Math.abs(loc.x - centerX), Math.abs(loc.z - centerZ));
                    if (dist > maxDist) continue;
                    const locType = LocType.get(loc.type);
                    const ops = locType.op?.filter(Boolean).join(',') || 'none';
                    locs.push({ debugname: locType.debugname ?? `type_${loc.type}`, x: loc.x, z: loc.z, ops });
                }
            }
        }

        if (locs.length === 0) return '(no locs within range)';
        return locs.map(l => `  ${l.debugname} at (${l.x},${l.z}) ops=[${l.ops}]`).join('\n');
    }

    /**
     * Walk to a destination using the engine's pathfinder.
     * For long distances, picks intermediate targets within pathfinder search range
     * (max ~34 tiles), pathfinds to each, walks, and repeats.
     *
     * If a path segment is blocked, automatically scans for nearby doors/gates
     * (locs with op1='Open'), opens them, and retries the segment.
     */
    async walkToWithPathfinding(x: number, z: number): Promise<void> {
        this.log('ACTION', `walkToWithPathfinding: (${this.player.x},${this.player.z}) -> (${x},${z})`);

        // rsmod pathfinder search grid is ~72x72, so max ~34 tiles from source
        const MAX_SEGMENT_DIST = 30;
        const MAX_ITERATIONS = 30;

        // Track doors we've already opened to avoid infinite retry loops.
        // Key = "x,z" of the door loc.
        const openedDoors = new Set<string>();

        for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
            const curX = this.player.x;
            const curZ = this.player.z;
            if (curX === x && curZ === z) {
                break;
            }

            const level = this.player.level;
            const dx = x - curX;
            const dz = z - curZ;
            const chebyshev = Math.max(Math.abs(dx), Math.abs(dz));

            let targetX: number;
            let targetZ: number;
            if (chebyshev <= MAX_SEGMENT_DIST) {
                targetX = x;
                targetZ = z;
            } else {
                const ratio = MAX_SEGMENT_DIST / chebyshev;
                targetX = curX + Math.round(dx * ratio);
                targetZ = curZ + Math.round(dz * ratio);
            }

            const result = findPathSegment(level, curX, curZ, targetX, targetZ);

            if (result.length === 0) {
                // Path is blocked — try to find and open a nearby door/gate.
                // Search near the bot's current position first, then near the target,
                // then along the midpoint between them.
                const midX = Math.round((curX + targetX) / 2);
                const midZ = Math.round((curZ + targetZ) / 2);
                const searchPoints = [
                    { x: curX, z: curZ },
                    { x: targetX, z: targetZ },
                    { x: midX, z: midZ },
                ];

                let door: Loc | null = null;
                for (const pt of searchPoints) {
                    door = this.findOpenableLocNear(pt.x, pt.z, level, 5);
                    if (door && !openedDoors.has(`${door.x},${door.z}`)) break;
                    door = null; // Skip already-opened doors
                }

                if (door) {
                    const doorKey = `${door.x},${door.z}`;
                    openedDoors.add(doorKey);
                    const doorType = LocType.get(door.type);
                    this.log('ACTION', `openDoor (auto): ${doorType.debugname} at (${door.x},${door.z}) — path was blocked at (${curX},${curZ})->(${targetX},${targetZ})`);

                    await this.interactLoc(door, 1);
                    await this.waitForTicks(1);

                    // After opening the door, immediately try to walk toward the target
                    // before the door auto-closes
                    const throughResult = findPathSegment(level, this.player.x, this.player.z, targetX, targetZ);
                    if (throughResult.length > 0) {
                        this.player.queueWaypoints(throughResult);
                        for (let tick = 0; tick < 35; tick++) {
                            await this.waitForTick();
                            if (this.player.x === x && this.player.z === z) break;
                            if (!this.player.hasWaypoints()) break;
                        }
                    }
                    // Resume the loop — next iteration will re-pathfind from current position
                    continue;
                }

                // No openable loc found — throw with diagnostic info
                const nearbyLocs = this.describeNearbyLocs(curX, curZ, level, 5);
                const targetNearbyLocs = (curX !== targetX || curZ !== targetZ) ? this.describeNearbyLocs(targetX, targetZ, level, 5) : '';
                throw new Error(
                    `Pathfinding failed: no path from (${curX},${curZ}) to (${targetX},${targetZ}) on level ${level} (final destination: (${x},${z}))\n` +
                    'No openable door/gate found nearby.\n' +
                    `Locs within 5 tiles of bot (${curX},${curZ}):\n${nearbyLocs}` +
                    (targetNearbyLocs ? `\nLocs within 5 tiles of target (${targetX},${targetZ}):\n${targetNearbyLocs}` : '')
                );
            }

            this.player.queueWaypoints(result);

            // Wait until the player stops moving or reaches destination
            for (let tick = 0; tick < 35; tick++) {
                await this.waitForTick();
                if (this.player.x === x && this.player.z === z) {
                    break;
                }
                if (!this.player.hasWaypoints()) {
                    break;
                }
            }
        }

        if (this.player.x !== x || this.player.z !== z) {
            throw new Error(`walkToWithPathfinding: failed to reach (${x},${z}), stopped at (${this.player.x},${this.player.z})`);
        }

        this.log('STATE', `Arrived at (${this.player.x},${this.player.z})`);
    }

    /**
     * Walk to a position, continuously clearing NPC collision flags each tick
     * to allow pathfinding and movement through NPCs.
     */
    async walkToIgnoringNpcs(x: number, z: number): Promise<void> {
        const level = this.player.level;

        // Helper: clear NPC collision in nearby zones, return list for restore
        const clearNearbyNpcCollision = (): { npc: Npc; x: number; z: number; width: number }[] => {
            const cleared: { npc: Npc; x: number; z: number; width: number }[] = [];
            const zoneX = this.player.x >> 3;
            const zoneZ = this.player.z >> 3;
            for (let dx = -3; dx <= 3; dx++) {
                for (let dz = -3; dz <= 3; dz++) {
                    const zone = World.gameMap.getZone((zoneX + dx) << 3, (zoneZ + dz) << 3, level);
                    for (const npc of zone.getAllNpcsSafe()) {
                        if (npc.isActive) {
                            changeNpcCollision(npc.width, npc.x, npc.z, npc.level, false);
                            cleared.push({ npc, x: npc.x, z: npc.z, width: npc.width });
                        }
                    }
                }
            }
            return cleared;
        };

        // Helper: restore NPC collision
        const restoreNpcCollision = (cleared: { npc: Npc; x: number; z: number; width: number }[]) => {
            for (const { npc, x: nx, z: nz, width } of cleared) {
                if (npc.isActive && npc.x === nx && npc.z === nz) {
                    changeNpcCollision(width, nx, nz, level, true);
                }
            }
        };

        // Clear collision and find path
        let cleared = clearNearbyNpcCollision();
        const MAX_SEGMENT_DIST = 30;
        let curX = this.player.x;
        let curZ = this.player.z;

        for (let segment = 0; segment < 20; segment++) {
            if (curX === x && curZ === z) break;

            const dx = x - curX;
            const dz = z - curZ;
            const chebyshev = Math.max(Math.abs(dx), Math.abs(dz));
            let targetX: number, targetZ: number;
            if (chebyshev <= MAX_SEGMENT_DIST) {
                targetX = x;
                targetZ = z;
            } else {
                const ratio = MAX_SEGMENT_DIST / chebyshev;
                targetX = curX + Math.round(dx * ratio);
                targetZ = curZ + Math.round(dz * ratio);
            }

            const result = findPathSegment(level, curX, curZ, targetX, targetZ);
            if (result.length === 0) {
                restoreNpcCollision(cleared);
                throw new Error(`walkToIgnoringNpcs: no path from (${curX},${curZ}) to (${targetX},${targetZ})`);
            }

            this.player.queueWaypoints(result);

            // Wait for movement — collision must stay cleared DURING the tick
            // so that takeStep()/canTravel() doesn't see NPC blocking
            for (let tick = 0; tick < 35; tick++) {
                await this.waitForTick();
                // After tick: restore old positions, then re-clear at new positions
                restoreNpcCollision(cleared);
                cleared = clearNearbyNpcCollision();
                if (this.player.x === x && this.player.z === z) break;
                if (!this.player.hasWaypoints()) break;
            }

            curX = this.player.x;
            curZ = this.player.z;
        }

        restoreNpcCollision(cleared);

        if (this.player.x !== x || this.player.z !== z) {
            throw new Error(`walkToIgnoringNpcs: failed to reach (${x},${z}), stopped at (${this.player.x},${this.player.z})`);
        }
        this.log('STATE', `Arrived at (${this.player.x},${this.player.z}) [NPC-ignore]`);
    }

    // --- Dialog methods ---

    /**
     * Find an NPC by name and interact with it using Talk-to (op1).
     */
    async talkToNpc(name: string): Promise<void> {
        const npc = this.findNearbyNpc(name);
        if (!npc) {
            throw new Error(`talkToNpc: NPC "${name}" not found near (${this.player.x},${this.player.z},${this.player.level})`);
        }
        this.log('ACTION', `talkToNpc: ${name} at (${npc.x},${npc.z})`);
        await this.interactNpc(npc, 1);
    }

    /**
     * Check if the player's active script is paused waiting for button input.
     */
    isDialogOpen(): boolean {
        return this.player.activeScript !== null &&
               this.player.activeScript.execution === ScriptState.PAUSEBUTTON;
    }

    /**
     * Check if the current dialog is a multi-choice dialog (multi2/multi3/multi4/multi5).
     * Uses modalChat to check the interface component ID.
     */
    isMultiChoiceOpen(): boolean {
        if (!this.isDialogOpen()) return false;
        const multiIds = [
            Component.getId('multi2'),
            Component.getId('multi3'),
            Component.getId('multi4'),
            Component.getId('multi5')
        ];
        return multiIds.includes(this.player.modalChat);
    }

    /**
     * Continue through dialog pages until a multi-choice dialog appears or dialog ends.
     * Returns true if a multi-choice is now open, false if dialog ended.
     */
    async continueDialogsUntilChoice(maxPages: number = 30): Promise<boolean> {
        for (let i = 0; i < maxPages; i++) {
            const hasDialog = await this.waitForDialog(10);
            if (!hasDialog) return false;
            if (this.isMultiChoiceOpen()) return true;
            await this.continueDialog();
        }
        return false;
    }

    /**
     * Continue through remaining dialog pages until no more dialogs appear.
     */
    async continueRemainingDialogs(maxPages: number = 20): Promise<void> {
        for (let i = 0; i < maxPages; i++) {
            const hasDialog = await this.waitForDialog(3);
            if (!hasDialog) return;
            if (this.isMultiChoiceOpen()) return; // unexpected choice, stop
            await this.continueDialog();
        }
    }

    /**
     * Wait until a dialog is open (script paused on PAUSEBUTTON), or timeout.
     */
    async waitForDialog(timeoutTicks: number = 30): Promise<boolean> {
        for (let i = 0; i < timeoutTicks; i++) {
            if (this.isDialogOpen()) {
                return true;
            }
            await this.waitForTick();
        }
        return false;
    }

    /**
     * Read recent captured dialog text from BotPlayer's message buffer.
     */
    getDialogText(): string[] {
        return this.player.capturedMessages
            .filter(m => m.text !== undefined)
            .map(m => m.text!);
    }

    /**
     * Simulate RESUME_PAUSEBUTTON: resume a paused dialog script.
     * This is what happens when the real client clicks "Click to continue".
     */
    async continueDialog(): Promise<void> {
        if (!this.player.activeScript || this.player.activeScript.execution !== ScriptState.PAUSEBUTTON) {
            throw new Error('continueDialog: no active script paused on PAUSEBUTTON');
        }
        this.log('ACTION', 'continueDialog');
        this.player.executeScript(this.player.activeScript, true, true);
        await this.waitForTick();
    }

    /**
     * Simulate IF_BUTTON on a multi-choice dialog option.
     * index is 1-based (1 = first option, 2 = second, etc.).
     *
     * The dialog system uses components like multi2:com_1, multi2:com_2 for 2-choice,
     * multi3:com_1..com_3 for 3-choice, etc. The RS2 script checks `last_com` against
     * these components to determine which option was selected.
     *
     * We derive the button component ID from the current modalChat interface rather
     * than from resumeButtons, because resumeButtons can contain stale entries from
     * previous choices (openChatModal only clears them when the script is paused,
     * not during execution).
     */
    async selectDialogOption(index: number): Promise<void> {
        if (!this.player.activeScript || this.player.activeScript.execution !== ScriptState.PAUSEBUTTON) {
            throw new Error('selectDialogOption: no active script paused on PAUSEBUTTON');
        }
        if (index < 1 || index > 5) {
            throw new Error(`selectDialogOption: index must be 1-5, got ${index}`);
        }

        // Determine the current multi-choice interface from modalChat and derive
        // the correct button component ID. This avoids issues with stale resumeButtons.
        const multiInterfaces: { root: number; prefix: string; maxOptions: number }[] = [
            { root: Component.getId('multi2'), prefix: 'multi2', maxOptions: 2 },
            { root: Component.getId('multi3'), prefix: 'multi3', maxOptions: 3 },
            { root: Component.getId('multi4'), prefix: 'multi4', maxOptions: 4 },
            { root: Component.getId('multi5'), prefix: 'multi5', maxOptions: 5 }
        ];

        const currentMulti = multiInterfaces.find(m => m.root === this.player.modalChat);
        if (!currentMulti) {
            throw new Error(`selectDialogOption: current modalChat ${this.player.modalChat} is not a multi-choice interface`);
        }

        if (index > currentMulti.maxOptions) {
            throw new Error(`selectDialogOption: index ${index} out of range for ${currentMulti.prefix} (max ${currentMulti.maxOptions})`);
        }

        const comId = Component.getId(`${currentMulti.prefix}:com_${index}`);
        if (comId === -1) {
            throw new Error(`selectDialogOption: component ${currentMulti.prefix}:com_${index} not found`);
        }

        this.player.lastCom = comId;
        this.log('ACTION', `selectDialogOption: index=${index}, comId=${comId}`);

        // Resume the script — same as IfButtonHandler does when the button is in resumeButtons
        this.player.executeScript(this.player.activeScript, true, true);
        await this.waitForTick();
    }

    /**
     * Simulate pressing an interface button (IF_BUTTON).
     * componentName is the interface:component name, e.g. 'controls:com_3'.
     */
    async pressButton(componentName: string): Promise<void> {
        const comId = Component.getId(componentName);
        if (comId === -1) {
            throw new Error(`pressButton: component '${componentName}' not found`);
        }
        const com = Component.get(comId);
        if (typeof com === 'undefined' || com.buttonType === Component.NO_BUTTON) {
            throw new Error(`pressButton: component '${componentName}' is not a button`);
        }
        if (!this.player.isComponentVisible(com)) {
            throw new Error(`pressButton: component '${componentName}' is not visible`);
        }
        this.player.lastCom = comId;
        this.log('ACTION', `pressButton: ${componentName} (comId=${comId})`);

        const script = ScriptProvider.getByTriggerSpecific(ServerTriggerType.IF_BUTTON, comId, -1);
        if (!script) {
            throw new Error(`pressButton: no if_button trigger for '${componentName}'`);
        }
        const root = Component.get(com.rootLayer);
        this.player.executeScript(ScriptRunner.init(script, this.player), root.overlay == false);
        await this.waitForTick();
    }

    // --- Navigation methods ---

    /**
     * Open a closed door. Interacts with the door loc using op1 (Open).
     * If the door loc is not found (already open), this is a no-op.
     */
    async openDoor(doorDebugname: string): Promise<void> {
        const door = this.findNearbyLoc(doorDebugname);
        if (!door) {
            this.log('STATE', `openDoor: "${doorDebugname}" not found nearby — may already be open`);
            return;
        }
        this.log('ACTION', `openDoor: ${doorDebugname} at (${door.x},${door.z})`);
        await this.interactLoc(door, 1);
        await this.waitForTicks(1);
    }

    /**
     * Interact with stairs/ladder loc using the given op. Wait for level/position change.
     * op=1 is the primary action. For loc_1739 (mid-level stairs): op2=climb-up, op3=climb-down.
     *
     * Stairs/ladders teleport the player (p_telejump) to a different level or a
     * distant z-coordinate (basements use z + 6400). The engine script typically
     * does p_delay(0) then p_telejump, so the actual teleport happens 1 tick after
     * the script first runs. We snapshot position AFTER interactLoc completes
     * (when the bot has already walked to the loc), then wait for the teleport.
     */
    async climbStairs(stairsDebugname: string, op: number): Promise<void> {
        const stairs = this.findNearbyLoc(stairsDebugname);
        if (!stairs) {
            throw new Error(`climbStairs: "${stairsDebugname}" not found near (${this.player.x},${this.player.z},${this.player.level})`);
        }

        const startLevel = this.player.level;
        this.log('ACTION', `climbStairs: ${stairsDebugname} (op=${op}) at (${stairs.x},${stairs.z}), player level=${startLevel}`);

        await this.interactLoc(stairs, op);

        // Snapshot position AFTER approach walk is done
        const afterWalkX = this.player.x;
        const afterWalkZ = this.player.z;
        const afterWalkLevel = this.player.level;

        // If the teleport already happened during interactLoc, we're done
        if (afterWalkLevel !== startLevel || Math.abs(afterWalkZ - stairs.z) > 100) {
            this.log('STATE', `After stairs: pos=(${this.player.x},${this.player.z},${this.player.level})`);
            return;
        }

        // Wait for the p_telejump to fire (happens after p_delay(0) resumes)
        for (let i = 0; i < 15; i++) {
            await this.waitForTick();
            if (this.player.level !== afterWalkLevel ||
                this.player.x !== afterWalkX ||
                this.player.z !== afterWalkZ) {
                this.log('STATE', `After stairs: pos=(${this.player.x},${this.player.z},${this.player.level})`);
                return;
            }
        }

        // If we're still at the same position, the stair interaction didn't teleport us.
        // This can happen if the script has a dialog choice (like loc_1739 op1).
        this.log('STATE', `After stairs (no teleport detected): pos=(${this.player.x},${this.player.z},${this.player.level})`);
    }

    /**
     * Get quest progress for a given varp ID.
     */
    getQuestProgress(varpId: number): number {
        return this.player.vars[varpId]!;
    }

    /**
     * Find a nearby NPC by its internal type ID (debugname in npc.pack).
     * Unlike findNearbyNpc which matches the display name, this matches the
     * NpcType.id directly. Useful when multiple NPC types share the same
     * display name (e.g. sheered vs unsheered sheep are both "Sheep").
     */
    findNearbyNpcByTypeId(typeId: number, maxDist: number = 16): Npc | null {
        const px = this.player.x;
        const pz = this.player.z;
        const level = this.player.level;

        let closest: Npc | null = null;
        let closestDist = maxDist + 1;

        const zoneRadius = Math.ceil(maxDist / 8) + 1;
        const playerZoneX = px >> 3;
        const playerZoneZ = pz >> 3;

        for (let dx = -zoneRadius; dx <= zoneRadius; dx++) {
            for (let dz = -zoneRadius; dz <= zoneRadius; dz++) {
                const zoneX = playerZoneX + dx;
                const zoneZ = playerZoneZ + dz;
                const zone = World.gameMap.getZone(zoneX << 3, zoneZ << 3, level);
                for (const npc of zone.getAllNpcsSafe()) {
                    if (npc.type !== typeId) {
                        continue;
                    }
                    const dist = Math.max(Math.abs(npc.x - px), Math.abs(npc.z - pz));
                    if (dist < closestDist) {
                        closest = npc;
                        closestDist = dist;
                    }
                }
            }
        }

        return closest;
    }

    /**
     * Find a nearby NPC by type ID, but only if the bot can actually path to it.
     * This prevents targeting NPCs on the other side of walls/fences that the bot
     * can't reach. Uses entity-aware pathfinding to check reachability.
     * Returns the closest reachable NPC within maxDist.
     */
    findReachableNpcByTypeId(typeId: number, maxDist: number = 16): Npc | null {
        const px = this.player.x;
        const pz = this.player.z;
        const level = this.player.level;

        const candidates: Array<{ npc: Npc; dist: number }> = [];

        const zoneRadius = Math.ceil(maxDist / 8) + 1;
        const playerZoneX = px >> 3;
        const playerZoneZ = pz >> 3;

        for (let dx = -zoneRadius; dx <= zoneRadius; dx++) {
            for (let dz = -zoneRadius; dz <= zoneRadius; dz++) {
                const zoneX = playerZoneX + dx;
                const zoneZ = playerZoneZ + dz;
                const zone = World.gameMap.getZone(zoneX << 3, zoneZ << 3, level);
                for (const npc of zone.getAllNpcsSafe()) {
                    if (npc.type !== typeId) {
                        continue;
                    }
                    const dist = Math.max(Math.abs(npc.x - px), Math.abs(npc.z - pz));
                    if (dist <= maxDist) {
                        candidates.push({ npc, dist });
                    }
                }
            }
        }

        // Sort by distance, then check pathfinding for each until we find a reachable one
        candidates.sort((a, b) => a.dist - b.dist);
        for (const { npc } of candidates) {
            const path = findPathToEntity(level, px, pz, npc.x, npc.z, this.player.width, npc.width, npc.length);
            if (path.length > 0) {
                return npc;
            }
        }

        return null;
    }

    /**
     * Find ALL nearby NPCs of a given type ID within maxDist tiles.
     * Returns an array sorted by distance (closest first).
     */
    findAllNearbyNpcsByTypeId(typeId: number, maxDist: number = 16): Npc[] {
        const px = this.player.x;
        const pz = this.player.z;
        const level = this.player.level;

        const results: Array<{ npc: Npc; dist: number }> = [];

        const zoneRadius = Math.ceil(maxDist / 8) + 1;
        const playerZoneX = px >> 3;
        const playerZoneZ = pz >> 3;

        for (let dx = -zoneRadius; dx <= zoneRadius; dx++) {
            for (let dz = -zoneRadius; dz <= zoneRadius; dz++) {
                const zoneX = playerZoneX + dx;
                const zoneZ = playerZoneZ + dz;
                const zone = World.gameMap.getZone(zoneX << 3, zoneZ << 3, level);
                for (const npc of zone.getAllNpcsSafe()) {
                    if (npc.type !== typeId) {
                        continue;
                    }
                    const dist = Math.max(Math.abs(npc.x - px), Math.abs(npc.z - pz));
                    if (dist <= maxDist) {
                        results.push({ npc, dist });
                    }
                }
            }
        }

        results.sort((a, b) => a.dist - b.dist);
        return results.map(r => r.npc);
    }

    /**
     * Use an item from inventory on a nearby NPC.
     * Sets player.lastUseItem and player.lastUseSlot, then triggers APNPCU.
     * This mirrors how OpNpcUHandler works in the client network layer.
     */
    async useItemOnNpc(itemName: string, npcName: string): Promise<void> {
        const item = this.findItem(itemName);
        if (!item) {
            throw new Error(`useItemOnNpc: item "${itemName}" not found in inventory`);
        }

        const npc = this.findNearbyNpc(npcName);
        if (!npc) {
            throw new Error(`useItemOnNpc: NPC "${npcName}" not found nearby`);
        }

        const npcType = NpcType.get(npc.type);
        this.log('ACTION', `useItemOnNpc: ${itemName} (id=${item.id}, slot=${item.slot}) on ${npcType.name} at (${npc.x},${npc.z})`);

        // Set the use-item fields (same as OpNpcUHandler)
        this.player.lastUseItem = item.id;
        this.player.lastUseSlot = item.slot;

        const success = this.player.setInteraction(Interaction.SCRIPT, npc, ServerTriggerType.APNPCU);
        if (!success) {
            throw new Error(`setInteraction APNPCU failed for NPC ${npcType.name} at (${npc.x},${npc.z}) npc.delayed=${npc.delayed} npc.isActive=${npc.isActive}`);
        }

        // Wait for the engine to process the interaction
        for (let i = 0; i < 15; i++) {
            await this.waitForTick();
            if (this.player.target === null) {
                return;
            }
        }
    }

    /**
     * Use an item from inventory on a specific NPC instance (by reference).
     * Same as useItemOnNpc but takes an Npc directly instead of searching by name.
     */
    async useItemOnNpcDirect(itemName: string, npc: Npc): Promise<void> {
        const item = this.findItem(itemName);
        if (!item) {
            throw new Error(`useItemOnNpcDirect: item "${itemName}" not found in inventory`);
        }

        const npcType = NpcType.get(npc.type);
        this.log('ACTION', `useItemOnNpcDirect: ${itemName} (id=${item.id}, slot=${item.slot}) on ${npcType.name} at (${npc.x},${npc.z})`);

        // Pre-compute path to the NPC using entity-aware pathfinding.
        // This mirrors how the real client handler works: OpNpcUHandler sets
        // opcalled=true, then processClientsIn calls pathToTarget() which uses
        // findPathToEntity. Since BotPlayer extends Player (not NetworkPlayer),
        // we don't have opcalled, so we pre-queue the path ourselves.
        const waypoints = findPathToEntity(
            this.player.level, this.player.x, this.player.z,
            npc.x, npc.z, this.player.width,
            npc.width, npc.length
        );
        if (waypoints.length > 0) {
            this.player.queueWaypoints(waypoints);
        }

        this.player.lastUseItem = item.id;
        this.player.lastUseSlot = item.slot;

        const success = this.player.setInteraction(Interaction.SCRIPT, npc, ServerTriggerType.APNPCU);
        if (!success) {
            throw new Error(`setInteraction APNPCU failed for NPC ${npcType.name} at (${npc.x},${npc.z}) npc.delayed=${npc.delayed} npc.isActive=${npc.isActive}`);
        }

        for (let i = 0; i < 15; i++) {
            await this.waitForTick();
            if (this.player.target === null) {
                return;
            }
        }
    }

    /**
     * Buy an item from an open shop interface.
     *
     * Simulates clicking "Buy 1" (inv_button2) on the shop_template:inv component.
     * The shop must already be open (e.g. after interacting with a shopkeeper via op3/Trade
     * or via dialog). The RS2 shop script sets up invListeners and varps when the shop opens.
     *
     * @param itemName Display name of the item to buy
     * @param quantity Number to buy (each triggers a separate buy-1 click)
     */
    async buyFromShop(itemName: string, quantity: number): Promise<void> {
        const lowerName = itemName.toLowerCase();

        // shop_template:inv component ID (from interface.pack: 3900=shop_template:inv)
        const SHOP_TEMPLATE_INV_COM = 3900;

        // Find the shop inventory from the invListeners
        const shopListener = this.player.invListeners.find(l => l.com === SHOP_TEMPLATE_INV_COM);
        if (!shopListener) {
            throw new Error(`buyFromShop: shop is not open (no invListener for shop_template:inv). invListeners: [${this.player.invListeners.map(l => `com=${l.com},type=${l.type}`).join('; ')}]`);
        }

        const shopInv = this.player.getInventoryFromListener(shopListener);
        if (!shopInv) {
            throw new Error('buyFromShop: could not get shop inventory from listener');
        }

        // Find the item slot in the shop inventory
        let itemSlot = -1;
        let itemObjId = -1;
        for (let slot = 0; slot < shopInv.capacity; slot++) {
            const slotItem = shopInv.items[slot];
            if (slotItem) {
                const objType = ObjType.get(slotItem.id);
                if (objType.name?.toLowerCase() === lowerName) {
                    itemSlot = slot;
                    itemObjId = slotItem.id;
                    break;
                }
            }
        }

        if (itemSlot === -1) {
            throw new Error(`buyFromShop: item "${itemName}" not found in shop inventory`);
        }

        this.log('ACTION', `buyFromShop: ${itemName} (id=${itemObjId}, slot=${itemSlot}) x${quantity}`);

        // Buy one at a time by executing the INV_BUTTON2 trigger for shop_template:inv
        const com = Component.get(SHOP_TEMPLATE_INV_COM);
        const trigger = ServerTriggerType.INV_BUTTON2;

        for (let i = 0; i < quantity; i++) {
            // Verify item is still in stock
            const currentItem = shopInv.items[itemSlot];
            if (!currentItem || currentItem.id !== itemObjId) {
                throw new Error(`buyFromShop: item "${itemName}" no longer in stock at slot ${itemSlot} after buying ${i}/${quantity}`);
            }

            // Set lastItem and lastSlot (same as InvButtonHandler)
            this.player.lastItem = itemObjId;
            this.player.lastSlot = itemSlot;

            const script = ScriptProvider.getByTrigger(trigger, SHOP_TEMPLATE_INV_COM, -1);
            if (!script) {
                throw new Error('buyFromShop: no script found for [inv_button2,shop_template:inv]');
            }

            const root = Component.get(com.rootLayer);
            this.player.executeScript(ScriptRunner.init(script, this.player), root.overlay == false);
            await this.waitForTick();
        }
    }

    /**
     * Use one inventory item on another (triggers OPHELDU).
     * This simulates the client's "Use X -> Y" action. The engine looks up
     * [opheldu,b] then [opheldu,a] then category variants, matching the
     * OpHeldUHandler behavior.
     *
     * @param itemAName Display name of the item being used (the one you click "Use" on)
     * @param itemBName Display name of the target item
     */
    async useItemOnItem(itemAName: string, itemBName: string): Promise<void> {
        const itemA = this.findItem(itemAName);
        if (!itemA) {
            throw new Error(`useItemOnItem: item "${itemAName}" not found in inventory`);
        }

        const itemB = this.findItem(itemBName);
        if (!itemB) {
            throw new Error(`useItemOnItem: item "${itemBName}" not found in inventory`);
        }

        this.log('ACTION', `useItemOnItem: ${itemAName} (id=${itemA.id}, slot=${itemA.slot}) on ${itemBName} (id=${itemB.id}, slot=${itemB.slot})`);

        // Set lastItem/lastSlot = the "target" (obj), lastUseItem/lastUseSlot = the "used" item
        // This matches OpHeldUHandler: obj is the target, useObj is the source.
        this.player.lastItem = itemB.id;
        this.player.lastSlot = itemB.slot;
        this.player.lastUseItem = itemA.id;
        this.player.lastUseSlot = itemA.slot;

        const objType = ObjType.get(this.player.lastItem);
        const useObjType = ObjType.get(this.player.lastUseItem);

        this.player.clearPendingAction();

        // Look up script in the same order as OpHeldUHandler:
        // [opheldu,b] -> [opheldu,a] -> [opheldu,b_category] -> [opheldu,a_category]
        let script = ScriptProvider.getByTriggerSpecific(ServerTriggerType.OPHELDU, objType.id, -1);

        if (!script) {
            script = ScriptProvider.getByTriggerSpecific(ServerTriggerType.OPHELDU, useObjType.id, -1);
            if (script) {
                [this.player.lastItem, this.player.lastUseItem] = [this.player.lastUseItem, this.player.lastItem];
                [this.player.lastSlot, this.player.lastUseSlot] = [this.player.lastUseSlot, this.player.lastSlot];
            }
        }

        const objCategory = objType.category !== -1 ? CategoryType.get(objType.category) : null;
        if (!script && objCategory) {
            script = ScriptProvider.getByTriggerSpecific(ServerTriggerType.OPHELDU, -1, objCategory.id);
        }

        const useObjCategory = useObjType.category !== -1 ? CategoryType.get(useObjType.category) : null;
        if (!script && useObjCategory) {
            script = ScriptProvider.getByTriggerSpecific(ServerTriggerType.OPHELDU, -1, useObjCategory.id);
            if (script) {
                [this.player.lastItem, this.player.lastUseItem] = [this.player.lastUseItem, this.player.lastItem];
                [this.player.lastSlot, this.player.lastUseSlot] = [this.player.lastUseSlot, this.player.lastSlot];
            }
        }

        if (!script) {
            throw new Error(`useItemOnItem: no [opheldu] script found for ${itemAName} (${objType.debugname}) on ${itemBName} (${useObjType.debugname})`);
        }

        this.player.executeScript(ScriptRunner.init(script, this.player), true);
        await this.waitForTick();
    }

    /**
     * Pick up a ground item (world Obj) at the given coordinates.
     * Simulates clicking "Take" (op3 by default for most items) on a ground object.
     * The engine will walk to the tile and execute the appropriate trigger.
     *
     * @param objName Display name of the obj to pick up
     * @param x World x coordinate
     * @param z World z coordinate
     */
    async takeGroundItem(objName: string, x: number, z: number): Promise<void> {
        const lowerName = objName.toLowerCase();
        const level = this.player.level;

        // Search for the obj at the given tile
        const zone = World.gameMap.getZone(x, z, level);
        let targetObj: Obj | null = null;

        for (const obj of zone.getAllObjsSafe()) {
            if (obj.x !== x || obj.z !== z) {
                continue;
            }
            const objType = ObjType.get(obj.type);
            if (objType.name?.toLowerCase() === lowerName) {
                targetObj = obj;
                break;
            }
        }

        if (!targetObj) {
            throw new Error(`takeGroundItem: "${objName}" not found at (${x},${z},${level})`);
        }

        const objType = ObjType.get(targetObj.type);
        this.log('ACTION', `takeGroundItem: ${objType.name} (id=${targetObj.type}) at (${x},${z})`);

        // Ground item "Take" is typically op3 (APOBJ3).
        // Walk to the tile first, then set interaction.
        const waypoints = findPathSegment(level, this.player.x, this.player.z, x, z);
        if (waypoints.length > 0) {
            this.player.queueWaypoints(waypoints);
        }

        const trigger: ServerTriggerType = ServerTriggerType.APOBJ3;
        const success = this.player.setInteraction(Interaction.ENGINE, targetObj, trigger);
        if (!success) {
            throw new Error(`takeGroundItem: setInteraction failed for ${objType.name} at (${x},${z})`);
        }

        // Wait for the engine to process the interaction
        for (let i = 0; i < 30; i++) {
            await this.waitForTick();
            if (this.player.target === null) {
                return;
            }
        }
    }

    /**
     * Find ground items of a given name near the player.
     * Returns the closest matching Obj within maxDist tiles, or null.
     */
    findNearbyGroundItem(name: string, maxDist: number = 16): { obj: Obj; x: number; z: number } | null {
        const lowerName = name.toLowerCase();
        const px = this.player.x;
        const pz = this.player.z;
        const level = this.player.level;

        let closest: { obj: Obj; x: number; z: number } | null = null;
        let closestDist = maxDist + 1;

        const zoneRadius = Math.ceil(maxDist / 8) + 1;
        const playerZoneX = px >> 3;
        const playerZoneZ = pz >> 3;

        for (let dx = -zoneRadius; dx <= zoneRadius; dx++) {
            for (let dz = -zoneRadius; dz <= zoneRadius; dz++) {
                const zoneX = playerZoneX + dx;
                const zoneZ = playerZoneZ + dz;
                const zone = World.gameMap.getZone(zoneX << 3, zoneZ << 3, level);
                for (const obj of zone.getAllObjsSafe()) {
                    const objType = ObjType.get(obj.type);
                    if (objType.name?.toLowerCase() !== lowerName) {
                        continue;
                    }
                    const dist = Math.max(Math.abs(obj.x - px), Math.abs(obj.z - pz));
                    if (dist < closestDist) {
                        closest = { obj, x: obj.x, z: obj.z };
                        closestDist = dist;
                    }
                }
            }
        }

        return closest;
    }

    /**
     * Equip (wield/wear) an inventory item by triggering OPHELD2.
     * This simulates the client clicking "Wield" or "Wear" on an item in inventory.
     *
     * @param itemName Display name of the item to equip
     */
    async equipItem(itemName: string): Promise<void> {
        const item = this.findItem(itemName);
        if (!item) {
            throw new Error(`equipItem: "${itemName}" not found in inventory`);
        }

        const objType = ObjType.get(item.id);

        // Set lastItem and lastSlot (same as OpHeldHandler)
        this.player.lastItem = item.id;
        this.player.lastSlot = item.slot;

        // Look up the [opheld2,_] script (Wield/Wear is always op 2)
        const trigger = ServerTriggerType.OPHELD2;
        const script = ScriptProvider.getByTrigger(trigger, objType.id, objType.category);
        if (!script) {
            throw new Error(`equipItem: no [opheld2] script found for "${itemName}" (${objType.debugname})`);
        }

        this.log('ACTION', `equipItem: ${itemName} (id=${item.id}, slot=${item.slot})`);
        this.player.executeScript(ScriptRunner.init(script, this.player), true);
        await this.waitForTick();
    }

    /**
     * Enable or disable running.
     * Equivalent to clicking the run orb in the player controls interface.
     * The run orb calls p_run(1) or p_run(0), which sets player.run and syncs the varp.
     * Requires run energy >= 1% (100/10000) to enable.
     */
    enableRun(enabled: boolean = true): void {
        const value = enabled ? 1 : 0;
        if (enabled && this.player.runenergy < 100) {
            throw new Error('enableRun: not enough run energy (need >= 1%)');
        }
        this.player.run = value;
        this.player.setVar(VarPlayerType.RUN, value);
        this.log('ACTION', `enableRun: ${enabled} (runenergy=${this.player.runenergy})`);
    }

    // --- Banking methods ---

    /**
     * Open the bank by interacting with a bank booth (oploc2=Bank on bankbooth).
     * The bot must be near a bank booth. After calling this, the bank interface
     * will be open and you can use depositItem/withdrawItem.
     */
    async openBank(): Promise<void> {
        const booth = this.findNearbyLoc('bankbooth');
        if (!booth) {
            throw new Error(`openBank: no bankbooth found near (${this.player.x},${this.player.z},${this.player.level})`);
        }
        this.log('ACTION', `openBank: bankbooth at (${booth.x},${booth.z})`);
        await this.interactLoc(booth, 2); // op2 = Bank
        await this.waitForTicks(2);
    }

    /**
     * Deposit an item into the bank using the bank_side:inv interface.
     * The bank must already be open (via openBank()).
     * Uses inv_button2 (deposit 1) on bank_side:inv.
     *
     * @param itemName Display name of the item to deposit
     * @param quantity Number to deposit (each triggers a separate deposit-1 click)
     */
    async depositItem(itemName: string, quantity: number = 1): Promise<void> {
        const BANK_SIDE_INV_COM = 2006; // bank_side:inv component ID

        for (let i = 0; i < quantity; i++) {
            const item = this.findItem(itemName);
            if (!item) {
                if (i === 0) {
                    throw new Error(`depositItem: "${itemName}" not found in inventory`);
                }
                break; // deposited all we had
            }

            this.player.lastItem = item.id;
            this.player.lastSlot = item.slot;

            const script = ScriptProvider.getByTrigger(ServerTriggerType.INV_BUTTON2, BANK_SIDE_INV_COM, -1);
            if (!script) {
                throw new Error('depositItem: no script found for [inv_button2,bank_side:inv]');
            }

            const com = Component.get(BANK_SIDE_INV_COM);
            const root = Component.get(com.rootLayer);
            this.player.executeScript(ScriptRunner.init(script, this.player), root.overlay == false);
            await this.waitForTick();
        }

        this.log('ACTION', `depositItem: ${itemName} x${quantity}`);
    }

    /**
     * Deposit ALL items from inventory into the bank.
     * The bank must already be open (via openBank()).
     * Deposits each unique item stack one at a time using deposit-all (inv_button4).
     */
    async depositAll(): Promise<void> {
        const BANK_SIDE_INV_COM = 2006; // bank_side:inv component ID

        // Get all items currently in inventory
        const items = this.getInventory();
        const deposited = new Set<number>();

        for (const item of items) {
            if (deposited.has(item.id)) continue; // already deposited this item type
            deposited.add(item.id);

            this.player.lastItem = item.id;
            this.player.lastSlot = item.slot;

            // inv_button4 = deposit all
            const script = ScriptProvider.getByTrigger(ServerTriggerType.INV_BUTTON4, BANK_SIDE_INV_COM, -1);
            if (!script) {
                throw new Error('depositAll: no script found for [inv_button4,bank_side:inv]');
            }

            const com = Component.get(BANK_SIDE_INV_COM);
            const root = Component.get(com.rootLayer);
            this.player.executeScript(ScriptRunner.init(script, this.player), root.overlay == false);
            await this.waitForTick();
        }

        this.log('ACTION', `depositAll: deposited ${deposited.size} item types`);
    }

    /**
     * Withdraw an item from the bank using the bank_main:inv interface.
     * The bank must already be open (via openBank()).
     *
     * @param itemName Display name of the item to withdraw
     * @param quantity Number to withdraw (each triggers a separate withdraw-1 click)
     */
    async withdrawItem(itemName: string, quantity: number = 1): Promise<void> {
        const BANK_MAIN_INV_COM = 5382; // bank_main:inv component ID
        const lowerName = itemName.toLowerCase();

        // Find the item in the bank inventory
        const bankListener = this.player.invListeners.find(l => l.com === BANK_MAIN_INV_COM);
        if (!bankListener) {
            throw new Error(`withdrawItem: bank is not open (no invListener for bank_main:inv). invListeners: [${this.player.invListeners.map(l => `com=${l.com},type=${l.type}`).join('; ')}]`);
        }

        const bankInv = this.player.getInventoryFromListener(bankListener);
        if (!bankInv) {
            throw new Error('withdrawItem: could not get bank inventory from listener');
        }

        // Find the item slot in the bank
        let itemSlot = -1;
        let itemObjId = -1;
        for (let slot = 0; slot < bankInv.capacity; slot++) {
            const slotItem = bankInv.items[slot];
            if (slotItem) {
                const objType = ObjType.get(slotItem.id);
                if (objType.name?.toLowerCase() === lowerName) {
                    itemSlot = slot;
                    itemObjId = slotItem.id;
                    break;
                }
            }
        }

        if (itemSlot === -1) {
            throw new Error(`withdrawItem: "${itemName}" not found in bank`);
        }

        this.log('ACTION', `withdrawItem: ${itemName} (id=${itemObjId}, slot=${itemSlot}) x${quantity}`);

        for (let i = 0; i < quantity; i++) {
            // Verify item is still in bank
            const currentItem = bankInv.items[itemSlot];
            if (!currentItem || currentItem.id !== itemObjId) {
                if (i === 0) {
                    throw new Error(`withdrawItem: "${itemName}" no longer in bank at slot ${itemSlot}`);
                }
                break; // withdrew all available
            }

            this.player.lastItem = itemObjId;
            this.player.lastSlot = itemSlot;

            // inv_button1 = withdraw 1
            const script = ScriptProvider.getByTrigger(ServerTriggerType.INV_BUTTON1, BANK_MAIN_INV_COM, -1);
            if (!script) {
                throw new Error('withdrawItem: no script found for [inv_button1,bank_main:inv]');
            }

            const com = Component.get(BANK_MAIN_INV_COM);
            const root = Component.get(com.rootLayer);
            this.player.executeScript(ScriptRunner.init(script, this.player), root.overlay == false);
            await this.waitForTick();
        }
    }

    /**
     * Close the bank interface.
     */
    closeBank(): void {
        if (this.player.containsModalInterface()) {
            this.player.closeModal();
        }
        this.log('ACTION', 'closeBank');
    }

    // --- Combat style methods ---

    /**
     * Set the combat attack style (com_mode varp).
     * 0 = style 1 (Accurate for melee, Accurate for ranged)
     * 1 = style 2 (Aggressive for melee, Rapid for ranged)
     * 2 = style 3 (Defensive for melee, Longrange for ranged)
     * 3 = style 4 (Controlled for melee, if available)
     *
     * For a bronze pickaxe (weapon_pickaxe category):
     *   0 = Accurate (attack XP)
     *   1 = Aggressive (strength XP) - Stab
     *   2 = Aggressive (strength XP) - Crush
     *   3 = Defensive (defence XP)
     */
    setCombatStyle(style: number): void {
        if (style < 0 || style > 3) {
            throw new Error(`setCombatStyle: style must be 0-3, got ${style}`);
        }
        this.player.vars[43] = style; // varp 43 = com_mode
        this.log('ACTION', `setCombatStyle: ${style}`);
    }

    // --- Item action methods ---

    /**
     * Use (click) an inventory item with its op1 action (e.g. Bury for bones, Drop, etc.).
     * Triggers [opheld1,item] which is the primary action for most items.
     */
    async useItemOp1(itemName: string): Promise<void> {
        const item = this.findItem(itemName);
        if (!item) {
            throw new Error(`useItemOp1: "${itemName}" not found in inventory`);
        }

        const objType = ObjType.get(item.id);

        this.player.lastItem = item.id;
        this.player.lastSlot = item.slot;

        const trigger = ServerTriggerType.OPHELD1;
        const script = ScriptProvider.getByTrigger(trigger, objType.id, objType.category);
        if (!script) {
            throw new Error(`useItemOp1: no [opheld1] script found for "${itemName}" (${objType.debugname})`);
        }

        this.log('ACTION', `useItemOp1: ${itemName} (id=${item.id}, slot=${item.slot})`);
        this.player.executeScript(ScriptRunner.init(script, this.player), true);
        await this.waitForTick();
    }

    /**
     * Drop an inventory item. Triggers [opheld5,_] (Drop is typically op5).
     */
    async dropItem(itemName: string): Promise<void> {
        const item = this.findItem(itemName);
        if (!item) {
            throw new Error(`dropItem: "${itemName}" not found in inventory`);
        }

        const objType = ObjType.get(item.id);

        this.player.lastItem = item.id;
        this.player.lastSlot = item.slot;

        const trigger = ServerTriggerType.OPHELD5;
        const script = ScriptProvider.getByTrigger(trigger, objType.id, objType.category);
        if (!script) {
            throw new Error(`dropItem: no [opheld5] script found for "${itemName}" (${objType.debugname})`);
        }

        this.log('ACTION', `dropItem: ${itemName} (id=${item.id}, slot=${item.slot})`);
        this.player.executeScript(ScriptRunner.init(script, this.player), true);
        await this.waitForTick();
    }

    /**
     * Cast a spell on an NPC by setting the spellCom and using APNPCT trigger.
     * This simulates the client clicking a spell in the spellbook then clicking an NPC.
     *
     * @param npc The NPC to cast on
     * @param spellComId The component ID of the spell (e.g. 1152 for magic:wind_strike)
     */
    async castSpellOnNpc(npc: import('../../src/engine/entity/Npc.ts').default, spellComId: number): Promise<void> {
        const npcType = NpcType.get(npc.type);
        this.log('ACTION', `castSpellOnNpc: spell com=${spellComId} on ${npcType.name} at (${npc.x},${npc.z})`);

        this.player.clearPendingAction();
        const success = this.player.setInteraction(Interaction.ENGINE, npc, ServerTriggerType.APNPCT, spellComId);
        if (!success) {
            throw new Error(`castSpellOnNpc: setInteraction APNPCT failed for NPC ${npcType.name} at (${npc.x},${npc.z})`);
        }

        // Wait for the engine to process the interaction
        for (let i = 0; i < 15; i++) {
            await this.waitForTick();
            if (this.player.target === null) {
                return;
            }
        }
    }

    /**
     * Count total number of items with a given name in inventory.
     * Unlike findItem which returns the first matching slot, this sums across all slots.
     * Needed for unstackable items where each occupies a separate slot.
     */
    countItem(name: string): number {
        const items = this.getInventory();
        const lowerName = name.toLowerCase();
        let total = 0;
        for (const item of items) {
            if (item.name.toLowerCase() === lowerName) {
                total += item.count;
            }
        }
        return total;
    }

    /**
     * Count free inventory slots.
     */
    freeSlots(): number {
        return 28 - this.getInventory().length;
    }

    /**
     * Click an item in the smithing interface to smith it.
     * The smithing interface must already be open (via useItemOnLoc with a bar on an anvil).
     *
     * Triggers [inv_button1,smithing:column1] with last_item set to the target product.
     * For bronze daggers: itemDebugName='bronze_dagger', column='column1', slot=0.
     *
     * @param itemDebugName The internal debug name of the item to smith (e.g. 'bronze_dagger')
     * @param column Which smithing column ('column1' through 'column5', or 'column_claws')
     * @param slot The slot index within that column (0-based)
     */
    async smithItem(itemDebugName: string, column: string = 'column1', slot: number = 0): Promise<void> {
        const comName = `smithing:${column}`;
        const comId = Component.getId(comName);
        if (comId === -1) {
            throw new Error(`smithItem: component "${comName}" not found`);
        }

        const objId = ObjType.getId(itemDebugName);
        if (objId === -1) {
            throw new Error(`smithItem: object "${itemDebugName}" not found`);
        }

        this.player.lastItem = objId;
        this.player.lastSlot = slot;

        const script = ScriptProvider.getByTrigger(ServerTriggerType.INV_BUTTON1, comId, -1);
        if (!script) {
            throw new Error(`smithItem: no script found for [inv_button1,${comName}]`);
        }

        const com = Component.get(comId);
        const root = Component.get(com.rootLayer);
        this.log('ACTION', `smithItem: ${itemDebugName} via ${comName} slot=${slot}`);
        this.player.executeScript(ScriptRunner.init(script, this.player), root.overlay == false);
        await this.waitForTick();
    }

    /**
     * Check if an item exists in the bank.
     */
    hasBankItem(itemName: string): boolean {
        const lowerName = itemName.toLowerCase();
        const bankInvType = InvType.getId('bank');
        const bankInv = this.player.getInventory(bankInvType);
        if (!bankInv) return false;

        for (let slot = 0; slot < bankInv.capacity; slot++) {
            const item = bankInv.items[slot];
            if (item) {
                const objType = ObjType.get(item.id);
                if (objType.name?.toLowerCase() === lowerName) return true;
            }
        }
        return false;
    }

    // --- Death recovery methods ---

    /**
     * Check if the bot is dead (hitpoints at 0 or death varp set).
     */
    isDead(): boolean {
        const hp = this.player.levels[3]; // HITPOINTS = stat index 3
        return hp !== undefined && hp <= 0;
    }

    /**
     * Wait for the bot to respawn after death.
     * Death takes ~4 ticks (animation + teleport to Lumbridge).
     * After respawn, re-enables run and logs the event.
     *
     * @returns true if death was detected and recovered, false if not dead
     */
    async waitForRespawn(timeoutTicks: number = 20): Promise<boolean> {
        if (!this.isDead() && this.player.vars[78] !== 1) {
            return false;
        }

        this.log('STATE', `Death detected at (${this.player.x},${this.player.z},${this.player.level})`);

        // Wait for the death script to complete and teleport us to Lumbridge
        for (let i = 0; i < timeoutTicks; i++) {
            await this.waitForTick();
            // After respawn, HP is restored and death varp cleared
            if (this.player.levels[3]! > 0 && this.player.vars[78] !== 1) {
                break;
            }
        }

        // Re-enable running (death restores energy via healenergy(10000))
        this.player.run = 1;

        this.log('STATE', `Respawned at (${this.player.x},${this.player.z},${this.player.level}), HP=${this.player.levels[3]}`);
        return true;
    }

    // --- Smart helper methods ---

    /**
     * Wait until stun/delay varps (58 and 103) have expired.
     * Also waits for player.delayed to clear.
     * Replaces the identical 6-line varp-checking pattern used across 5+ scripts.
     */
    async waitForActionReady(): Promise<void> {
        const stunnedUntil = this.getVarp(103);
        const actionDelayUntil = this.getVarp(58);
        const currentTick = this.getCurrentTick();

        if (stunnedUntil > currentTick || actionDelayUntil > currentTick) {
            const waitUntil = Math.max(stunnedUntil, actionDelayUntil);
            const ticksToWait = waitUntil - currentTick + 1;
            this.log('STATE', `waitForActionReady: stunned/delayed, waiting ${ticksToWait} ticks`);
            await this.waitForTicks(ticksToWait);
        }

        if (this.player.delayed) {
            await this.waitForCondition(() => !this.player.delayed, 20);
        }
    }

    /**
     * Attack an NPC by name and fight until it dies.
     * Re-engages if player.target clears (NPC moved, got hit by someone else).
     * Optionally eats food if HP drops below a threshold.
     * Throws if the bot dies or if the fight times out.
     *
     * @param npcName Display name of the NPC to attack
     * @param options.eatAt If set, eat food when HP% drops below this (0-100)
     * @param options.eatItemName Name of food item to eat (default: searches for any edible)
     * @param options.maxTicks Max ticks before timeout (default: 200)
     */
    async attackNpcUntilDead(npcName: string, options?: {
        eatAt?: number;
        eatItemName?: string;
        maxTicks?: number;
    }): Promise<void> {
        const maxTicks = options?.maxTicks ?? 200;

        const npc = this.findNearbyNpc(npcName, 20);
        if (!npc) {
            throw new Error(`attackNpcUntilDead: NPC "${npcName}" not found near (${this.player.x},${this.player.z})`);
        }

        this.log('ACTION', `attackNpcUntilDead: ${npcName} at (${npc.x},${npc.z})`);

        // Initial attack (op2 = Attack)
        try {
            await this.interactNpc(npc, 2);
        } catch {
            this.log('STATE', `Failed to initiate attack on ${npcName}, it may be attacking us already`);
        }

        // IMPORTANT: Do NOT re-engage after the initial interactNpc.
        // The engine's player_melee_attack script ends with p_opnpc(2) which
        // self-sustains the combat loop. Re-engaging (calling interactNpc again)
        // triggers p_stopaction which cancels the pending p_opnpc(2), resetting
        // the combat cycle and preventing attacks from landing.

        const NPC_HITPOINTS_STAT = 3;

        for (let tick = 0; tick < maxTicks; tick++) {
            await this.waitForTick();

            this.dismissModals();

            // Check if bot died
            if (this.isDead()) {
                throw new Error(`attackNpcUntilDead: bot died fighting ${npcName}`);
            }

            // Check if NPC died
            if (!npc.isActive) {
                this.log('EVENT', `${npcName} defeated (became inactive)`);
                return;
            }

            // Check NPC HP
            const npcHP = npc.levels[NPC_HITPOINTS_STAT];
            if (npcHP !== undefined && npcHP <= 0) {
                // Wait a few ticks for the death animation
                await this.waitForTicks(3);
                this.log('EVENT', `${npcName} defeated (HP reached 0)`);
                return;
            }

            // Eat food if HP is low
            if (options?.eatAt !== undefined) {
                const health = this.getHealth();
                const hpPercent = (health.current / health.max) * 100;
                if (hpPercent < options.eatAt) {
                    const foodName = options.eatItemName;
                    if (foodName) {
                        const food = this.findItem(foodName);
                        if (food) {
                            this.log('ACTION', `Eating ${foodName} (HP=${health.current}/${health.max})`);
                            await this.useItemOp1(foodName);
                            await this.waitForTicks(2);
                        }
                    }
                }
            }

            // Log progress periodically
            if (tick > 0 && tick % 50 === 0) {
                const hp = this.getHealth();
                this.log('STATE', `attackNpcUntilDead: tick ${tick}: bot HP=${hp.current}/${hp.max}`);
            }

        }

        throw new Error(`attackNpcUntilDead: ${npcName} did not die after ${maxTicks} ticks`);
    }

    /**
     * Attack an NPC with NPC collision temporarily cleared.
     *
     * For size-2 NPCs (cows, giant rats) grouped together, NPC collision can
     * completely block the engine's pathfinder from routing the player to the
     * target. This method clears NPC collision before initiating the interaction
     * and keeps it cleared during the walk phase so the engine can path through
     * other NPCs. Once combat starts (verified by XP gain), collision is restored.
     *
     * Returns the NPC's last position before death, or null if combat failed.
     */
    async attackNpcClearingCollision(npc: Npc, maxTicks: number = 200): Promise<{ x: number; z: number } | null> {
        const npcType = NpcType.get(npc.type);
        this.log('ACTION', `attackNpcClearingCollision: ${npcType.name} at (${npc.x},${npc.z})`);

        const level = this.player.level;

        // Clear NPC collision in nearby zones
        const clearNearbyNpcCollision = (): { npc: Npc; x: number; z: number; width: number }[] => {
            const cleared: { npc: Npc; x: number; z: number; width: number }[] = [];
            const zoneX = this.player.x >> 3;
            const zoneZ = this.player.z >> 3;
            for (let dx = -3; dx <= 3; dx++) {
                for (let dz = -3; dz <= 3; dz++) {
                    const zone = World.gameMap.getZone((zoneX + dx) << 3, (zoneZ + dz) << 3, level);
                    for (const n of zone.getAllNpcsSafe()) {
                        if (n.isActive) {
                            changeNpcCollision(n.width, n.x, n.z, n.level, false);
                            cleared.push({ npc: n, x: n.x, z: n.z, width: n.width });
                        }
                    }
                }
            }
            return cleared;
        };

        const restoreNpcCollision = (cleared: { npc: Npc; x: number; z: number; width: number }[]) => {
            for (const { npc: n, x: nx, z: nz, width } of cleared) {
                if (n.isActive && n.x === nx && n.z === nz) {
                    changeNpcCollision(width, nx, nz, level, true);
                }
            }
        };

        // Clear collision before dispatching the interaction
        let cleared = clearNearbyNpcCollision();

        // Dispatch the interaction with collision cleared so the engine's
        // pathfinder can route through other NPCs
        const trigger: ServerTriggerType = ServerTriggerType.APNPC1 + (2 - 1); // op2 = Attack
        const success = this.player.setInteraction(Interaction.SCRIPT, npc, trigger);
        if (!success) {
            restoreNpcCollision(cleared);
            this.log('STATE', `setInteraction failed for ${npcType.name}`);
            return null;
        }

        // Keep collision cleared during walk phase (engine pathfinds each tick).
        // Restore and re-clear each tick to handle NPC movement.
        const startExp = this.getSkill('Attack').exp + this.getSkill('Strength').exp + this.getSkill('Defence').exp;
        let combatStarted = false;
        let lastX = npc.x;
        let lastZ = npc.z;

        for (let tick = 0; tick < maxTicks; tick++) {
            await this.waitForTick();

            // Restore old NPC positions, re-clear at new positions
            restoreNpcCollision(cleared);
            cleared = clearNearbyNpcCollision();

            if (npc.isActive) {
                lastX = npc.x;
                lastZ = npc.z;
            }

            if (!npc.isActive) {
                restoreNpcCollision(cleared);
                this.log('EVENT', `${npcType.name} died at (${lastX},${lastZ}) after ~${tick} ticks`);
                await this.waitForTicks(2);
                return { x: lastX, z: lastZ };
            }

            // Check for combat start via XP gain
            if (!combatStarted) {
                const currentExp = this.getSkill('Attack').exp + this.getSkill('Strength').exp + this.getSkill('Defence').exp;
                if (currentExp > startExp) {
                    combatStarted = true;
                    // Restore collision now that combat is engaged
                    restoreNpcCollision(cleared);
                    this.log('STATE', `Combat started with ${npcType.name} at tick ${tick}`);
                    // Continue the loop without collision clearing
                    break;
                }
                if (tick >= 20) {
                    restoreNpcCollision(cleared);
                    this.log('STATE', `No combat XP after ${tick} ticks with ${npcType.name}, bailing`);
                    return null;
                }
            }
        }

        if (!combatStarted) {
            return null;
        }

        // Combat is engaged, NPC collision restored. Wait for death.
        // Do NOT re-engage — p_opnpc(2) self-sustains the loop.
        for (let tick = 0; tick < maxTicks; tick++) {
            await this.waitForTick();

            if (npc.isActive) {
                lastX = npc.x;
                lastZ = npc.z;
            }

            if (!npc.isActive) {
                this.log('EVENT', `${npcType.name} died at (${lastX},${lastZ})`);
                await this.waitForTicks(2);
                return { x: lastX, z: lastZ };
            }

            if (this.isDead()) {
                this.log('STATE', `Bot died fighting ${npcType.name}`);
                return null;
            }
        }

        this.log('STATE', `Combat timed out after ${maxTicks} ticks with ${npcType.name}`);
        return null;
    }

    /**
     * Earn coins by pickpocketing NPCs (default: Man in Lumbridge).
     * Loops: find NPC -> waitForActionReady -> pickpocket (op3) -> wait -> repeat
     * until the target GP is reached.
     *
     * @param targetGp Target coin count to reach
     * @param npcName NPC to pickpocket (default: 'Man')
     * @param area Coordinates to search near (default: Lumbridge spawn 3222,3218)
     */
    async earnCoinsViaPickpocket(targetGp: number, npcName: string = 'Man', area?: { x: number; z: number }): Promise<void> {
        const areaX = area?.x ?? 3222;
        const areaZ = area?.z ?? 3218;

        this.log('STATE', `earnCoinsViaPickpocket: target=${targetGp}gp, npc=${npcName}, area=(${areaX},${areaZ})`);

        let attempts = 0;
        const MAX_ATTEMPTS = 600;

        while (attempts < MAX_ATTEMPTS) {
            const coins = this.findItem('Coins');
            const currentGp = coins ? coins.count : 0;
            if (currentGp >= targetGp) {
                this.log('EVENT', `Earned ${currentGp}gp (target: ${targetGp}gp) in ${attempts} pickpocket attempts`);
                return;
            }

            this.dismissModals();

            // Wait for stun/delay to expire
            await this.waitForActionReady();

            let npc = this.findNearbyNpc(npcName);
            if (!npc) {
                this.log('STATE', `No ${npcName} found nearby, walking to area (${areaX},${areaZ})`);
                await this.walkToWithPathfinding(areaX, areaZ);
                await this.waitForTicks(2);
                npc = this.findNearbyNpc(npcName);
                if (!npc) {
                    throw new Error(`No ${npcName} NPC found near (${areaX},${areaZ})`);
                }
            }

            attempts++;
            await this.interactNpc(npc, 3); // op3 = Pickpocket
            await this.waitForTicks(5);
            await this.waitForTicks(1);
            this.dismissModals();
        }

        const finalCoins = this.findItem('Coins');
        throw new Error(`earnCoinsViaPickpocket: failed to earn ${targetGp}gp after ${MAX_ATTEMPTS} attempts. Current gp: ${finalCoins ? finalCoins.count : 0}`);
    }

    // --- Snapshot restoration (test mode only) ---

    /**
     * Restore the bot to a previously captured snapshot state.
     * Teleports to the snapshot position, sets skills, varps, and inventory.
     * Used for single-state testing from snapshots — NOT during E2E runs.
     */
    restoreFromSnapshot(snapshot: StateSnapshot): void {
        const player = this.player;

        // Teleport to snapshot position
        player.teleport(snapshot.position.x, snapshot.position.z, snapshot.position.level);
        this.log('STATE', `restoreFromSnapshot: teleported to (${snapshot.position.x},${snapshot.position.z},${snapshot.position.level})`);

        // Restore skills (base levels + current levels)
        for (const [name, baseLevel] of Object.entries(snapshot.skills)) {
            const statId = PlayerStatMap.get(name);
            if (statId === undefined) {
                throw new Error(`restoreFromSnapshot: unknown skill "${name}"`);
            }
            player.baseLevels[statId] = baseLevel;
            player.levels[statId] = baseLevel;
        }

        // Restore varps
        for (const [idStr, value] of Object.entries(snapshot.varps)) {
            const id = parseInt(idStr, 10);
            player.vars[id] = value;
        }

        // Restore inventory — clear first, then add items using stored IDs
        player.invClear(InvType.INV);
        for (const item of snapshot.items) {
            player.invAdd(InvType.INV, item.id, item.count);
        }
        this.log('STATE', `restoreFromSnapshot: restored ${snapshot.items.length} items, ${Object.keys(snapshot.skills).length} skills, ${Object.keys(snapshot.varps).length} varps`);
    }

}
