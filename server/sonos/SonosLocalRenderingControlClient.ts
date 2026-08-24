export class SonosLocalRenderingControlError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message); this.status = status; this.name = 'SonosLocalRenderingControlError';
  }
}

function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) throw new Error('Room speaker volume must be a finite number.');
  return Math.max(0, Math.min(100, Math.round(volume)));
}

function parseCurrentVolume(xml: string): number {
  const value = xml.match(/<CurrentVolume(?:\s[^>]*)?>(\d+)<\/CurrentVolume>/i)?.[1];
  if (value === undefined) throw new Error('Sonos GetVolume response did not include CurrentVolume.');
  return clampVolume(Number(value));
}

export class SonosLocalRenderingControlClient {
  async getVolume(controlUrl: string): Promise<number> {
    return parseCurrentVolume(await this.action(
      controlUrl, 'GetVolume', '<InstanceID>0</InstanceID><Channel>Master</Channel>'
    ));
  }

  async setVolume(controlUrl: string, volume: number): Promise<void> {
    const desiredVolume = clampVolume(volume);
    await this.action(controlUrl, 'SetVolume',
      `<InstanceID>0</InstanceID><Channel>Master</Channel><DesiredVolume>${desiredVolume}</DesiredVolume>`);
  }

  private async action(controlUrl: string, action: 'GetVolume' | 'SetVolume', body: string): Promise<string> {
    const service = 'urn:schemas-upnp-org:service:RenderingControl:1';
    const envelope = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${service}">${body}</u:${action}></s:Body></s:Envelope>`;
    const response = await fetch(controlUrl, {
      method: 'POST', signal: AbortSignal.timeout(5_000),
      headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${service}#${action}"` },
      body: envelope,
    });
    const responseBody = await response.text();
    if (!response.ok) {
      const fault = responseBody.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
      throw new SonosLocalRenderingControlError(
        response.status, `Sonos local ${action} failed (${response.status})${fault ? `: ${fault}` : ''}`
      );
    }
    return responseBody;
  }
}

export { clampVolume as clampSonosVolume, parseCurrentVolume as parseSonosCurrentVolume };
