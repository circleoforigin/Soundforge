import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SonosApiError,
  SonosClient,
  SonosTopologyTimeoutError,
} from './SonosClient.ts';

test('Sonos topology household and group requests have bounded timeouts', async () => {
  const hangingFetch: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
  });
  const client = new SonosClient({
    fetch: hangingFetch,
    topologyTimeoutMs: 20,
    accessTokenProvider: async () => 'test-token',
  });
  await assert.rejects(client.getHouseholds(), SonosTopologyTimeoutError);
  await assert.rejects(client.getGroups('home'), SonosTopologyTimeoutError);
});

test('Sonos 429 preserves rate-limit and retry metadata', async () => {
  const client = new SonosClient({
    accessTokenProvider: async () => 'test-token',
    fetch: async () => new Response(JSON.stringify({ reason: 'spike arrest' }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'RateLimit-Limit': '100',
        'RateLimit-Remaining': '0',
        'RateLimit-Reset': '42',
        'Retry-After': '32',
      },
    }),
  });
  await assert.rejects(client.getHouseholds(), (error: unknown) => {
    assert.ok(error instanceof SonosApiError);
    assert.equal(error.status, 429);
    assert.deepEqual(error.rateLimit, {
      limit: '100', remaining: '0', reset: '42', retryAfter: '32',
    });
    assert.match(error.message, /retry after 32 seconds/i);
    return true;
  });
});
