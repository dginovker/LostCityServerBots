import fs from 'fs';

import FileStream from '#/io/FileStream.js';
import Packet from '#/io/Packet.js';
import Environment from '#/util/Environment.js';
import { printWarning } from '#/util/Logger.js';
import { PackFile } from '#/util/PackFileBase.js';
import { listFilesExt } from '#/util/Parse.js';

export const BasePack = new PackFile('base');
export const FramePack = new PackFile('anim');

const cache = new FileStream('data/pack/original');

const existingBases = listFilesExt(`${Environment.BUILD_SRC_DIR}/models`, '.base');
const existingFrames = listFilesExt(`${Environment.BUILD_SRC_DIR}/models`, '.frame');

const baseOrder = [];
const frameOrder = [];

const baseCount = cache.count(2);
for (let baseId = 0; baseId < baseCount; baseId++) {
    const set = cache.read(2, baseId, true);
    if (!set) {
        printWarning(`Missing anim set ${baseId}`);
        continue;
    }

    baseOrder.push(baseId.toString());

    const offsets = new Packet(set);
    offsets.pos = set.length - 8;

    const head = new Packet(set);
    const tran1 = new Packet(set);
    const tran2 = new Packet(set);
    const del = new Packet(set);
    const base = new Packet(set);

    let offset = 0;
    head.pos = offset;
    offset += offsets.g2() + 2;

    tran1.pos = offset;
    offset += offsets.g2();

    tran2.pos = offset;
    offset += offsets.g2();

    del.pos = offset;
    offset += offsets.g2();

    base.pos = offset;

    const length = base.g1();

    const tstart = base.pos;
    for (let j = 0; j < length; j++) {
        base.g1();
    }
    const tend = base.pos;

    const labelstart = base.pos;
    for (let j = 0; j < length; j++) {
        const labelCount = base.g1();
        for (let k = 0; k < labelCount; k++) {
            base.g1();
        }
    }
    const labelend = base.pos;

    const baseOut = Packet.alloc(1);
    const pp = new Uint8Array(tend - tstart);
    base.pos = tstart;
    base.gdata(pp, 0, pp.length);
    baseOut.pdata(pp, 0, pp.length);

    const pl = new Uint8Array(labelend - labelstart);
    base.pos = labelstart;
    base.gdata(pl, 0, pl.length);
    baseOut.pdata(pl, 0, pl.length);

    baseOut.p2(tend - tstart);
    baseOut.p2(labelend - labelstart);

    if (!BasePack.getById(baseId)) {
        BasePack.register(baseId, `base_${baseId}`);
    }
    const name = BasePack.getById(baseId);

    const existingFile = existingBases.find(x => x.endsWith(`/${name}.base`));
    const destFile = existingFile ?? `${Environment.BUILD_SRC_DIR}/models/_unpack/base/${name}.base`;

    baseOut.save(destFile);
    baseOut.release();

    const frameCount = head.g2();
    for (let i = 0; i < frameCount; i++) {
        const hstart = head.pos;
        const t1start = tran1.pos;
        const t2start = tran2.pos;
        const dstart = del.pos;

        const frameId = head.g2();
        del.g1();

        frameOrder.push(frameId.toString());

        if (!FramePack.getById(frameId)) {
            FramePack.register(frameId, `anim_${frameId}`);
        }
        const name = FramePack.getById(frameId);

        const labelCount = head.g1();
        for (let j = 0; j < labelCount; j++) {
            const flags = tran1.g1();
            if (flags === 0) {
                continue;
            }

            if ((flags & 0x1) != 0) {
                tran2.gsmarts();
            }

            if ((flags & 0x2) != 0) {
                tran2.gsmarts();
            }

            if ((flags & 0x4) != 0) {
                tran2.gsmarts();
            }
        }

        const hend = head.pos;
        const t1end = tran1.pos;
        const t2end = tran2.pos;
        const dend = del.pos;

        const frame = Packet.alloc(2);

        // const p_hend = new Uint8Array(hend - hstart);
        // head.pos = hstart;
        // head.gdata(p_hend, 0, p_hend.length);
        // frame.pdata(p_hend, 0, p_hend.length);

        frame.p2(frameId);
        frame.p2(baseId);
        frame.p1(labelCount);

        const p_t1end = new Uint8Array(t1end - t1start);
        tran1.pos = t1start;
        tran1.gdata(p_t1end, 0, p_t1end.length);
        frame.pdata(p_t1end, 0, p_t1end.length);

        const p_t2end = new Uint8Array(t2end - t2start);
        tran2.pos = t2start;
        tran2.gdata(p_t2end, 0, p_t2end.length);
        frame.pdata(p_t2end, 0, p_t2end.length);

        const p_dend = new Uint8Array(dend - dstart);
        del.pos = dstart;
        del.gdata(p_dend, 0, p_dend.length);
        frame.pdata(p_dend, 0, p_dend.length);

        frame.p2(hend - hstart + 2);
        frame.p2(t1end - t1start);
        frame.p2(t2end - t2start);
        frame.p2(dend - dstart);

        const existingFile = existingFrames.find(x => x.endsWith(`/${name}.frame`));
        const destFile = existingFile ?? `${Environment.BUILD_SRC_DIR}/models/_unpack/frame/${name}.frame`;

        frame.save(destFile);
        frame.release();
    }
}

fs.writeFileSync(`${Environment.BUILD_SRC_DIR}/pack/anim.order`, frameOrder.join('\n') + '\n');
fs.writeFileSync(`${Environment.BUILD_SRC_DIR}/pack/base.order`, baseOrder.join('\n') + '\n');

BasePack.save();
FramePack.save();
