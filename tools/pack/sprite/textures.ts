import fs from 'fs';

import FileStream from '#/io/FileStream.js';

export async function packClientTexture(cache: FileStream) {
    cache.write(0, 6, fs.readFileSync('data/raw/textures'));
}
