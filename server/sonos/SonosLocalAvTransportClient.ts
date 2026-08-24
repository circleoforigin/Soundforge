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

export interface SonosLocalAvTransportRequestDiagnostic {
  action: 'BecomeCoordinatorOfStandaloneGroup' | 'SetAVTransportURI' | 'Play' | 'Stop';
  requestStartedAt: string;
  responseReceivedAt: string | null;
  timeoutAt: string | null;
  httpStatus: number | null;
  elapsedMs: number;
  timedOut: boolean;
}

interface SonosLocalAvTransportRequestOptions {
  onDiagnostic?: (diagnostic: SonosLocalAvTransportRequestDiagnostic) => void;
}

export class SonosLocalAvTransportClient {
  async becomeCoordinatorOfStandaloneGroup(
    controlUrl: string,
    options: SonosLocalAvTransportRequestOptions = {}
  ): Promise<void> {
    await this.action(
      controlUrl,
      'BecomeCoordinatorOfStandaloneGroup',
      '<InstanceID>0</InstanceID>',
      options
    );
  }

  async setStreamUri(
    controlUrl: string,
    streamUri: string,
    metadata = '',
    options: SonosLocalAvTransportRequestOptions = {}
  ): Promise<void> {
    await this.action(controlUrl, 'SetAVTransportURI',
      `<InstanceID>0</InstanceID><CurrentURI>${escapeXml(streamUri)}</CurrentURI><CurrentURIMetaData>${escapeXml(metadata)}</CurrentURIMetaData>`, options);
  }

  async play(controlUrl: string, options: SonosLocalAvTransportRequestOptions = {}): Promise<void> {
    await this.action(controlUrl, 'Play', '<InstanceID>0</InstanceID><Speed>1</Speed>', options);
  }

  async stop(controlUrl: string, options: SonosLocalAvTransportRequestOptions = {}): Promise<void> {
    await this.action(controlUrl, 'Stop', '<InstanceID>0</InstanceID>', options);
  }

  private async action(
    controlUrl: string,
    action: SonosLocalAvTransportRequestDiagnostic['action'],
    body: string,
    options: SonosLocalAvTransportRequestOptions
  ): Promise<void> {
    const service = 'urn:schemas-upnp-org:service:AVTransport:1';
    const envelope = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${service}">${body}</u:${action}></s:Body></s:Envelope>`;
    const requestStartedAt = new Date();
    let response: Response;
    try {
      response = await fetch(controlUrl, {
        method: 'POST', signal: AbortSignal.timeout(5_000),
        headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${service}#${action}"` },
        body: envelope,
      });
    } catch (error) {
      const completedAt = new Date();
      const timedOut = typeof error === 'object' && error !== null
        && ((error as { name?: unknown }).name === 'TimeoutError'
          || /aborted due to timeout/i.test(String((error as { message?: unknown }).message ?? '')));
      options.onDiagnostic?.({
        action, requestStartedAt: requestStartedAt.toISOString(), responseReceivedAt: null,
        timeoutAt: timedOut ? completedAt.toISOString() : null, httpStatus: null,
        elapsedMs: completedAt.getTime() - requestStartedAt.getTime(), timedOut,
      });
      if (timedOut) {
        const timeout = new Error(`Sonos local ${action} timed out after 5000 ms`, { cause: error });
        timeout.name = 'TimeoutError';
        throw timeout;
      }
      throw error;
    }
    const responseReceivedAt = new Date();
    options.onDiagnostic?.({
      action, requestStartedAt: requestStartedAt.toISOString(),
      responseReceivedAt: responseReceivedAt.toISOString(), timeoutAt: null,
      httpStatus: response.status, elapsedMs: responseReceivedAt.getTime() - requestStartedAt.getTime(),
      timedOut: false,
    });
    if (!response.ok) {
      const fault = (await response.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
      throw new SonosLocalAvTransportError(response.status, `Sonos local ${action} failed (${response.status})${fault ? `: ${fault}` : ''}`);
    }
  }
}
