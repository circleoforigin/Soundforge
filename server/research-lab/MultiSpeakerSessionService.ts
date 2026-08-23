import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';

import type {
  AudioDevice,
  AudioStreamDiagnosticEvent,
  MultiSpeakerParticipantSlot,
  MultiSpeakerSessionSnapshot,
  MultiSpeakerTeardownSummary,
} from '../../src/models/ResearchLab.ts';
import { ResearchLabRequestError, ResearchLabStreamService } from './ResearchLabStreamService.ts';
import { getSonosAudioDevices } from './SonosAudioDeviceDiscovery.ts';

export const multiSpeakerEventLeadMs = 400;
export const multiSpeakerAlternatingIntervalMs = 3_000;
export const multiSpeakerMigrationDurationMs = 8_000;
export const multiSpeakerMigrationFrequencyHz = 880;

interface Participant {
  slot: MultiSpeakerParticipantSlot;
  device: AudioDevice;
  streamId: string;
}

interface Session {
  id: string;
  participants: Participant[];
  events: AudioStreamDiagnosticEvent[];
  stopping: boolean;
  stopped: boolean;
  lastSimultaneousEventId: string | null;
  lastMigrationEventId: string | null;
  teardown: MultiSpeakerTeardownSummary | null;
  stopPromise: Promise<MultiSpeakerSessionSnapshot> | null;
}

export class MultiSpeakerSessionService {
  private readonly streamService: ResearchLabStreamService;
  private readonly discoverDevices: () => Promise<AudioDevice[]>;
  private readonly sessions = new Map<string, Session>();

  constructor(
    streamService: ResearchLabStreamService,
    discoverDevices: () => Promise<AudioDevice[]> = getSonosAudioDevices
  ) {
    this.streamService = streamService;
    this.discoverDevices = discoverDevices;
  }

  async create(
    deviceAId: string,
    deviceBId: string,
    createStreamUrl: (streamId: string) => string
  ): Promise<MultiSpeakerSessionSnapshot> {
    if (deviceAId === deviceBId) throw new ResearchLabRequestError(400, 'Speaker A and Speaker B must be different physical devices.');
    const devices = await this.discoverDevices();
    const selected = [deviceAId, deviceBId].map((id) => devices.find((device) => device.id === id));
    if (!selected[0] || !selected[1]) throw new ResearchLabRequestError(404, 'One or both selected physical devices are no longer discovered.');
    for (const device of selected as AudioDevice[]) {
      const transport = device.transports.find((candidate) => candidate.id === 'sonos-local-continuous');
      if (!transport || transport.operation !== 'persistent-stream' || transport.scope !== 'physical-device'
        || !transport.independentlyTargetable || transport.availability === 'unavailable') {
        throw new ResearchLabRequestError(409, `${device.name} is not independently targetable by Sonos local continuous transport.`);
      }
    }

    const id = crypto.randomUUID();
    const session: Session = {
      id, participants: [], events: [], stopping: false, stopped: false,
      lastSimultaneousEventId: null, lastMigrationEventId: null,
      teardown: null, stopPromise: null,
    };
    this.sessions.set(id, session);
    this.record(session, 'Multi-speaker session created.');
    const results = await Promise.allSettled((selected as AudioDevice[]).map((device) =>
      this.streamService.start(device.id, 'sonos-local-continuous', createStreamUrl)
    ));
    for (const [index, result] of results.entries()) {
      const slot: MultiSpeakerParticipantSlot = index === 0 ? 'A' : 'B';
      if (result.status === 'fulfilled') {
        session.participants.push({ slot, device: (selected as AudioDevice[])[index], streamId: result.value.id });
        this.record(session, `Participant ${slot} transport started.`, { streamId: result.value.id });
      } else {
        this.record(session, `Participant ${slot} failed to start.`, { error: result.reason instanceof Error ? result.reason.message : String(result.reason) }, 'error');
      }
    }
    return this.snapshot(session);
  }

  get(id: string): MultiSpeakerSessionSnapshot {
    const session = this.requireSession(id);
    this.captureSimultaneousDiagnostics(session);
    const snapshot = this.snapshot(session);
    if (snapshot.state === 'ready' && !session.events.some((event) => event.code === 'session-ready')) {
      this.record(session, 'Participant A streaming.');
      this.record(session, 'Participant B streaming.');
      this.record(session, 'Multi-speaker session ready.', undefined, 'lifecycle', 'session-ready');
      return this.snapshot(session);
    }
    return snapshot;
  }

  runAlternating(id: string): MultiSpeakerSessionSnapshot {
    const session = this.requireReady(id);
    const start = performance.now() + multiSpeakerEventLeadMs;
    this.record(session, 'Alternating test started.', { firstTargetMonotonicTime: start });
    (['A', 'B', 'A', 'B'] as MultiSpeakerParticipantSlot[]).forEach((slot, index) => {
      const participant = session.participants.find((candidate) => candidate.slot === slot)!;
      const eventId = crypto.randomUUID();
      const stream = this.streamService.manager.getActive(participant.streamId)!;
      stream.scheduleTone({ eventId, targetMonotonicTime: start + index * multiSpeakerAlternatingIntervalMs });
      this.record(session, `Event ${eventId} scheduled for ${slot}.`, { eventId, slot, targetMonotonicTime: start + index * multiSpeakerAlternatingIntervalMs });
    });
    return this.snapshot(session);
  }

  runSimultaneous(id: string): MultiSpeakerSessionSnapshot {
    const session = this.requireReady(id);
    const eventId = crypto.randomUUID();
    const targetMonotonicTime = performance.now() + multiSpeakerEventLeadMs;
    session.lastSimultaneousEventId = eventId;
    for (const participant of session.participants) {
      this.streamService.manager.getActive(participant.streamId)!.scheduleTone({ eventId, targetMonotonicTime });
    }
    this.record(session, 'Simultaneous PCM-generation event scheduled.', { eventId, targetMonotonicTime, targets: ['A', 'B'] });
    return this.snapshot(session);
  }

  runMigration(id: string): MultiSpeakerSessionSnapshot {
    const session = this.requireReady(id);
    const eventId = crypto.randomUUID();
    const targetMonotonicTime = performance.now() + multiSpeakerEventLeadMs;
    session.lastMigrationEventId = eventId;
    for (const participant of session.participants) {
      const fromA = participant.slot === 'A';
      this.streamService.manager.getActive(participant.streamId)!.scheduleTone({
        eventId,
        targetMonotonicTime,
        frequencyHz: multiSpeakerMigrationFrequencyHz,
        durationMs: multiSpeakerMigrationDurationMs,
        gainEnvelope: {
          startGain: fromA ? 1 : 0,
          endGain: fromA ? 0 : 1,
          curve: 'equal-power',
        },
      });
    }
    this.record(session, 'Audio migration A → B scheduled.', {
      eventId,
      targetMonotonicTime,
      durationMs: multiSpeakerMigrationDurationMs,
      frequencyHz: multiSpeakerMigrationFrequencyHz,
      curve: 'equal-power',
    }, 'source', `migration-scheduled:${eventId}`);
    return this.snapshot(session);
  }

  async stop(id: string): Promise<MultiSpeakerSessionSnapshot> {
    const session = this.requireSession(id);
    if (session.stopped) return this.snapshot(session);
    if (session.stopPromise) return session.stopPromise;
    session.stopPromise = this.stopSession(session);
    return session.stopPromise;
  }

  private async stopSession(session: Session): Promise<MultiSpeakerSessionSnapshot> {
    session.stopping = true;
    this.record(session, 'Stopping all multi-speaker participants.');
    let pendingEventsCancelled = 0;
    for (const participant of session.participants) {
      const stream = this.streamService.manager.getActive(participant.streamId);
      pendingEventsCancelled += stream?.getSnapshot().scheduledEvents
        .filter((event) => event.status === 'scheduled').length ?? 0;
      stream?.cancelScheduledEvents('multi-speaker Stop All');
    }

    const results = await Promise.all(session.participants.map(async (participant) => {
      try {
        const active = this.streamService.manager.getActive(participant.streamId);
        const result = active ? await this.streamService.stop(participant.streamId) : null;
        const snapshot = result?.snapshot ?? this.streamService.manager.getSnapshot(participant.streamId);
        return {
          slot: participant.slot,
          stopped: !active || snapshot?.lifecycle === 'stopped',
          transportStopped: result ? result.cleanup.transportStopped : true,
          listenerClosed: result ? result.cleanup.listenerClosed : !(snapshot?.httpClient.connected ?? false),
          encoderStopped: result ? result.cleanup.encoderStopped : snapshot?.encoder.pid == null,
          ...(result?.transportError ? { error: result.transportError } : {}),
        };
      } catch (error) {
        const snapshot = this.streamService.manager.getSnapshot(participant.streamId);
        return {
          slot: participant.slot,
          stopped: snapshot?.lifecycle === 'stopped',
          transportStopped: false,
          listenerClosed: !(snapshot?.httpClient.connected ?? false),
          encoderStopped: snapshot?.encoder.pid == null,
          error: error instanceof Error ? error.message : 'Participant cleanup failed.',
        };
      }
    }));

    const forSlot = (slot: MultiSpeakerParticipantSlot) => {
      const result = results.find((candidate) => candidate.slot === slot);
      return result
        ? {
            stopped: result.stopped,
            transportStopped: result.transportStopped,
            listenerClosed: result.listenerClosed,
            encoderStopped: result.encoderStopped,
            ...(result.error ? { error: result.error } : {}),
          }
        : {
            stopped: true, transportStopped: true, listenerClosed: true, encoderStopped: true,
          };
    };
    session.teardown = {
      sessionId: session.id,
      participantA: forSlot('A'),
      participantB: forSlot('B'),
      pendingEventsCancelled,
    };
    session.stopping = false;
    session.stopped = true;
    this.record(session, 'Multi-speaker session stopped.', { ...session.teardown });
    return this.snapshot(session);
  }

  private requireSession(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new ResearchLabRequestError(404, 'Multi-speaker session not found.');
    return session;
  }

  private requireReady(id: string): Session {
    const session = this.requireSession(id);
    if (this.snapshot(session).state !== 'ready') throw new ResearchLabRequestError(409, 'Both participants must be actively streaming before coordinated tests can run.');
    return session;
  }

  private snapshot(session: Session): MultiSpeakerSessionSnapshot {
    this.captureMigrationDiagnostics(session);
    const participants = session.participants.map((participant) => {
      const stream = this.streamService.manager.getSnapshot(participant.streamId);
      return {
        slot: participant.slot, deviceId: participant.device.id,
        deviceName: participant.device.presentation?.alias ?? participant.device.name,
        streamId: participant.streamId, state: stream?.transport?.state ?? stream?.lifecycle ?? 'missing',
        encoderPid: stream?.encoder.pid ?? null,
        consumerConnected: stream?.httpClient.connected ?? false,
      };
    });
    const ready = participants.length === 2 && participants.every((participant) => {
      const stream = this.streamService.manager.getSnapshot(participant.streamId);
      return stream?.transport?.state === 'active' && stream.toneReady;
    });
    const degraded = participants.length !== 2 || participants.some((participant) => {
      const stream = this.streamService.manager.getSnapshot(participant.streamId);
      return !stream || stream.lifecycle === 'error' || stream.lifecycle === 'stopped';
    });
    const eventId = session.lastSimultaneousEventId;
    const results = eventId ? session.participants.map((participant) =>
      this.streamService.manager.getSnapshot(participant.streamId)?.scheduledEvents.find((event) => event.eventId === eventId)
    ) : [];
    const a = results[0]; const b = results[1];
    const migrationEventId = session.lastMigrationEventId;
    const migrationEvents = migrationEventId ? session.participants.map((participant) =>
      this.streamService.manager.getSnapshot(participant.streamId)?.scheduledEvents
        .find((event) => event.eventId === migrationEventId)
    ) : [];
    const migrationA = migrationEvents[0];
    const migrationB = migrationEvents[1];
    const migrationStatuses = migrationEvents.map((event) => event?.status);
    return {
      id: session.id,
      state: session.stopped ? 'stopped' : session.stopping ? 'stopping' : degraded ? 'degraded' : ready ? 'ready' : 'starting',
      participants,
      recentEvents: [...session.events],
      teardown: session.teardown,
      lastMigrationResult: migrationEventId && migrationA && migrationB ? {
        eventId: migrationEventId,
        direction: 'A-to-B',
        targetMonotonicTime: migrationA.targetMonotonicTime,
        frequencyHz: migrationA.frequencyHz,
        durationMs: migrationA.durationMs,
        curve: 'equal-power',
        aActualStart: migrationA.actualPcmStartMonotonicTime,
        bActualStart: migrationB.actualPcmStartMonotonicTime,
        aScheduleErrorMs: migrationA.scheduleErrorMs,
        bScheduleErrorMs: migrationB.scheduleErrorMs,
        sourceGenerationSkewMs: migrationA.actualPcmStartMonotonicTime !== null
          && migrationB.actualPcmStartMonotonicTime !== null
          ? Math.abs(migrationA.actualPcmStartMonotonicTime - migrationB.actualPcmStartMonotonicTime)
          : null,
        status: migrationStatuses.includes('cancelled')
          ? 'cancelled'
          : migrationStatuses.every((status) => status === 'completed')
            ? 'completed'
            : migrationStatuses.some((status) => status === 'started' || status === 'completed')
              ? 'running'
              : 'scheduled',
      } : null,
      lastSimultaneousResult: eventId && a && b ? {
        eventId, scheduledMonotonicTime: a.targetMonotonicTime,
        aActualStart: a.actualPcmStartMonotonicTime,
        bActualStart: b.actualPcmStartMonotonicTime,
        aScheduleErrorMs: a.scheduleErrorMs,
        bScheduleErrorMs: b.scheduleErrorMs,
        sourceGenerationSkewMs: a.actualPcmStartMonotonicTime !== null && b.actualPcmStartMonotonicTime !== null
          ? Math.abs(a.actualPcmStartMonotonicTime - b.actualPcmStartMonotonicTime)
          : null,
      } : null,
    };
  }

  private captureSimultaneousDiagnostics(session: Session): void {
    const eventId = session.lastSimultaneousEventId;
    if (!eventId || session.events.some((event) => event.code === `simultaneous-skew:${eventId}`)) return;
    const values = session.participants.map((participant) => ({
      slot: participant.slot,
      event: this.streamService.manager.getSnapshot(participant.streamId)?.scheduledEvents
        .find((candidate) => candidate.eventId === eventId),
    }));
    for (const value of values) {
      if (value.event?.actualPcmStartMonotonicTime !== null && value.event?.actualPcmStartMonotonicTime !== undefined
        && !session.events.some((event) => event.code === `simultaneous-start:${eventId}:${value.slot}`)) {
        this.record(session, `Participant ${value.slot} PCM event began.`, {
          eventId,
          scheduledMonotonicTime: value.event.targetMonotonicTime,
          actualPcmStartMonotonicTime: value.event.actualPcmStartMonotonicTime,
          scheduleErrorMs: value.event.scheduleErrorMs,
        }, 'source', `simultaneous-start:${eventId}:${value.slot}`);
      }
    }
    const starts = values.map((value) => value.event?.actualPcmStartMonotonicTime);
    if (starts.every((value): value is number => typeof value === 'number')) {
      this.record(session, 'Source-generation skew measured.', {
        eventId, sourceGenerationSkewMs: Math.abs(starts[0] - starts[1]),
      }, 'source', `simultaneous-skew:${eventId}`);
    }
  }

  private captureMigrationDiagnostics(session: Session): void {
    const eventId = session.lastMigrationEventId;
    if (!eventId) return;
    const values = session.participants.map((participant) => ({
      slot: participant.slot,
      event: this.streamService.manager.getSnapshot(participant.streamId)?.scheduledEvents
        .find((candidate) => candidate.eventId === eventId),
    }));
    for (const value of values) {
      if (value.event?.actualPcmStartMonotonicTime !== null
        && value.event?.actualPcmStartMonotonicTime !== undefined
        && !session.events.some((event) => event.code === `migration-start:${eventId}:${value.slot}`)) {
        this.record(session, `Participant ${value.slot} migration source began.`, {
          eventId,
          scheduleErrorMs: value.event.scheduleErrorMs,
          actualPcmStartMonotonicTime: value.event.actualPcmStartMonotonicTime,
          startGain: value.event.gainEnvelope?.startGain ?? 1,
          endGain: value.event.gainEnvelope?.endGain ?? 1,
        }, 'source', `migration-start:${eventId}:${value.slot}`);
      }
    }
    const starts = values.map((value) => value.event?.actualPcmStartMonotonicTime);
    if (starts.every((value): value is number => typeof value === 'number')
      && !session.events.some((event) => event.code === `migration-skew:${eventId}`)) {
      this.record(session, 'Migration source-start generation skew measured.', {
        eventId,
        sourceGenerationSkewMs: Math.abs(starts[0] - starts[1]),
      }, 'source', `migration-skew:${eventId}`);
    }
    if (values.every((value) => value.event?.status === 'completed')
      && !session.events.some((event) => event.code === `migration-completed:${eventId}`)) {
      this.record(session, 'Audio migration completed.', {
        eventId,
        durationMs: multiSpeakerMigrationDurationMs,
      }, 'source', `migration-completed:${eventId}`);
    }
  }

  private record(session: Session, message: string, details?: Record<string, unknown>, category: AudioStreamDiagnosticEvent['category'] = 'lifecycle', code = 'multi-speaker'): void {
    session.events.push({ timestamp: new Date().toISOString(), category, code, message, ...(details ? { details } : {}) });
    if (session.events.length > 100) session.events.shift();
  }
}
