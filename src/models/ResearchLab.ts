export type AudioTopologyKind =
  | 'household'
  | 'group'
  | 'logical-player'
  | 'physical-device';

export type AudioDeviceCapability =
  | 'audio-clip'
  | 'continuous-stream';

export type AudioTransportAvailability =
  | 'available'
  | 'experimental'
  | 'unavailable';

export type AudioTransportScope =
  | 'physical-device'
  | 'logical-player'
  | 'group';

export interface AudioTopologyNode {
  id: string;
  kind: AudioTopologyKind;
  name: string;
  parentId?: string;
  selected?: boolean;
}

export interface AudioTransportOption {
  id: string;
  name: string;
  operation: 'audio-clip' | 'persistent-stream';
  scope: AudioTransportScope;
  independentlyTargetable: boolean;
  availability: AudioTransportAvailability;
  limitation?: string;
}

export interface AudioDevice {
  id: string;
  provider: string;
  name: string;
  model?: string;
  capabilities: AudioDeviceCapability[];
  topology: AudioTopologyNode[];
  transports: AudioTransportOption[];
}

export interface AudioDeviceDiscoveryResponse {
  ok: true;
  devices: AudioDevice[];
}
