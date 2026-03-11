import Environment from '../../src/util/Environment.ts';
import BotManager from './manager.ts';
import { getScriptFn } from './registry.ts';
import { skipTutorial } from '../scripts/skip-tutorial.ts';
import { printInfo } from '../../src/util/Logger.ts';

export function autostartBots(): void {
    const config = Environment.BOT_AUTOSTART;
    if (!config) {
        return;
    }

    const entries = config.split(',');
    for (const entry of entries) {
        const trimmed = entry.trim();
        if (!trimmed) {
            continue;
        }

        const colonIndex = trimmed.lastIndexOf(':');
        if (colonIndex === -1) {
            throw new Error(`Invalid BOT_AUTOSTART entry "${trimmed}": missing :count (expected format name:count, e.g. sheepshearer:1)`);
        }

        const scriptName = trimmed.substring(0, colonIndex);
        const countStr = trimmed.substring(colonIndex + 1);
        const count = parseInt(countStr, 10);

        if (isNaN(count) || count < 1) {
            throw new Error(`Invalid BOT_AUTOSTART entry "${trimmed}": count must be a positive integer (got "${countStr}")`);
        }

        // This throws if the script name is not found in the registry
        const scriptFn = getScriptFn(scriptName);

        for (let i = 1; i <= count; i++) {
            const username = `${scriptName}-${i}`;
            BotManager.spawnBot(username, async (bot) => {
                await skipTutorial(bot);
                await scriptFn(bot);
            });
            printInfo(`Spawned bot: ${username}`);
        }
    }
}
