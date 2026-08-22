'use strict';
// stdio bridge for MCP clients that require stdio transport.
// Config example (Antigravity / Claude / any MCP client):
//   { "command": "node", "args": ["<path>/daemon/stdio-bridge.js"] }
// Forwards each stdin JSON-RPC line to the daemon's HTTP /mcp endpoint.

const readline = require('node:readline');
const http = require('node:http');

// AI_COUNCIL_URL: legacy variable name, kept so existing setups keep working
const DAEMON = process.env.AI_COUNCIL_URL || 'http://127.0.0.1:8765';

function post(body) {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(DAEMON + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        if (!buf.trim()) return resolve(null); // 204/notification
        try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch (_) {
    process.stdout.write(JSON.stringify(
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n');
    return;
  }
  try {
    const resp = await post(msg);
    if (resp) process.stdout.write(JSON.stringify(resp) + '\n');
  } catch (e) {
    if (msg.id !== undefined) {
      process.stdout.write(JSON.stringify(
        { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: `daemon unreachable: ${e.message}` } }) + '\n');
    }
  }
});
