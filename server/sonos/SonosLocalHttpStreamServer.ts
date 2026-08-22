import net, { type Socket } from 'node:net';

interface LocalStreamServerOptions {
  streamId: string;
  bindAddress: string;
  onClient(client: Socket): void;
  onDiagnostic(message: string, details?: Record<string, unknown>): void;
}

export class SonosLocalHttpStreamServer {
  private readonly options: LocalStreamServerOptions;
  private readonly server: net.Server;
  private clientAccepted = false;
  private client: Socket | null = null;

  constructor(options: LocalStreamServerOptions) {
    this.options = options;
    this.server = net.createServer((socket) => this.handle(socket));
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
    this.client?.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private handle(socket: Socket): void {
    let request = Buffer.alloc(0);
    socket.once('data', (chunk) => {
      request = Buffer.concat([request, chunk]);
      const text = request.toString('latin1');
      const [line = '', ...headers] = text.split('\r\n');
      const [method, path, version] = line.split(' ');
      this.options.onDiagnostic('Sonos local stream HTTP request received.', {
        method, path, version, remoteAddress: socket.remoteAddress,
        userAgent: headers.find((header) => /^user-agent:/i.test(header))?.slice(11).trim() ?? null,
        range: headers.find((header) => /^range:/i.test(header))?.slice(6).trim() ?? null,
      });
      if (method !== 'GET' || this.clientAccepted) {
        socket.end(`HTTP/1.0 ${this.clientAccepted ? '409 Conflict' : '405 Method Not Allowed'}\r\nConnection: close\r\n\r\n`);
        return;
      }
      this.clientAccepted = true;
      this.client = socket;
      socket.write('HTTP/1.0 200 OK\r\nContent-Type: audio/aac\r\nCache-Control: no-store, no-cache, must-revalidate, no-transform\r\nConnection: close\r\n\r\n');
      this.options.onDiagnostic('Sonos local non-chunked HTTP/1.0 response started.', {
        contentType: 'audio/aac', transferEncoding: null, contentLength: null,
      });
      this.options.onClient(socket);
    });
    socket.setTimeout(5_000, () => {
      if (!this.clientAccepted) socket.destroy(new Error('Local stream request timed out.'));
    });
  }
}
