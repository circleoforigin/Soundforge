export interface AudioFormatInspection {
  container: 'WAV' | 'MP3' | 'unknown';
  codec: string | null;
  sampleRateHz: number | null;
  channels: number | null;
  bitDepth: number | null;
  bitRateKbps: number | null;
}

function inspectWave(data: Buffer): AudioFormatInspection | null {
  if (
    data.length < 12 ||
    data.toString('ascii', 0, 4) !== 'RIFF' ||
    data.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    return null;
  }

  let offset = 12;
  while (offset + 8 <= data.length) {
    const chunkId = data.toString('ascii', offset, offset + 4);
    const chunkSize = data.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;

    if (chunkId === 'fmt ' && chunkSize >= 16 && chunkStart + 16 <= data.length) {
      let formatTag = data.readUInt16LE(chunkStart);
      const channels = data.readUInt16LE(chunkStart + 2);
      const sampleRateHz = data.readUInt32LE(chunkStart + 4);
      const bitDepth = data.readUInt16LE(chunkStart + 14);

      if (formatTag === 0xfffe && chunkSize >= 40 && chunkStart + 26 <= data.length) {
        formatTag = data.readUInt16LE(chunkStart + 24);
      }

      const codec = formatTag === 1
        ? 'PCM integer'
        : formatTag === 3
          ? 'IEEE float PCM'
          : `WAVE format tag 0x${formatTag.toString(16).padStart(4, '0')}`;

      return {
        container: 'WAV',
        codec,
        sampleRateHz,
        channels,
        bitDepth,
        bitRateKbps: null,
      };
    }

    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  return {
    container: 'WAV',
    codec: 'unknown (fmt chunk not available)',
    sampleRateHz: null,
    channels: null,
    bitDepth: null,
    bitRateKbps: null,
  };
}

function inspectMp3(data: Buffer): AudioFormatInspection | null {
  let offset = 0;
  if (data.length >= 10 && data.toString('ascii', 0, 3) === 'ID3') {
    offset = 10 +
      ((data[6] & 0x7f) << 21) +
      ((data[7] & 0x7f) << 14) +
      ((data[8] & 0x7f) << 7) +
      (data[9] & 0x7f);
  }

  for (; offset + 4 <= data.length; offset += 1) {
    if (data[offset] !== 0xff || (data[offset + 1] & 0xe0) !== 0xe0) {
      continue;
    }

    const versionBits = (data[offset + 1] >> 3) & 0x03;
    const layerBits = (data[offset + 1] >> 1) & 0x03;
    const sampleRateIndex = (data[offset + 2] >> 2) & 0x03;
    const bitRateIndex = (data[offset + 2] >> 4) & 0x0f;
    if (
      versionBits === 1 ||
      layerBits === 0 ||
      sampleRateIndex === 3 ||
      bitRateIndex === 0 ||
      bitRateIndex === 15
    ) {
      continue;
    }

    const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;
    const layer = 4 - layerBits;
    if (layer !== 3) {
      continue;
    }

    const baseRates = [44100, 48000, 32000];
    const sampleRateHz = baseRates[sampleRateIndex] / (version === 1 ? 1 : version === 2 ? 2 : 4);
    const channelMode = (data[offset + 3] >> 6) & 0x03;
    const mpeg1BitRates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
    const mpeg2BitRates = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

    return {
      container: 'MP3',
      codec: `MPEG-${version} Layer III`,
      sampleRateHz,
      channels: channelMode === 3 ? 1 : 2,
      bitDepth: null,
      bitRateKbps: (version === 1 ? mpeg1BitRates : mpeg2BitRates)[bitRateIndex],
    };
  }

  return null;
}

export function inspectAudioFormat(data: Buffer): AudioFormatInspection {
  return inspectWave(data) ?? inspectMp3(data) ?? {
    container: 'unknown',
    codec: null,
    sampleRateHz: null,
    channels: null,
    bitDepth: null,
    bitRateKbps: null,
  };
}
