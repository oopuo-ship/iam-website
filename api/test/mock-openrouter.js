// M2-01 D-13: local HTTP stub for OpenRouter /api/v1/chat/completions.
// Never calls the live upstream. Records received request bodies for assertions.
const http = require('http');

function startMockOpenRouter(port = 0) {
  const receivedRequests = [];

  const server = http.createServer((req, res) => {
    let chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');

      if (req.method === 'POST' && req.url === '/api/v1/chat/completions') {
        receivedRequests.push({ headers: req.headers, body });

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":" world"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{}}],"usage":{"total_tokens":42}}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actualPort = server.address().port;
      const stop = () => new Promise((r) => server.close(() => r()));
      resolve({ server, port: actualPort, receivedRequests, stop });
    });
  });
}

module.exports = { startMockOpenRouter };
