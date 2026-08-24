import dgram from 'node:dgram';
import os from 'node:os';

export interface SonosLocalDevice {
  physicalDeviceId: string;
  address: string;
  descriptionUrl: string;
  avTransportControlUrl: string;
  renderingControlUrl?: string;
  name?: string;
  model?: string;
  modelNumber?: string;
  serialNumber?: string;
}

function xmlValue(xml: string, name: string): string | undefined {
  return xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'))?.[1]?.trim();
}

export function parseSonosDeviceDescription(xml: string, descriptionUrl: string): SonosLocalDevice | undefined {
  const udn = xmlValue(xml, 'UDN')?.replace(/^uuid:/i, '');
  const services = [...xml.matchAll(/<service>([\s\S]*?)<\/service>/gi)].map((match) => match[1]);
  const service = services.find((value) => xmlValue(value, 'serviceType') === 'urn:schemas-upnp-org:service:AVTransport:1');
  const renderingService = services.find((value) => xmlValue(value, 'serviceType') === 'urn:schemas-upnp-org:service:RenderingControl:1');
  const controlUrl = service ? xmlValue(service, 'controlURL') : undefined;
  const renderingControlUrl = renderingService ? xmlValue(renderingService, 'controlURL') : undefined;
  if (!udn || !controlUrl) return undefined;
  const base = new URL(descriptionUrl);
  return {
    physicalDeviceId: udn,
    address: base.hostname,
    descriptionUrl,
    avTransportControlUrl: new URL(controlUrl, base).toString(),
    ...(renderingControlUrl ? { renderingControlUrl: new URL(renderingControlUrl, base).toString() } : {}),
    ...(xmlValue(xml, 'roomName') || xmlValue(xml, 'friendlyName') ? { name: xmlValue(xml, 'roomName') ?? xmlValue(xml, 'friendlyName') } : {}),
    ...(xmlValue(xml, 'modelName') ? { model: xmlValue(xml, 'modelName') } : {}),
    ...(xmlValue(xml, 'modelNumber') ? { modelNumber: xmlValue(xml, 'modelNumber') } : {}),
    ...(xmlValue(xml, 'serialNum') || xmlValue(xml, 'serialNumber')
      ? { serialNumber: xmlValue(xml, 'serialNum') ?? xmlValue(xml, 'serialNumber') }
      : {}),
  };
}

function locationsFromResponse(message: Buffer): string | undefined {
  return message.toString('utf8').match(/^location:\s*(.+)$/im)?.[1]?.trim();
}

export async function discoverLocalSonosDevices(
  timeoutMs = 1_800
): Promise<SonosLocalDevice[]> {
  const addresses = Object.values(os.networkInterfaces()).flatMap((entries) =>
    (entries ?? []).filter((entry) => entry.family === 'IPv4' && !entry.internal).map((entry) => entry.address)
  );
  const locations = new Set<string>();
  await Promise.all(addresses.map((address) => new Promise<void>((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      socket.close();
      resolve();
    };
    socket.on('message', (message) => {
      const location = locationsFromResponse(message);
      if (location) locations.add(location);
    });
    socket.on('error', finish);
    socket.bind(0, address, () => {
      const request = Buffer.from([
        'M-SEARCH * HTTP/1.1', 'HOST: 239.255.255.250:1900',
        'MAN: "ssdp:discover"', 'MX: 1',
        'ST: urn:schemas-upnp-org:device:ZonePlayer:1', '', '',
      ].join('\r\n'));
      socket.send(request, 1900, '239.255.255.250');
      setTimeout(finish, timeoutMs);
    });
  })));

  const devices: SonosLocalDevice[] = [];
  for (const location of locations) {
    try {
      const response = await fetch(location, { signal: AbortSignal.timeout(2_500) });
      if (!response.ok) continue;
      const device = parseSonosDeviceDescription(await response.text(), location);
      if (device && !devices.some((item) => item.physicalDeviceId === device.physicalDeviceId)) devices.push(device);
    } catch {
      // A stale or unreachable SSDP response must not prevent checking other devices.
    }
  }
  return devices;
}

export async function discoverLocalSonosDevice(
  physicalDeviceId: string,
  timeoutMs = 1_800
): Promise<SonosLocalDevice | undefined> {
  return (await discoverLocalSonosDevices(timeoutMs)).find((device) => device.physicalDeviceId === physicalDeviceId);
}
