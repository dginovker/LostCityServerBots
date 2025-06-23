import fs from 'fs';

import FileStream from '#/io/FileStream.js';
import Environment from '#/util/Environment.js';
import { printWarning } from '#/util/Logger.js';
import { MidiPack } from '#/util/PackFile.js';

fs.mkdirSync(`${Environment.BUILD_SRC_DIR}/midi`, { recursive: true });

const cache = new FileStream('data/unpack', false, true);

console.time('midis');
const midiCount = cache.count(3);
for (let i = 0; i < midiCount; i++) {
    const data = cache.read(3, i, true);
    if (!data) {
        printWarning(`Missing midi id=${i}`);
        continue;
    }

    const name = `midi_${i}`;
    MidiPack.register(i, name);
    fs.writeFileSync(`${Environment.BUILD_SRC_DIR}/midi/${name}.mid`, data);
}
console.timeEnd('midis');

MidiPack.save();
