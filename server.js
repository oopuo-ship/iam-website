const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PORT = process.env.PORT || 3007;

const routes = {
  '/': '/index.html',
  '/blog': '/blog.html',
  '/about': '/about.html',
  '/pricing': '/pricing.html',
  '/education': '/education.html',
  '/healthcare': '/healthcare.html',
  '/entertainment': '/entertainment.html',
  '/build-a-park': '/build-a-park.html',
  '/3d-games': '/3d-games.html',
  '/create-your-game': '/create-your-game.html',
  '/partner': '/partner.html',
  '/privacy': '/privacy.html',
  '/cookies': '/cookies.html',
  '/accessibility': '/accessibility.html',
  '/products/2-in-1-floor-wall': '/products/2-in-1-floor-wall.html',
  '/products/interactive-floor': '/products/interactive-floor.html',
  '/products/interactive-wall': '/products/interactive-wall.html',
  '/products/interactive-sandbox': '/products/interactive-sandbox.html',
  '/products/software': '/products/software.html',
};

const redirects = {
  '/about': '/about',
  '/pricing': '/pricing',
  '/education': '/education',
  '/zorg': '/healthcare',
  '/parken': '/entertainment',
  '/build-a-park': '/build-a-park',
  '/3d-games': '/3d-games',
};

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  // 1. Security Headers
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // 2. Proxy /api/chat to chat-proxy service
  if (url === '/api/chat') {
    const CHAT_PORT = process.env.CHAT_PORT || 3860;
    const proxyOpts = { hostname: '127.0.0.1', port: CHAT_PORT, path: '/chat', method: req.method, headers: req.headers };
    const proxyReq = require('http').request(proxyOpts, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', () => { res.writeHead(502); res.end('Chat service unavailable'); });
    req.pipe(proxyReq);
    return;
  }

  // 3. Redirects
  if (redirects[url]) {
    res.writeHead(301, { 'Location': redirects[url] });
    return res.end();
  }

  // 3. Routing
  let filePath = routes[url] || url;
  if (filePath === '/') filePath = '/index.html';

  let fullPath = path.join(__dirname, filePath);

  // 4. Try .html if not found
  if (!fs.existsSync(fullPath) && !path.extname(fullPath)) {
    if (fs.existsSync(fullPath + '.html')) {
      fullPath += '.html';
    }
  }

  // 5. Directory index
  if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
    fullPath = path.join(fullPath, 'index.html');
  }

  // 6. Serve file
  fs.access(fullPath, fs.constants.F_OK, (err) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not Found');
    }

    const ext = path.extname(fullPath).toLowerCase();
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    const isCompressible = /text|javascript|json|xml|svg|font/.test(contentType);

    const stream = fs.createReadStream(fullPath);
    const acceptEncoding = req.headers['accept-encoding'] || '';

    if (isCompressible && acceptEncoding.includes('gzip')) {
      res.writeHead(200, { 'Content-Type': contentType, 'Content-Encoding': 'gzip' });
      stream.pipe(zlib.createGzip()).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      stream.pipe(res);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/`);
});
