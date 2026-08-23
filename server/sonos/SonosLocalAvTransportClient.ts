function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

export class SonosLocalAvTransportError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message); this.status = status; this.name = 'SonosLocalAvTransportError';
  }
}
export class SonosLocalAvTransportClient {
  async setStreamUri(controlUrl: string, streamUri: string, metadata = ''): Promise<void> {
    await this.action(controlUrl, 'SetAVTransportURI',
      `<InstanceID>0</InstanceID><CurrentURI>${escapeXml(streamUri)}</CurrentURI><CurrentURIMetaData>${escapeXml(metadata)}</CurrentURIMetaData>`);
  }

  async play(controlUrl: string): Promise<void> {
    await this.action(controlUrl, 'Play', '<InstanceID>0</InstanceID><Speed>1</Speed>');
  }

  async stop(controlUrl: string): Promise<void> {
    await this.action(controlUrl, 'Stop', '<InstanceID>0</InstanceID>');
  }

  private async action(controlUrl: string, action: string, body: string): Promise<void> {
    const service = 'urn:schemas-upnp-org:service:AVTransport:1';
    const envelope = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${service}">${body}</u:${action}></s:Body></s:Envelope>`;
    const response = await fetch(controlUrl, {
      method: 'POST', signal: AbortSignal.timeout(5_000),
      headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${service}#${action}"` },
      body: envelope,
    });
    if (!response.ok) {
      const fault = (await response.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
      throw new SonosLocalAvTransportError(response.status, `Sonos local ${action} failed (${response.status})${fault ? `: ${fault}` : ''}`);
    }
  }
}
