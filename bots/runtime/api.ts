import CategoryType from '../../src/cache/config/CategoryType.ts';
import Component from '../../src/cache/config/Component.ts';
import InvType from '../../src/cache/config/InvType.ts';
import LocType from '../../src/cache/config/LocType.ts';
import NpcType from '../../src/cache/config/NpcType.ts';
import ObjType from '../../src/cache/config/ObjType.ts';
import World from '../../src/engine/World.ts';
import { Interaction } from '../../src/engine/entity/Interaction.ts';
import type Loc from '../../src/engine/entity/Loc.ts';
import type Npc from '../../src/engine/entity/Npc.ts';
import type Obj from '../../src/engine/entity/Obj.ts';
import { PlayerStatMap } from '../../src/engine/entity/PlayerStat.ts';
import ScriptProvider from '../../src/engine/script/ScriptProvider.ts';
import ScriptRunner from '../../src/engine/script/ScriptRunner.ts';
import ScriptState from '../../src/engine/script/ScriptState.ts';
import ServerTriggerType from '../../src/engine/script/ServerTriggerType.ts';
import { BotPlayer } from '../integration/bot-player.ts';
import { BotController } from './controller.ts';
import { BotLogger, type LogLevel } from './logger.ts';
import { findPathSegment, findPathToLocSegment } from './pathfinding.ts';
import { findPathToEntity } from '../../src/engine/GameMap.ts';

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
     * then closes any remaining modal.
     */
    dismissModals(): void {
        // Resume the paused script first so it can run to completion.
        // This matches what the client does when the player clicks the button.
        if (this.player.activeScript?.execution === ScriptState.PAUSEBUTTON) {
            this.player.executeScript(this.player.activeScript, true, true);
        }
        // If a modal is still open after the script finished, close it.
        if (this.player.containsModalInterface()) {
            this.player.closeModal();
        }
    }

    log(level: LogLevel, message: string): void {
        this.logger.log(level, message);
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
     * Walk to a destination using the engine's pathfinder.
     * For long distances, picks intermediate targets within pathfinder search range
     * (max ~34 tiles), pathfinds to each, walks, and repeats.
     */
    async walkToWithPathfinding(x: number, z: number): Promise<void> {
        this.log('ACTION', `walkToWithPathfinding: (${this.player.x},${this.player.z}) -> (${x},${z})`);

        // rsmod pathfinder search grid is ~72x72, so max ~34 tiles from source
        const MAX_SEGMENT_DIST = 30;
        const MAX_ITERATIONS = 30;

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
                throw new Error(`Pathfinding failed: no path from (${curX},${curZ}) to (${targetX},${targetZ}) on level ${level} (final destination: (${x},${z}))`);
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
     * the resumeButtons list to determine which option was selected.
     */
    async selectDialogOption(index: number): Promise<void> {
        if (!this.player.activeScript || this.player.activeScript.execution !== ScriptState.PAUSEBUTTON) {
            throw new Error('selectDialogOption: no active script paused on PAUSEBUTTON');
        }
        if (index < 1 || index > 5) {
            throw new Error(`selectDialogOption: index must be 1-5, got ${index}`);
        }

        // Find which component to click by checking resumeButtons.
        // resumeButtons are set by if_setresumebuttons in order: com_1, com_2, com_3, com_4, com_5.
        // We select the Nth valid (non -1) button.
        const validButtons = this.player.resumeButtons.filter(id => id !== -1);
        if (index > validButtons.length) {
            throw new Error(`selectDialogOption: index ${index} out of range, only ${validButtons.length} options available (resumeButtons: [${this.player.resumeButtons.join(',')}])`);
        }

        const comId = validButtons[index - 1]!;
        this.player.lastCom = comId;
        this.log('ACTION', `selectDialogOption: index=${index}, comId=${comId}`);

        // Resume the script — same as IfButtonHandler does when the button is in resumeButtons
        this.player.executeScript(this.player.activeScript, true, true);
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
}
