import net, {
  type Server,
  type Socket,
} from 'node:net';

export type Sonos2HttpConnectionState =
  | 'waiting'
  | 'connected'
  | 'disconnected'
  | 'error';

export type Sonos2DeliveryKind =
  | 'wav-prefix'
  | 'live-audio';

export interface Sonos2HttpConsumerInfo {
  ordinal: number;
  remoteAddress?: string;
  userAgent?: string;
  range?: string;
  connectedAt: string;
}

export interface Sonos2HttpConsumerDelivery {
  consumer: Sonos2HttpConsumerInfo;
  kind: Sonos2DeliveryKind;
  byteLength: number;
  totalBytesDelivered: number;
  wavPrefixDelivered: boolean;
  liveBytesDelivered: boolean;
  deliveredAt: string;
}

interface Sonos2LocalHttpStreamServerOptions {
  bindAddress: string;
  contentType: string;

  onConsumerConnected(
    consumer: Sonos2HttpConsumerInfo,
  ): void;

  onConsumerDelivery?(
    delivery: Sonos2HttpConsumerDelivery,
  ): void;

  onConsumerDisconnected?(
    consumer: Sonos2HttpConsumerInfo,
  ): void;

  onError?(error: Error): void;
}

export class Sonos2LocalHttpStreamServer {
  private readonly server: Server;

  private readonly options:
    Sonos2LocalHttpStreamServerOptions;

  private currentSocket: Socket | null = null;

  private currentConsumer:
    Sonos2HttpConsumerInfo | null = null;

  private connectionOrdinal = 0;

  private currentConsumerBytesDelivered = 0;

  private currentConsumerWavPrefixDelivered = false;

  private currentConsumerLiveBytesDelivered = false;

  constructor(
    options: Sonos2LocalHttpStreamServerOptions,
  ) {
    this.options = options;

    this.server = net.createServer(
      (socket) => this.handleSocket(socket),
    );

    this.server.on('error', (error) => {
      this.options.onError?.(error);
    });
  }

  get connected(): boolean {
    return Boolean(
      this.currentSocket &&
        !this.currentSocket.destroyed &&
        this.currentConsumer,
    );
  }

  get consumer():
    | Sonos2HttpConsumerInfo
    | null {
    return this.currentConsumer;
  }

  get totalBytesDelivered(): number {
    return this.currentConsumerBytesDelivered;
  }

  get wavPrefixDelivered(): boolean {
    return this.currentConsumerWavPrefixDelivered;
  }

  get liveBytesDelivered(): boolean {
    return this.currentConsumerLiveBytesDelivered;
  }

  async listen(): Promise<number> {
    await new Promise<void>(
      (resolve, reject) => {
        const handleError = (
          error: Error,
        ) => {
          this.server.off(
            'listening',
            handleListening,
          );

          reject(error);
        };

        const handleListening = () => {
          this.server.off(
            'error',
            handleError,
          );

          resolve();
        };

        this.server.once(
          'error',
          handleError,
        );

        this.server.once(
          'listening',
          handleListening,
        );

        this.server.listen(
          0,
          this.options.bindAddress,
        );
      },
    );

    const address = this.server.address();

    if (
      !address ||
      typeof address === 'string'
    ) {
      throw new Error(
        'Sonos2 HTTP stream listener failed to obtain a TCP port.',
      );
    }

    return address.port;
  }

  async close(): Promise<void> {
    this.currentSocket?.destroy();

    this.clearCurrentConsumer();

    if (!this.server.listening) {
      return;
    }

    await new Promise<void>(
      (resolve, reject) => {
        this.server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      },
    );
  }

  async writeWavPrefix(
    data: Buffer,
  ): Promise<void> {
    await this.writeToCurrentConsumer(
      data,
      'wav-prefix',
    );
  }

  async writeLiveAudio(
    data: Buffer,
  ): Promise<void> {
    await this.writeToCurrentConsumer(
      data,
      'live-audio',
    );
  }

  private async writeToCurrentConsumer(
    data: Buffer,
    kind: Sonos2DeliveryKind,
  ): Promise<void> {
    const socket = this.currentSocket;
    const consumer = this.currentConsumer;

    if (
      !socket ||
      socket.destroyed ||
      !consumer
    ) {
      throw new Error(
        'No active Sonos2 HTTP consumer is available.',
      );
    }

    if (data.length === 0) {
      return;
    }

    await new Promise<void>(
      (resolve, reject) => {
        socket.write(
          data,
          (error?: Error | null) => {
            if (error) {
              reject(error);
              return;
            }

            resolve();
          },
        );
      },
    );

    /*
     * The socket could theoretically have been replaced
     * while an asynchronous write was completing.
     *
     * Delivery information belongs only to the consumer
     * that was current when this write began.
     */
    if (
      this.currentSocket !== socket ||
      this.currentConsumer !== consumer ||
      socket.destroyed
    ) {
      return;
    }

    this.currentConsumerBytesDelivered +=
      data.length;

    if (kind === 'wav-prefix') {
      this.currentConsumerWavPrefixDelivered =
        true;
    }

    if (kind === 'live-audio') {
      this.currentConsumerLiveBytesDelivered =
        true;
    }

    this.options.onConsumerDelivery?.({
      consumer,
      kind,
      byteLength: data.length,
      totalBytesDelivered:
        this.currentConsumerBytesDelivered,
      wavPrefixDelivered:
        this.currentConsumerWavPrefixDelivered,
      liveBytesDelivered:
        this.currentConsumerLiveBytesDelivered,
      deliveredAt:
        new Date().toISOString(),
    });
  }

  private handleSocket(
    socket: Socket,
  ): void {
    socket.once('data', (chunk) => {
      const request =
        chunk.toString('latin1');

      const [
        requestLine = '',
        ...headers
      ] = request.split('\r\n');

      const [method] =
        requestLine.split(' ');

      if (method !== 'GET') {
        socket.end(
          'HTTP/1.0 405 Method Not Allowed\r\n' +
            'Connection: close\r\n\r\n',
        );

        return;
      }

      /*
       * Only one physical Sonos consumer owns this
       * stream at a time.
       *
       * A replacement connection is accepted only
       * after the previous socket has actually gone
       * away.
       */
      if (
        this.currentSocket &&
        !this.currentSocket.destroyed
      ) {
        socket.end(
          'HTTP/1.0 409 Conflict\r\n' +
            'Connection: close\r\n\r\n',
        );

        return;
      }

      const userAgent = headers
        .find((header) =>
          /^user-agent:/i.test(header),
        )
        ?.slice(11)
        .trim();

      const range = headers
        .find((header) =>
          /^range:/i.test(header),
        )
        ?.slice(6)
        .trim();

      const consumer:
        Sonos2HttpConsumerInfo = {
          ordinal:
            ++this.connectionOrdinal,

          connectedAt:
            new Date().toISOString(),

          ...(socket.remoteAddress
            ? {
                remoteAddress:
                  socket.remoteAddress,
              }
            : {}),

          ...(userAgent
            ? { userAgent }
            : {}),

          ...(range
            ? { range }
            : {}),
        };

      this.currentSocket = socket;
      this.currentConsumer = consumer;

      /*
       * Every new consumer starts verification
       * completely from scratch.
       */
      this.currentConsumerBytesDelivered = 0;

      this.currentConsumerWavPrefixDelivered =
        false;

      this.currentConsumerLiveBytesDelivered =
        false;

      socket.write(
        [
          'HTTP/1.0 200 OK',
          `Content-Type: ${this.options.contentType}`,
          'Cache-Control: no-store, no-cache, must-revalidate, no-transform',
          'Connection: close',
          '',
          '',
        ].join('\r\n'),
      );

      socket.once('close', () => {
        const wasCurrentConsumer =
          this.currentSocket === socket &&
          this.currentConsumer === consumer;

        if (wasCurrentConsumer) {
          this.clearCurrentConsumer();
        }

        this.options
          .onConsumerDisconnected
          ?.(consumer);
      });

      socket.on('error', (error) => {
        this.options.onError?.(
          error,
        );
      });

      this.options.onConsumerConnected(
        consumer,
      );
    });
  }

  private clearCurrentConsumer(): void {
    this.currentSocket = null;
    this.currentConsumer = null;

    this.currentConsumerBytesDelivered = 0;

    this.currentConsumerWavPrefixDelivered =
      false;

    this.currentConsumerLiveBytesDelivered =
      false;
  }
}