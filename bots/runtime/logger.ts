import fs from 'fs';
import path from 'path';
import World from '../../src/engine/World.ts';

export type LogLevel = 'INFO' | 'ACTION' | 'STATE' | 'EVENT' | 'ERROR' | 'SUCCESS' | 'FAIL';

export class BotLogger {
    private readonly filePath: string;
    private readonly botName: string;

    constructor(botName: string) {
        this.botName = botName;
        const logDir = path.resolve(import.meta.dir, '..', 'logs');
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
        this.filePath = path.join(logDir, `${botName}.log`);
        // Clear any existing log for this bot
        fs.writeFileSync(this.filePath, '');
    }

    log(level: LogLevel, message: string): void {
        const tick = World.currentTick;
        const line = `[tick:${String(tick).padStart(4, '0')}] [${level}] ${message}\n`;
        fs.appendFileSync(this.filePath, line);
    }

    result(status: 'PASS' | 'FAIL', durationSeconds: number, assertionsPassed: number, assertionsTotal: number, failedDescription?: string): void {
        const failed = failedDescription ? ` failed="${failedDescription}"` : '';
        const line = `[RESULT] status=${status} duration=${durationSeconds}s assertions_passed=${assertionsPassed}/${assertionsTotal}${failed}\n`;
        fs.appendFileSync(this.filePath, line);
    }
}
