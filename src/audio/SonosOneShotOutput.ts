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
}: SonosOneShotRequest): Promise<void> {
  if (node.muted) {
    return;
  }

  const streamUrl = await resolveSonosStreamUrl(asset);
  const spatialGains = new Map(
    speakerMix.map((speaker) => [speaker.speakerId, speaker.gain])
  );
  const baseGain = dbToLinear(node.gainDb ?? 0) *
    sceneOneShotVolume * sceneMasterVolume;
  const mappedSpeakers = speakerMap.speakers.filter(
    (speaker) => speaker.enabled && speaker.deviceId
  );

  if (mappedSpeakers.length === 0) {
    throw new Error('No enabled Sonos speakers are assigned to this Room.');
  }

  const targets = mappedSpeakers.flatMap((speaker) => {
    const effectiveGain = baseGain *
      (spatialGains.get(speaker.speakerId) ?? 0) *
      dbToLinear(speaker.trim ?? 0);

    return effectiveGain > 0
      ? [{ playerId: speaker.deviceId, volume: Math.min(100, effectiveGain * 100) }]
      : [];
  });

  if (targets.length === 0) {
    return;
  }

  const results = await Promise.allSettled(
    targets.map(async ({ playerId, volume }) => {
      const response = await fetch(
        apiUrl(`/api/sonos/audio-clip/${encodeURIComponent(playerId)}`),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            streamUrl,
            volume,
            name: node.instanceName || asset.name || 'SACscape One Shot',
          }),
        }
      );

      if (!response.ok) {
        throw new Error(await getErrorMessage(response, `Unable to play on ${playerId}.`));
      }
    })
  );
  const failures = results.filter((result) => result.status === 'rejected');

  if (failures.length > 0) {
    throw new Error(
      failures.length === results.length
        ? 'Sonos could not play this One Shot on any mapped speaker.'
        : `Sonos played on ${results.length - failures.length} of ${results.length} mapped speakers.`
    );
  }
}
