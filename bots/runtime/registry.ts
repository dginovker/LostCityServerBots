import type { BotScriptFn } from './manager.ts';

import { sheepShearer } from '../scripts/sheep-shearer.ts';
import { runeMysteries } from '../scripts/rune-mysteries.ts';
import { princeAliRescue } from '../scripts/prince-ali-rescue.ts';
import { impCatcher } from '../scripts/imp-catcher.ts';
import { romeoAndJuliet } from '../scripts/romeo-and-juliet.ts';
import { thievingMen } from '../scripts/thieving-men.ts';
import { mineAndSmelt } from '../scripts/mine-and-smelt.ts';
import { f2pSkills } from '../scripts/f2p-skills.ts';

const registry: Map<string, BotScriptFn> = new Map([
    ['sheepshearer', sheepShearer],
    ['rune-mysteries', runeMysteries],
    ['prince-ali-rescue', princeAliRescue],
    ['imp-catcher', impCatcher],
    ['romeo-and-juliet', romeoAndJuliet],
    ['thieving-men', thievingMen],
    ['mine-and-smelt', mineAndSmelt],
    ['f2p-skills', f2pSkills]
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
