import { logSonosInfo } from './SonosDiagnosticLog.ts';

interface AudioClipCorrelation {
  playerId: string;
  assetId: string;
  assetName: string;
}

export interface SonosAudioClipStatus {
  id?: unknown;
  status?: unknown;
  errorCode?: unknown;
  name?: unknown;
  appId?: unknown;
}

const correlations = new Map<string, AudioClipCorrelation>();

function correlationKey(playerId: string, clipId: string): string {
  return `${playerId}\u0000${clipId}`;
}

export function rememberAudioClip(
  playerId: string,
  clipId: string,
  assetId: string,
  assetName: string
): void {
  correlations.set(correlationKey(playerId, clipId), {
    playerId,
    assetId,
    assetName,
  });
}

export function logAudioClipStatus(
  playerId: string,
  clip: SonosAudioClipStatus
): void {
  const clipId = typeof clip.id === 'string' ? clip.id : null;
  const correlation = clipId
    ? correlations.get(correlationKey(playerId, clipId))
    : undefined;

  logSonosInfo('AUDIO_CLIP', 'Sonos audioClipStatus event.', {
    playerId,
    clipId,
    status: clip.status ?? null,
    errorCode: clip.errorCode ?? null,
    name: clip.name ?? null,
    appId: clip.appId ?? null,
    correlated: Boolean(correlation),
    assetId: correlation?.assetId ?? null,
    assetName: correlation?.assetName ?? null,
  });

  if (
    clipId &&
    ['DONE', 'DISMISSED', 'ERROR', 'INTERRUPTED'].includes(String(clip.status))
  ) {
    correlations.delete(correlationKey(playerId, clipId));
  }
}
