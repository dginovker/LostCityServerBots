import fs from 'fs';
import path from 'path';

import GZip from '#/io/GZip.js';
import Environment from '#/util/Environment.js';
import FileStream from '#/io/FileStream.js';
import { MidiPack } from '#/util/PackFile.js';
import { listFilesExt } from '#/util/Parse.js';

export function packClientMusic(cache: FileStream) {
    const midis = listFilesExt(`${Environment.BUILD_SRC_DIR}/midi`, '.mid');
    for (const file of midis) {
        const basename = path.basename(file);
        const id = MidiPack.getByName(basename.substring(0, basename.lastIndexOf('.')));
        cache.write(3, id, GZip.compress(fs.readFileSync(file)));
    }
}
