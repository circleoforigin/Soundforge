import type { AudioStreamTransportSnapshot } from '../../src/models/ResearchLab.ts';
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
  hasReachedActiveState: boolean;
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
      hasReachedActiveState: false,
      playbackState: 'ATTACHING',
      context,
    };
    this.byGroupId.set(groupId, active);
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
      active.sessionId = result.sessionId;
      this.bySessionId.set(result.sessionId, active);
      context.updateTransport({
        state: 'bound',
        bound: true,
        hasBinding: true,
      }, 'Sonos Cloud playback session bound to continuous stream.');
      context.addDiagnostic('Sonos Cloud continuous transport attached.', {
        groupId,
        sessionId: result.sessionId,
        targetScope: 'group',
      });
      return {
        transportId: this.id,
        targetScope: 'group',
        targetDescription,
        independentlyTargetable: context.transport.independentlyTargetable,
        providerBinding: { groupId, sessionId: result.sessionId } satisfies SonosCloudBindingData,
      };
    } catch (error) {
      this.byGroupId.delete(groupId);
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

  handlePlaybackState(groupId: string, nextState: string): void {
    const active = this.byGroupId.get(groupId);
    if (!active) {
      return;
    }
    const previousState = active.playbackState;
    const isActive =
      nextState === 'PLAYBACK_STATE_BUFFERING' || nextState === 'PLAYBACK_STATE_PLAYING';
    if (isActive) {
      active.hasReachedActiveState = true;
    }
    active.playbackState = nextState;
    active.context.updateTransport({ providerPlaybackState: nextState },
      'Sonos Cloud playback state changed.');
    active.context.addDiagnostic('Sonos Cloud playback-state transition.', {
      groupId,
      previousState,
      nextState,
      hasReachedActiveState: active.hasReachedActiveState,
    });

    if (nextState !== 'PLAYBACK_STATE_IDLE') {
      return;
    }
    if (!active.hasReachedActiveState) {
      active.context.addDiagnostic('Initial Sonos IDLE state ignored.', { groupId });
      return;
    }
    this.failActive(active, 'Active Sonos Cloud playback returned to IDLE.');
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
    this.removeBinding(active.groupId, active.sessionId);
    const update: Partial<AudioStreamTransportSnapshot> = {
      state: 'error',
      bound: false,
      hasBinding: false,
      lastError: reason,
    };
    active.context.updateTransport(update, reason);
    active.context.terminate(reason);
  }

  private removeBinding(groupId: string, sessionId: string | null): void {
    this.byGroupId.delete(groupId);
    if (sessionId) {
      this.bySessionId.delete(sessionId);
    }
  }
}

export const sonosCloudContinuousStreamTransport =
  new SonosCloudContinuousStreamTransport();
