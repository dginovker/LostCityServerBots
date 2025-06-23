import fs from 'fs';

import FileStream from '#/io/FileStream.js';

export async function packClientTitle(cache: FileStream) {
    cache.write(0, 1, fs.readFileSync('data/raw/title'));
}
