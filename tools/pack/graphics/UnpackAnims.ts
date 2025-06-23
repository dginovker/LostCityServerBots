import fs from 'fs';

import FileStream from '#/io/FileStream.js';
import { printWarning } from '#/util/Logger.js';
import { PackFile } from '#/util/PackFileBase.js';
import { AnimSetPack } from '#/util/PackFile.js';
import Environment from '#/util/Environment.js';

export const BasePack = new PackFile('base');
export const FramePack = new PackFile('anim');

const cache = new FileStream('data/unpack');

const baseCount = cache.count(2);
for (let baseId = 0; baseId < baseCount; baseId++) {
    const set = cache.read(2, baseId, true);
    if (!set) {
        printWarning(`Missing anim set ${baseId}`);
        continue;
    }

    const name = `anim_${baseId}`;
    AnimSetPack.register(baseId, name);
    fs.writeFileSync(`${Environment.BUILD_SRC_DIR}/models/${name}.anim`, set);
}

AnimSetPack.save();
