import World from '../../src/engine/World.js';
import { getExpByLevel } from '../../src/engine/entity/Player.js';
import { BotPlayer } from '../integration/bot-player.js';
import { BotController } from './controller.js';
import { BotLogger } from './logger.js';
import { BotAPI } from './api.js';

export type BotScriptFn = (bot: BotAPI) => Promise<void>;

interface ActiveBot {
    player: BotPlayer;
    controller: BotController;
    logger: BotLogger;
    api: BotAPI;
}

class BotManager {
    private readonly activeBots: Map<string, ActiveBot> = new Map();

    spawnBot(username: string, scriptFn: BotScriptFn): BotAPI {
        if (this.activeBots.has(username)) {
            throw new Error(`Bot "${username}" is already active`);
        }

        const player = new BotPlayer(username);

        // Initialize stats like a new player (matching PlayerLoading for empty save)
        for (let i = 0; i < 21; i++) {
            player.stats[i] = 0;
            player.baseLevels[i] = 1;
            player.levels[i] = 1;
        }
        // Hitpoints starts at level 10
        player.stats[3] = getExpByLevel(10); // PlayerStat.HITPOINTS = 3
        player.baseLevels[3] = 10;
        player.levels[3] = 10;

        player.lastConnected = World.currentTick;
        player.lastResponse = World.currentTick;

        // Set tutorial complete BEFORE login so the login trigger doesn't open
        // the tutorial interface (which would make the player busy/inaccessible).
        player.vars[281] = 1000; // tutorial varp = tutorial_complete

        const controller = new BotController(player);
        const logger = new BotLogger(username);
        const api = new BotAPI(player, controller, logger);

        this.activeBots.set(username, { player, controller, logger, api });

        // Register controller with World for per-tick processing
        World.botControllers.add(controller);

        // Add player to world login queue
        World.newPlayers.add(player);

        // Start the bot script asynchronously
        scriptFn(api).catch((err) => {
            logger.log('ERROR', `Script error: ${err.message}`);
        });

        return api;
    }

    stopBot(username: string): void {
        const bot = this.activeBots.get(username);
        if (!bot) {
            throw new Error(`Bot "${username}" is not active`);
        }

        World.botControllers.delete(bot.controller);
        World.removePlayer(bot.player);
        this.activeBots.delete(username);
    }

    listBots(): string[] {
        return Array.from(this.activeBots.keys());
    }

    countBotsByPrefix(prefix: string): number {
        let count = 0;
        for (const name of this.activeBots.keys()) {
            if (name.startsWith(prefix + '-')) {
                count++;
            }
        }
        return count;
    }

    nextBotNumber(prefix: string): number {
        let max = 0;
        for (const name of this.activeBots.keys()) {
            if (name.startsWith(prefix + '-')) {
                const num = parseInt(name.slice(prefix.length + 1), 10);
                if (num > max) max = num;
            }
        }
        return max + 1;
    }

    getBot(username: string): BotAPI | null {
        return this.activeBots.get(username)?.api ?? null;
    }
}

export default new BotManager();
