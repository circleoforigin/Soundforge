import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import type {
  AudioStreamListResponse,
  AudioStreamSnapshotResponse,
} from '../../src/models/ResearchLab.ts';
import { ContinuousAudioStreamManager } from '../audio/ContinuousAudioStreamManager.ts';
import { ContinuousStreamTransportRegistry } from '../audio/transports/ContinuousStreamTransportRegistry.ts';
import { ResearchLabStreamService } from '../research-lab/ResearchLabStreamService.ts';
import {
  indefiniteStreamContentLength,
  registerResearchLabStreamRoute,
} from './ResearchLabStreamRoute.ts';

test('Research Lab stream diagnostics routes return list, snapshot, and not-found responses', async () => {
  const manager = new ContinuousAudioStreamManager();
  const stream = manager.create({ deviceId: 'route-test-device' });
  const service = new ResearchLabStreamService(
    manager,
    new ContinuousStreamTransportRegistry(),
    async () => []
  );
  const app = express();
  registerResearchLabStreamRoute(app, { manager, service });
  const server = app.listen(0, '127.0.0.1');

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const listResponse = await fetch(`${baseUrl}/api/research-lab/streams`);
    assert.equal(listResponse.status, 200);
    const list = await listResponse.json() as AudioStreamListResponse;
    assert.equal(list.ok, true);
    assert.ok(list.streams.some((candidate) => candidate.id === stream.id));

    const snapshotResponse = await fetch(
      `${baseUrl}/api/research-lab/streams/${encodeURIComponent(stream.id)}`
    );
    assert.equal(snapshotResponse.status, 200);
    const snapshot = await snapshotResponse.json() as AudioStreamSnapshotResponse;
    assert.equal(snapshot.stream.id, stream.id);
    assert.equal(snapshot.stream.deviceId, 'route-test-device');

    const missingResponse = await fetch(
      `${baseUrl}/api/research-lab/streams/missing-stream`
    );
    assert.equal(missingResponse.status, 404);

    const invalidFramingResponse = await fetch(`${baseUrl}/api/research-lab/streams`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'route-test-device',
        transportId: 'test-transport',
        httpFramingMode: 'invalid-mode',
      }),
    });
    assert.equal(invalidFramingResponse.status, 400);

    stream.start();
    await stream.waitUntilReadyForClient();
    await new Promise<void>((resolve, reject) => {
      const request = http.get(
        `${baseUrl}/api/research-lab/streams/${encodeURIComponent(stream.id)}/live.mp3`,
        {
          headers: {
            Accept: 'audio/mpeg',
            Connection: 'keep-alive',
            Range: 'bytes=0-',
            'User-Agent': 'ResearchLabRouteTest/1.0',
          },
        },
        (response) => {
          assert.equal(response.headers['transfer-encoding'], 'chunked');
          assert.equal(response.headers['content-length'], undefined);
          response.once('data', () => {
            response.destroy();
            resolve();
          });
          response.once('error', reject);
        }
      );
      request.once('error', reject);
    });
    const httpSnapshot = manager.getSnapshot(stream.id);
    const requestMetadata = httpSnapshot?.recentEvents.find(
      (event) => event.code === 'http-request-metadata'
    );
    const responseMetadata = httpSnapshot?.recentEvents.find(
      (event) => event.code === 'http-response-metadata'
    );
    assert.equal(requestMetadata?.details?.method, 'GET');
    assert.equal(requestMetadata?.details?.userAgent, 'ResearchLabRouteTest/1.0');
    assert.equal(requestMetadata?.details?.range, 'bytes=0-');
    assert.equal(responseMetadata?.details?.statusCode, 200);
    assert.equal(responseMetadata?.details?.contentType, 'audio/mpeg');
    assert.equal(responseMetadata?.details?.transferEncoding, 'chunked');
  } finally {
    manager.stopAll('route test cleanup');
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test('indefinite framing sends Content-Length without chunked encoding and stops cleanly', async () => {
  const manager = new ContinuousAudioStreamManager();
  const stream = manager.create({
    deviceId: 'indefinite-route-device',
    httpFramingMode: 'indefinite-content-length',
  });
  const service = new ResearchLabStreamService(
    manager,
    new ContinuousStreamTransportRegistry(),
    async () => []
  );
  const app = express();
  registerResearchLabStreamRoute(app, { manager, service });
  const server = app.listen(0, '127.0.0.1');

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    stream.start();
    await stream.waitUntilReadyForClient();
    const startupBytes = stream.getSnapshot().encoder.startupBufferBytes;
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    let firstBodyChunk: Buffer | undefined;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      const request = http.get(
        `${baseUrl}/api/research-lab/streams/${encodeURIComponent(stream.id)}/live.mp3`,
        (response) => {
          assert.equal(response.statusCode, 200);
          assert.equal(response.headers['content-type'], 'audio/mpeg');
          assert.equal(response.headers['content-length'], String(indefiniteStreamContentLength));
          assert.equal(response.headers['transfer-encoding'], undefined);
          response.once('data', (chunk: Buffer) => {
            firstBodyChunk = Buffer.from(chunk);
            manager.stop(stream.id, 'indefinite framing route test');
          });
          response.once('aborted', () => finish());
          response.once('close', () => finish());
          response.once('error', (error) => {
            if ((error as NodeJS.ErrnoException).code === 'ECONNRESET') {
              finish();
            } else {
              finish(error);
            }
          });
        }
      );
      request.once('error', finish);
    });

    assert.ok(firstBodyChunk);
    assert.ok(firstBodyChunk.length >= startupBytes);
    const beginsWithId3 = firstBodyChunk.subarray(0, 3).toString('ascii') === 'ID3';
    const beginsWithMpegFrameSync =
      firstBodyChunk[0] === 0xff && (firstBodyChunk[1] & 0xe0) === 0xe0;
    assert.ok(beginsWithId3 || beginsWithMpegFrameSync);
    const retained = manager.getSnapshot(stream.id);
    assert.equal(retained?.lifecycle, 'stopped');
    assert.equal(retained?.httpClient.framingMode, 'indefinite-content-length');
    const responseDiagnostic = retained?.recentEvents.find(
      (event) => event.code === 'http-response-metadata'
    );
    assert.equal(responseDiagnostic?.details?.httpFramingMode, 'indefinite-content-length');
    assert.equal(responseDiagnostic?.details?.transferEncoding, null);
    assert.equal(
      responseDiagnostic?.details?.contentLength,
      String(indefiniteStreamContentLength)
    );
    const startupFlush = retained?.recentEvents.find(
      (event) => event.code === 'startup-buffer-flushed'
    );
    assert.equal(startupFlush?.details?.chunkBytes, startupBytes);
    assert.equal(startupFlush?.details?.beganAtEncodedByte, 0);
    assert.ok(retained?.recentEvents.some((event) => event.code === 'indefinite-response-started'));
  } finally {
    manager.stopAll('indefinite route test cleanup');
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});
