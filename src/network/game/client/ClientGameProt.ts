export default class ClientGameProt {
    static byId: ClientGameProt[] = [];

    static readonly NO_TIMEOUT = new ClientGameProt(120, 0); // NXT naming

    static readonly IDLE_TIMER = new ClientGameProt(209, 0);
    static readonly EVENT_MOUSE_CLICK = new ClientGameProt(20, 4);
    static readonly EVENT_MOUSE_MOVE = new ClientGameProt(222, -1);
    static readonly EVENT_APPLET_FOCUS = new ClientGameProt(73, 1);
    static readonly EVENT_CAMERA_POSITION = new ClientGameProt(53, 4);

    static readonly ANTICHEAT_OPLOGIC1 = new ClientGameProt(219, 4);
    static readonly ANTICHEAT_OPLOGIC2 = new ClientGameProt(201, 2);
    static readonly ANTICHEAT_OPLOGIC3 = new ClientGameProt(41, 4);
    static readonly ANTICHEAT_OPLOGIC4 = new ClientGameProt(80, 1);
    static readonly ANTICHEAT_OPLOGIC5 = new ClientGameProt(235, 1);
    static readonly ANTICHEAT_OPLOGIC6 = new ClientGameProt(250, 2);
    static readonly ANTICHEAT_OPLOGIC7 = new ClientGameProt(25, 4);
    static readonly ANTICHEAT_OPLOGIC8 = new ClientGameProt(0, 1);
    static readonly ANTICHEAT_OPLOGIC9 = new ClientGameProt(24, 3);

    static readonly ANTICHEAT_CYCLELOGIC1 = new ClientGameProt(12, -1);
    static readonly ANTICHEAT_CYCLELOGIC2 = new ClientGameProt(149, -1);
    static readonly ANTICHEAT_CYCLELOGIC3 = new ClientGameProt(52, 1);
    static readonly ANTICHEAT_CYCLELOGIC4 = new ClientGameProt(230, 1);
    static readonly ANTICHEAT_CYCLELOGIC5 = new ClientGameProt(100, 0);
    static readonly ANTICHEAT_CYCLELOGIC6 = new ClientGameProt(188, 1);
    static readonly ANTICHEAT_CYCLELOGIC7 = new ClientGameProt(89, 0);

    static readonly OPOBJ1 = new ClientGameProt(247, 6); // NXT naming
    static readonly OPOBJ2 = new ClientGameProt(169, 6); // NXT naming
    static readonly OPOBJ3 = new ClientGameProt(108, 6); // NXT naming
    static readonly OPOBJ4 = new ClientGameProt(62, 6); // NXT naming
    static readonly OPOBJ5 = new ClientGameProt(117, 6); // NXT naming
    static readonly OPOBJT = new ClientGameProt(91, 8); // NXT naming
    static readonly OPOBJU = new ClientGameProt(39, 12); // NXT naming

    static readonly OPNPC1 = new ClientGameProt(236, 2); // NXT naming
    static readonly OPNPC2 = new ClientGameProt(233, 2); // NXT naming
    static readonly OPNPC3 = new ClientGameProt(223, 2); // NXT naming
    static readonly OPNPC4 = new ClientGameProt(147, 2); // NXT naming
    static readonly OPNPC5 = new ClientGameProt(189, 2); // NXT naming
    static readonly OPNPCT = new ClientGameProt(181, 4); // NXT naming
    static readonly OPNPCU = new ClientGameProt(150, 8); // NXT naming

    static readonly OPLOC1 = new ClientGameProt(215, 6); // NXT naming
    static readonly OPLOC2 = new ClientGameProt(103, 6); // NXT naming
    static readonly OPLOC3 = new ClientGameProt(187, 6); // NXT naming
    static readonly OPLOC4 = new ClientGameProt(157, 6); // NXT naming
    static readonly OPLOC5 = new ClientGameProt(127, 6); // NXT naming
    static readonly OPLOCT = new ClientGameProt(213, 8); // NXT naming
    static readonly OPLOCU = new ClientGameProt(60, 12); // NXT naming

    static readonly OPPLAYER1 = new ClientGameProt(109, 2); // NXT naming
    static readonly OPPLAYER2 = new ClientGameProt(166, 2); // NXT naming
    static readonly OPPLAYER3 = new ClientGameProt(196, 2); // NXT naming
    static readonly OPPLAYER4 = new ClientGameProt(98, 2); // NXT naming
    static readonly OPPLAYER5 = new ClientGameProt(174, 2); // NXT naming
    static readonly OPPLAYERT = new ClientGameProt(240, 4); // NXT naming
    static readonly OPPLAYERU = new ClientGameProt(36, 8); // NXT naming

    static readonly OPHELD1 = new ClientGameProt(185, 6); // name based on runescript trigger
    static readonly OPHELD2 = new ClientGameProt(2, 6); // name based on runescript trigger
    static readonly OPHELD3 = new ClientGameProt(123, 6); // name based on runescript trigger
    static readonly OPHELD4 = new ClientGameProt(216, 6); // name based on runescript trigger
    static readonly OPHELD5 = new ClientGameProt(42, 6); // name based on runescript trigger
    static readonly OPHELDT = new ClientGameProt(135, 8); // name based on runescript trigger
    static readonly OPHELDU = new ClientGameProt(136, 12); // name based on runescript trigger

    static readonly INV_BUTTON1 = new ClientGameProt(74, 6); // NXT has "IF_BUTTON1" but for our interface system, this makes more sense
    static readonly INV_BUTTON2 = new ClientGameProt(82, 6); // NXT has "IF_BUTTON2" but for our interface system, this makes more sense
    static readonly INV_BUTTON3 = new ClientGameProt(239, 6); // NXT has "IF_BUTTON3" but for our interface system, this makes more sense
    static readonly INV_BUTTON4 = new ClientGameProt(179, 6); // NXT has "IF_BUTTON4" but for our interface system, this makes more sense
    static readonly INV_BUTTON5 = new ClientGameProt(46, 6); // NXT has "IF_BUTTON5" but for our interface system, this makes more sense

    static readonly IF_BUTTON = new ClientGameProt(9, 2); // NXT naming
    static readonly RESUME_PAUSEBUTTON = new ClientGameProt(72, 2); // NXT naming
    static readonly CLOSE_MODAL = new ClientGameProt(51, 0); // NXT naming
    static readonly RESUME_P_COUNTDIALOG = new ClientGameProt(102, 4); // NXT naming
    static readonly TUT_CLICKSIDE = new ClientGameProt(94, 1);

    static readonly MAP_BUILD_COMPLETE = new ClientGameProt(214, 0); // NXT naming
    static readonly MOVE_OPCLICK = new ClientGameProt(138, -1); // comes with OP packets, name based on other MOVE packets
    static readonly REPORT_ABUSE = new ClientGameProt(137, 10); // todo: rename to SEND_SNAPSHOT
    static readonly MOVE_MINIMAPCLICK = new ClientGameProt(86, -1); // NXT naming
    static readonly INV_BUTTOND = new ClientGameProt(93, 7); // NXT has "IF_BUTTOND" but for our interface system, this makes more sense
    static readonly IGNORELIST_DEL = new ClientGameProt(101, 8); // NXT naming
    static readonly IGNORELIST_ADD = new ClientGameProt(255, 8); // NXT naming
    static readonly IDK_SAVEDESIGN = new ClientGameProt(125, 13);
    static readonly CHAT_SETMODE = new ClientGameProt(154, 3); // NXT naming
    static readonly MESSAGE_PRIVATE = new ClientGameProt(139, -1); // NXT naming
    static readonly FRIENDLIST_DEL = new ClientGameProt(106, 8); // NXT naming
    static readonly FRIENDLIST_ADD = new ClientGameProt(13, 8); // NXT naming
    static readonly CLIENT_CHEAT = new ClientGameProt(224, -1); // NXT naming
    static readonly MESSAGE_PUBLIC = new ClientGameProt(253, -1); // NXT naming
    static readonly MOVE_GAMECLICK = new ClientGameProt(207, -1); // NXT naming

    constructor(
        readonly id: number,
        readonly length: number
    ) {
        ClientGameProt.byId[id] = this;
    }
}
