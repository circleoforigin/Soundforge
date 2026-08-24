import dgram from 'node:dgram';

import {
  discoverSonos2LocalDevice,
  type Sonos2LocalDevice,
} from './Sonos2LocalDeviceDiscovery.ts';

import {
  Sonos2LocalAvTransportClient,
} from './Sonos2LocalAvTransportClient.ts';

import {
  Sonos2LocalHttpStreamServer,
  type Sonos2HttpConsumerInfo,
  type Sonos2HttpConsumerDelivery,
} from './Sonos2LocalHttpStreamServer.ts';

export type Sonos2ConnectionState =
  | 'idle'
  | 'discovering'
  | 'starting-listener'
  | 'assigning-uri'
  | 'playing'
  | 'verifying'
  | 'verified'
  | 'disconnected'
  | 'failed'
  | 'stopped';

export interface Sonos2TransportSnapshot {
  state: Sonos2ConnectionState;

  physicalDeviceId: string;

  deviceAddress?: string;

  streamUrl?: string;

  currentConsumer?: Sonos2HttpConsumerInfo;

  consumerConnected: boolean;

  wavPrefixDelivered: boolean;

  liveBytesDelivered: boolean;

  deliveredBytes: number;

  connectedSince?: string;

  verifiedAt?: string;

  lastError?: string;
}

export interface Sonos2TransportStartOptions {
  physicalDeviceId: string;

  onStateChange?(
    snapshot: Sonos2TransportSnapshot,
  ): void;
}

export class Sonos2LocalContinuousStreamTransport {
  private readonly avTransport =
    new Sonos2LocalAvTransportClient();

  private server:
    | Sonos2LocalHttpStreamServer
    | null = null;

  private device:
    | Sonos2LocalDevice
    | null = null;

  private state:
    Sonos2ConnectionState = 'idle';

  private physicalDeviceId = '';

  private streamUrl:
    | string
    | undefined;

  private currentConsumer:
    | Sonos2HttpConsumerInfo
    | undefined;

  private consumerConnected = false;

  private wavPrefixDelivered = false;

  private liveBytesDelivered = false;

  private deliveredBytes = 0;

  private connectedSince:
    | string
    | undefined;

  private verifiedAt:
    | string
    | undefined;

  private lastError:
    | string
    | undefined;

  private onStateChange:
    | ((
        snapshot: Sonos2TransportSnapshot,
      ) => void)
    | undefined;

  getSnapshot(): Sonos2TransportSnapshot {
    return {
      state: this.state,

      physicalDeviceId:
        this.physicalDeviceId,

      consumerConnected:
        this.consumerConnected,

      wavPrefixDelivered:
        this.wavPrefixDelivered,

      liveBytesDelivered:
        this.liveBytesDelivered,

      deliveredBytes:
        this.deliveredBytes,

      ...(this.device
        ? {
            deviceAddress:
              this.device.address,
          }
        : {}),

      ...(this.streamUrl
        ? {
            streamUrl:
              this.streamUrl,
          }
        : {}),

      ...(this.currentConsumer
        ? {
            currentConsumer:
              this.currentConsumer,
          }
        : {}),

      ...(this.connectedSince
        ? {
            connectedSince:
              this.connectedSince,
          }
        : {}),

      ...(this.verifiedAt
        ? {
            verifiedAt:
              this.verifiedAt,
          }
        : {}),

      ...(this.lastError
        ? {
            lastError:
              this.lastError,
          }
        : {}),
    };
  }

  isVerified(): boolean {
    return (
      this.state === 'verified' &&
      this.consumerConnected &&
      this.wavPrefixDelivered &&
      this.liveBytesDelivered
    );
  }

  async start(
    options: Sonos2TransportStartOptions,
  ): Promise<void> {
    await this.stopExistingSession();

    this.reset();

    this.physicalDeviceId =
      options.physicalDeviceId;

    this.onStateChange =
      options.onStateChange;

    try {
      /*
       * STEP 1
       *
       * Find the actual physical Sonos
       * device on the LAN.
       */
      this.setState('discovering');

      const device =
        await discoverSonos2LocalDevice(
          options.physicalDeviceId,
        );

      if (!device) {
        throw new Error(
          'Sonos speaker was not found on the local network.',
        );
      }

      this.device = device;

      /*
       * Determine which local network
       * interface can actually reach
       * this Sonos speaker.
       */
      const localAddress =
        await routeAddress(
          device.address,
        );

      /*
       * STEP 2
       *
       * Start the HTTP endpoint that
       * the physical Sonos speaker
       * will connect back to.
       */
      this.setState(
        'starting-listener',
      );

      this.server =
        new Sonos2LocalHttpStreamServer({
          bindAddress:
            localAddress,

          contentType:
            'audio/wav',

          onConsumerConnected:
            (consumer) => {
              /*
               * A new physical HTTP
               * consumer always starts
               * verification from zero.
               *
               * We deliberately do NOT
               * care whether this is
               * consumer #1, #2, etc.
               */
              this.currentConsumer =
                consumer;

              this.consumerConnected =
                true;

              this.wavPrefixDelivered =
                false;

              this.liveBytesDelivered =
                false;

              this.deliveredBytes = 0;

              this.connectedSince =
                consumer.connectedAt;

              this.verifiedAt =
                undefined;

              this.setState(
                'verifying',
              );
            },

          onConsumerDelivery:
            (delivery) => {
              this.handleDelivery(
                delivery,
              );
            },

          onConsumerDisconnected:
            (consumer) => {
              /*
               * Ignore disconnect
               * notifications belonging
               * to an older/replaced
               * consumer.
               */
              if (
                this.currentConsumer
                  ?.ordinal !==
                consumer.ordinal
              ) {
                return;
              }

              const hadBeenVerified =
                this.isVerified();

              this.currentConsumer =
                undefined;

              this.consumerConnected =
                false;

              this.wavPrefixDelivered =
                false;

              this.liveBytesDelivered =
                false;

              this.deliveredBytes = 0;

              this.connectedSince =
                undefined;

              this.verifiedAt =
                undefined;

              if (hadBeenVerified) {
                this.setState(
                  'disconnected',
                );

                return;
              }

              /*
               * Sonos may replace an
               * initial HTTP consumer
               * during startup.
               *
               * That is not automatically
               * a failure. We simply wait
               * for the next consumer and
               * verify it from scratch.
               */
              if (
                this.state !==
                  'stopped' &&
                this.state !==
                  'failed'
              ) {
                this.setState(
                  'verifying',
                );
              }
            },

          onError: (error) => {
            this.lastError =
              error.message;

            if (
              this.state !==
              'stopped'
            ) {
              this.setState(
                'failed',
              );
            }
          },
        });

      const port =
        await this.server.listen();

      const httpUrl =
        `http://${localAddress}:${port}/sacscape.wav`;

      this.streamUrl =
        httpUrl;

      /*
       * STEP 3
       *
       * Tell Sonos where our persistent
       * WAV stream lives.
       */
      this.setState(
        'assigning-uri',
      );

      await this.avTransport
        .setStreamUri(
          device.avTransportControlUrl,
          httpUrl,
          buildBroadcastMetadata(
            httpUrl,
          ),
        );

      /*
       * STEP 4
       *
       * Tell the physical Sonos device
       * to begin playback.
       */
      this.setState('playing');

      await this.avTransport.play(
        device.avTransportControlUrl,
      );

      /*
       * IMPORTANT:
       *
       * Play succeeding does NOT mean
       * the connection is verified.
       *
       * We wait for:
       *
       * 1. Sonos HTTP consumer
       * 2. WAV prefix delivery
       * 3. live audio delivery
       *
       * before declaring VERIFIED.
       */
      if (!this.isVerified()) {
        this.setState(
          'verifying',
        );
      }
    } catch (error) {
      this.lastError =
        error instanceof Error
          ? error.message
          : String(error);

      this.setState('failed');

      throw error;
    }
  }

  /*
   * The generic audio system calls
   * this when it has the WAV startup
   * prefix/header ready.
   *
   * Sonos2 owns the actual write so
   * it can positively verify delivery.
   */
  async writeWavPrefix(
    data: Buffer,
  ): Promise<void> {
    const server = this.server;

    if (!server) {
      throw new Error(
        'Sonos2 HTTP stream server is not running.',
      );
    }

    await server.writeWavPrefix(
      data,
    );
  }

  /*
   * The generic audio system calls
   * this for live WAV audio after the
   * startup prefix.
   */
  async writeLiveAudio(
    data: Buffer,
  ): Promise<void> {
    const server = this.server;

    if (!server) {
      throw new Error(
        'Sonos2 HTTP stream server is not running.',
      );
    }

    await server.writeLiveAudio(
      data,
    );
  }

  async stop(): Promise<void> {
    const device = this.device;
    const server = this.server;

    /*
     * Mark stopped first so socket
     * close events caused by our own
     * shutdown cannot become
     * DISCONNECTED.
     */
    this.state = 'stopped';

    this.emit();

    try {
      if (device) {
        await this.avTransport
          .stop(
            device
              .avTransportControlUrl,
          )
          .catch(() => undefined);
      }
    } finally {
      await server
        ?.close()
        .catch(() => undefined);

      this.server = null;

      this.currentConsumer =
        undefined;

      this.consumerConnected =
        false;

      this.wavPrefixDelivered =
        false;

      this.liveBytesDelivered =
        false;

      this.deliveredBytes = 0;

      this.connectedSince =
        undefined;

      this.verifiedAt =
        undefined;
    }
  }

  private handleDelivery(
    delivery:
      Sonos2HttpConsumerDelivery,
  ): void {
    /*
     * Delivery information is valid
     * only for the HTTP consumer we
     * are currently verifying.
     */
    if (
      !this.currentConsumer ||
      this.currentConsumer.ordinal !==
        delivery.consumer.ordinal
    ) {
      return;
    }

    this.consumerConnected = true;

    this.wavPrefixDelivered =
      delivery.wavPrefixDelivered;

    this.liveBytesDelivered =
      delivery.liveBytesDelivered;

    this.deliveredBytes =
      delivery.totalBytesDelivered;

    /*
     * This is the single authoritative
     * Sonos2 verification decision.
     *
     * The CURRENT physical consumer
     * must:
     *
     * - still be connected
     * - have received the WAV prefix
     * - have received live audio
     */
    if (
      this.consumerConnected &&
      this.wavPrefixDelivered &&
      this.liveBytesDelivered
    ) {
      if (
        this.state !== 'verified'
      ) {
        this.verifiedAt =
          new Date().toISOString();

        this.setState(
          'verified',
        );
      } else {
        this.emit();
      }

      return;
    }

    if (
      this.state !== 'verified'
    ) {
      this.setState(
        'verifying',
      );
    }
  }

  private async stopExistingSession():
    Promise<void> {
    if (
      !this.server &&
      !this.device
    ) {
      return;
    }

    await this.stop();
  }

  private reset(): void {
    this.server = null;

    this.device = null;

    this.state = 'idle';

    this.physicalDeviceId = '';

    this.streamUrl =
      undefined;

    this.currentConsumer =
      undefined;

    this.consumerConnected =
      false;

    this.wavPrefixDelivered =
      false;

    this.liveBytesDelivered =
      false;

    this.deliveredBytes = 0;

    this.connectedSince =
      undefined;

    this.verifiedAt =
      undefined;

    this.lastError =
      undefined;
  }

  private setState(
    state:
      Sonos2ConnectionState,
  ): void {
    this.state = state;

    this.emit();
  }

  private emit(): void {
    this.onStateChange?.(
      this.getSnapshot(),
    );
  }
}

async function routeAddress(
  targetAddress: string,
): Promise<string> {
  const socket =
    dgram.createSocket('udp4');

  try {
    await new Promise<void>(
      (resolve, reject) => {
        const handleError = (
          error: Error,
        ) => {
          socket.off(
            'connect',
            handleConnect,
          );

          reject(error);
        };

        const handleConnect = () => {
          socket.off(
            'error',
            handleError,
          );

          resolve();
        };

        socket.once(
          'error',
          handleError,
        );

        socket.once(
          'connect',
          handleConnect,
        );

        socket.connect(
          9,
          targetAddress,
        );
      },
    );

    const address =
      socket.address();

    if (
      typeof address === 'string'
    ) {
      throw new Error(
        'Unable to determine the local LAN address for the Sonos speaker.',
      );
    }

    return address.address;
  } finally {
    socket.close();
  }
}

function buildBroadcastMetadata(
  streamUrl: string,
): string {
  return [
    '<DIDL-Lite',
    ' xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"',
    ' xmlns:dc="http://purl.org/dc/elements/1.1/"',
    ' xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">',
    '<item id="0" parentID="0" restricted="1">',
    '<dc:title>SACscape</dc:title>',
    '<upnp:class>object.item.audioItem.audioBroadcast</upnp:class>',
    `<res protocolInfo="http-get:*:audio/wav:*">${streamUrl}</res>`,
    '</item>',
    '</DIDL-Lite>',
  ].join('');
}