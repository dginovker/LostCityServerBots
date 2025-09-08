import { ServerGameProtPriority } from '#/network/game/server/ServerGameProtPriority.js';

export default abstract class ServerGameMessage {
    abstract readonly priority: ServerGameProtPriority;
}
