import type {
  HostEventMessage,
} from '@settingforge/module-sdk';

import { moduleEventBus } from './ModuleBus';

export type ModulePresenceState =
  | 'enabled'
  | 'starting'
  | 'ready'
  | 'stopped';

export interface ModuleCapabilitySet {
  events?: string[];
  actions?: string[];
}

export interface ModulePresence {
  id: string;
  name: string;
  version: string;
  state: ModulePresenceState;
  capabilities: ModuleCapabilitySet;
}

interface ModuleSnapshotPayload {
  modules: ModulePresence[];
}

interface ModuleEventPayload {
  module: ModulePresence;
}

export class ModulePresenceStore {
  private readonly modules =
    new Map<string, ModulePresence>();

  private unsubscribers:
    (() => void)[] = [];

  start(): void {
    this.stop();

    this.unsubscribers = [
      moduleEventBus.subscribe(
        'modules.snapshot',
        (message) =>
          this.handleSnapshot(
            message
          )
      ),

      moduleEventBus.subscribe(
        'module.added',
        (message) =>
          this.handleModuleUpdate(
            message
          )
      ),

      moduleEventBus.subscribe(
        'module.ready',
        (message) =>
          this.handleModuleUpdate(
            message
          )
      ),

      moduleEventBus.subscribe(
        'module.stopped',
        (message) =>
          this.handleModuleUpdate(
            message
          )
      ),

      moduleEventBus.subscribe(
        'module.removed',
        (message) =>
          this.handleModuleRemoved(
            message
          )
      ),
    ];
  }

  stop(): void {
    for (
      const unsubscribe
      of this.unsubscribers
    ) {
      unsubscribe();
    }

    this.unsubscribers = [];
  }

  announceReady(): void {
    moduleEventBus.emit(
      'module.ready',
      {
        capabilities: {
          events: [
            'sacscape.scene.opened',
            'sacscape.scene.closed',
            'sacscape.loopingZone.spawned',
          ],

          actions: [],
        },
      }
    );
  }

  getAll(): ModulePresence[] {
    return Array.from(
      this.modules.values()
    );
  }

  get(
    moduleId: string
  ): ModulePresence | undefined {
    return this.modules.get(
      moduleId
    );
  }

  has(
    moduleId: string
  ): boolean {
    return this.modules.has(
      moduleId
    );
  }

  isReady(
    moduleId: string
  ): boolean {
    return (
      this.modules.get(
        moduleId
      )?.state === 'ready'
    );
  }

  private handleSnapshot(
    message: HostEventMessage
  ): void {
    const payload =
      message.payload as
        | ModuleSnapshotPayload
        | undefined;

    if (
      !payload ||
      !Array.isArray(
        payload.modules
      )
    ) {
      return;
    }

    this.modules.clear();

    for (
      const module
      of payload.modules
    ) {
      this.modules.set(
        module.id,
        module
      );
    }
  }

  private handleModuleUpdate(
    message: HostEventMessage
  ): void {
    const payload =
      message.payload as
        | ModuleEventPayload
        | undefined;

    if (!payload?.module) {
      return;
    }

    this.modules.set(
      payload.module.id,
      payload.module
    );
  }

  private handleModuleRemoved(
    message: HostEventMessage
  ): void {
    const payload =
      message.payload as
        | ModuleEventPayload
        | undefined;

    if (!payload?.module) {
      return;
    }

    this.modules.delete(
      payload.module.id
    );
  }
}

export const modulePresence =
  new ModulePresenceStore();