import InvType from '../../src/cache/config/InvType.ts';
import LocType from '../../src/cache/config/LocType.ts';
import NpcType from '../../src/cache/config/NpcType.ts';
import ObjType from '../../src/cache/config/ObjType.ts';
import World from '../../src/engine/World.ts';
import { Interaction } from '../../src/engine/entity/Interaction.ts';
import type Loc from '../../src/engine/entity/Loc.ts';
import type Npc from '../../src/engine/entity/Npc.ts';
import { PlayerStatMap } from '../../src/engine/entity/PlayerStat.ts';
import ScriptState from '../../src/engine/script/ScriptState.ts';
import ServerTriggerType from '../../src/engine/script/ServerTriggerType.ts';
import { BotPlayer } from '../integration/bot-player.ts';
import { BotController } from './controller.ts';
import { BotLogger, type LogLevel } from './logger.ts';
import { findPathSegment, findPathToLocSegment } from './pathfinding.ts';

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
}
