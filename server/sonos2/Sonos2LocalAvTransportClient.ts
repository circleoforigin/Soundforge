function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export type Sonos2AvTransportAction =
  | 'SetAVTransportURI'
  | 'Play'
  | 'Stop'
  | 'GetTransportInfo';

export interface Sonos2TransportInfo {
  currentTransportState: string;
  currentTransportStatus: string;
  currentSpeed: string;
}

export class Sonos2LocalAvTransportError extends Error {
  readonly status: number;

  constructor(
    status: number,
    message: string,
  ) {
    super(message);
    this.status = status;
    this.name =
      'Sonos2LocalAvTransportError';
  }
}

export class Sonos2LocalAvTransportClient {
  async setStreamUri(
    controlUrl: string,
    streamUri: string,
    metadata = '',
  ): Promise<void> {
    await this.action(
      controlUrl,
      'SetAVTransportURI',
      [
        '<InstanceID>0</InstanceID>',
        `<CurrentURI>${escapeXml(
          streamUri,
        )}</CurrentURI>`,
        `<CurrentURIMetaData>${escapeXml(
          metadata,
        )}</CurrentURIMetaData>`,
      ].join(''),
    );
  }

  async play(
    controlUrl: string,
  ): Promise<void> {
    await this.action(
      controlUrl,
      'Play',
      [
        '<InstanceID>0</InstanceID>',
        '<Speed>1</Speed>',
      ].join(''),
    );
  }

  async stop(
    controlUrl: string,
  ): Promise<void> {
    await this.action(
      controlUrl,
      'Stop',
      '<InstanceID>0</InstanceID>',
    );
  }

  async getTransportInfo(
    controlUrl: string,
  ): Promise<Sonos2TransportInfo> {
    const responseText = await this.action(
      controlUrl,
      'GetTransportInfo',
      '<InstanceID>0</InstanceID>',
    );

    return {
      currentTransportState:
        xmlResponseValue(
          responseText,
          'CurrentTransportState',
        ) ?? 'UNKNOWN',
      currentTransportStatus:
        xmlResponseValue(
          responseText,
          'CurrentTransportStatus',
        ) ?? 'UNKNOWN',
      currentSpeed:
        xmlResponseValue(
          responseText,
          'CurrentSpeed',
        ) ?? '1',
    };
  }

  private async action(
    controlUrl: string,
    action: Sonos2AvTransportAction,
    body: string,
  ): Promise<string> {
    const service =
      'urn:schemas-upnp-org:service:AVTransport:1';

    const envelope = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<s:Envelope',
      ' xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"',
      ' s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">',
      '<s:Body>',
      `<u:${action} xmlns:u="${service}">`,
      body,
      `</u:${action}>`,
      '</s:Body>',
      '</s:Envelope>',
    ].join('');

    const response = await fetch(controlUrl, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
      headers: {
        'Content-Type':
          'text/xml; charset="utf-8"',
        SOAPAction:
          `"${service}#${action}"`,
      },
      body: envelope,
    });

    const responseText =
      await response.text();

    if (!response.ok) {
      const fault = responseText
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 500);

      throw new Sonos2LocalAvTransportError(
        response.status,
        `Sonos ${action} failed (${response.status})${
          fault ? `: ${fault}` : ''
        }`,
      );
    }

    return responseText;
  }
}

function xmlResponseValue(
  xml: string,
  name: string,
): string | undefined {
  return xml
    .match(
      new RegExp(
        `<${name}[^>]*>([\\s\\S]*?)</${name}>`,
        'i',
      ),
    )?.[1]
    ?.trim();
}