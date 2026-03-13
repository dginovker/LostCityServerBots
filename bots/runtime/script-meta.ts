import type { BotAPI } from './api.js';
import type { BotState, StateEntry } from './state-machine.js';

export type { StateEntry };

/**
 * Metadata exported by each bot script for auto-discovery.
 * The test server and runner use this to build registries dynamically
 * instead of hardcoding test definitions.
 */
export interface ScriptMeta {
    /** Test name used on CLI / HTTP endpoint, e.g. "sheepshearer" */
    name: string;
    /** Category of script */
    type: 'quest' | 'skill' | 'activity';
    /** Varp ID that tracks quest progress */
    varpId?: number;
    /** Varp value when the quest is complete */
    varpComplete?: number;
    /** Maximum ticks before the test is considered timed out */
    maxTicks: number;
    /** The main script function (called after skipTutorial by the test harness) */
    run: (bot: BotAPI) => Promise<void>;
    /** Optional state machine builder for --state= single-state testing */
    buildStates?: (bot: BotAPI) => BotState;
    /** Optional extra assertions run after the script completes */
    extraAssertions?: (api: BotAPI) => { name: string; pass: boolean }[];
}
