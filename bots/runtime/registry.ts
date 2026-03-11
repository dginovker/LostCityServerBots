import type { BotScriptFn } from './manager.js';

import { sheepShearer } from '../scripts/sheep-shearer.js';
import { runeMysteries } from '../scripts/rune-mysteries.js';
import { princeAliRescue } from '../scripts/prince-ali-rescue.js';
import { impCatcher } from '../scripts/imp-catcher.js';
import { romeoAndJuliet } from '../scripts/romeo-and-juliet.js';
import { thievingMen } from '../scripts/thieving-men.js';
import { mineAndSmelt } from '../scripts/mine-and-smelt.js';
import { f2pSkills } from '../scripts/f2p-skills.js';
import { cooksAssistant } from '../scripts/cooks-assistant.js';

const registry: Map<string, BotScriptFn> = new Map([
    ['sheepshearer', sheepShearer],
    ['rune-mysteries', runeMysteries],
    ['prince-ali-rescue', princeAliRescue],
    ['imp-catcher', impCatcher],
    ['romeo-and-juliet', romeoAndJuliet],
    ['thieving-men', thievingMen],
    ['mine-and-smelt', mineAndSmelt],
    ['f2p-skills', f2pSkills],
    ['cooks-assistant', cooksAssistant]
]);

export function getScriptFn(name: string): BotScriptFn {
    const fn = registry.get(name);
    if (!fn) {
        throw new Error(`Unknown bot script: "${name}". Available: ${listScriptNames().join(', ')}`);
    }
    return fn;
}

export function listScriptNames(): string[] {
    return Array.from(registry.keys());
}
