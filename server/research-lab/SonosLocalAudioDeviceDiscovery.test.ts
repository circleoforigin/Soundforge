import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeSonosLocalAudioDevices } from './SonosLocalAudioDeviceDiscovery.ts';

test('local devices with duplicate room names retain distinct physical identities and metadata', () => {
  const devices = normalizeSonosLocalAudioDevices([
    {
      physicalDeviceId: 'RINCON_00000000DB6A01400', address: '192.168.1.21',
      descriptionUrl: 'http://192.168.1.21:1400/xml/device_description.xml',
      avTransportControlUrl: 'http://192.168.1.21:1400/MediaRenderer/AVTransport/Control',
      name: 'Living Room', model: 'PLAY:1', modelNumber: 'S1', serialNumber: 'SERIAL-DB6A',
    },
    {
      physicalDeviceId: 'RINCON_00000000DE0001400', address: '192.168.1.22',
      descriptionUrl: 'http://192.168.1.22:1400/xml/device_description.xml',
      avTransportControlUrl: 'http://192.168.1.22:1400/MediaRenderer/AVTransport/Control',
      name: 'Living Room', model: 'Era 100', modelNumber: 'S39', serialNumber: 'SERIAL-DE00',
    },
  ]);
  assert.equal(devices.length, 2);
  assert.equal(new Set(devices.map((device) => device.id)).size, 2);
  assert.deepEqual(devices.map((device) => device.name), ['Living Room', 'Living Room']);
  assert.deepEqual(devices.map((device) => device.model), ['PLAY:1', 'Era 100']);
  assert.equal(devices[0].identity.providerIdentifier, 'RINCON_00000000DB6A01400');
  assert.equal(devices[1].identity.networkAddress, '192.168.1.22');
  assert.equal(devices[0].identity.serialNumber, 'SERIAL-DB6A');
});

test('local device normalization tolerates absent optional model metadata', () => {
  const [device] = normalizeSonosLocalAudioDevices([{
    physicalDeviceId: 'RINCON_UNKNOWN01400', address: '192.168.1.30',
    descriptionUrl: 'http://192.168.1.30:1400/xml/device_description.xml',
    avTransportControlUrl: 'http://192.168.1.30:1400/MediaRenderer/AVTransport/Control',
    name: 'Living Room',
  }]);
  assert.equal(device.model, undefined);
  assert.equal(device.identity.providerIdentifier, 'RINCON_UNKNOWN01400');
});
