import { ServerGameProtPriority } from '#/network/game/server/ServerGameProtPriority.js';
import ServerGameMessage from '#/network/game/server/ServerGameMessage.js';

export default class CamMoveTo extends ServerGameMessage {
    priority = ServerGameProtPriority.BUFFERED;

    constructor(
        readonly x: number,
        readonly z: number,
        readonly height: number,
        readonly rate: number,
        readonly rate2: number
    ) {
        super();
    }
}
