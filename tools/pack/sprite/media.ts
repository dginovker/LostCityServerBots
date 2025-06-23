import fs from 'fs';

import FileStream from '#/io/FileStream.js';

export async function packClientMedia(cache: FileStream) {
    cache.write(0, 4, fs.readFileSync('data/raw/media'));
}
