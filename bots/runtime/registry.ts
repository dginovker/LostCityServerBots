import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BotScriptFn } from './manager.js';

import { sheepShearer } from '../scripts/quests/sheep-shearer.js';
import { runeMysteries } from '../scripts/quests/rune-mysteries.js';
import { princeAliRescue } from '../scripts/quests/prince-ali-rescue.js';
import { impCatcher } from '../scripts/quests/imp-catcher.js';
import { romeoAndJuliet } from '../scripts/quests/romeo-and-juliet.js';
import { thievingMen } from '../scripts/skiller/thieving-men.js';
import { mineAndSmelt } from '../scripts/skiller/mine-and-smelt.js';
import { f2pSkills } from '../scripts/skiller/f2p-skills.js';
import { cooksAssistant } from '../scripts/quests/cooks-assistant.js';
import { doricsQuest } from '../scripts/quests/dorics-quest.js';
import { goblinDiplomacy } from '../scripts/quests/goblin-diplomacy.js';
import { restlessGhost } from '../scripts/quests/restless-ghost.js';
import { vampireSlayer } from '../scripts/quests/vampire-slayer.js';
import { ernestTheChicken } from '../scripts/quests/ernest-the-chicken.js';
import { piratesTreasure } from '../scripts/quests/pirates-treasure.js';
import { demonSlayer } from '../scripts/quests/demon-slayer.js';
import { druidicRitual } from '../scripts/quests/druidic-ritual.js';
import { blackKnightsFortress } from '../scripts/quests/black-knights-fortress.js';

const registry: Map<string, BotScriptFn> = new Map([
    ['sheepshearer', sheepShearer],
    ['rune-mysteries', runeMysteries],
    ['prince-ali-rescue', princeAliRescue],
    ['imp-catcher', impCatcher],
    ['romeo-and-juliet', romeoAndJuliet],
    ['thieving-men', thievingMen],
    ['mine-and-smelt', mineAndSmelt],
    ['f2p-skills', f2pSkills],
    ['cooks-assistant', cooksAssistant],
    ['dorics-quest', doricsQuest],
    ['goblin-diplomacy', goblinDiplomacy],
    ['restless-ghost', restlessGhost],
    ['vampire-slayer', vampireSlayer],
    ['ernest-the-chicken', ernestTheChicken],
    ['pirates-treasure', piratesTreasure],
    ['demon-slayer', demonSlayer],
    ['druidic-ritual', druidicRitual],
    ['black-knights-fortress', blackKnightsFortress]
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

// ---- Hot-reload infrastructure ----

const botsDir = path.resolve(import.meta.dir, '..');
const scriptsDir = path.resolve(botsDir, 'scripts');

/** MD5 hash of each source file at last reload. Used to detect changes. */
const fileHashes: Map<string, string> = new Map();

function hashFile(filePath: string): string {
    return crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex');
}

function collectTs(dir: string): string[] {
    const results: string[] = [];
    for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f);
        if (fs.statSync(full).isDirectory()) results.push(...collectTs(full));
        else if (f.endsWith('.ts')) results.push(full);
    }
    return results;
}

function copyTree(src: string, dst: string): void {
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(src)) {
        const s = path.join(src, f);
        const d = path.join(dst, f);
        if (fs.statSync(s).isDirectory()) copyTree(s, d);
        else fs.copyFileSync(s, d);
    }
}

// Build initial hashes so first reload only picks up actual changes
for (const file of collectTs(scriptsDir)) {
    fileHashes.set(file, hashFile(file));
}

// ---- PvP module cache ----

type RunHumanFightFn = (bot: any, targetUsername: string, strategy: string) => Promise<void>;
let cachedRunHumanFight: RunHumanFightFn | null = null;

/**
 * Get the cached runHumanFight function.
 * Lazy-loads on first call; updated by reloadRegistry() when pvp scripts change.
 */
export async function getRunHumanFight(): Promise<RunHumanFightFn> {
    if (!cachedRunHumanFight) {
        // Initial load — copy to temp dir so module cache is busted
        const engineDir = path.resolve(botsDir, '..');
        const hotDir = path.resolve(engineDir, '.hot_pvp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6));
        try {
            copyTree(path.join(botsDir, 'runtime'), hotDir + '/runtime');
            copyTree(path.join(botsDir, 'scripts'), hotDir + '/scripts');
            const mod = await import(hotDir + '/scripts/pvp/pvp-human-fight.ts');
            cachedRunHumanFight = mod.runHumanFight;
        } finally {
            try { fs.rmSync(hotDir, { recursive: true, force: true }); } catch { /* cleanup best-effort */ }
        }
    }
    return cachedRunHumanFight!;
}

/**
 * Hot-reload changed bot scripts from disk.
 * Only reimports files whose content hash changed since the last reload.
 * Returns the names of scripts that were updated (registry + pvp).
 */
export async function reloadRegistry(): Promise<string[]> {
    // Find which source files changed
    const changedFiles: string[] = [];
    for (const file of collectTs(scriptsDir)) {
        const hash = hashFile(file);
        if (fileHashes.get(file) !== hash) {
            changedFiles.push(file);
            fileHashes.set(file, hash);
        }
    }

    if (changedFiles.length === 0) return [];

    // Copy bots/ to temp dir so dynamic import busts module cache
    const engineDir = path.resolve(botsDir, '..');
    const hotDir = path.resolve(engineDir, '.hot_reload_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6));

    try {
        copyTree(path.join(botsDir, 'runtime'), hotDir + '/runtime');
        copyTree(path.join(botsDir, 'scripts'), hotDir + '/scripts');
        copyTree(path.join(botsDir, 'integration'), hotDir + '/integration');

        // Map source paths to hot-dir paths
        const hotScriptsDir = hotDir + '/scripts';
        const hotFiles = changedFiles.map(f => hotScriptsDir + f.slice(scriptsDir.length));

        const reloaded: string[] = [];
        for (const file of hotFiles) {
            try {
                const mod = await import(file);
                for (const key of Object.keys(mod)) {
                    const fn = mod[key];
                    if (typeof fn === 'function') {
                        const kebab = key.replace(/([A-Z])/g, (_, c: string) => '-' + c.toLowerCase()).replace(/^-/, '');
                        if (registry.has(kebab)) {
                            registry.set(kebab, fn);
                            reloaded.push(kebab);
                        }
                    }
                }
            } catch {
                // Skip files that fail to import
            }
        }

        // Also reload PvP module if any pvp/ files changed
        const pvpChanged = changedFiles.some(f => f.includes('/pvp/'));
        if (pvpChanged) {
            try {
                const pvpMod = await import(hotScriptsDir + '/pvp/pvp-human-fight.ts');
                cachedRunHumanFight = pvpMod.runHumanFight;
                reloaded.push('pvp-human-fight');
            } catch (e) {
                console.error('Failed to reload PvP module:', e);
            }
        }

        return reloaded;
    } finally {
        try { fs.rmSync(hotDir, { recursive: true, force: true }); } catch { /* cleanup best-effort */ }
    }
}
