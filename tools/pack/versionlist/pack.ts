import fs from 'fs';

import FileStream from '#/io/FileStream.js';
// import Jagfile from '#/io/Jagfile.js';
// import Packet from '#/io/Packet.js';

// todo
export function packClientVersionList(cache: FileStream) {
    // const versionlist = new Jagfile();

    // const modelVersion = Packet.alloc(3);
    // const modelCrc = Packet.alloc(4);
    // const modelIndex = Packet.alloc(3);
    // for (let i = 0; i < 1000; i++) {
    //     modelVersion.p2(i);
    //     modelCrc.p2(i);
    //     modelIndex.p1(i);
    // }
    // versionlist.write('model_version', modelVersion);
    // versionlist.write('model_crc', modelCrc);
    // versionlist.write('model_index', modelIndex);

    // const animVersion = Packet.alloc(3);
    // const animCrc = Packet.alloc(4);
    // const animIndex = Packet.alloc(3);
    // for (let i = 0; i < 1000; i++) {
    //     animVersion.p2(i);
    //     animCrc.p4(i);
    //     animIndex.p2(i);
    // }
    // versionlist.write('anim_version', animVersion);
    // versionlist.write('anim_crc', animCrc);
    // versionlist.write('anim_index', animIndex);

    // const midiVersion = Packet.alloc(3);
    // const midiCrc = Packet.alloc(4);
    // const midiIndex = Packet.alloc(3);
    // for (let i = 0; i < 1000; i++) {
    //     midiVersion.p2(i);
    //     midiCrc.p4(i);
    //     midiIndex.p1(i);
    // }
    // versionlist.write('midi_version', midiVersion);
    // versionlist.write('midi_crc', midiCrc);
    // versionlist.write('midi_index', midiIndex);

    // const mapVersion = Packet.alloc(3);
    // const mapCrc = Packet.alloc(4);
    // const mapIndex = Packet.alloc(4);
    // for (let i = 0; i < 1000; i++) {
    //     mapVersion.p2(i);
    //     mapCrc.p4(i);

    //     mapIndex.p2(i);
    //     mapIndex.p2(i);
    //     mapIndex.p2(i);
    //     mapIndex.p1(i);
    // }
    // versionlist.write('map_version', mapVersion);
    // versionlist.write('map_crc', mapCrc);
    // versionlist.write('map_index', mapIndex);

    // versionlist.save('data/pack/client/versionlist');

    cache.write(0, 5, fs.readFileSync('data/raw/versionlist'));
}

// const cache = new FileStream('data/unpack');
// fs.writeFileSync('data/raw/title', cache.read(0, 1)!);
// fs.writeFileSync('data/raw/config', cache.read(0, 2)!);
// fs.writeFileSync('data/raw/media', cache.read(0, 4)!);
// fs.writeFileSync('data/raw/versionlist', cache.read(0, 5)!);
// fs.writeFileSync('data/raw/textures', cache.read(0, 6)!);
// fs.writeFileSync('data/raw/wordenc', cache.read(0, 7)!);
// fs.writeFileSync('data/raw/sounds', cache.read(0, 8)!);
