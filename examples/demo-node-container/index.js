/* eslint-disable @typescript-eslint/no-require-imports */
const http = require('node:http');

const port = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  const body = JSON.stringify({
    message: 'Hello from Demo Appliance!',
    path: req.url,
    method: req.method,
    timestamp: new Date().toISOString(),
  });

  res.writeHead(200, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
});

server.listen(port, () => {
  console.log(`Listening on port ${port}`);
});
