
export interface AppSettings {
  activeSpeakerMapId?: string;

  defaultFadeInMs: number;
  defaultFadeOutMs: number;

  autosave: boolean;

  diagnosticsEnabled: boolean;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  defaultFadeInMs: 1000,
  defaultFadeOutMs: 1000,
  autosave: false,
  diagnosticsEnabled: false,
};
