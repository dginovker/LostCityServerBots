import Player from '../../src/engine/entity/Player.ts';
import ServerGameMessage from '../../src/network/game/server/ServerGameMessage.ts';
import MessageGame from '../../src/network/game/server/model/MessageGame.ts';
import IfOpenChat from '../../src/network/game/server/model/IfOpenChat.ts';
import IfSetText from '../../src/network/game/server/model/IfSetText.ts';
import { toBase37 } from '../../src/util/JString.ts';

export interface CapturedMessage {
    type: string;
    text?: string;
    component?: number;
    raw: ServerGameMessage;
}

const MAX_CAPTURED_MESSAGES = 50;

export class BotPlayer extends Player {
    readonly capturedMessages: CapturedMessage[] = [];

    constructor(username: string) {
        const username37 = toBase37(username);
        // hash64 is the same as username37 for bots (matches PlayerLoading behavior)
        const hash64 = username37;
        super(username, username37, hash64);
    }

    override write(message: ServerGameMessage): void {
        // Capture dialog-relevant messages for bot scripts to inspect.
        // Uses a ring buffer capped at MAX_CAPTURED_MESSAGES entries.
        if (message instanceof MessageGame) {
            this.pushCaptured({
                type: 'MessageGame',
                text: message.msg,
                raw: message
            });
        } else if (message instanceof IfOpenChat) {
            this.pushCaptured({
                type: 'IfOpenChat',
                component: message.component,
                raw: message
            });
        } else if (message instanceof IfSetText) {
            this.pushCaptured({
                type: 'IfSetText',
                component: message.component,
                text: message.text,
                raw: message
            });
        }
        // All other messages are silently dropped (no client to send to)
    }

    private pushCaptured(msg: CapturedMessage): void {
        this.capturedMessages.push(msg);
        if (this.capturedMessages.length > MAX_CAPTURED_MESSAGES) {
            this.capturedMessages.shift();
        }
    }
}
