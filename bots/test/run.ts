/**
 * Thin client for the persistent test server.
 * Reads NDJSON stream: heartbeat lines + final result line.
 *
 * Usage:
 *   bun engine/bots/test/run.ts sheepshearer [--timeout=60]
 */
import path from 'path';

const testName = process.argv[2];
if (!testName) {
    console.error('Usage: bun engine/bots/test/run.ts <test-name> [--timeout=<seconds>] [--state=<path>]');
    process.exit(1);
}

let timeoutParam = '';
let stateParam = '';
for (const arg of process.argv.slice(3)) {
    const m = arg.match(/^--timeout=(\d+)$/);
    if (m) timeoutParam = m[1];
    const s = arg.match(/^--state=(.+)$/);
    if (s) stateParam = s[1];
}

const PORT = 7123;
const clientBotsDir = path.resolve(import.meta.dir, '..');
const params = new URLSearchParams();
if (timeoutParam) params.set('timeout', timeoutParam);
if (stateParam) params.set('state', stateParam);
params.set('scriptDir', clientBotsDir);
const qs = params.toString();
const url = `http://localhost:${PORT}/${testName}${qs ? '?' + qs : ''}`;

try {
    const res = await fetch(url);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalResult: { status: string; duration: number; error?: string; varp?: number } | null = null;

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
                console.log(`[HEARTBEAT] tick=${parsed.tick} state="${parsed.state}" pos=(${parsed.pos}) hp=${parsed.hp} free=${parsed.freeSlots} inv=[${parsed.inv}]`);
            } else if (parsed.type === 'state') {
                console.log(`${parsed.message}`);
            } else if (parsed.type === 'result') {
                finalResult = parsed;
            }
        }
    }

    if (!finalResult) {
        console.error('Error: Server closed connection without sending result');
        process.exit(1);
    }

    console.log(`[RESULT] status=${finalResult.status} duration=${finalResult.duration}s${finalResult.varp !== undefined ? ` quest_varp=${finalResult.varp}` : ''}${finalResult.error ? ` error="${finalResult.error}"` : ''}`);

    if (finalResult.status !== 'PASS' && finalResult.botState) {
        console.log('\n[BOT STATE AT FAILURE]');
        console.log(JSON.stringify(finalResult.botState, null, 2));
    }

    process.exit(finalResult.status === 'PASS' ? 0 : 1);
} catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('ECONNREFUSED') || msg.includes('ConnectionRefused') || msg.includes('Unable to connect')) {
        console.error('Test server not running. Start it first:\n  bun engine/bots/test/server.ts');
    } else {
        console.error(`Error: ${msg}`);
    }
    process.exit(1);
}
