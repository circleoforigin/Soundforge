import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { SonosLocalAvTransportClient } from './SonosLocalAvTransportClient.ts';

test('local AVTransport sends escaped SetAVTransportURI followed by Play', async () => {
  const requests: Array<{ action: string | undefined; body: string }> = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8'); request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => { requests.push({ action: request.headers.soapaction, body }); response.end('<ok/>'); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const client = new SonosLocalAvTransportClient();
    const url = `http://127.0.0.1:${address.port}/control`;
    await client.setStreamUri(url, 'x-rincon-mp3radio://127.0.0.1/a&b.aac');
    await client.play(url);
    assert.match(requests[0].action ?? '', /SetAVTransportURI/);
    assert.match(requests[0].body, /a&amp;b\.aac/);
    assert.match(requests[0].body, /<CurrentURIMetaData><\/CurrentURIMetaData>/);
    assert.doesNotMatch(requests[0].body, /duration|protocolInfo|upnp:class/i);
    assert.match(requests[1].action ?? '', /#Play/);
  } finally { server.close(); }
});

test('local AVTransport carries escaped broadcast DIDL metadata when provided', async () => {
  let body = '';
  const server = http.createServer((request, response) => {
    request.setEncoding('utf8'); request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => response.end('<ok/>'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const metadata = '<DIDL-Lite><item><upnp:class>object.item.audioItem.audioBroadcast</upnp:class></item></DIDL-Lite>';
    await new SonosLocalAvTransportClient().setStreamUri(
      `http://127.0.0.1:${address.port}/control`, 'http://127.0.0.1/live.wav', metadata
    );
    assert.match(body, /&lt;DIDL-Lite&gt;/);
    assert.match(body, /audioItem\.audioBroadcast/);
  } finally { server.close(); }
});
