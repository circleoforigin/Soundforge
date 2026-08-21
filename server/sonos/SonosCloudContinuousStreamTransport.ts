import type {
  AudioStreamDiagnosticEvent,
  AudioStreamSnapshot,
  AudioStreamTransportSnapshot,
} from '../../src/models/ResearchLab.ts';
import type {
  ContinuousStreamTransport,
  ContinuousStreamTransportBinding,
  ContinuousStreamTransportContext,
} from '../audio/transports/ContinuousStreamTransport.ts';
import {
  resolveSonosAudioDevice,
  type ResolvedSonosAudioDevice,
} from '../research-lab/SonosAudioDeviceDiscovery.ts';
import {
  SonosClient,
  type SonosGroupStreamTestResult,
} from './SonosClient.ts';

interface SonosCloudClient {
  attachGroupStreamPlayback(
    groupId: string,
    streamUrl: string,
    appContext?: string
  ): Promise<SonosGroupStreamTestResult>;
  pauseGroupPlayback(groupId: string): Promise<unknown>;
}

interface SonosCloudBindingData {
  groupId: string;
  sessionId: string;
}

interface ActiveSonosCloudStream {
  streamId: string;
  groupId: string;
  sessionId: string | null;
  phase: 'binding' | 'bound' | 'active' | 'terminal';
  hasSeenProviderActiveState: boolean;
  httpClientConnected: boolean;
  hasDeliveredBytes: boolean;
  terminalMonitoringArmed: boolean;
  playbackState: string;
  context: ContinuousStreamTransportContext;
}

export class SonosCloudContinuousStreamTransport implements ContinuousStreamTransport {
  readonly id = 'sonos-cloud-continuous';

  private readonly client: SonosCloudClient;
  private readonly resolveDevice: (
    deviceId: string
  ) => Promise<ResolvedSonosAudioDevice | undefined>;
  private readonly byGroupId = new Map<string, ActiveSonosCloudStream>();
  private readonly bySessionId = new Map<string, ActiveSonosCloudStream>();
  private readonly byStreamId = new Map<string, ActiveSonosCloudStream>();

  constructor(
    client: SonosCloudClient = new SonosClient(),
    resolveDevice: (
      deviceId: string
    ) => Promise<ResolvedSonosAudioDevice | undefined> = resolveSonosAudioDevice
  ) {
    this.client = client;
    this.resolveDevice = resolveDevice;
  }

  async start(
    context: ContinuousStreamTransportContext
  ): Promise<ContinuousStreamTransportBinding> {
    const resolved = await this.resolveDevice(context.device.id);
    if (!resolved) {
      throw new Error('The selected Sonos device is no longer present in current topology.');
    }
    if (!resolved.group) {
      throw new Error('The selected Sonos device has no valid owning group.');
    }

    const groupId = resolved.group.id;
    const targetDescription = resolved.group.name;
    if (this.byGroupId.has(groupId)) {
      throw new Error('The owning Sonos group already has an active Research Lab stream.');
    }
    const active: ActiveSonosCloudStream = {
      streamId: context.streamId,
      groupId,
      sessionId: null,
      phase: 'binding',
      hasSeenProviderActiveState: false,
      httpClientConnected: false,
      hasDeliveredBytes: false,
      terminalMonitoringArmed: false,
      playbackState: 'ATTACHING',
      context,
    };
    this.byGroupId.set(groupId, active);
    this.byStreamId.set(context.streamId, active);
    context.updateTransport({
      state: 'binding',
      targetScope: 'group',
      targetDescription,
      independentlyTargetable: context.transport.independentlyTargetable,
      providerPlaybackState: 'ATTACHING',
      bound: false,
      hasBinding: false,
      lastError: null,
    }, 'Binding continuous stream to Sonos Cloud group.');

    try {
      const result = await this.client.attachGroupStreamPlayback(
        groupId,
        context.streamUrl,
        `research-lab-${context.streamId}`
      );
      if (active.phase === 'terminal' || this.byGroupId.get(groupId) !== active) {
        await this.client.pauseGroupPlayback(groupId).catch(() => undefined);
        throw new Error('Sonos Cloud transport became terminal while binding was in progress.');
      }
      active.sessionId = result.sessionId;
      this.bySessionId.set(result.sessionId, active);
      active.phase = 'bound';
      context.updateTransport({
        state: 'bound',
        bound: true,
        hasBinding: true,
      }, 'Sonos Cloud playback session bound to continuous stream.');
      context.addDiagnostic('Sonos Cloud continuous transport attached.', {
        groupId,
        sessionId: result.sessionId,
        targetScope: 'group',
        phase: active.phase,
        httpClientConnected: active.httpClientConnected,
        hasDeliveredBytes: active.hasDeliveredBytes,
      });
      if (active.hasDeliveredBytes) {
        this.armTerminalMonitoring(active, 'Encoded stream bytes were delivered during binding.');
      } else {
        context.addDiagnostic('Sonos Cloud transport is bound and waiting for stream client.', {
          groupId,
          phase: active.phase,
        });
      }
      return {
        transportId: this.id,
        targetScope: 'group',
        targetDescription,
        independentlyTargetable: context.transport.independentlyTargetable,
        providerBinding: { groupId, sessionId: result.sessionId } satisfies SonosCloudBindingData,
      };
    } catch (error) {
      this.removeBinding(groupId, active.sessionId, active.streamId);
      const message = error instanceof Error ? error.message : 'Sonos Cloud transport failed.';
      context.updateTransport({
        state: 'error',
        bound: false,
        hasBinding: false,
        lastError: message,
      }, 'Sonos Cloud continuous transport failed to bind.');
      throw error;
    }
  }

  async stop(binding: ContinuousStreamTransportBinding): Promise<void> {
    const providerBinding = binding.providerBinding as SonosCloudBindingData;
    try {
      await this.client.pauseGroupPlayback(providerBinding.groupId);
    } finally {
      this.removeBinding(providerBinding.groupId, providerBinding.sessionId);
    }
  }

  handleRuntimeEvent(
    streamId: string,
    event: AudioStreamDiagnosticEvent,
    snapshot: AudioStreamSnapshot | undefined
  ): void {
    const active = this.byStreamId.get(streamId);
    if (!active || active.phase === 'terminal') {
      return;
    }
    if (event.code === 'client-connected') {
      active.httpClientConnected = true;
      active.context.addDiagnostic('Sonos HTTP stream client connected.', {
        groupId: active.groupId,
        phase: active.phase,
        connectedAt: snapshot?.httpClient.connectedAt ?? event.timestamp,
      });
      return;
    }
    if (event.code === 'first-client-bytes') {
      active.httpClientConnected = snapshot?.httpClient.connected ?? true;
      active.hasDeliveredBytes = true;
      active.context.addDiagnostic('First encoded bytes delivered to Sonos HTTP client.', {
        groupId: active.groupId,
        phase: active.phase,
        deliveredBytes: snapshot?.httpClient.deliveredBytes ?? null,
      });
      if (active.phase === 'bound') {
        this.armTerminalMonitoring(active, 'Transport binding and delivered stream bytes confirmed.');
      }
    }
  }

  handlePlaybackState(groupId: string, nextState: string): void {
    const active = this.byGroupId.get(groupId);
    if (!active) {
      return;
    }
    const previousState = active.playbackState;
    const isActive =
      nextState === 'PLAYBACK_STATE_BUFFERING' || nextState === 'PLAYBACK_STATE_PLAYING';
    if (isActive) {
      active.hasSeenProviderActiveState = true;
    }
    active.playbackState = nextState;
    active.context.updateTransport({ providerPlaybackState: nextState },
      'Sonos Cloud playback state changed.');
    active.context.addDiagnostic('Sonos Cloud playback-state transition.', {
      groupId,
      previousState,
      nextState,
      phase: active.phase,
      bindingComplete: active.phase !== 'binding',
      hasSeenProviderActiveState: active.hasSeenProviderActiveState,
      httpClientConnected: active.httpClientConnected,
      hasDeliveredBytes: active.hasDeliveredBytes,
      terminalMonitoringArmed: active.terminalMonitoringArmed,
    });

    if (nextState !== 'PLAYBACK_STATE_IDLE') {
      return;
    }
    if (active.phase === 'binding') {
      active.context.addDiagnostic(
        'Sonos IDLE state ignored because transport binding is still in progress.',
        { groupId, phase: active.phase, hasSeenProviderActiveState: active.hasSeenProviderActiveState }
      );
      return;
    }
    if (!active.terminalMonitoringArmed) {
      active.context.addDiagnostic(
        'Sonos IDLE state ignored until HTTP stream delivery is confirmed.',
        {
          groupId,
          phase: active.phase,
          httpClientConnected: active.httpClientConnected,
          hasDeliveredBytes: active.hasDeliveredBytes,
        }
      );
      return;
    }
    this.failActive(
      active,
      'Established Sonos Cloud stream returned to IDLE after HTTP audio delivery.'
    );
  }

  handlePlaybackError(groupId: string, details?: Record<string, unknown>): void {
    const active = this.byGroupId.get(groupId);
    if (active) {
      active.context.addDiagnostic('Sonos playback error.', details);
      this.failActive(active, 'Sonos playback error.');
    }
  }

  handleSessionError(sessionId: string, details?: Record<string, unknown>): void {
    const active = this.bySessionId.get(sessionId);
    if (active) {
      active.context.addDiagnostic('Sonos playback-session error.', details);
      this.failActive(active, 'Sonos playback-session error.');
    }
  }

  private failActive(active: ActiveSonosCloudStream, reason: string): void {
    active.phase = 'terminal';
    this.removeBinding(active.groupId, active.sessionId, active.streamId);
    const update: Partial<AudioStreamTransportSnapshot> = {
      state: 'error',
      bound: false,
      hasBinding: false,
      lastError: reason,
    };
    active.context.updateTransport(update, reason);
    active.context.terminate(reason);
  }

  private armTerminalMonitoring(active: ActiveSonosCloudStream, reason: string): void {
    if (active.terminalMonitoringArmed || active.phase === 'terminal') {
      return;
    }
    active.phase = 'active';
    active.terminalMonitoringArmed = true;
    active.context.updateTransport({ state: 'active' },
      'Sonos Cloud stream is active and terminal monitoring is armed.');
    active.context.addDiagnostic('Sonos terminal playback monitoring armed.', {
      groupId: active.groupId,
      phase: active.phase,
      reason,
      httpClientConnected: active.httpClientConnected,
      hasDeliveredBytes: active.hasDeliveredBytes,
    });
  }

  private removeBinding(
    groupId: string,
    sessionId: string | null,
    streamId?: string
  ): void {
    this.byGroupId.delete(groupId);
    if (streamId) {
      this.byStreamId.delete(streamId);
    } else {
      for (const [candidateStreamId, active] of this.byStreamId) {
        if (active.groupId === groupId) {
          this.byStreamId.delete(candidateStreamId);
        }
      }
    }
    if (sessionId) {
      this.bySessionId.delete(sessionId);
    }
  }
}

export const sonosCloudContinuousStreamTransport =
  new SonosCloudContinuousStreamTransport();
