import fs from 'fs';

import GZip from '#/io/GZip.js';
import Environment from '#/util/Environment.js';
import FileStream from '#/io/FileStream.js';
import { MidiPack } from '#/util/PackFile.js';

export function packClientMusic() {
    const cache = new FileStream('data/pack');

    fs.readdirSync(`${Environment.BUILD_SRC_DIR}/midi`).forEach(f => {
        if (!f.endsWith('.mid')) {
            return;
        }

        const id = MidiPack.getByName(f.substring(0, f.lastIndexOf('.')));
        cache.write(3, id, GZip.compress(fs.readFileSync(`${Environment.BUILD_SRC_DIR}/midi/${f}`)), true);
    });
}
