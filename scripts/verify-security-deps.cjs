'use strict';

// Offline regression checks: loopback services, in-memory SQLite, no real mail/data.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

function isolated(fn) {
  // A vulnerable parser must not hang or crash the parent test process.
  const result = spawnSync(process.execPath, ['-e', `(${fn})().catch(e => { console.error(e); process.exit(1); })`], {
    cwd: root, encoding: 'utf8', timeout: 5000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

async function listen(server, t) {
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise(resolve => server.close(resolve));
  });
  return server.address().port;
}

test('all locked copies of affected packages meet the security floor', () => {
  const floors = { axios: '1.20.0', nodemailer: '10.0.6', qs: '6.16.0', tar: '7.5.21', undici: '6.28.1' };
  const packages = require('../package-lock.json').packages;
  const numeric = version => version.split('.').reduce((n, part) => n * 10000 + Number(part), 0);
  for (const [name, floor] of Object.entries(floors)) {
    const copies = Object.entries(packages).filter(([key]) => key.endsWith(`/node_modules/${name}`) || key === `node_modules/${name}`);
    assert.ok(copies.length, `${name} must remain covered`);
    for (const [key, pkg] of copies) {
      assert.ok(numeric(pkg.version) >= numeric(floor), `${key}: ${pkg.version} < ${floor}`);
      assert.equal(require(path.join(root, key, 'package.json')).version, pkg.version);
    }
  }
});

test('Axios preserves JSON GET/POST, redirects and timeouts', { timeout: 10000 }, async t => {
  const axios = require('axios');
  const server = http.createServer((req, res) => {
    if (req.url === '/slow') return;
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/quote' }); return res.end(); }
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ method: req.method, body, price: 1.234 }));
    });
  });
  const port = await listen(server, t);
  const client = axios.create({ baseURL: `http://127.0.0.1:${port}`, proxy: false, timeout: 1500 });
  assert.equal((await client.get('/quote')).data.price, 1.234);
  assert.equal((await client.get('/redirect')).data.price, 1.234);
  assert.equal((await client.post('/ai', { model: 'test' })).data.body, '{"model":"test"}');
  await assert.rejects(client.get('/slow', { timeout: 50 }), e => e.code === 'ECONNABORTED');
});

test('Axios rejects malformed data URLs without synchronous CPU exhaustion', () => {
  isolated(async () => {
    const assert = require('node:assert/strict');
    await assert.rejects(require('axios').get('data:' + '/'.repeat(128000)));
  });
});

test('Nodemailer composes hostile addresses without blocking', () => {
  isolated(async () => {
    const transport = require('nodemailer').createTransport({ streamTransport: true, buffer: true });
    const message = await transport.sendMail({
      from: 'Fund Monitor <sender@example.test>', to: ' >' + '>[x][x]'.repeat(40000),
      subject: '安全回归测试', html: '<p>test</p>',
    });
    require('node:assert/strict').ok(Buffer.isBuffer(message.message));
    transport.close();
  });
});

test('Nodemailer SMTP auth and HTML sending work with a local fake server', { timeout: 10000 }, async t => {
  const received = [];
  let authenticated = false;
  const server = net.createServer(socket => {
    socket.setEncoding('utf8');
    socket.write('220 localhost test SMTP\r\n');
    let buffer = '', dataMode = false;
    socket.on('data', chunk => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (dataMode) {
          if (line === '.') { dataMode = false; socket.write('250 queued\r\n'); }
          else received.push(line);
        } else if (/^EHLO /.test(line)) socket.write('250-localhost\r\n250 AUTH PLAIN\r\n');
        else if (/^AUTH PLAIN /.test(line)) { authenticated = true; socket.write('235 authenticated\r\n'); }
        else if (/^(MAIL FROM:|RCPT TO:)/.test(line)) socket.write('250 OK\r\n');
        else if (line === 'DATA') { dataMode = true; socket.write('354 send data\r\n'); }
        else if (line === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('500 unsupported\r\n');
      }
    });
  });
  const port = await listen(server, t);
  const transport = require('nodemailer').createTransport({
    host: '127.0.0.1', port, secure: false, ignoreTLS: true,
    auth: { user: 'local-test', pass: 'local-test' }, connectionTimeout: 2000, socketTimeout: 2000,
  });
  t.after(() => transport.close());
  const info = await transport.sendMail({
    from: 'Fund Monitor <sender@example.test>', to: 'receiver@example.test',
    subject: '基金提醒', html: '<p>price: 1.234</p>',
  });
  assert.ok(authenticated);
  assert.deepEqual(info.accepted, ['receiver@example.test']);
  assert.match(received.join('\n'), /price: 1\.234/);
});

test('qs handles attacker-controlled constructor.isBuffer safely', () => {
  const qs = require('qs');
  const value = qs.parse('x[constructor][isBuffer]=y', { plainObjects: true });
  assert.doesNotThrow(() => qs.stringify(value));
  assert.deepEqual(qs.parse('symbol=AAPL&limit=10'), { symbol: 'AAPL', limit: '10' });
});

test('SQLite native binding still supports parameterized reads/writes', async () => {
  const sqlite3 = require('sqlite3');
  const db = await new Promise((resolve, reject) => {
    const instance = new sqlite3.Database(':memory:', e => e ? reject(e) : resolve(instance));
  });
  try {
    await new Promise((resolve, reject) => db.run('CREATE TABLE quotes (symbol TEXT, price REAL)', e => e ? reject(e) : resolve()));
    await new Promise((resolve, reject) => db.run('INSERT INTO quotes VALUES (?, ?)', ['AAPL', 1.234], e => e ? reject(e) : resolve()));
    const row = await new Promise((resolve, reject) => db.get('SELECT * FROM quotes WHERE symbol = ?', ['AAPL'], (e, r) => e ? reject(e) : resolve(r)));
    assert.deepEqual(row, { symbol: 'AAPL', price: 1.234 });
  } finally { await new Promise((resolve, reject) => db.close(e => e ? reject(e) : resolve())); }
});

test('tar selected-member extraction remains compatible', async t => {
  const tar = require('tar');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fund-security-tar-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'out'));
  await fs.writeFile(path.join(dir, 'fixture.txt'), 'security regression');
  await tar.c({ cwd: dir, file: path.join(dir, 'fixture.tgz'), gzip: true }, ['fixture.txt']);
  await tar.x({ cwd: path.join(dir, 'out'), file: path.join(dir, 'fixture.tgz') }, ['fixture.txt']);
  assert.equal(await fs.readFile(path.join(dir, 'out', 'fixture.txt'), 'utf8'), 'security regression');
});

test('tar member selection bounds recursion for hostile long paths', () => {
  isolated(async () => {
    const assert = require('node:assert/strict');
    const options = {};
    // Exercise the exact filesFilter/mapHas path from GHSA-r292-9mhp-454m,
    // without constructing or extracting an untrusted archive on disk.
    require('tar').filesFilter(options, ['selected.txt']);
    assert.equal(options.filter('selected.txt'), true);
    assert.equal(options.filter('a/'.repeat(12000) + 'unselected.txt'), false);
  });
});

test('undici rejects an unrequested WebSocket subprotocol without process crash', () => {
  isolated(async () => {
    const http = require('node:http');
    const { createHash } = require('node:crypto');
    const { WebSocket } = require('undici');
    const server = http.createServer();
    let socket;
    server.on('upgrade', (req, connection) => {
      socket = connection;
      const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\nSec-WebSocket-Protocol: unexpected\r\n\r\n');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
        ws.addEventListener('error', resolve, { once: true });
        ws.addEventListener('open', () => reject(new Error('Invalid handshake accepted')), { once: true });
      });
    } finally {
      if (socket) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    }
  });
});
