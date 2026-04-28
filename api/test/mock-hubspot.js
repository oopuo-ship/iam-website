// Local mock of the subset of HubSpot Forms v3 that the contact route uses.
// Never reaches out to api.hsforms.com. Used by contact smoke tests.
const http = require('http');

function startMockHubSpot(port = 0) {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c.toString('utf8'); });
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body });
      // Match /submissions/v3/integration/submit/:portal/:guid
      const m = req.url.match(/^\/submissions\/v3\/integration\/submit\/([^/]+)\/([^/]+)$/);
      if (req.method === 'POST' && m) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ inlineMessage: '' }));
      }
      res.writeHead(404).end();
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: boundPort } = server.address();
      resolve({
        port: boundPort,
        receivedRequests: received,
        stop: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

module.exports = { startMockHubSpot };
