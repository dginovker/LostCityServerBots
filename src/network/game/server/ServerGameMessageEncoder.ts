import Packet from '#/io/Packet.js';
import ServerProtBase from '#/network/game/server/ServerProtBase.js';
import ServerGameMessage from '#/network/game/server/ServerGameMessage.js';

export default abstract class ServerGameMessageEncoder<T extends ServerGameMessage> {
    abstract prot: ServerProtBase;

    abstract encode(buf: Packet, message: T): void;

    test(_: T): number {
        return this.prot.length;
    }
}
