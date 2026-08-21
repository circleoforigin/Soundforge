import type { Response } from 'express';

import type { AudioStreamDiagnosticEvent } from '../../src/models/ResearchLab.ts';
import { continuousAudioStreamManager } from '../audio/ContinuousAudioStreamManager.ts';
import { logSonosError, logSonosInfo } from './SonosDiagnosticLog.ts';

interface GroupRuntime {
  streamId: string;
  details: Record<string, unknown>;
}

class SonosContinuousGroupStream {
  private readonly runtimes = new Map<string, GroupRuntime>();
  private readonly attachedGroups = new Map<string, { sessionId: string; streamUrl: string }>();
  private readonly playbackStates = new Map<string, {
    state: string;
    hasReachedActiveState: boolean;
  }>();

  addClient(groupId: string, response: Response, details: Record<string, unknown>): void {
    const previousRuntime = this.runtimes.get(groupId);
    if (previousRuntime) {
      this.runtimes.delete(groupId);
      continuousAudioStreamManager.stop(
        previousRuntime.streamId,
        'replacement Sonos stream client connected'
      );
    }

    let streamId = '';
    const stream = continuousAudioStreamManager.create({
      onEvent: (event) => this.logRuntimeEvent(groupId, details, event),
      onClientDisconnected: (reason) => {
        if (this.runtimes.get(groupId)?.streamId !== streamId) {
          return;
        }
        this.runtimes.delete(groupId);
        continuousAudioStreamManager.stop(streamId, reason);
        this.invalidateAttachment(groupId, 'stream client disconnected');
      },
      onEncoderExit: () => {
        if (this.runtimes.get(groupId)?.streamId !== streamId) {
          return;
        }
        this.runtimes.delete(groupId);
        continuousAudioStreamManager.stop(streamId, 'FFmpeg encoder exited');
        this.invalidateAttachment(groupId, 'FFmpeg encoder exited');
      },
    });
    streamId = stream.id;
    this.runtimes.set(groupId, { streamId, details });
    stream.bindHttpClient(response);
  }

  markAttached(groupId: string, sessionId: string, streamUrl: string): void {
    this.attachedGroups.set(groupId, { sessionId, streamUrl });
  }

  beginAttachment(groupId: string): void {
    this.playbackStates.set(groupId, { state: 'ATTACHING', hasReachedActiveState: false });
    logSonosInfo('GROUP_PLAYBACK', 'Continuous group stream playback state initialized.', {
      groupId,
      state: 'ATTACHING',
      hasReachedActiveState: false,
    });
  }

  handlePlaybackState(groupId: string, nextState: string): void {
    const lifecycle = this.playbackStates.get(groupId);
    if (!lifecycle) {
      logSonosInfo('GROUP_PLAYBACK', 'Ignoring playback state for an unattached group stream.', {
        groupId,
        nextState,
      });
      return;
    }

    const previousState = lifecycle.state;
    const isActiveState =
      nextState === 'PLAYBACK_STATE_BUFFERING' ||
      nextState === 'PLAYBACK_STATE_PLAYING';
    if (isActiveState) {
      lifecycle.hasReachedActiveState = true;
    }
    lifecycle.state = nextState;

    logSonosInfo('GROUP_PLAYBACK', 'Continuous group stream playback-state transition.', {
      groupId,
      previousState,
      nextState,
      hasReachedActiveState: lifecycle.hasReachedActiveState,
    });

    if (nextState !== 'PLAYBACK_STATE_IDLE') {
      return;
    }
    if (!lifecycle.hasReachedActiveState) {
      logSonosInfo('GROUP_PLAYBACK', 'Initial Sonos group stream IDLE state ignored.', {
        groupId,
        previousState,
        hasReachedActiveState: false,
      });
      return;
    }

    logSonosInfo('GROUP_PLAYBACK', 'Active Sonos group stream returned to IDLE.', {
      groupId,
      previousState,
      hasReachedActiveState: true,
      action: 'invalidate attachment',
    });
    this.invalidateGroupStream(groupId, 'active Sonos playback returned to IDLE');
  }

  getAttachment(groupId: string): { sessionId: string; streamUrl: string } | undefined {
    return this.attachedGroups.get(groupId);
  }

  hasActiveClient(groupId: string): boolean {
    const runtime = this.runtimes.get(groupId);
    return Boolean(runtime && continuousAudioStreamManager.get(runtime.streamId)?.hasActiveClient());
  }

  invalidateAttachment(groupId: string, reason: string): void {
    const attachment = this.attachedGroups.get(groupId);
    this.attachedGroups.delete(groupId);
    this.playbackStates.delete(groupId);
    logSonosInfo('GROUP_PLAYBACK', 'Continuous group stream attachment invalidated.', {
      groupId,
      sessionId: attachment?.sessionId ?? null,
      reason,
    });
  }

  invalidateAttachmentBySessionId(sessionId: string, reason: string): void {
    for (const [groupId, attachment] of this.attachedGroups) {
      if (attachment.sessionId === sessionId) {
        this.invalidateGroupStream(groupId, reason);
      }
    }
  }

  invalidateGroupStream(groupId: string, reason: string): void {
    this.invalidateAttachment(groupId, reason);
    const runtime = this.runtimes.get(groupId);
    if (runtime) {
      this.runtimes.delete(groupId);
      continuousAudioStreamManager.stop(runtime.streamId, reason);
    }
  }

  injectTone(
    groupId: string,
    details: Record<string, unknown> = {}
  ): { frequencyHz: number; durationMs: number } {
    const runtime = this.runtimes.get(groupId);
    const stream = runtime ? continuousAudioStreamManager.get(runtime.streamId) : undefined;
    if (!stream || !stream.hasActiveClient()) {
      throw new Error('The continuous Sonos group stream has no active client.');
    }

    const tone = stream.injectTestTone();
    logSonosInfo('GROUP_PLAYBACK', 'Continuous group stream tone injected.', {
      ...details,
      groupId,
      streamId: stream.id,
      ...tone,
    });
    return tone;
  }

  private logRuntimeEvent(
    groupId: string,
    details: Record<string, unknown>,
    event: AudioStreamDiagnosticEvent
  ): void {
    const messages: Record<string, string> = {
      'encoder-started': 'Continuous group stream encoder started.',
      'first-encoded-output': 'Continuous group stream first encoded output.',
      'client-connected': 'Continuous group stream connected.',
      'first-client-bytes': 'Continuous group stream first bytes written to client.',
      'client-disconnected': 'Continuous group stream disconnected.',
      'stdin-backpressure': 'Continuous group stream FFmpeg stdin backpressure.',
      'stdin-drain': 'Continuous group stream FFmpeg stdin drained.',
      'http-backpressure': 'Continuous group stream HTTP backpressure.',
      'http-drain': 'Continuous group stream HTTP output drained.',
      'encoder-exited': 'Continuous group stream encoder exited.',
      'encoder-diagnostic': 'Continuous group stream FFmpeg diagnostic.',
      'encoder-input-error': 'Continuous group stream encoder input failed.',
      'encoder-start-error': 'Continuous group stream encoder failed to start.',
    };
    const message = messages[event.code];
    if (!message) {
      return;
    }
    const diagnosticDetails = {
      ...details,
      groupId,
      timestamp: event.timestamp,
      ...event.details,
    };
    if (
      event.code === 'encoder-exited' ||
      event.code === 'encoder-diagnostic' ||
      event.code === 'encoder-input-error' ||
      event.code === 'encoder-start-error'
    ) {
      logSonosError(message, diagnosticDetails);
      return;
    }
    logSonosInfo('GROUP_PLAYBACK', message, {
      ...diagnosticDetails,
    });
  }
}

export const sonosContinuousGroupStream = new SonosContinuousGroupStream();
