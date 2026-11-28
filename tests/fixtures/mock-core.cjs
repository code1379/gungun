#!/usr/bin/env node
/* eslint @typescript-eslint/no-require-imports: "off", no-undef: "off" */
// Process-lifecycle fixture only. This is not a proxy core or a protocol test.
const fs = require('node:fs');
const net = require('node:net');
const http = require('node:http');
const args = process.argv.slice(2);
if (args[0] === 'version') { console.log('sing-box version 1.14.4'); process.exit(0); }
const path = args[args.indexOf('-c') + 1];
const config = JSON.parse(fs.readFileSync(path, 'utf8'));
if (config.outbounds.some(o => o.server === 'invalid-config')) process.exit(1);
if (args[0] === 'check') process.exit(0);
const marker = config.outbounds.find(o => o.server === 'fail-cutover');
if (marker && config.inbounds[0].listen_port === marker.server_port && !fs.existsSync(path + '.unused')) {
  const key = process.env.GUNGUN_FIXTURE_FAILURE_MARKER;
  if (key && !fs.existsSync(key)) { fs.writeFileSync(key, 'failed-once'); process.exit(1); }
}
const servers = config.inbounds.map(inbound => {
  if (inbound.type === 'http') {
    return http.createServer((req, res) => {
      const target = new URL(req.url);
      const upstream = http.get(target, reply => { res.writeHead(reply.statusCode); reply.pipe(res); });
      upstream.on('error', () => { res.statusCode = 502; res.end(); });
    }).listen(inbound.listen_port, inbound.listen);
  }
  return net.createServer(socket => socket.on('data', () => socket.end(Buffer.from([5, 0])))).listen(inbound.listen_port, inbound.listen);
});
for (const s of servers) s.on('error', () => process.exit(1));
process.on('SIGTERM', () => { for (const s of servers) s.close(); process.exit(0); });
