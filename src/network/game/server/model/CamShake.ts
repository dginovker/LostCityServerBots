import { ServerGameProtPriority } from '#/network/game/server/ServerGameProtPriority.js';
import ServerGameMessage from '#/network/game/server/ServerGameMessage.js';

export default class CamShake extends ServerGameMessage {
    priority = ServerGameProtPriority.BUFFERED;

    constructor(
        readonly axis: number,
        readonly random: number,
        readonly amplitude: number,
        readonly rate: number
    ) {
        super();
    }
}
