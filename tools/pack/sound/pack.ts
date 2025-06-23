import fs from 'fs';

import FileStream from '#/io/FileStream.js';

export function packClientSound(cache: FileStream) {
    cache.write(0, 8, fs.readFileSync('data/raw/sounds'));
}
