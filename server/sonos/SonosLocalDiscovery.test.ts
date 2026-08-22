import assert from 'node:assert/strict';
import test from 'node:test';

import { parseSonosDeviceDescription } from './SonosLocalDiscovery.ts';

test('device description resolves a physical RINCON and AVTransport control URL', () => {
  const device = parseSonosDeviceDescription(`
    <root><device><UDN>uuid:RINCON_TEST01400</UDN><serviceList>
      <service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
      <controlURL>/MediaRenderer/AVTransport/Control</controlURL></service>
    </serviceList></device></root>`, 'http://192.168.1.25:1400/xml/device_description.xml');
  assert.equal(device?.physicalDeviceId, 'RINCON_TEST01400');
  assert.equal(device?.address, '192.168.1.25');
  assert.equal(device?.avTransportControlUrl, 'http://192.168.1.25:1400/MediaRenderer/AVTransport/Control');
});
