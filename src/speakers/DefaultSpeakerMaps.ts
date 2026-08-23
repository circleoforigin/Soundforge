import type { SpeakerMap } from '../models/SpeakerMap';

const now = new Date();

export const headphonesSpeakerMap: SpeakerMap = {
  id: 'builtin-headphones-map',
  name: 'Headphones',

  createdAt: now,
  updatedAt: now,

  adapterType: 'browser-stereo',
  spatialOutputMode: 'fullSpatial',

  speakers: [
    {
      speakerId: 'headphones-left',
      providerId: 'browser-stereo',
      deviceId: 'channel-0',
      displayName: 'Left',
      enabled: true,
      trim: 0,
    },
    {
      speakerId: 'headphones-right',
      providerId: 'browser-stereo',
      deviceId: 'channel-1',
      displayName: 'Right',
      enabled: true,
      trim: 0,
    },
  ],
};
