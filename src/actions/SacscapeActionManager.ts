import { reactionMatches } from '@settingforge/module-sdk';
import type {
  HostEventMessage,
  ModuleEventBus,
  RegisteredActionDefinition,
} from '@settingforge/module-sdk';
import type { Project } from '../models/Project';
import { moduleEventBus } from '../host/ModuleBus';

type ProjectProvider = () => Project | null;
type ActiveSceneProvider = () => string | null;
type SceneTransitionRequester = (sceneId: string) => Promise<void>;

export class SacscapeActionManager {
  private readonly eventBus: ModuleEventBus;
  private readonly actionSubscriptions = new Map<string, () => void>();
  private stopCatalogSubscription: (() => void) | null = null;
  private getProject: ProjectProvider = () => null;
  private getActiveSceneId: ActiveSceneProvider = () => null;
  private transitionToScene: SceneTransitionRequester = async () => undefined;

  constructor(eventBus: ModuleEventBus) {
    this.eventBus = eventBus;
  }

  start(
    getProject: ProjectProvider,
    getActiveSceneId: ActiveSceneProvider,
    transitionToScene: SceneTransitionRequester
  ): () => void {
    this.stop();
    this.getProject = getProject;
    this.getActiveSceneId = getActiveSceneId;
    this.transitionToScene = transitionToScene;
    this.stopCatalogSubscription = this.eventBus.onActionsChanged(
      (actions) => this.synchronizeSubscriptions(actions)
    );
    return () => this.stop();
  }

  stop(): void {
    this.stopCatalogSubscription?.();
    this.stopCatalogSubscription = null;
    for (const unsubscribe of this.actionSubscriptions.values()) {
      unsubscribe();
    }
    this.actionSubscriptions.clear();
  }

  private synchronizeSubscriptions(
    actions: RegisteredActionDefinition[]
  ): void {
    const availableIds = new Set(actions.map((action) => action.id));
    for (const [actionId, unsubscribe] of this.actionSubscriptions) {
      if (availableIds.has(actionId)) continue;
      unsubscribe();
      this.actionSubscriptions.delete(actionId);
    }

    for (const action of actions) {
      if (this.actionSubscriptions.has(action.id)) continue;
      const unsubscribe = this.eventBus.subscribe(action.id, (message) => {
        void this.handleAction(message);
      });
      this.actionSubscriptions.set(action.id, unsubscribe);
    }
  }

  private async handleAction(message: HostEventMessage): Promise<void> {
    const project = this.getProject();
    if (!project) return;

    const sceneIds = new Set<string>();
    for (const reaction of project.reactions) {
      if (!reactionMatches(reaction.trigger, message.type, message.payload)) {
        continue;
      }
      if (reaction.effect.type === 'load-scene') {
        sceneIds.add(reaction.effect.sceneId);
      }
    }

    for (const sceneId of sceneIds) {
      if (sceneId === this.getActiveSceneId()) continue;
      await this.transitionToScene(sceneId);
    }
  }
}

export const sacscapeActionManager =
  new SacscapeActionManager(moduleEventBus);
