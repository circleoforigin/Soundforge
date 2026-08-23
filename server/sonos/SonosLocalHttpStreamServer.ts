import net, { type Socket } from 'node:net';

interface LocalStreamServerOptions {
  streamId: string;
  bindAddress: string;
  onClient(client: Socket, metadata: {
    remoteAddress?: string;
    httpVersion?: string;
    userAgent?: string;
    range?: string;
    role: 'startup-consumer' | 'startup-reconnect';
    phase: string;
  }): void;
  onDiagnostic(message: string, details?: Record<string, unknown>): void;
}

export class SonosLocalHttpStreamServer {
  private readonly options: LocalStreamServerOptions;
  private readonly server: net.Server;
  private client: Socket | null = null;
  private connectionOrdinal = 0;
  private closePromise: Promise<void> | null = null;

  constructor(options: LocalStreamServerOptions) {
    this.options = options;
    this.server = net.createServer((socket) => this.handle(socket));
    this.server.on('error', (error) => {
      this.options.onDiagnostic('Sonos local stream listener error.', {
        code: (error as NodeJS.ErrnoException).code ?? null,
        message: error.message,
      });
    });
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, this.options.bindAddress, () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Local stream listener did not obtain a TCP port.');
    return address.port;
  }

  async close(): Promise<void> {
    if (!this.closePromise) {
      this.closePromise = new Promise<void>((resolve, reject) => {
        this.client?.destroy();
        if (!this.server.listening) {
          resolve();
          return;
        }
        this.server.close((error) => {
          if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
    await this.closePromise;
  }

  private handle(socket: Socket): void {
    let request = Buffer.alloc(0);
    socket.on('error', (error) => {
      this.options.onDiagnostic('Sonos local stream socket error.', {
        code: (error as NodeJS.ErrnoException).code ?? null,
        message: error.message,
        remoteAddress: socket.remoteAddress,
      });
    });
    socket.once('data', (chunk) => {
      request = Buffer.concat([request, chunk]);
      const text = request.toString('latin1');
      const [line = '', ...headers] = text.split('\r\n');
      const [method, path, version] = line.split(' ');
      const userAgent = headers.find((header) => /^user-agent:/i.test(header))?.slice(11).trim();
      const range = headers.find((header) => /^range:/i.test(header))?.slice(6).trim();
      const ordinal = this.connectionOrdinal + 1;
      this.options.onDiagnostic('Sonos local stream HTTP request received.', {
        method, path, version, remoteAddress: socket.remoteAddress,
        userAgent: userAgent ?? null,
        range: range ?? null,
        connectionOrdinal: ordinal,
        radioStyleUserAgent: /Nullsoft Winamp3/i.test(userAgent ?? ''),
      });
      if (method !== 'GET' || (this.client && !this.client.destroyed)) {
        socket.end(`HTTP/1.0 ${this.client && !this.client.destroyed ? '409 Conflict' : '405 Method Not Allowed'}\r\nConnection: close\r\n\r\n`);
        return;
      }
      this.connectionOrdinal = ordinal;
      this.client = socket;
      socket.once('close', () => { if (this.client === socket) this.client = null; });
      socket.write('HTTP/1.0 200 OK\r\nContent-Type: audio/aac\r\nCache-Control: no-store, no-cache, must-revalidate, no-transform\r\nConnection: close\r\n\r\n');
      this.options.onDiagnostic('Sonos local non-chunked HTTP/1.0 response started.', {
        contentType: 'audio/aac', transferEncoding: null, contentLength: null,
      });
      this.options.onClient(socket, {
        ...(socket.remoteAddress ? { remoteAddress: socket.remoteAddress } : {}),
        ...(version ? { httpVersion: version } : {}),
        ...(userAgent ? { userAgent } : {}),
        ...(range ? { range } : {}),
        role: ordinal === 1 ? 'startup-consumer' : 'startup-reconnect',
        phase: ordinal === 1 ? 'startup-consumer' : 'awaiting-startup-reconnect',
      });
    });
    socket.setTimeout(5_000, () => {
      if (this.client !== socket) {
        this.options.onDiagnostic('Sonos local stream request timed out.', {
          remoteAddress: socket.remoteAddress,
          timeoutMs: 5_000,
        });
        socket.destroy();
      }
    });
  }
}
