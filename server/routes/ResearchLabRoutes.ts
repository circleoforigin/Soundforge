import type { Express } from 'express';

import {
  registerResearchLabDeviceRoute,
  type ResearchLabDeviceRouteDependencies,
} from './ResearchLabDeviceRoute.ts';
import { registerResearchLabMultiSpeakerRoute } from './ResearchLabMultiSpeakerRoute.ts';
import {
  registerResearchLabStreamRoute,
  type ResearchLabStreamRouteDependencies,
} from './ResearchLabStreamRoute.ts';
import type { MultiSpeakerSessionService } from '../research-lab/MultiSpeakerSessionService.ts';

export interface ResearchLabRouteDependencies {
  device?: ResearchLabDeviceRouteDependencies;
  stream?: ResearchLabStreamRouteDependencies;
  multiSpeaker?: MultiSpeakerSessionService;
}

export function registerResearchLabRoutes(
  app: Express,
  dependencies: ResearchLabRouteDependencies = {}
): void {
  registerResearchLabDeviceRoute(app, dependencies.device);
  registerResearchLabStreamRoute(app, dependencies.stream);
  registerResearchLabMultiSpeakerRoute(app, dependencies.multiSpeaker);
}
