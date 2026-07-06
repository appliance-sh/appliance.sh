const http = require('node:http');

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const BFF_URL = process.env.BFF_URL;

const PAGE = `<!doctype html>
<html>
  <head><title>Quotes demo</title></head>
  <body>
    <h1>Quotes (frontend → bff → backend)</h1>
    <pre id="out">loading…</pre>
    <script>
      fetch('/api/summary')
        .then((r) => r.json())
        .then((d) => (document.getElementById('out').textContent = JSON.stringify(d, null, 2)))
        .catch((e) => (document.getElementById('out').textContent = String(e)));
    </script>
  </body>
</html>`;

http
  .createServer(async (req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (req.url === '/api/summary') {
      if (!BFF_URL) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ service: 'frontend', error: 'BFF_URL is not set' }));
        return;
      }
      try {
        const upstream = await fetch(`${BFF_URL}/api/summary`);
        res.writeHead(upstream.status, { 'content-type': 'application/json' });
        res.end(await upstream.text());
      } catch (err) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ service: 'frontend', error: `bff unreachable: ${err.message}`, bff: BFF_URL }));
      }
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  })
  .listen(PORT, () => console.log(`frontend listening on :${PORT}, bff=${BFF_URL ?? '(unset)'}`));
