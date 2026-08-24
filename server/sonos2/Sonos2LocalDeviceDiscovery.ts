import dgram from 'node:dgram';
import os from 'node:os';

export interface Sonos2LocalDevice {
  physicalDeviceId: string;
  address: string;
  descriptionUrl: string;
  avTransportControlUrl: string;
  name?: string;
  model?: string;
  modelNumber?: string;
  serialNumber?: string;
}

function xmlValue(xml: string, name: string): string | undefined {
  return xml
    .match(
      new RegExp(
        `<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`,
        'i',
      ),
    )?.[1]
    ?.trim();
}

export function parseSonos2DeviceDescription(
  xml: string,
  descriptionUrl: string,
): Sonos2LocalDevice | undefined {
  const physicalDeviceId = xmlValue(xml, 'UDN')?.replace(/^uuid:/i, '');

  const avTransportService = [
    ...xml.matchAll(/<service>([\s\S]*?)<\/service>/gi),
  ]
    .map((match) => match[1])
    .find(
      (serviceXml) =>
        xmlValue(serviceXml, 'serviceType') ===
        'urn:schemas-upnp-org:service:AVTransport:1',
    );

  const controlUrl = avTransportService
    ? xmlValue(avTransportService, 'controlURL')
    : undefined;

  if (!physicalDeviceId || !controlUrl) {
    return undefined;
  }

  const description = new URL(descriptionUrl);

  const name =
    xmlValue(xml, 'roomName') ??
    xmlValue(xml, 'friendlyName');

  const model = xmlValue(xml, 'modelName');
  const modelNumber = xmlValue(xml, 'modelNumber');
  const serialNumber =
    xmlValue(xml, 'serialNum') ??
    xmlValue(xml, 'serialNumber');

  return {
    physicalDeviceId,
    address: description.hostname,
    descriptionUrl,
    avTransportControlUrl: new URL(
      controlUrl,
      description,
    ).toString(),
    ...(name ? { name } : {}),
    ...(model ? { model } : {}),
    ...(modelNumber ? { modelNumber } : {}),
    ...(serialNumber ? { serialNumber } : {}),
  };
}

function locationFromSsdp(
  message: Buffer,
): string | undefined {
  return message
    .toString('utf8')
    .match(/^location:\s*(.+)$/im)?.[1]
    ?.trim();
}

export async function discoverSonos2LocalDevices(
  timeoutMs = 1800,
): Promise<Sonos2LocalDevice[]> {
  const networkAddresses = Object.values(
    os.networkInterfaces(),
  ).flatMap((entries) =>
    (entries ?? [])
      .filter(
        (entry) =>
          entry.family === 'IPv4' &&
          !entry.internal,
      )
      .map((entry) => entry.address),
  );

  const locations = new Set<string>();

  await Promise.all(
    networkAddresses.map(
      (address) =>
        new Promise<void>((resolve) => {
          const socket = dgram.createSocket({
            type: 'udp4',
            reuseAddr: true,
          });

          let finished = false;

          const finish = () => {
            if (finished) return;

            finished = true;
            socket.close();
            resolve();
          };

          socket.on('message', (message) => {
            const location =
              locationFromSsdp(message);

            if (location) {
              locations.add(location);
            }
          });

          socket.on('error', finish);

          socket.bind(0, address, () => {
            const request = Buffer.from(
              [
                'M-SEARCH * HTTP/1.1',
                'HOST: 239.255.255.250:1900',
                'MAN: "ssdp:discover"',
                'MX: 1',
                'ST: urn:schemas-upnp-org:device:ZonePlayer:1',
                '',
                '',
              ].join('\r\n'),
            );

            socket.send(
              request,
              1900,
              '239.255.255.250',
            );

            setTimeout(finish, timeoutMs);
          });
        }),
    ),
  );

  const devices: Sonos2LocalDevice[] = [];

  for (const location of locations) {
    try {
      const response = await fetch(location, {
        signal: AbortSignal.timeout(2500),
      });

      if (!response.ok) {
        continue;
      }

      const device =
        parseSonos2DeviceDescription(
          await response.text(),
          location,
        );

      if (
        device &&
        !devices.some(
          (candidate) =>
            candidate.physicalDeviceId ===
            device.physicalDeviceId,
        )
      ) {
        devices.push(device);
      }
    } catch {
      // Ignore one unreachable Sonos response and
      // continue checking the others.
    }
  }

  return devices;
}

export async function discoverSonos2LocalDevice(
  physicalDeviceId: string,
  timeoutMs = 1800,
): Promise<Sonos2LocalDevice | undefined> {
  const devices =
    await discoverSonos2LocalDevices(timeoutMs);

  return devices.find(
    (device) =>
      device.physicalDeviceId === physicalDeviceId,
  );
}