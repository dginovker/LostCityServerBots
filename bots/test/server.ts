/**
 * Persistent test server — loads the world once, runs tests on demand via HTTP.
 * Uses a single continuous tick loop so multiple tests can run concurrently.
 *
 * Usage:
 *   bun engine/bots/test/server.ts          # start server (takes ~20s to load world)
 *   bun engine/bots/test/run.ts sheepshearer # run a test (~2s)
 */
import fs from 'fs';
import path from 'path';
import type { ScriptMeta } from '../runtime/script-meta.ts';

// Skip worker threads — bots don't need login/friend/logger
process.env.BOT_TEST_MODE = 'true';

// Change cwd to engine/ so engine-relative paths resolve
const engineDir = path.resolve(import.meta.dir, '..', '..');
process.chdir(engineDir);

const { default: World } = await import('../../src/engine/World.ts');
const { default: BotManager } = await import('../runtime/manager.ts');

console.log('Loading world...');
const loadStart = Date.now();
await World.start(false, false);
console.log(`World loaded in ${((Date.now() - loadStart) / 1000).toFixed(1)}s`);

// --- Nice the process to avoid CPU starvation while tick loop runs ---
try {
    Bun.spawn(['renice', '-n', '10', '-p', process.pid.toString()]);
} catch {
    // renice may not be available on all systems — non-fatal
    console.log('[WARN] Could not renice process');
}

// --- Auto-discover scripts with metadata exports ---
const scriptsDir = path.resolve(import.meta.dir, '..', 'scripts');
const scriptFiles = fs.readdirSync(scriptsDir).filter(f => f.endsWith('.ts'));

const scriptRegistry: Record<string, ScriptMeta> = {};

for (const file of scriptFiles) {
    const modulePath = path.join(scriptsDir, file);
    const mod = await import(modulePath);
    // Register all exported ScriptMeta objects (supports multiple tests per file)
    for (const key of Object.keys(mod)) {
        const val = mod[key];
        if (val && typeof val === 'object' && typeof val.name === 'string' && typeof val.run === 'function' && typeof val.maxTicks === 'number') {
            scriptRegistry[val.name] = val as ScriptMeta;
        }
    }
}

console.log(`Auto-discovered ${Object.keys(scriptRegistry).length} scripts: ${Object.keys(scriptRegistry).join(', ')}`);

// --- Per-bot tracking for timeout and heartbeat ---
type StreamWriter = (line: string) => void;

interface ActiveTest {
    testName: string;
    botName: string;
    startTick: number;
    startTime: number;
    maxTicks: number;
    api: ReturnType<typeof BotManager.spawnBot>;
    scriptDone: boolean;
    scriptDoneTick: number;
    scriptError: Error | null;
    lastHeartbeatTick: number;
    resolve: (result: TestResult) => void;
    streamWriter: StreamWriter | null;
}

interface TestResult {
    status: string;
    duration: number;
    error?: string;
    varp?: number;
    botState?: Record<string, unknown>;
}

const activeTests = new Map<string, ActiveTest>();
const CLEANUP_TICKS = 5; // extra ticks after script completion for world cleanup

// --- Prevent World.cycle() from self-scheduling ---
// World.cycle() ends with: setTimeout(this.cycle.bind(this), delay)
// We suppress this by temporarily replacing global setTimeout during cycle().
const origCycle = World.cycle.bind(World);

World.cycle = function(this: typeof World) {
    const saved = globalThis.setTimeout;
    globalThis.setTimeout = ((_fn: any, _delay: any, ..._args: any[]) => {
        return 0 as any;
    }) as any;
    try {
        origCycle();
    } finally {
        globalThis.setTimeout = saved;
    }
};

// --- Inventory summary for heartbeats ---
function summarizeInventory(api: ReturnType<typeof BotManager.spawnBot>): string {
    const items = api.getInventory();
    const counts = new Map<string, number>();
    for (const item of items) {
        counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
    }
    return [...counts.entries()].map(([name, count]) => count > 1 ? `${count}x${name}` : name).join(', ');
}

// --- Full bot state dump for failure diagnostics ---
const SKILL_NAMES = ['attack', 'defence', 'strength', 'hitpoints', 'ranged', 'prayer', 'magic',
    'cooking', 'woodcutting', 'fishing', 'firemaking', 'crafting', 'smithing', 'mining', 'runecraft'];

function dumpBotState(api: ReturnType<typeof BotManager.spawnBot>): Record<string, unknown> {
    const pos = api.getPosition();
    const inv = api.getInventory().map(i => ({ name: i.name, count: i.count, slot: i.slot }));
    const skills: Record<string, string> = {};
    for (const name of SKILL_NAMES) {
        const s = api.getSkill(name);
        if (s.baseLevel > 1 || s.exp > 0) {
            skills[name] = `${s.level}/${s.baseLevel} (${s.exp}xp)`;
        }
    }
    return { position: pos, inventory: inv, freeSlots: 28 - inv.length, skills, state: api.currentStatePath };
}

// --- Check active tests for completion/timeout/heartbeat ---
function checkActiveTests(): void {
    for (const [_botName, test] of activeTests) {
        const elapsed = World.currentTick - test.startTick;

        // Heartbeat logging + streaming (every 1000 ticks, deduplicated)
        if (elapsed > 0 && elapsed % 1000 === 0 && World.currentTick !== test.lastHeartbeatTick) {
            test.lastHeartbeatTick = World.currentTick;
            const pos = test.api.getPosition();
            const state = test.api.currentStatePath || '?';
            const inv = summarizeInventory(test.api);
            const hp = test.api.getSkill('hitpoints');
            const heartbeat = {
                type: 'heartbeat', test: test.testName, tick: elapsed,
                pos: `${pos.x},${pos.z}`, state, inv,
                hp: `${hp.level}/${hp.baseLevel}`,
                freeSlots: 28 - test.api.getInventory().length,
            };
            console.log(`[HEARTBEAT] ${test.testName} tick=${elapsed} state="${state}" pos=(${pos.x},${pos.z}) inv=[${inv}] free=${28 - test.api.getInventory().length}`);
            if (test.streamWriter) {
                test.streamWriter(JSON.stringify(heartbeat));
            }
        }

        // Script finished — wait for cleanup ticks, then resolve
        if (test.scriptDone) {
            if (test.scriptDoneTick === 0) {
                test.scriptDoneTick = World.currentTick;
            }
            if (World.currentTick - test.scriptDoneTick >= CLEANUP_TICKS) {
                resolveTest(test);
            }
            continue;
        }

        // Timeout check
        if (elapsed >= test.maxTicks) {
            test.scriptDone = true;
            resolveTest(test);
        }
    }
}

function resolveTest(test: ActiveTest): void {
    activeTests.delete(test.botName);

    const duration = Math.round((Date.now() - test.startTime) / 1000);
    const meta = scriptRegistry[test.testName]!;
    const elapsed = World.currentTick - test.startTick;

    // Clean up the bot
    try {
        BotManager.stopBot(test.botName);
    } catch {
        // best effort — bot may already be removed
    }

    let result: TestResult;

    if (meta.varpId !== undefined && meta.varpComplete !== undefined) {
        if (elapsed >= test.maxTicks && !test.scriptError) {
            const pos = test.api.getPosition();
            result = { status: 'FAIL', duration, error: `TIMEOUT at (${pos.x},${pos.z})`, varp: test.api.getQuestProgress(meta.varpId) };
        } else if (test.scriptError) {
            result = { status: 'FAIL', duration, error: test.scriptError.message, varp: test.api.getQuestProgress(meta.varpId) };
        } else {
            const questVarp = test.api.getQuestProgress(meta.varpId);
            if (questVarp !== meta.varpComplete) {
                result = { status: 'FAIL', duration, error: `Quest varp is ${questVarp}, expected ${meta.varpComplete}`, varp: questVarp };
            } else if (meta.extraAssertions) {
                const failedAssertion = meta.extraAssertions(test.api).find(a => !a.pass);
                if (failedAssertion) {
                    result = { status: 'FAIL', duration, error: `Assertion failed: ${failedAssertion.name}`, varp: questVarp };
                } else {
                    result = { status: 'PASS', duration, varp: questVarp };
                }
            } else {
                result = { status: 'PASS', duration, varp: questVarp };
            }
        }
    } else {
        // Non-quest scripts
        if (elapsed >= test.maxTicks && !test.scriptError) {
            const pos = test.api.getPosition();
            result = { status: 'FAIL', duration, error: `TIMEOUT at (${pos.x},${pos.z})` };
        } else if (test.scriptError) {
            result = { status: 'FAIL', duration, error: test.scriptError.message };
        } else {
            result = { status: 'PASS', duration };
        }
    }

    // Attach full bot state dump on failure for diagnostics
    if (result.status === 'FAIL') {
        try {
            result.botState = dumpBotState(test.api);
        } catch {
            // bot may already be cleaned up
        }
    }

    test.resolve(result);
}

// --- Continuous tick loop ---
// Runs World.cycle() as fast as possible when bots are active.
// Each cycle is followed by a microtask yield (await Promise.resolve()) so bot
// script continuations run between ticks. Every TICKS_PER_MACRO_YIELD ticks we
// do a full macrotask yield so HTTP handlers get a chance to run.
// Test completion checks run inline after each cycle — no setInterval needed.
const IDLE_SLEEP_MS = 100;
const TICKS_PER_MACRO_YIELD = 100;

async function tickLoop(): Promise<never> {
    World.nextTick = Date.now();
    let ticksSinceYield = 0;
    while (true) {
        if (activeTests.size > 0) {
            World.cycle();
            checkActiveTests();
            // Flush microtasks so bot script continuations run before next tick
            await Promise.resolve();
            ticksSinceYield++;
            if (ticksSinceYield >= TICKS_PER_MACRO_YIELD) {
                ticksSinceYield = 0;
                // Yield to macrotask queue for HTTP handlers
                await new Promise<void>(r => setImmediate(r));
            }
        } else {
            ticksSinceYield = 0;
            await new Promise<void>(r => setTimeout(r, IDLE_SLEEP_MS));
        }
    }
}

// --- Test runner ---
const PORT = 7123;
let testCounter = 0;

function runTest(testName: string, timeoutTicks?: number, streamWriter?: StreamWriter): Promise<TestResult> {
    const meta = scriptRegistry[testName];
    if (!meta) {
        const available = Object.keys(scriptRegistry).join(', ');
        return Promise.resolve({ status: 'FAIL', duration: 0, error: `Unknown test: ${testName}. Available: ${available}` });
    }

    const maxTicks = timeoutTicks ?? meta.maxTicks;
    const botName = `testbot_${testCounter++}`;

    return new Promise<TestResult>((resolve) => {
        const test: ActiveTest = {
            testName,
            botName,
            startTick: World.currentTick,
            startTime: Date.now(),
            maxTicks,
            api: null as any, // set after spawnBot
            scriptDone: false,
            scriptDoneTick: 0,
            scriptError: null,
            lastHeartbeatTick: 0,
            resolve,
            streamWriter: streamWriter ?? null,
        };

        const api = BotManager.spawnBot(botName, async (bot) => {
            try {
                // Stream state transitions to the client
                if (streamWriter) {
                    bot.onLog = (level, message) => {
                        if (level === 'STATE') {
                            streamWriter(JSON.stringify({ type: 'state', test: testName, message }));
                        }
                    };
                }
                await bot.waitForTick();
                await bot.waitForTick();
                await meta.run(bot);
                test.scriptDone = true;
            } catch (err) {
                test.scriptError = err as Error;
                test.scriptDone = true;
            }
        });

        test.api = api;
        activeTests.set(botName, test);
    });
}

// Start the tick loop (runs forever in the background)
tickLoop();

// HTTP server
const _server = Bun.serve({
    port: PORT,
    idleTimeout: 255, // seconds — max Bun allows
    async fetch(req) {
        const url = new URL(req.url);
        const testName = url.pathname.slice(1); // "/sheepshearer" -> "sheepshearer"

        if (!testName || testName === 'health') {
            return Response.json({ status: 'ok', tests: Object.keys(scriptRegistry) });
        }

        const timeoutParam = url.searchParams.get('timeout');
        const timeoutTicks = timeoutParam ? Math.ceil(parseInt(timeoutParam) * 1000 / 600) : undefined;

        console.log(`[TEST] Starting: ${testName}`);

        // Stream NDJSON: heartbeat lines followed by final result line
        const stream = new ReadableStream({
            start(controller) {
                const encoder = new TextEncoder();
                const writer = (line: string) => {
                    try { controller.enqueue(encoder.encode(line + '\n')); } catch { /* stream closed */ }
                };

                runTest(testName, timeoutTicks, writer).then(result => {
                    console.log(`[TEST] ${testName}: ${result.status} (${result.duration}s)${result.error ? ` - ${result.error}` : ''}`);
                    writer(JSON.stringify({ type: 'result', ...result }));
                    controller.close();
                });
            },
        });

        return new Response(stream, {
            headers: { 'Content-Type': 'application/x-ndjson', 'Transfer-Encoding': 'chunked' },
        });
    },
});

console.log(`\nTest server ready on http://localhost:${PORT}`);
console.log(`Available tests: ${Object.keys(scriptRegistry).join(', ')}`);
console.log('\nUsage: bun engine/bots/test/run.ts <testname> [--timeout=<seconds>]');
