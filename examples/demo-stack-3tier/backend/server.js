const http = require('node:http');

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

const QUOTES = [
  { id: 1, author: 'Hopper', text: 'The most dangerous phrase is: we have always done it this way.' },
  { id: 2, author: 'Kay', text: 'The best way to predict the future is to invent it.' },
  { id: 3, author: 'Knuth', text: 'Premature optimization is the root of all evil.' },
];

http
  .createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (req.url === '/api/quotes') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ service: 'backend', quotes: QUOTES }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  })
  .listen(PORT, () => console.log(`backend listening on :${PORT}`));
