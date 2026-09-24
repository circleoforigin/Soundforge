import {
  projectCommandDefinitions,
  projectEventDefinitions,
  projectQueryDefinitions,
} from '@settingforge/module-sdk';

import type {
  CommandDefinition,
} from '@settingforge/module-sdk';

export const loadSceneCommandDefinition:
  CommandDefinition = {
    id: 'SACscape.LoadScene',

    label: 'Load Scene',

    description:
      'Loads and activates a Scene in SACscape.',

    input: [
      {
        key: 'sceneId',
        label: 'Scene ID',
        type: 'string',
        required: true,
      },
    ],
  };

export const sacscapeEventDefinitions = [
  ...projectEventDefinitions,
];

export const sacscapeCommandDefinitions = [
  loadSceneCommandDefinition,
  ...projectCommandDefinitions,
];

export const sacscapeQueryDefinitions = [
  ...projectQueryDefinitions,
];