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

test('device description retains physical presentation metadata when available', () => {
  const device = parseSonosDeviceDescription(`
    <root><device>
      <roomName>Living Room</roomName><friendlyName>Living Room</friendlyName>
      <modelName>PLAY:1</modelName><modelNumber>S1</modelNumber>
      <serialNum>00-11-22-33-DB-6A</serialNum><UDN>uuid:RINCON_00112233DB6A01400</UDN>
      <serviceList><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
      <controlURL>/MediaRenderer/AVTransport/Control</controlURL></service>
      <service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>
      <controlURL>/MediaRenderer/RenderingControl/Control</controlURL></service></serviceList>
    </device></root>`, 'http://192.168.1.25:1400/xml/device_description.xml');
  assert.equal(device?.name, 'Living Room');
  assert.equal(device?.model, 'PLAY:1');
  assert.equal(device?.modelNumber, 'S1');
  assert.equal(device?.serialNumber, '00-11-22-33-DB-6A');
  assert.equal(device?.physicalDeviceId, 'RINCON_00112233DB6A01400');
  assert.equal(device?.address, '192.168.1.25');
  assert.equal(device?.renderingControlUrl, 'http://192.168.1.25:1400/MediaRenderer/RenderingControl/Control');
});
