/**
 * CLI client for the persistent test server.
 *
 * Usage:
 *   bun engine/bots/test/run.ts <test-name>                         # default: --all-states
 *   bun engine/bots/test/run.ts <test-name> --states s1 s2 ...      # run specific states in parallel
 *   bun engine/bots/test/run.ts <test-name> --all-states             # discover & run all states in parallel
 *   bun engine/bots/test/run.ts <test-name> --e2e                    # all-states first (fail-fast), then full sequential E2E
 */
import path from 'path';

const PORT = 7123;
const BASE_URL = `http://localhost:${PORT}`;
const clientBotsDir = path.resolve(import.meta.dir, '..');

// --- Argument parsing ---

const testName = process.argv[2];
if (!testName) {
    console.error('Usage: bun engine/bots/test/run.ts <test-name> [--states s1 s2 ...] [--all-states] [--e2e]');
    process.exit(1);
}

type Mode = 'all-states' | 'specific-states' | 'e2e';

let mode: Mode = 'all-states'; // default
const specificStates: string[] = [];

const args = process.argv.slice(3);
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--all-states') {
        mode = 'all-states';
    } else if (args[i] === '--e2e') {
        mode = 'e2e';
    } else if (args[i] === '--states') {
        mode = 'specific-states';
        // Collect all subsequent args until another flag or end
        i++;
        while (i < args.length && !args[i]!.startsWith('--')) {
            specificStates.push(args[i]!);
            i++;
        }
        i--; // back up so the outer loop's i++ doesn't skip the next flag
        if (specificStates.length === 0) {
            console.error('Error: --states requires at least one state name');
            process.exit(1);
        }
    } else {
        console.error(`Unknown argument: ${args[i]}`);
        process.exit(1);
    }
}

// --- HTTP helpers ---

interface TestResult {
    status: string;
    duration: number;
    error?: string;
    varp?: number;
    botState?: Record<string, unknown>;
}

interface DiscoverResponse {
    test: string;
    states: Array<{ path: string; source: string }>;
    error?: string;
}

/**
 * Discover all available states for a test from the server.
 */
async function discoverStates(test: string): Promise<DiscoverResponse> {
    const res = await fetch(`${BASE_URL}/discover/${test}`);
    const body = await res.json() as DiscoverResponse & { error?: string };
    if (!res.ok) {
        throw new Error(body.error ?? `Discover failed with status ${res.status}`);
    }
    return body;
}

/**
 * Run a single test (full E2E or single state) via the server.
 * Streams NDJSON and returns the final result.
 */
async function runSingleTest(test: string, statePath?: string): Promise<TestResult> {
    const params = new URLSearchParams();
    params.set('scriptDir', clientBotsDir);
    if (statePath) params.set('state', statePath);
    const qs = params.toString();
    const url = `${BASE_URL}/${test}${qs ? '?' + qs : ''}`;

    const label = statePath ?? test;

    const res = await fetch(url);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalResult: TestResult | null = null;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newlineIdx).trim();
            buffer = buffer.slice(newlineIdx + 1);
            if (!line) continue;

            const parsed = JSON.parse(line);
            if (parsed.type === 'heartbeat') {
                console.log(`[${label}] [HEARTBEAT] tick=${parsed.tick} state="${parsed.state}" pos=(${parsed.pos}) hp=${parsed.hp} free=${parsed.freeSlots} inv=[${parsed.inv}]`);
            } else if (parsed.type === 'state') {
                console.log(`[${label}] ${parsed.message}`);
            } else if (parsed.type === 'result') {
                finalResult = parsed as TestResult;
            }
        }
    }

    if (!finalResult) {
        throw new Error(`Server closed connection for "${label}" without sending result`);
    }

    return finalResult;
}

/**
 * Resolve state paths from short names.
 * Short names are the leaf portion of the path (e.g. "earn-coins" matches "sheep-shearer/earn-coins").
 * Full paths are also accepted (e.g. "sheep-shearer/deliver-wool").
 * Throws if any name doesn't match exactly one state.
 */
function resolveStateNames(
    shortNames: string[],
    availableStates: Array<{ path: string; source: string }>
): string[] {
    const resolved: string[] = [];
    for (const name of shortNames) {
        // Try exact match first
        const exact = availableStates.find(s => s.path === name);
        if (exact) {
            resolved.push(exact.path);
            continue;
        }
        // Try leaf match (last segment of path)
        const leafMatches = availableStates.filter(s => {
            const leaf = s.path.split('/').pop();
            return leaf === name;
        });
        if (leafMatches.length === 1) {
            resolved.push(leafMatches[0]!.path);
            continue;
        }
        if (leafMatches.length > 1) {
            throw new Error(
                `Ambiguous state name "${name}" matches multiple states: ${leafMatches.map(m => m.path).join(', ')}`
            );
        }
        // No match
        const available = availableStates.map(s => s.path).join(', ');
        throw new Error(`State "${name}" not found. Available states: ${available}`);
    }
    return resolved;
}

// --- Main execution ---

interface StateTestResult {
    path: string;
    result: TestResult;
}

/**
 * Run states in parallel. Returns array of results.
 */
async function runStatesParallel(test: string, statePaths: string[]): Promise<StateTestResult[]> {
    const promises = statePaths.map(async (statePath): Promise<StateTestResult> => {
        const result = await runSingleTest(test, statePath);
        return { path: statePath, result };
    });
    return Promise.all(promises);
}

/**
 * Print a summary table and return whether all passed.
 */
function printSummary(results: StateTestResult[]): boolean {
    console.log('\n' + '='.repeat(80));
    console.log('SUMMARY');
    console.log('='.repeat(80));

    let allPassed = true;
    for (const { path: statePath, result } of results) {
        const icon = result.status === 'PASS' ? 'PASS' : 'FAIL';
        const extra = result.error ? ` -- ${result.error}` : '';
        console.log(`  [${icon}] ${statePath} (${result.duration}s)${extra}`);
        if (result.status !== 'PASS') {
            allPassed = false;
            if (result.botState) {
                console.log(`         Bot state: ${JSON.stringify(result.botState)}`);
            }
        }
    }

    const passCount = results.filter(r => r.result.status === 'PASS').length;
    const failCount = results.length - passCount;
    console.log('='.repeat(80));
    console.log(`${passCount} passed, ${failCount} failed out of ${results.length} states`);
    console.log('='.repeat(80));

    return allPassed;
}

async function main(): Promise<void> {
    if (mode === 'specific-states') {
        // --states: discover available states, resolve short names, run in parallel
        const discovery = await discoverStates(testName);
        if (discovery.states.length === 0) {
            throw new Error(`No states with snapshots found for "${testName}". Run a full E2E first or add entrySnapshot to states.`);
        }

        const resolvedPaths = resolveStateNames(specificStates, discovery.states);
        console.log(`Running ${resolvedPaths.length} state(s) in parallel for "${testName}"...`);
        console.log(`  ${resolvedPaths.join(', ')}\n`);

        const results = await runStatesParallel(testName, resolvedPaths);
        const allPassed = printSummary(results);
        process.exit(allPassed ? 0 : 1);

    } else if (mode === 'all-states') {
        // --all-states (default): discover all states, run in parallel
        const discovery = await discoverStates(testName);
        if (discovery.states.length === 0) {
            throw new Error(`No states with snapshots found for "${testName}". Run a full E2E first or add entrySnapshot to states.`);
        }

        const statePaths = discovery.states.map(s => s.path);
        console.log(`Running all ${statePaths.length} state(s) in parallel for "${testName}"...`);
        console.log(`  ${statePaths.join(', ')}\n`);

        const results = await runStatesParallel(testName, statePaths);
        const allPassed = printSummary(results);
        process.exit(allPassed ? 0 : 1);

    } else if (mode === 'e2e') {
        // --e2e: run all-states first (fail-fast), then full sequential E2E
        const discovery = await discoverStates(testName);

        if (discovery.states.length > 0) {
            const statePaths = discovery.states.map(s => s.path);
            console.log(`[E2E] Phase 1: Running all ${statePaths.length} state(s) in parallel (fail-fast)...`);
            console.log(`  ${statePaths.join(', ')}\n`);

            const stateResults = await runStatesParallel(testName, statePaths);
            const statesPassed = printSummary(stateResults);

            if (!statesPassed) {
                console.log('\n[E2E] Phase 1 FAILED -- aborting before full E2E run.');
                process.exit(1);
            }

            console.log('\n[E2E] Phase 1 PASSED. Starting Phase 2: full sequential E2E...\n');
        } else {
            console.log('[E2E] No states with snapshots found — skipping Phase 1, running full E2E directly.\n');
        }

        // Phase 2: full sequential E2E (no --state=)
        const result = await runSingleTest(testName);
        console.log(`\n[RESULT] status=${result.status} duration=${result.duration}s${result.varp !== undefined ? ` quest_varp=${result.varp}` : ''}${result.error ? ` error="${result.error}"` : ''}`);

        if (result.status !== 'PASS' && result.botState) {
            console.log('\n[BOT STATE AT FAILURE]');
            console.log(JSON.stringify(result.botState, null, 2));
        }

        process.exit(result.status === 'PASS' ? 0 : 1);
    }
}

try {
    await main();
} catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('ECONNREFUSED') || msg.includes('ConnectionRefused') || msg.includes('Unable to connect')) {
        console.error('Test server not running. Start it first:\n  bun engine/bots/test/server.ts');
    } else {
        console.error(`Error: ${msg}`);
    }
    process.exit(1);
}
