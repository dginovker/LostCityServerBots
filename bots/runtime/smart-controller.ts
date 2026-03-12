import { BotAPI } from './api.js';

/**
 * A single task in the bot's task list.
 */
export interface BotTask {
    /** Human-readable name for logging */
    name: string;
    /** Return true if this task is already complete (for resume support) */
    isComplete: () => boolean;
    /** Execute the task */
    run: () => Promise<void>;
    /** Max retries on failure (default 3) */
    maxRetries?: number;
}

/**
 * SmartController — a lightweight task runner with death recovery and auto-resume.
 *
 * Usage:
 *   const ctrl = new SmartController(bot);
 *   ctrl.addTask({ name: 'Train Mining', isComplete: () => bot.getSkill('Mining').baseLevel >= 10, run: trainMining });
 *   await ctrl.run();
 *
 * Features:
 * - Auto-skips tasks that are already complete (resume after crash/death)
 * - Detects death and recovers (respawn, re-enable run, retry task)
 * - Configurable retries per task
 * - Logs progress for each task
 */
export class SmartController {
    private readonly bot: BotAPI;
    private readonly tasks: BotTask[] = [];

    constructor(bot: BotAPI) {
        this.bot = bot;
    }

    addTask(task: BotTask): void {
        this.tasks.push(task);
    }

    /**
     * Run all tasks in order. Skips completed tasks. Retries on failure with death recovery.
     */
    async run(): Promise<void> {
        this.bot.log('STATE', `SmartController: ${this.tasks.length} tasks queued`);

        for (let i = 0; i < this.tasks.length; i++) {
            const task = this.tasks[i];

            if (task.isComplete()) {
                this.bot.log('STATE', `[${i + 1}/${this.tasks.length}] SKIP ${task.name} (already complete)`);
                continue;
            }

            const maxRetries = task.maxRetries ?? 3;

            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    this.bot.log('STATE', `[${i + 1}/${this.tasks.length}] START ${task.name} (attempt ${attempt}/${maxRetries})`);
                    await task.run();
                    this.bot.log('STATE', `[${i + 1}/${this.tasks.length}] DONE ${task.name}`);
                    break;
                } catch (err) {
                    const msg = (err as Error).message;
                    this.bot.log('ERROR', `${task.name} failed: ${msg}`);

                    // Death recovery
                    if (this.bot.isDead()) {
                        this.bot.log('STATE', `Death during ${task.name}, recovering...`);
                        await this.bot.waitForRespawn();
                    }

                    // Maybe the task completed despite the error (e.g., level-up triggered mid-action)
                    if (task.isComplete()) {
                        this.bot.log('STATE', `${task.name} completed despite error`);
                        break;
                    }

                    if (attempt === maxRetries) {
                        throw new Error(`${task.name} failed after ${maxRetries} attempts: ${msg}`);
                    }

                    this.bot.log('STATE', `Retrying ${task.name}...`);
                    // Small cooldown before retry
                    await this.bot.waitForTicks(5);
                }
            }
        }

        this.bot.log('STATE', 'SmartController: all tasks complete');
    }
}
