import World from '../../src/engine/World.js';
import { BotPlayer } from '../integration/bot-player.js';

export class BotController {
    readonly player: BotPlayer;
    private tickResolver: (() => void) | null = null;

    constructor(player: BotPlayer) {
        this.player = player;
    }

    /**
     * Called by World.processBotInput() each game tick.
     * Resolves the pending waitForTick promise so the bot script advances.
     */
    onTick(): void {
        // Keep the bot player alive — without a real client connection,
        // lastConnected/lastResponse would go stale and the engine would
        // idle-logout the player after TIMEOUT_NO_CONNECTION (50 ticks).
        this.player.lastConnected = World.currentTick;
        this.player.lastResponse = World.currentTick;

        // Suppress random events (swarm, tree spirit, etc.) for bots.
        // The engine sets afkEventReady every 500 ticks (~5 min) and the
        // general_macro_events timer spawns hostile NPCs that can kill the bot.
        // Bots can't handle random events, so prevent them from firing.
        this.player.afkEventReady = false;

        if (this.tickResolver) {
            const resolve = this.tickResolver;
            this.tickResolver = null;
            resolve();
        }
    }

    /**
     * Returns a promise that resolves on the next game tick.
     */
    waitForTick(): Promise<void> {
        return new Promise<void>((resolve) => {
            this.tickResolver = resolve;
        });
    }

    /**
     * Waits for the specified number of game ticks.
     */
    async waitForTicks(n: number): Promise<void> {
        for (let i = 0; i < n; i++) {
            await this.waitForTick();
        }
    }

    /**
     * Waits until predicate returns true, or throws after timeoutTicks.
     */
    async waitForCondition(predicate: () => boolean, timeoutTicks: number): Promise<void> {
        for (let i = 0; i < timeoutTicks; i++) {
            if (predicate()) {
                return;
            }
            await this.waitForTick();
        }
        throw new Error(`waitForCondition timed out after ${timeoutTicks} ticks`);
    }
}
