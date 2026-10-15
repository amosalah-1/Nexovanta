'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const port = Number(process.env.PORT || 8000);
const host = process.env.HOST || '127.0.0.1';
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

const server = http.createServer((request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end('Method Not Allowed');
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, `http://${request.headers.host || 'localhost'}`).pathname);
  } catch {
    response.writeHead(400);
    response.end('Bad Request');
    return;
  }

  if (pathname.split(/[\\/]/).some(segment => segment.startsWith('.'))) {
    response.writeHead(404);
    response.end('Not Found');
    return;
  }

  const filePath = path.resolve(root, `.${pathname}`);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  fs.stat(filePath, (statError, stats) => {
    const targetPath = !statError && stats.isDirectory()
      ? path.join(filePath, 'index.html')
      : filePath;

    fs.stat(targetPath, (targetError, fileStats) => {
      if (targetError || !fileStats.isFile()) {
        const status = targetError && (targetError.code === 'ENOENT' || targetError.code === 'ENOTDIR') ? 404 : 500;
        response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end(status === 404 ? 'Not Found' : 'Internal Server Error');
        return;
      }

      const headers = {
        'Content-Type': mimeTypes[path.extname(targetPath).toLowerCase()] || 'application/octet-stream',
        'Accept-Ranges': 'bytes',
        'Content-Length': fileStats.size,
        'X-Content-Type-Options': 'nosniff',
      };
      let start = 0;
      let end = fileStats.size - 1;
      const range = request.headers.range;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || (!match[1] && !match[2])) {
          response.writeHead(416, { 'Content-Range': `bytes */${fileStats.size}` });
          response.end();
          return;
        }

        if (match[1]) {
          start = Number(match[1]);
          if (match[2]) end = Number(match[2]);
        } else {
          const suffixLength = Number(match[2]);
          start = Math.max(fileStats.size - suffixLength, 0);
        }
        if (start >= fileStats.size || end < start) {
          response.writeHead(416, { 'Content-Range': `bytes */${fileStats.size}` });
          response.end();
          return;
        }
        end = Math.min(end, fileStats.size - 1);
        headers['Content-Length'] = end - start + 1;
        headers['Content-Range'] = `bytes ${start}-${end}/${fileStats.size}`;
        response.writeHead(206, headers);
      } else {
        response.writeHead(200, headers);
      }

      if (request.method === 'HEAD') {
        response.end();
        return;
      }
      if (fileStats.size === 0) {
        response.end();
        return;
      }
      fs.createReadStream(targetPath, { start, end }).pipe(response);
    });
  });
});

server.on('error', error => {
  console.error(`Could not start the local server: ${error.message}`);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  console.log(`Nexovanta is available at http://${host}:${port}`);
  console.log('Press Ctrl+C to stop the server.');
});
