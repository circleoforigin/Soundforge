import {
  normalizeReaction,
} from '@settingforge/module-sdk';

import type {
  LegacyReaction,
  Reaction,
} from '@settingforge/module-sdk';

import type {
  SacscapeEffect,
} from './SacscapeEffect';

export interface SacscapeReaction {
  id: string;
  name?: string;
  trigger: Reaction;
  effect: SacscapeEffect;
}

export interface LegacySacscapeReaction {
  id: string;
  name?: string;
  trigger:
    | Reaction
    | LegacyReaction;
  effect: SacscapeEffect;
}

export function normalizeSacscapeReaction(
  reaction:
    LegacySacscapeReaction
): SacscapeReaction {
  return {
    ...reaction,

    trigger:
      normalizeReaction(
        reaction.trigger
      ),

    effect: {
      ...reaction.effect,
    },
  };
}