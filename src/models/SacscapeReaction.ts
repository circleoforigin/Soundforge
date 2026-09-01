import type { Reaction } from '@settingforge/module-sdk';
import type { SacscapeEffect } from './SacscapeEffect';

export interface SacscapeReaction {
  id: string;
  name?: string;
  trigger: Reaction;
  effect: SacscapeEffect;
}
