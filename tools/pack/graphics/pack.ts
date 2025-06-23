import fs from 'fs';
import path from 'path';

import GZip from '#/io/GZip.js';
import Environment from '#/util/Environment.js';
import FileStream from '#/io/FileStream.js';
import { listFilesExt } from '#/util/Parse.js';
import { AnimSetPack, ModelPack } from '#/util/PackFile.js';

export function packClientModel() {
    const cache = new FileStream('data/pack');

    const models = listFilesExt(`${Environment.BUILD_SRC_DIR}/models`, '.ob2');
    for (const file of models) {
        const basename = path.basename(file);
        const id = ModelPack.getByName(basename.substring(0, basename.lastIndexOf('.')));
        cache.write(1, id, GZip.compress(fs.readFileSync(file)));
    }

    const anims = listFilesExt(`${Environment.BUILD_SRC_DIR}/models`, '.anim');
    for (const file of anims) {
        const basename = path.basename(file);
        const id = AnimSetPack.getByName(basename.substring(0, basename.lastIndexOf('.')));
        cache.write(2, id, GZip.compress(fs.readFileSync(file)));
    }
}

packClientModel();
