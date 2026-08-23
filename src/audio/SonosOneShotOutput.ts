import type { SceneObjectInstance } from '../models/SceneObjectInstance';
import type { SoundAsset } from '../models/SoundAsset';
import type { SpeakerMap } from '../models/SpeakerMap';
import { apiUrl } from '../config/api';
import type { SpeakerMix } from '../utils/spatialMixMath';

interface SonosOneShotRequest {
  asset: SoundAsset;
  node: SceneObjectInstance;
  speakerMap: SpeakerMap;
  speakerMix: SpeakerMix[];
  sceneOneShotVolume: number;
  sceneMasterVolume: number;
  roomSpeakerNames: ReadonlyMap<string, string>;
  balancedFieldRoute?: 'center' | 'directional';
  correlationId?: string;
}

export interface SonosOneShotTargetResult {
  speakerId: string;
  playerId: string;
  label: string;
  accepted: boolean;
  httpStatus?: number;
  message: string;
  volume: number;
  routingKind?: 'logical-player center' | 'physical-device directional';
}

const synchronizedStreamUrls = new Map<string, string>();
const synchronizationRequests = new Map<string, Promise<string>>();

function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

async function getErrorMessage(response: Response, fallback: string) {
  try {
    const data = await response.json() as { message?: string };
    return data.message ?? fallback;
  } catch {
    return fallback;
  }
}

async function resolveLogicalPlayer(deviceIds: string[]): Promise<{
  playerId: string;
  playerName: string;
}> {
  const response = await fetch(apiUrl('/api/sonos/resolve-logical-player'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceIds }),
  });

  if (!response.ok) {
    throw new Error(await getErrorMessage(
      response,
      'Unable to resolve the logical Sonos player for center playback.'
    ));
  }

  return response.json() as Promise<{ playerId: string; playerName: string }>;
}

async function performLocalAssetSynchronization(asset: SoundAsset): Promise<string> {
  const cachedUrl = synchronizedStreamUrls.get(asset.id);

  if (cachedUrl) {
    return cachedUrl;
  }

  const mediaUrl = apiUrl(`/api/sonos/media/${encodeURIComponent(asset.id)}`);
  const existingResponse = await fetch(mediaUrl, { method: 'HEAD' });

  if (existingResponse.ok) {
    synchronizedStreamUrls.set(asset.id, mediaUrl);
    return mediaUrl;
  }

  const localUrl = asset.source.playbackUrl;

  if (!localUrl) {
    throw new Error(
      'This sound is not available from the local library. Reconnect its Library Folder, then try again.'
    );
  }

  const localResponse = await fetch(localUrl);

  if (!localResponse.ok) {
    throw new Error('Unable to read this sound from the local library for Sonos synchronization.');
  }

  const blob = await localResponse.blob();
  const mimeType = (asset.mimeType || blob.type).toLowerCase();

  if (!['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave'].includes(mimeType)) {
    throw new Error('Sonos One Shots currently support WAV and MP3 assets only.');
  }

  const formData = new FormData();
  formData.append(
    'file',
    new File([blob], asset.originalFileName || `${asset.id}.${mimeType.includes('wav') ? 'wav' : 'mp3'}`, {
      type: mimeType,
    })
  );

  const uploadResponse = await fetch(mediaUrl, {
    method: 'POST',
    body: formData,
  });

  if (!uploadResponse.ok) {
    throw new Error(await getErrorMessage(uploadResponse, 'Unable to synchronize this sound for Sonos.'));
  }

  const data = await uploadResponse.json() as { streamUrl?: string };
  const streamUrl = data.streamUrl || mediaUrl;
  synchronizedStreamUrls.set(asset.id, streamUrl);
  return streamUrl;
}

async function synchronizeLocalAsset(asset: SoundAsset): Promise<string> {
  const existingRequest = synchronizationRequests.get(asset.id);

  if (existingRequest) {
    return existingRequest;
  }

  const request = performLocalAssetSynchronization(asset).finally(() => {
    synchronizationRequests.delete(asset.id);
  });

  synchronizationRequests.set(asset.id, request);
  return request;
}

async function resolveSonosStreamUrl(asset: SoundAsset): Promise<string> {
  if (asset.source.type === 'local') {
    return synchronizeLocalAsset(asset);
  }

  if (!asset.source.path.startsWith('https://')) {
    throw new Error('Sonos web sounds require a public HTTPS WAV or MP3 URL.');
  }

  const mimeType = asset.mimeType?.toLowerCase();
  const pathName = new URL(asset.source.path).pathname.toLowerCase();
  const supportedByMetadata = mimeType
    ? ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave'].includes(mimeType)
    : false;

  if (!supportedByMetadata && !pathName.endsWith('.mp3') && !pathName.endsWith('.wav')) {
    throw new Error('Sonos One Shots currently support WAV and MP3 assets only.');
  }

  return asset.source.path;
}

export async function playSonosOneShot({
  asset,
  node,
  speakerMap,
  speakerMix,
  sceneOneShotVolume,
  sceneMasterVolume,
  roomSpeakerNames,
  balancedFieldRoute,
  correlationId,
}: SonosOneShotRequest): Promise<SonosOneShotTargetResult[]> {
  if (node.muted) {
    return [];
  }

  const mappedSpeakers = speakerMap.speakers.filter(
    (speaker) => speaker.enabled && speaker.deviceId
  );

  if (mappedSpeakers.length === 0) {
    throw new Error('No enabled Sonos speakers are assigned to this Room.');
  }

  const spatialGains = new Map(
    speakerMix.map((speaker) => [speaker.speakerId, speaker.gain])
  );
  const baseGain = dbToLinear(node.gainDb ?? 0) *
    sceneOneShotVolume * sceneMasterVolume;
  const routedSpeakers = mappedSpeakers.filter(
    (speaker) => (spatialGains.get(speaker.speakerId) ?? 0) > 0
  );

  const targets = balancedFieldRoute === 'center'
    ? await (async () => {
        const logicalPlayer = await resolveLogicalPlayer(
          routedSpeakers.map((speaker) => speaker.deviceId)
        );
        return [{
          speakerId: logicalPlayer.playerId,
          playerId: logicalPlayer.playerId,
          label: logicalPlayer.playerName || 'Sonos logical player',
          volume: Math.min(100, baseGain * 100),
          routingKind: 'logical-player center' as const,
        }];
      })()
    : routedSpeakers.map((speaker) => {
        const effectiveGain = baseGain *
          (spatialGains.get(speaker.speakerId) ?? 0) *
          dbToLinear(speaker.trim ?? 0);

        return {
          speakerId: speaker.speakerId,
          playerId: speaker.deviceId,
          label: roomSpeakerNames.get(speaker.speakerId) ||
            speaker.displayName ||
            speaker.speakerId,
          volume: Math.min(100, effectiveGain * 100),
          routingKind: balancedFieldRoute === 'directional'
            ? 'physical-device directional' as const
            : undefined,
        };
      });

  if (targets.length === 0) {
    return [];
  }

  const streamUrl = await resolveSonosStreamUrl(asset);

  return Promise.all(
    targets.map(async ({ speakerId, playerId, label, volume, routingKind }) => {
      try {
        const response = await fetch(
          apiUrl(`/api/sonos/audio-clip/${encodeURIComponent(playerId)}`),
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              streamUrl,
              volume,
              name: node.instanceName || asset.name || 'SACscape One Shot',
              assetId: asset.id,
              assetName: asset.name,
              routingKind,
              correlationId,
            }),
          }
        );

        if (response.ok) {
          return {
            speakerId,
            playerId,
            label,
            accepted: true,
            httpStatus: response.status,
            message: 'accepted',
            volume,
            routingKind,
          };
        }

        return {
          speakerId,
          playerId,
          label,
          accepted: false,
          httpStatus: response.status,
          message: await getErrorMessage(response, `Sonos ${response.status}`),
          volume,
          routingKind,
        };
      } catch (error) {
        return {
          speakerId,
          playerId,
          label,
          accepted: false,
          message: error instanceof Error ? error.message : 'Request failed',
          volume,
          routingKind,
        };
      }
    })
  );
}
