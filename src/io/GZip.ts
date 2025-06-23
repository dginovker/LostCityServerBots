import zlib from 'zlib';

function compress(src: Uint8Array) {
    const data = zlib.gzipSync(src);
    data[9] = 0;
    return data;
}

export default {
    compress
};
