import fs from 'fs';
import fsp from 'fs/promises';
import http from 'http';
import { extname } from 'path';

import { register } from 'prom-client';

import Environment from '#/util/Environment.js';
import { CrcBuffer } from './cache/CrcTable.js';
import OnDemand from './engine/OnDemand.js';

const MIME_TYPES = new Map<string, string>();
MIME_TYPES.set('.js', 'application/javascript');
MIME_TYPES.set('.mjs', 'application/javascript');
MIME_TYPES.set('.css', 'text/css');
MIME_TYPES.set('.html', 'text/html');
MIME_TYPES.set('.wasm', 'application/wasm');
MIME_TYPES.set('.sf2', 'application/octet-stream');

// we don't need/want a full blown website or API on the game server
export const web = http.createServer(async (req, res) => {
    try {
        if (req.method !== 'GET') {
            res.writeHead(405);
            res.end();
            return;
        }

        const url = new URL(req.url ?? '', `http://${req.headers.host}`);

        if (url.pathname.startsWith('/crc')) {
            res.setHeader('Content-Type', 'application/octet-stream');
            res.writeHead(200);
            res.end(CrcBuffer.data);
        } else if (url.pathname.startsWith('/title')) {
            res.setHeader('Content-Type', 'application/octet-stream');
            res.writeHead(200);
            res.end(OnDemand.cache.read(0, 1));
        } else if (url.pathname.startsWith('/config')) {
            res.setHeader('Content-Type', 'application/octet-stream');
            res.writeHead(200);
            res.end(OnDemand.cache.read(0, 2));
        } else if (url.pathname.startsWith('/interface')) {
            res.setHeader('Content-Type', 'application/octet-stream');
            res.writeHead(200);
            res.end(OnDemand.cache.read(0, 3));
        } else if (url.pathname.startsWith('/media')) {
            res.setHeader('Content-Type', 'application/octet-stream');
            res.writeHead(200);
            res.end(OnDemand.cache.read(0, 4));
        } else if (url.pathname.startsWith('/versionlist')) {
            res.setHeader('Content-Type', 'application/octet-stream');
            res.writeHead(200);
            res.end(OnDemand.cache.read(0, 5));
        } else if (url.pathname.startsWith('/textures')) {
            res.setHeader('Content-Type', 'application/octet-stream');
            res.writeHead(200);
            res.end(OnDemand.cache.read(0, 6));
        } else if (url.pathname.startsWith('/wordenc')) {
            res.setHeader('Content-Type', 'application/octet-stream');
            res.writeHead(200);
            res.end(OnDemand.cache.read(0, 7));
        } else if (url.pathname.startsWith('/sounds')) {
            res.setHeader('Content-Type', 'application/octet-stream');
            res.writeHead(200);
            res.end(OnDemand.cache.read(0, 8));
        } else if (url.pathname === '/') {
            if (Environment.WEBSITE_REGISTRATION) {
                res.writeHead(404);
                res.end();
            } else {
                res.writeHead(302, { Location: '/rs2.cgi?lowmem=0&plugin=0' });
                res.end();
            }
        } else if (fs.existsSync('public' + url.pathname)) {
            res.setHeader('Content-Type', MIME_TYPES.get(extname(url.pathname ?? '')) ?? 'text/plain');
            res.writeHead(200);
            res.end(await fsp.readFile('public' + url.pathname));
        } else {
            res.writeHead(404);
            res.end();
        }
    } catch (_) {
        res.end();
    }
});

const managementWeb = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '', `http://${req.headers.host}`);

    if (url.pathname === '/prometheus') {
        res.setHeader('Content-Type', register.contentType);
        res.writeHead(200);
        res.end(await register.metrics());
    } else {
        res.writeHead(404);
        res.end();
    }
});

export function startWeb() {
    web.listen(Environment.WEB_PORT, '0.0.0.0');
}

export function startManagementWeb() {
    managementWeb.listen(Environment.WEB_MANAGEMENT_PORT, '0.0.0.0');
}
