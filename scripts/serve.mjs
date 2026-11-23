#!/usr/bin/env node
// Minimal static file server for the spectral editing window.
// Usage: node scripts/serve.mjs [port]

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const port = Number(process.argv[2] || process.env.PORT || 5173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wav': 'audio/wav',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/' || pathname === '') pathname = '/index.html';
    const filePath = normalize(join(root, pathname));
    // Reject traversal outside the project root.
    if (filePath !== root && !filePath.startsWith(root + sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const info = await stat(filePath);
    if (info.isDirectory()) {
      res.writeHead(404).end('Not found');
      return;
    }
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(filePath)] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch (err) {
    if (err.code === 'ENOENT') res.writeHead(404).end('Not found');
    else {
      res.writeHead(500).end('Server error');
      console.error(err);
    }
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Spectral pitch transposer running at http://127.0.0.1:${port}/`);
  console.log('Open the URL in a browser. Press Ctrl+C to stop.');
});
