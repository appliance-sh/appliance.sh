const http = require('node:http');

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const BACKEND_URL = process.env.BACKEND_URL;

http
  .createServer(async (req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (req.url === '/api/summary') {
      if (!BACKEND_URL) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ service: 'bff', error: 'BACKEND_URL is not set' }));
        return;
      }
      try {
        const upstream = await fetch(`${BACKEND_URL}/api/quotes`);
        const data = await upstream.json();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            service: 'bff',
            backend: BACKEND_URL,
            count: data.quotes.length,
            quotes: data.quotes.map((q) => `${q.text} — ${q.author}`),
          })
        );
      } catch (err) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ service: 'bff', error: `backend unreachable: ${err.message}`, backend: BACKEND_URL }));
      }
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  })
  .listen(PORT, () => console.log(`bff listening on :${PORT}, backend=${BACKEND_URL ?? '(unset)'}`));
