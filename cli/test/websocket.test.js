import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { acceptUpgrade, connectWebSocket } from '../src/websocket.js';

async function echoServer(t) {
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => {
    const ws = acceptUpgrade(req, socket, head);
    if (!ws) return;
    ws.on('message', (data, binary) => ws.send(binary ? data : `echo:${data}`));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return server.address().port;
}

const once = (emitter, event) => new Promise((r) => emitter.once(event, (...args) => r(args)));

test('client and server exchange text, large and binary messages', async (t) => {
  const port = await echoServer(t);
  const ws = await connectWebSocket(`ws://127.0.0.1:${port}/`);
  ws.send('hi');
  assert.deepEqual((await once(ws, 'message'))[0], 'echo:hi');

  const big = 'x'.repeat(200000);
  ws.send(big);
  assert.equal((await once(ws, 'message'))[0], `echo:${big}`);

  const bin = randomBytes(70000);
  ws.send(bin);
  const [data, isBinary] = await once(ws, 'message');
  assert.ok(isBinary);
  assert.deepEqual(data, bin);

  ws.ping(Buffer.from('p'));
  assert.equal((await once(ws, 'pong'))[0].toString(), 'p');

  const closed = once(ws, 'close');
  ws.close(1000, 'bye');
  assert.equal((await closed)[0], 1000);
});

test('server reassembles fragmented, masked frames and rejects unmasked ones', async (t) => {
  const port = await echoServer(t);
  const socket = net.connect(port, '127.0.0.1');
  await once(socket, 'connect');
  const key = randomBytes(16).toString('base64');
  socket.write(`GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  const [resp] = await once(socket, 'data');
  const expected = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  assert.match(resp.toString(), new RegExp(`Sec-WebSocket-Accept: ${expected.replace(/[+/]/g, '\\$&')}`));

  const frame = (fin, opcode, text, masked = true) => {
    const payload = Buffer.from(text);
    const mask = randomBytes(4);
    const head = Buffer.from([(fin ? 0x80 : 0) | opcode, (masked ? 0x80 : 0) | payload.length]);
    if (!masked) return Buffer.concat([head, payload]);
    return Buffer.concat([head, mask, Buffer.from(payload.map((b, i) => b ^ mask[i & 3]))]);
  };
  socket.write(Buffer.concat([frame(false, 1, 'hel'), frame(false, 0, 'lo '), frame(true, 0, 'there')]));
  const [reply] = await once(socket, 'data');
  assert.equal(reply.subarray(2).toString(), 'echo:hello there');

  socket.write(frame(true, 1, 'nope', false));
  const [closeFrame] = await once(socket, 'data');
  assert.equal(closeFrame[0] & 0x0f, 8);
  assert.equal(closeFrame.readUInt16BE(2), 1002);
  socket.destroy();
});

test('non-WebSocket upgrades get a 400', async (t) => {
  const port = await echoServer(t);
  const socket = net.connect(port, '127.0.0.1');
  await once(socket, 'connect');
  socket.write('GET / HTTP/1.1\r\nHost: x\r\nUpgrade: h2c\r\nConnection: Upgrade\r\n\r\n');
  const [resp] = await once(socket, 'data');
  assert.match(resp.toString(), /^HTTP\/1\.1 400/);
});
