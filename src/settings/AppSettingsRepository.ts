import type {
  AppSettings,
} from '../models/AppSettings';

import {
  DEFAULT_APP_SETTINGS,
} from '../models/AppSettings';

import {
  hostedCollectionRepository,
} from '../host/HostedCollectionRepository';

const SETTINGS_COLLECTION =
  'settings';

const APP_SETTINGS_KEY =
  'app';

export class AppSettingsRepository {
  async loadSettings(): Promise<AppSettings> {
    const settings =
      await hostedCollectionRepository
        .loadOne<AppSettings>(
          SETTINGS_COLLECTION,
          APP_SETTINGS_KEY
        );

    return {
      ...DEFAULT_APP_SETTINGS,
      ...(settings ?? {}),
    };
  }

  async saveSettings(
    settings: AppSettings
  ): Promise<AppSettings> {
    await hostedCollectionRepository.save(
      SETTINGS_COLLECTION,
      APP_SETTINGS_KEY,
      settings
    );

    return settings;
  }
}

export const appSettingsRepository =
  new AppSettingsRepository();