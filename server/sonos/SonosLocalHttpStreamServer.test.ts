import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';

import { SonosLocalHttpStreamServer } from './SonosLocalHttpStreamServer.ts';

test('local stream server emits non-chunked HTTP/1.0 AAC headers and binds one client', async () => {
  let bound = 0;
  const server = new SonosLocalHttpStreamServer({
    streamId: 'stream-test', bindAddress: '127.0.0.1',
    onClient: (client) => { bound += 1; client.write(Buffer.from([0xff, 0xf1])); },
    onDiagnostic: () => undefined,
  });
  const port = await server.listen();
  const payload = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = net.connect(port, '127.0.0.1', () => socket.write('GET /stream.aac HTTP/1.0\r\nUser-Agent: test\r\n\r\n'));
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).includes(Buffer.from([0xff, 0xf1]))) {
        resolve(Buffer.concat(chunks)); socket.destroy();
      }
    });
    socket.on('error', reject);
  });
  await server.close();
  const text = payload.toString('latin1');
  assert.match(text, /^HTTP\/1\.0 200 OK/);
  assert.match(text, /Content-Type: audio\/aac/i);
  assert.doesNotMatch(text, /Transfer-Encoding|Content-Length/i);
  assert.equal(bound, 1);
});
