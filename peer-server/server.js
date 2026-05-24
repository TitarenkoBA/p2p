const { PeerServer } = require('peer');

const port = Number(process.env['PORT'] ?? 9000);
const path = process.env['PEER_PATH'] ?? '/';

const server = PeerServer({
  port,
  path,
  allow_discovery: true,
  proxied: process.env['PROXIED'] === 'true'
});

server.on('connection', (client) => {
  console.log(`peer connected: ${client.getId()}`);
});

console.log(`PeerServer listening on http://0.0.0.0:${port}${path}`);
