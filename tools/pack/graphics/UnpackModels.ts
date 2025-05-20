import fs from 'fs';
import zlib from 'zlib';

import FileStream from '#/io/FileStream.js';
import Environment from '#/util/Environment.js';
import { printWarning } from '#/util/Logger.js';
import { PackFile } from '#/util/PackFileBase.js';
import { listFilesExt } from '#/util/Parse.js';

export const ModelPack = new PackFile('model');

const cache = new FileStream('data/pack/original');

const existingFiles = listFilesExt(`${Environment.BUILD_SRC_DIR}/models`, '.ob2');

const modelCount = cache.count(1);
const order = [];
for (let i = 0; i < modelCount; i++) {
    order.push(i.toString());

    if (!ModelPack.getById(i)) {
        ModelPack.register(i, `model_${i}`);
    }
    const name = ModelPack.getById(i);

    const model = cache.read(1, i);
    if (!model) {
        printWarning(`Missing model ${name}`);
        continue;
    }

    const existingFile = existingFiles.find(x => x.endsWith(`/${name}.ob2`));
    const destFile = existingFile ?? `${Environment.BUILD_SRC_DIR}/models/_unpack/${name}.ob2`;
    fs.writeFileSync(destFile, zlib.gunzipSync(model));
}

fs.writeFileSync(`${Environment.BUILD_SRC_DIR}/pack/model.order`, order.join('\n') + '\n');

ModelPack.save();
