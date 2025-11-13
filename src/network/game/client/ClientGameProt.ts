export default class ClientGameProt {
    static all: ClientGameProt[] = [];
    static byId: ClientGameProt[] = [];

    static readonly NO_TIMEOUT = new ClientGameProt(6, 239, 0); // NXT naming

    static readonly IDLE_TIMER = new ClientGameProt(30, 144, 0);
    static readonly EVENT_MOUSE_CLICK = new ClientGameProt(31, 234, 4);
    static readonly EVENT_MOUSE_MOVE = new ClientGameProt(32, 232, -1);
    static readonly EVENT_APPLET_FOCUS = new ClientGameProt(33, 8, 1);
    static readonly EVENT_TRACKING = new ClientGameProt(34, 142, -2);
    static readonly EVENT_CAMERA_POSITION = new ClientGameProt(35, 91, 4);

    static readonly ANTICHEAT_OPLOGIC1 = new ClientGameProt(60, 28, 4);
    static readonly ANTICHEAT_OPLOGIC2 = new ClientGameProt(61, 77, 2);
    static readonly ANTICHEAT_OPLOGIC3 = new ClientGameProt(62, 56, 4);
    static readonly ANTICHEAT_OPLOGIC4 = new ClientGameProt(63, 121, 1);
    static readonly ANTICHEAT_OPLOGIC5 = new ClientGameProt(64, 233, 1);
    static readonly ANTICHEAT_OPLOGIC6 = new ClientGameProt(65, 131, 2);
    static readonly ANTICHEAT_OPLOGIC7 = new ClientGameProt(66, 187, 4);
    static readonly ANTICHEAT_OPLOGIC8 = new ClientGameProt(67, 206, 1);
    static readonly ANTICHEAT_OPLOGIC9 = new ClientGameProt(68, 162, 3);

    static readonly ANTICHEAT_CYCLELOGIC1 = new ClientGameProt(70, 51, -1);
    static readonly ANTICHEAT_CYCLELOGIC2 = new ClientGameProt(71, 225, -1);
    static readonly ANTICHEAT_CYCLELOGIC3 = new ClientGameProt(72, 4, 1);
    static readonly ANTICHEAT_CYCLELOGIC4 = new ClientGameProt(73, 226, 1);
    static readonly ANTICHEAT_CYCLELOGIC5 = new ClientGameProt(74, 100, 0);
    static readonly ANTICHEAT_CYCLELOGIC6 = new ClientGameProt(75, 36, 1);
    static readonly ANTICHEAT_CYCLELOGIC7 = new ClientGameProt(76, 182, 0);

    static readonly OPOBJ1 = new ClientGameProt(80, 141, 6); // NXT naming
    static readonly OPOBJ2 = new ClientGameProt(81, 67, 6); // NXT naming
    static readonly OPOBJ3 = new ClientGameProt(82, 178, 6); // NXT naming
    static readonly OPOBJ4 = new ClientGameProt(83, 47, 6); // NXT naming
    static readonly OPOBJ5 = new ClientGameProt(84, 97, 6); // NXT naming
    static readonly OPOBJT = new ClientGameProt(88, 202, 8); // NXT naming
    static readonly OPOBJU = new ClientGameProt(89, 245, 12); // NXT naming

    static readonly OPNPC1 = new ClientGameProt(100, 143, 2); // NXT naming
    static readonly OPNPC2 = new ClientGameProt(101, 195, 2); // NXT naming
    static readonly OPNPC3 = new ClientGameProt(102, 69, 2); // NXT naming
    static readonly OPNPC4 = new ClientGameProt(103, 122, 2); // NXT naming
    static readonly OPNPC5 = new ClientGameProt(104, 118, 2); // NXT naming
    static readonly OPNPCT = new ClientGameProt(108, 231, 4); // NXT naming
    static readonly OPNPCU = new ClientGameProt(109, 119, 8); // NXT naming

    static readonly OPLOC1 = new ClientGameProt(120, 33, 6); // NXT naming
    static readonly OPLOC2 = new ClientGameProt(121, 213, 6); // NXT naming
    static readonly OPLOC3 = new ClientGameProt(122, 98, 6); // NXT naming
    static readonly OPLOC4 = new ClientGameProt(123, 87, 6); // NXT naming
    static readonly OPLOC5 = new ClientGameProt(124, 147, 6); // NXT naming
    static readonly OPLOCT = new ClientGameProt(128, 26, 8); // NXT naming
    static readonly OPLOCU = new ClientGameProt(129, 240, 12); // NXT naming

    static readonly OPPLAYER1 = new ClientGameProt(140, 192, 2); // NXT naming
    static readonly OPPLAYER2 = new ClientGameProt(141, 17, 2); // NXT naming
    static readonly OPPLAYER3 = new ClientGameProt(142, 18, 2); // NXT naming
    static readonly OPPLAYER4 = new ClientGameProt(143, 72, 2); // NXT naming
    static readonly OPPLAYER5 = new ClientGameProt(144, 230, 2); // NXT naming
    static readonly OPPLAYERT = new ClientGameProt(148, 68, 4); // NXT naming
    static readonly OPPLAYERU = new ClientGameProt(149, 113, 8); // NXT naming

    static readonly OPHELD1 = new ClientGameProt(160, 243, 6); // name based on runescript trigger
    static readonly OPHELD2 = new ClientGameProt(161, 228, 6); // name based on runescript trigger
    static readonly OPHELD3 = new ClientGameProt(162, 80, 6); // name based on runescript trigger
    static readonly OPHELD4 = new ClientGameProt(163, 163, 6); // name based on runescript trigger
    static readonly OPHELD5 = new ClientGameProt(164, 74, 6); // name based on runescript trigger
    static readonly OPHELDT = new ClientGameProt(168, 102, 8); // name based on runescript trigger
    static readonly OPHELDU = new ClientGameProt(169, 200, 12); // name based on runescript trigger

    static readonly INV_BUTTON1 = new ClientGameProt(190, 181, 6); // NXT has "IF_BUTTON1" but for our interface system, this makes more sense
    static readonly INV_BUTTON2 = new ClientGameProt(191, 70, 6); // NXT has "IF_BUTTON2" but for our interface system, this makes more sense
    static readonly INV_BUTTON3 = new ClientGameProt(192, 59, 6); // NXT has "IF_BUTTON3" but for our interface system, this makes more sense
    static readonly INV_BUTTON4 = new ClientGameProt(193, 160, 6); // NXT has "IF_BUTTON4" but for our interface system, this makes more sense
    static readonly INV_BUTTON5 = new ClientGameProt(194, 62, 6); // NXT has "IF_BUTTON5" but for our interface system, this makes more sense

    static readonly IF_BUTTON = new ClientGameProt(200, 244, 2); // NXT naming
    static readonly RESUME_PAUSEBUTTON = new ClientGameProt(201, 146, 2); // NXT naming
    static readonly CLOSE_MODAL = new ClientGameProt(202, 58, 0); // NXT naming
    static readonly RESUME_P_COUNTDIALOG = new ClientGameProt(203, 161, 4); // NXT naming
    static readonly TUTORIAL_CLICKSIDE = new ClientGameProt(204, 201, 1);

    static readonly MAP_BUILD_COMPLETE = new ClientGameProt(241, 134, 0); // NXT naming
    static readonly MOVE_OPCLICK = new ClientGameProt(242, 127, -1); // comes with OP packets, name based on other MOVE packets
    static readonly REPORT_ABUSE = new ClientGameProt(243, 203, 10);
    static readonly MOVE_MINIMAPCLICK = new ClientGameProt(244, 220, -1); // NXT naming
    static readonly INV_BUTTOND = new ClientGameProt(245, 176, 7); // NXT has "IF_BUTTOND" but for our interface system, this makes more sense
    static readonly IGNORELIST_DEL = new ClientGameProt(246, 193, 8); // NXT naming
    static readonly IGNORELIST_ADD = new ClientGameProt(247, 189, 8); // NXT naming
    static readonly IF_PLAYERDESIGN = new ClientGameProt(248, 13, 13);
    static readonly CHAT_SETMODE = new ClientGameProt(249, 129, 3); // NXT naming
    static readonly MESSAGE_PRIVATE = new ClientGameProt(250, 214, -1); // NXT naming
    static readonly FRIENDLIST_DEL = new ClientGameProt(251, 84, 8); // NXT naming
    static readonly FRIENDLIST_ADD = new ClientGameProt(252, 9, 8); // NXT naming
    static readonly CLIENT_CHEAT = new ClientGameProt(253, 86, -1); // NXT naming
    static readonly MESSAGE_PUBLIC = new ClientGameProt(254, 83, -1); // NXT naming
    static readonly MOVE_GAMECLICK = new ClientGameProt(255, 6, -1); // NXT naming

    // in these old revisions we can actually get the packet index from a leftover array in the client source
    constructor(
        readonly index: number,
        readonly id: number,
        readonly length: number
    ) {
        ClientGameProt.all[index] = this;
        ClientGameProt.byId[id] = this;
    }
}
