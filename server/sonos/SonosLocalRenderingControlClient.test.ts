import assert from 'node:assert/strict';
import test from 'node:test';
import { SonosLocalRenderingControlClient, parseSonosCurrentVolume } from './SonosLocalRenderingControlClient.ts';

test('GetVolume parses the Master CurrentVolume response', async () => {
  assert.equal(parseSonosCurrentVolume('<GetVolumeResponse><CurrentVolume>47</CurrentVolume></GetVolumeResponse>'), 47);
  const originalFetch = globalThis.fetch;
  let body = ''; let soapAction = '';
  globalThis.fetch = async (_url, init) => {
    body = String(init?.body); soapAction = String((init?.headers as Record<string, string>).SOAPAction);
    return new Response('<CurrentVolume>31</CurrentVolume>', { status: 200 });
  };
  try {
    assert.equal(await new SonosLocalRenderingControlClient().getVolume('http://speaker/rendering'), 31);
    assert.match(body, /<InstanceID>0<\/InstanceID><Channel>Master<\/Channel>/);
    assert.match(soapAction, /RenderingControl:1#GetVolume/);
  } finally { globalThis.fetch = originalFetch; }
});

test('SetVolume sends one clamped integer DesiredVolume to Master', async () => {
  const originalFetch = globalThis.fetch;
  const bodies: string[] = [];
  globalThis.fetch = async (_url, init) => { bodies.push(String(init?.body)); return new Response('', { status: 200 }); };
  try {
    const client = new SonosLocalRenderingControlClient();
    await client.setVolume('http://speaker/rendering', 49.6);
    await client.setVolume('http://speaker/rendering', 200);
    await client.setVolume('http://speaker/rendering', -5);
    assert.match(bodies[0], /<InstanceID>0<\/InstanceID><Channel>Master<\/Channel><DesiredVolume>50<\/DesiredVolume>/);
    assert.match(bodies[1], /<DesiredVolume>100<\/DesiredVolume>/);
    assert.match(bodies[2], /<DesiredVolume>0<\/DesiredVolume>/);
  } finally { globalThis.fetch = originalFetch; }
});
