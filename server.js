'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Math.max(1, parseInt(process.env.PORT, 10) || 8000);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME_BYTES = 64 * 1024;

const PALETTE = [
  '#c8553d',
  '#2a9d8f',
  '#e9a03b',
  '#5d7fb8',
  '#9b5de5',
  '#d65db1',
  '#4f772d',
  '#e07a5f'
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

const BLOCKED_FILES = new Set(['server.js', 'package.json', 'package-lock.json']);

const clients = new Map();
let visitorCounter = 1;

function sanitizeName(raw, fallback) {
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24);
  return cleaned || fallback;
}

function sanitizeColor(raw, fallback) {
  if (typeof raw === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.trim())) {
    return raw.trim().toLowerCase();
  }
  return fallback;
}

function sanitizeNum(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function sanitizeViewing(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);
}

function encodeFrame(opcode, payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '', 'utf8');
  const len = buf.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, buf]);
}

function sendJson(client, obj) {
  if (client.closed || client.socket.destroyed) return;
  try {
    client.socket.write(encodeFrame(0x1, JSON.stringify(obj)));
  } catch (e) {
    cleanupClient(client);
  }
}

function broadcast(obj, exceptId) {
  const frame = encodeFrame(0x1, JSON.stringify(obj));
  for (const [id, client] of clients) {
    if (id === exceptId || client.closed || client.socket.destroyed) continue;
    try {
      client.socket.write(frame);
    } catch (e) {
      cleanupClient(client);
    }
  }
}

function publicPeer(c) {
  return {
    id: c.id,
    name: c.name,
    color: c.color,
    x: c.x,
    y: c.y,
    z: c.z,
    yaw: c.yaw,
    pitch: c.pitch,
    viewing: c.viewing
  };
}

function cleanupClient(client) {
  if (client.closed) return;
  client.closed = true;
  if (clients.delete(client.id)) {
    broadcast({ type: 'leave', id: client.id }, client.id);
  }
  if (!client.socket.destroyed) {
    try { client.socket.destroy(); } catch (e) {}
  }
}

function handleMessage(client, text) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch (e) {
    return;
  }
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'state') {
    client.x = sanitizeNum(msg.x, -60, 60, client.x);
    client.y = sanitizeNum(msg.y, 0, 20, client.y);
    client.z = sanitizeNum(msg.z, -60, 60, client.z);
    client.yaw = sanitizeNum(msg.yaw, -1000, 1000, client.yaw);
    client.pitch = sanitizeNum(msg.pitch, -1.6, 1.6, client.pitch);
    client.viewing = sanitizeViewing(msg.viewing);
    broadcast({
      type: 'state',
      id: client.id,
      x: client.x,
      y: client.y,
      z: client.z,
      yaw: client.yaw,
      pitch: client.pitch,
      viewing: client.viewing
    }, client.id);
  } else if (msg.type === 'meta') {
    const nextName = sanitizeName(msg.name, client.name);
    const nextColor = sanitizeColor(msg.color, client.color);
    if (nextName !== client.name || nextColor !== client.color) {
      client.name = nextName;
      client.color = nextColor;
      broadcast({
        type: 'meta',
        id: client.id,
        name: client.name,
        color: client.color
      });
    }
  }
}

function consumeFrames(client) {
  while (client.buffer.length >= 2) {
    const b0 = client.buffer[0];
    const b1 = client.buffer[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let payloadLen = b1 & 0x7f;
    let offset = 2;

    if (!masked) {
      cleanupClient(client);
      return;
    }

    if (payloadLen === 126) {
      if (client.buffer.length < 4) return;
      payloadLen = client.buffer.readUInt16BE(2);
      offset = 4;
    } else if (payloadLen === 127) {
      if (client.buffer.length < 10) return;
      const bigLen = client.buffer.readBigUInt64BE(2);
      if (bigLen > BigInt(MAX_FRAME_BYTES)) {
        cleanupClient(client);
        return;
      }
      payloadLen = Number(bigLen);
      offset = 10;
    }

    if (payloadLen > MAX_FRAME_BYTES) {
      cleanupClient(client);
      return;
    }

    const totalLen = offset + 4 + payloadLen;
    if (client.buffer.length < totalLen) return;

    const maskKey = client.buffer.subarray(offset, offset + 4);
    const payload = Buffer.allocUnsafe(payloadLen);
    for (let i = 0; i < payloadLen; i++) {
      payload[i] = client.buffer[offset + 4 + i] ^ maskKey[i & 3];
    }
    client.buffer = client.buffer.subarray(totalLen);

    if (opcode === 0x8) {
      try {
        client.socket.end(encodeFrame(0x8, Buffer.alloc(0)));
      } catch (e) {}
      cleanupClient(client);
      return;
    }

    if (opcode === 0x9) {
      try {
        client.socket.write(encodeFrame(0xA, payload));
      } catch (e) {
        cleanupClient(client);
        return;
      }
      continue;
    }

    if (opcode === 0xA) {
      client.alive = true;
      continue;
    }

    if (opcode === 0x1 || opcode === 0x0) {
      if (opcode === 0x1) {
        client.fragOpcode = 0x1;
        client.fragChunks = [payload];
        client.fragSize = payload.length;
      } else if (client.fragOpcode === 0x1) {
        client.fragSize += payload.length;
        if (client.fragSize > MAX_FRAME_BYTES) {
          cleanupClient(client);
          return;
        }
        client.fragChunks.push(payload);
      }

      if (fin && client.fragOpcode === 0x1) {
        const text = Buffer.concat(client.fragChunks).toString('utf8');
        client.fragOpcode = 0;
        client.fragChunks = [];
        client.fragSize = 0;
        handleMessage(client, text);
      }
    }
  }
}

function serveStatic(req, res) {
  const reqUrl = new URL(req.url, 'http://localhost');
  let pathname;
  try {
    pathname = decodeURIComponent(reqUrl.pathname);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad request');
    return;
  }

  if (pathname === '/health') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({ ok: true, visitors: clients.size }));
    return;
  }

  if (pathname === '/') pathname = '/index.html';
  else if (pathname === '/admin') pathname = '/admin.html';

  const rel = pathname.replace(/^\/+/, '');
  if (!rel || rel.startsWith('.') || rel.includes('/.') || BLOCKED_FILES.has(rel)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  const filePath = path.resolve(ROOT, rel);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext];
  if (!mime) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(err.code === 'ENOENT' ? 'Not found' : 'Server error');
      return;
    }
    const headers = {
      'Content-Type': mime,
      'X-Content-Type-Options': 'nosniff'
    };
    if (rel === 'exhibition.json') {
      headers['Cache-Control'] = 'no-store';
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

const server = http.createServer(serveStatic);

server.on('upgrade', (req, socket, head) => {
  const reqUrl = new URL(req.url, 'http://localhost');
  if (reqUrl.pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers.upgrade || '').toLowerCase();
  if (!key || upgrade !== 'websocket') {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.setNoDelay(true);

  const num = visitorCounter++;
  const client = {
    id: 'v-' + crypto.randomBytes(4).toString('hex'),
    name: 'Visitor ' + num,
    color: PALETTE[(num - 1) % PALETTE.length],
    x: 0,
    y: 1.7,
    z: 4,
    yaw: 0,
    pitch: 0,
    viewing: '',
    socket,
    buffer: head && head.length ? Buffer.from(head) : Buffer.alloc(0),
    fragOpcode: 0,
    fragChunks: [],
    fragSize: 0,
    alive: true,
    closed: false
  };

  const peers = [];
  for (const existing of clients.values()) {
    peers.push(publicPeer(existing));
  }
  clients.set(client.id, client);

  sendJson(client, {
    type: 'welcome',
    id: client.id,
    name: client.name,
    color: client.color,
    peers
  });
  broadcast({ type: 'join', peer: publicPeer(client) }, client.id);

  socket.on('data', chunk => {
    client.alive = true;
    client.buffer = client.buffer.length ? Buffer.concat([client.buffer, chunk]) : chunk;
    if (client.buffer.length > MAX_FRAME_BYTES * 2) {
      cleanupClient(client);
      return;
    }
    consumeFrames(client);
  });

  socket.on('close', () => cleanupClient(client));
  socket.on('end', () => cleanupClient(client));
  socket.on('error', () => cleanupClient(client));

  if (client.buffer.length) {
    consumeFrames(client);
  }
});

const heartbeat = setInterval(() => {
  for (const client of clients.values()) {
    if (!client.alive) {
      cleanupClient(client);
      continue;
    }
    client.alive = false;
    try {
      client.socket.write(encodeFrame(0x9, Buffer.alloc(0)));
    } catch (e) {
      cleanupClient(client);
    }
  }
}, 25000);
heartbeat.unref();

server.listen(PORT, HOST, () => {
  console.log(`MANZINI multiplayer server listening on http://localhost:${PORT}`);
});
