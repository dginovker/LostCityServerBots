import World from '#/engine/World.js';

import { NetworkPlayer } from '#/engine/entity/NetworkPlayer.js';
import Player from '#/engine/entity/Player.js';

import InputTrackingBlob from '#/engine/entity/tracking/InputTrackingBlob.js';

import Packet from '#/io/Packet.js';

import EventAppletFocus from '#/network/game/client/model/EventAppletFocus.js';
import EventCameraPosition from '#/network/game/client/model/EventCameraPosition.js';
import EventMouseClick from '#/network/game/client/model/EventMouseClick.js';
import EventMouseMove from '#/network/game/client/model/EventMouseMove.js';

enum InputTrackingEvent {
    CAMERA_POSITION = 1,
    APPLET_FOCUS = 2,
    MOUSE_CLICK = 3,
    MOUSE_MOVE = 4
}

export default class InputTracking {
    private readonly player: Player;
    private max: number = 500;

    active: boolean = false;
    buf: Packet = Packet.alloc(1);
    seq: number = 0;

    constructor(player: Player) {
        this.player = player;
    }

    onCycle(): void {
        if (this.buf.pos >= this.max) {
            this.flush();
        }
    }

    flush(): void {
        if (!this.active) {
            return;
        }

        if (this.buf.pos > 0) {
            const uuid = this.player instanceof NetworkPlayer ? this.player.client.uuid : 'headless';
            const blob = new InputTrackingBlob(this.buf.data.subarray(0, this.buf.pos), this.seq++, this.player.coord);
            World.submitInputTracking(this.player.username, uuid, [blob]);
        }

        this.buf.pos = 0;
    }

    cameraPosition(event: EventCameraPosition) {
        if (!this.active) {
            return;
        }

        if (this.buf.pos + 5 > this.max) {
            this.flush();
        }

        this.buf.p1(InputTrackingEvent.CAMERA_POSITION);
        this.buf.p2(event.pitch);
        this.buf.p2(event.yaw);
    }

    appletFocus(event: EventAppletFocus) {
        if (!this.active) {
            return;
        }

        if (this.buf.pos + 3 > this.max) {
            this.flush();
        }

        this.buf.p1(InputTrackingEvent.APPLET_FOCUS);
        this.buf.p1(event.focus);
    }

    mouseClick(event: EventMouseClick) {
        if (!this.active) {
            return;
        }

        if (this.buf.pos + 5 > this.max) {
            this.flush();
        }

        this.buf.p1(InputTrackingEvent.MOUSE_CLICK);
        this.buf.p4(event.info);
    }

    mouseMove(event: EventMouseMove) {
        if (!this.active || event.data.length === 0 || event.data.length > 160) {
            return;
        }

        if (this.buf.pos + event.data.length > this.max) {
            this.flush();
        }

        this.buf.p1(InputTrackingEvent.MOUSE_MOVE);
        this.buf.p1(event.data.length);
        this.buf.pdata(event.data, 0, event.data.length);
    }
}
