import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { SoundAsset } from './models/SoundAsset';
import './App.css';
import type {
  ProjectLoadAcceptedPayload,
  ProjectLoadFailedPayload,
  ProjectLoadedPayload,
  ProjectLoadRequest,
} from '@settingforge/module-sdk';

import type { Project } from './models/Project';
import type { SceneInstance } from './models/SceneInstance';
import type { SoundObjectTemplate } from './models/SoundObjectTemplate';
import type { Room } from './models/Room';
import type { SpeakerMap } from './models/SpeakerMap';
import type { RegisteredActionDefinition } from '@settingforge/module-sdk';

import MenuBar from './components/MenuBar';
import SceneWorkspace from './components/SceneWorkspace';
import { headphonesRoom } from './rooms/DefaultRoom';
import { headphonesSpeakerMap } from './speakers/DefaultSpeakerMaps';
import { roomRepository } from './rooms/RoomRepository';
import { createDefaultRoom } from './rooms/createDefaultRoom';
import RoomManagerDialog from './components/RoomManagerDialog';
import ResearchLabDialog from './components/ResearchLabDialog';
import SettingsDialog from './components/SettingsDialog';
import DiagnosticLogDialog from './components/DiagnosticLogDialog';
import RoomSelectorDialog from './components/RoomSelectorDialog';
import ReactionsDialog, {
  type ReactionSceneOption,
} from './components/ReactionsDialog';
import { DEFAULT_APP_SETTINGS, type AppSettings } from './models/AppSettings';
import { appSettingsRepository} from './settings/AppSettingsRepository.ts';
import { speakerMapRepository } from './speakers/SpeakerMapRepository';
import { projectRepository } from './projects/ProjectRepository';
import { sceneRepository } from './scenes/SceneRepository';

import ImportSoundDialog, {
  type ImportSoundData,
} from './components/ImportSoundDialog';
import { hostedSoundLibrary} from './services/library/HostedSoundLibraryService';
import { roomAudioEngine } from './audio/RoomAudioEngine';

import { moduleEventBus } from './host/ModuleBus';
import { modulePresence } from './host/ModulePresence';
import { sacscapeActionManager } from './actions/SacscapeActionManager';

function App() {
  const [showNewProjectDialog, setShowNewProjectDialog] = useState(false);
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [savedProjects, setSavedProjects] = useState<Project[]>([]);
  const [soundAssets, setSoundAssets] = useState<SoundAsset[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [projectDirty, setProjectDirty] = useState(false);
  const [showReactions, setShowReactions] = useState(false);
  const [reactionScenes, setReactionScenes] =
    useState<ReactionSceneOption[]>([]);
  const [availableActions, setAvailableActions] =
    useState<RegisteredActionDefinition[]>(() => {
      return moduleEventBus.getAvailableActions();
    });
  const activeProjectRef = useRef<Project | null>(null);
  const currentSceneIdRef = useRef<string | null>(null);
  const transitionToSceneRef = useRef<(sceneId: string) => Promise<void>>(
    async () => undefined
  );
  type SceneSummary = {
    instanceId: string;
    instanceName: string;
    description: string;
  };
  const [loadedScenes, setLoadedScenes] =
    useState<Map<string, SceneInstance>>(
      () => new Map()
    );
  const loadedScenesRef = useRef<Map<string, SceneInstance>>(new Map());
  const [sceneSummaries, setSceneSummaries] = useState<SceneSummary[]>([]);
  const [
    selectedSceneIdsToLoad,
    setSelectedSceneIdsToLoad,
  ] = useState<Set<string>>(
    () => new Set()
  );
  const [dirtySceneIds, setDirtySceneIds] =
    useState<Set<string>>(() => new Set());
  const [showUnsavedChangesDialog, setShowUnsavedChangesDialog] =
    useState(false);
  const pendingProjectActionRef =
    useRef<(() => void) | null>(null);
  const pendingSaveActionRef =
  useRef<(() => Promise<boolean>) | null>(
    null
  );
  const [notification, setNotification] = useState<string | null>(null);
  const [currentSceneInstanceId, setCurrentSceneInstanceId] =
    useState<string | null>(null);
  const [showRoomSelectionDialog, setShowRoomSelectionDialog] = useState(false);
  const [showSceneSelectionDialog, setShowSceneSelectionDialog] = useState(false);
  const [showLoadSceneDialog, setShowLoadSceneDialog] = useState(false);
  const [showDeleteSceneDialog, setShowDeleteSceneDialog] = useState(false);
  const [selectedSceneIdToDelete, setSelectedSceneIdToDelete] = useState<string | null>(null);
  const [importingSound, setImportingSound] = useState(false);
  const [transitionTargetInstanceId, setTransitionTargetInstanceId] =
    useState<string | null>(null);
  const [previewingTarget, setPreviewingTarget] = useState(false);
  const [transitionInProgress, setTransitionInProgress] = useState(false);
  const transitionInProgressRef = useRef(false);
  const transitionRunIdRef = useRef(0);
  const [projectRuntimeKey, setProjectRuntimeKey] = useState(0);
  const [sceneOnLoadActivationVersion, setSceneOnLoadActivationVersion] = useState(0);
  const [newProjectName, setNewProjectName] = useState('');
  const [showNewSceneDialog, setShowNewSceneDialog] = useState(false);
  const [newSceneName, setNewSceneName] = useState('');
  const [showImportSoundDialog, setShowImportSoundDialog] =
    useState(false);
  const [soundObjectTemplates] =
    useState<SoundObjectTemplate[]>([]);
  const [activeRoom, setActiveRoom] = useState<Room | null>(null);
const [customRooms, setCustomRooms] = useState<Room[]>([]);
  const availableRooms: Room[] = [
    headphonesRoom,
    ...customRooms,
  ];
  const [showRoomManager, setShowRoomManager] =
    useState(false);
  const [showResearchLab, setShowResearchLab] =
    useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showDiagnosticLog, setShowDiagnosticLog] = useState(false);
  const [appSettings, setAppSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [savingSettings, setSavingSettings] = useState(false);
  const [speakerMaps, setSpeakerMaps] =
    useState<SpeakerMap[]>([]);
  const activeSpeakerMap: SpeakerMap =
    speakerMaps.find((speakerMap) => speakerMap.id === activeRoom?.speakerMapId) ??
    headphonesSpeakerMap;
  useSyncExternalStore(roomAudioEngine.subscribe, roomAudioEngine.getVersion);
  const roomSpeakerVolumeStatus = roomAudioEngine.getRoomSpeakerVolumeStatus();
  
useEffect(() => {
  modulePresence.start();

  modulePresence.announceReady();

  return () => {
    modulePresence.stop();
  };
}, []);

useEffect(() => {
  return moduleEventBus.onActionsChanged(setAvailableActions);
}, []);

useEffect(() => {
  activeProjectRef.current = activeProject;
}, [activeProject]);

useEffect(() => {
  currentSceneIdRef.current = currentSceneInstanceId;
}, [currentSceneInstanceId]);

useEffect(() => {
  loadedScenesRef.current = loadedScenes;
}, [loadedScenes]);

useEffect(() => {
  async function loadSoundLibrary() {
    try {
      const assets =
        await hostedSoundLibrary
          .initialize();

      setSoundAssets(
        assets
      );
    } catch (error) {
      console.error(
        'Unable to load sound library:',
        error
      );

      setNotification(
        'Unable to load sound library.'
      );

      setTimeout(() => {
        setNotification(null);
      }, 3000);
    }
  }

  void loadSoundLibrary();
}, []);

useEffect(() => {
  async function loadSettings() {
    try {
      const settings =
        await appSettingsRepository
          .loadSettings();

      setAppSettings(
        settings
      );
    } catch (error) {
      console.error(
        'Unable to load application settings:',
        error
      );

      setNotification(
        'Unable to load application settings.'
      );

      setTimeout(() => {
        setNotification(null);
      }, 3000);
    }
  }

  void loadSettings();
}, []);

useEffect(() => {
  async function loadRooms() {
    try {
      const rooms =
        await roomRepository.loadRooms();

      setCustomRooms(rooms);
    } catch (error) {
      console.error(
        'Unable to load rooms:',
        error
      );

      setNotification(
        'Unable to load rooms.'
      );

      setTimeout(() => {
        setNotification(null);
      }, 3000);
    }
  }

  void loadRooms();
}, []);

useEffect(() => {
  async function loadSpeakerMaps() {
    try {
      const maps =
        await speakerMapRepository
          .loadSpeakerMaps();

      setSpeakerMaps(maps);
    } catch (error) {
      console.error(
        'Unable to load speaker maps:',
        error
      );

      setNotification(
        'Unable to load speaker maps.'
      );

      setTimeout(() => {
        setNotification(null);
      }, 3000);
    }
  }

  void loadSpeakerMaps();
}, []);

async function handleSettingsChange(
  settings: AppSettings
) {
  const previous =
    appSettings;

  setAppSettings(
    settings
  );

  setSavingSettings(
    true
  );

  try {
    const savedSettings =
      await appSettingsRepository
        .saveSettings(
          settings
        );

    setAppSettings(
      savedSettings
    );
  } catch (error) {
    console.error(
      'Unable to save application settings:',
      error
    );

    setAppSettings(
      previous
    );

    setNotification(
      'Unable to save application settings.'
    );

    setTimeout(() => {
      setNotification(null);
    }, 3000);
  } finally {
    setSavingSettings(
      false
    );
  }
}

  const currentScene =
  currentSceneInstanceId
    ? loadedScenes.get(
        currentSceneInstanceId
      ) ?? null
    : null;

const transitionTarget =
  transitionTargetInstanceId
    ? loadedScenes.get(
        transitionTargetInstanceId
      ) ?? null
    : null;

  const displayedScene =
    previewingTarget && transitionTarget
      ? transitionTarget
      : currentScene;

  function handleNewProject() {
    setShowNewProjectDialog(true);
  }

  async function saveActiveProject(
  notificationMessage = 'Project saved.'
): Promise<boolean> {
  if (!activeProject) {
    return false;
  }

  try {
    for (const sceneId of dirtySceneIds) {
      const scene =
        loadedScenes.get(sceneId);

      if (!scene) {
        continue;
      }

      await sceneRepository.saveScene(
        scene
      );
    }

    const projectToSave: Project = {
      ...activeProject,

      activeSceneInstanceId:
        currentSceneInstanceId ??
        undefined,

      activeRoomId:
        activeRoom?.id ??
        undefined,

      lastSceneId:
        currentSceneInstanceId ??
        undefined,

      lastRoomId:
        activeRoom?.id ??
        undefined,

      updatedAt: new Date(),
    };

    const projects =
      await projectRepository.saveProject(
        projectToSave
      );

    setActiveProject(
      projectToSave
    );

    setSavedProjects(
      projects
    );

    setDirtySceneIds(
      new Set()
    );
    setProjectDirty(false);

    setNotification(
      notificationMessage
    );

    setTimeout(() => {
      setNotification(null);
    }, 3000);

    return true;
  } catch (error) {
    console.error(
      'Unable to save project:',
      error
    );

    setNotification(
      'Unable to save project.'
    );

    setTimeout(() => {
      setNotification(null);
    }, 3000);

    return false;
  }
}

  function handleSaveProject() {
  void saveActiveProject();
}

  async function handleSaveScene() {
  if (!currentScene) {
    return;
  }

  try {
    await sceneRepository.saveScene(
      currentScene
    );

    setDirtySceneIds((current) => {
      const updated =
        new Set(current);

      updated.delete(
        currentScene.instanceId
      );

      return updated;
    });

    setNotification(
      'Scene saved.'
    );

    setTimeout(() => {
      setNotification(null);
    }, 3000);
  } catch (error) {
    console.error(
      'Unable to save scene:',
      error
    );

    setNotification(
      'Unable to save scene.'
    );

    setTimeout(() => {
      setNotification(null);
    }, 3000);
  }
}

async function handleDeleteScene() {
  if (
    !activeProject ||
    activeProject.sceneIds.length === 0
  ) {
    return;
  }

  try {
    const scenes =
      await sceneRepository.loadScenes();

    const projectSceneIds =
      new Set(
        activeProject.sceneIds
      );

    const summaries: SceneSummary[] =
      scenes
        .filter((scene) =>
          projectSceneIds.has(
            scene.instanceId
          ) &&
          scene.instanceId !==
            currentSceneInstanceId
        )
        .map((scene) => ({
          instanceId:
            scene.instanceId,

          instanceName:
            scene.instanceName,

          description:
            scene.description ?? '',
        }));

        if (summaries.length === 0) {
  setNotification(
    'No scenes available to delete. Close the current scene first if you want to delete it.'
  );

  setTimeout(() => {
    setNotification(null);
  }, 3000);

  return;
}
    setSceneSummaries(
      summaries
    );

    setSelectedSceneIdToDelete(
      null
    );

    setShowDeleteSceneDialog(
      true
    );
  } catch (error) {
    console.error(
      'Unable to load scene list:',
      error
    );

    setNotification(
      'Unable to load scenes.'
    );

    setTimeout(() => {
      setNotification(null);
    }, 3000);
  }
}

async function confirmDeleteSelectedScene() {
  if (
    !activeProject ||
    !selectedSceneIdToDelete
  ) {
    return;
  }

  const sceneId =
    selectedSceneIdToDelete;

  const summary =
    sceneSummaries.find(
      (scene) =>
        scene.instanceId === sceneId
    );

  const sceneName =
    summary?.instanceName ??
    'this scene';

  if (
    !window.confirm(
      `Delete "${sceneName}"? This cannot be undone.`
    )
  ) {
    return;
  }

  try {
    await sceneRepository.deleteScene(
      sceneId
    );

    const updatedProject: Project = {
      ...activeProject,

      sceneIds:
        activeProject.sceneIds.filter(
          (candidateId) =>
            candidateId !== sceneId
        ),

     activeSceneInstanceId: activeProject.activeSceneInstanceId,
      lastSceneId:
        activeProject.lastSceneId === sceneId
          ? undefined
          : activeProject.lastSceneId,
      updatedAt: new Date(),
    };

    const projects =
      await projectRepository.saveProject(
        updatedProject
      );

    setLoadedScenes((current) => {
      const updated =
        new Map(current);

      updated.delete(sceneId);

      return updated;
    });

    setDirtySceneIds((current) => {
      const updated =
        new Set(current);

      updated.delete(sceneId);

      return updated;
    });

    if (
      currentSceneInstanceId === sceneId
    ) {
      setCurrentSceneInstanceId(
        null
      );
    }

    if (
      transitionTargetInstanceId === sceneId
    ) {
      setTransitionTargetInstanceId(
        null
      );

      setPreviewingTarget(false);
    }

    setActiveProject(
      updatedProject
    );
    setProjectDirty(false);

    setSavedProjects(
      projects
    );

    setSelectedSceneIdToDelete(
      null
    );

    setShowDeleteSceneDialog(
      false
    );

    setNotification(
      'Scene deleted.'
    );

    setTimeout(() => {
      setNotification(null);
    }, 3000);
  } catch (error) {
    console.error(
      'Unable to delete scene:',
      error
    );

    setNotification(
      'Unable to delete scene.'
    );

    setTimeout(() => {
      setNotification(null);
    }, 3000);
  }
}

  function requestProjectAction(
    action: () => void
    ) {
    if (!projectDirty && dirtySceneIds.size === 0) {
      action();
      return;
    }
    pendingSaveActionRef.current =
      () => saveActiveProject();
    pendingProjectActionRef.current = action;
    setShowUnsavedChangesDialog(true);
  }

  function requestCurrentSceneAction(
  action: () => void
) {
  if (
    !currentScene ||
    !dirtySceneIds.has(
      currentScene.instanceId
    )
  ) {
    action();
    return;
  }

  const sceneToSave =
  currentScene;

pendingSaveActionRef.current =
  async () => {
    try {
      await sceneRepository.saveScene(
        sceneToSave
      );

      setDirtySceneIds(
        (current) => {
          const updated =
            new Set(current);

          updated.delete(
            sceneToSave.instanceId
          );

          return updated;
        }
      );

      return true;
    } catch (error) {
      console.error(
        'Unable to save scene:',
        error
      );

      setNotification(
        'Unable to save scene.'
      );

      setTimeout(() => {
        setNotification(null);
      }, 3000);

      return false;
    }
  };

pendingProjectActionRef.current =
  action;

setShowUnsavedChangesDialog(
  true
);
}

  async function finishPendingProjectAction(
  saveFirst: boolean
) {
  const action =
    pendingProjectActionRef.current;

  if (!action) {
    return;
  }

 if (saveFirst) {
  const saveAction =
    pendingSaveActionRef.current;

  if (saveAction) {
    const saved =
      await saveAction();

    if (!saved) {
      return;
    }
  }
}

  pendingProjectActionRef.current =
    null;
pendingSaveActionRef.current =
  null;
  setShowUnsavedChangesDialog(
    false
  );

  action();
}

  function cancelPendingProjectAction() {
    pendingProjectActionRef.current = null;
    setShowUnsavedChangesDialog(false);
  }

  function teardownProjectRuntime()
  {
    console.warn('===== TEARDOWN ENTER =====');

  console.warn('===== ABOUT TO SHUTDOWN AUDIO ENGINE =====');
    roomAudioEngine.shutdown();
    console.warn('===== AUDIO ENGINE SHUTDOWN COMPLETE =====');

  console.warn(
    '===== ABOUT TO STOP LOADED SCENES =====',
    loadedScenes.size
  );
    for (const scene of loadedScenes.values()) {
      roomAudioEngine.stopScene(
        scene.instanceId
      );

      roomAudioEngine.setSceneTransitionGain(
        scene.instanceId, 1
      );
    }
 console.warn('===== SCENE STOP LOOP COMPLETE =====');

    transitionRunIdRef.current += 1;
    transitionInProgressRef.current = false;
    setTransitionInProgress(false);
    setTransitionTargetInstanceId(null);
    setPreviewingTarget(false);
    setDirtySceneIds(new Set());
    setProjectDirty(false);
    setShowReactions(false);
    setShowNewSceneDialog(false);
    setShowRoomSelectionDialog(false);
    setShowSceneSelectionDialog(false);
    setProjectRuntimeKey((current) => current + 1);
  }

  function closeActiveProject() {
    if (!activeProject) {
      return;
    }

    teardownProjectRuntime();
    setActiveProject(null);
    setLoadedScenes(new Map());
    setCurrentSceneInstanceId(null);
    setActiveRoom(null);
  }

  function handleCloseProject() {
    if (!activeProject) {
      return;
    }

    requestProjectAction(closeActiveProject);
  }

  async function handleOpenProjectPicker() {
  const projects =
    await projectRepository.loadProjects();

  setSavedProjects(projects);
  setShowProjectPicker(true);
}

  async function loadProject(
    project: Project,
    roomRestoreFailureIsFatal = false
  ): Promise<void> {
    const [rooms, maps] = await Promise.all([
      roomRepository.loadRooms(),
      speakerMapRepository.loadSpeakerMaps(),
    ]);
    const projectRooms = [headphonesRoom, ...rooms];
    const rememberedRoomId = project.lastRoomId ?? project.activeRoomId;
    const restoredRoom = projectRooms.find((room) => {
      return room.id === rememberedRoomId;
    }) ?? projectRooms[0] ?? null;
    const rememberedSceneId = project.lastSceneId
      ?? project.activeSceneInstanceId;

    const restoredScene = rememberedSceneId
      && project.sceneIds.includes(rememberedSceneId)
      ? await sceneRepository.loadScene(rememberedSceneId)
      : null;

      console.warn('===== loadProject ENTER =====');
    if (activeProject) {
      console.warn('===== ABOUT TO TEARDOWN OLD PROJECT =====');
      teardownProjectRuntime();
      console.warn('===== OLD PROJECT TEARDOWN COMPLETE =====');
    }
    console.warn('===== ABOUT TO SET NEW PROJECT STATE =====');
    setCustomRooms(rooms);
    setSpeakerMaps(maps);
    setLoadedScenes(restoredScene
      ? new Map([[restoredScene.instanceId, restoredScene]])
      : new Map());
    setActiveProject(project);
    setCurrentSceneInstanceId(restoredScene?.instanceId ?? null);
    setTransitionTargetInstanceId(null);
    setPreviewingTarget(false);
    setActiveRoom(restoredRoom);
    setDirtySceneIds(new Set());
    setProjectDirty(false);
    setShowProjectPicker(false);
    setShowRoomSelectionDialog(false);
    setShowSceneSelectionDialog(false);
    setShowLoadSceneDialog(false);
    setShowNewSceneDialog(false);

    console.warn('===== Right before restoring room =====');

    if (restoredScene) {
      setSceneOnLoadActivationVersion((version) => version + 1);
    }

    if (restoredRoom) {
      const restoredSpeakerMap = maps.find((speakerMap) => {
        return speakerMap.id === restoredRoom.speakerMapId;
      }) ?? headphonesSpeakerMap;
      try {
        await roomAudioEngine.configure(restoredRoom, restoredSpeakerMap);
      } catch (error) {
        console.error('Room restoration failed.', error);
        if (roomRestoreFailureIsFatal) throw error;
      }
    }
    console.warn('===== loadProject EXIT =====');
  }

  useEffect(() => {
  const unregisterStatus =
    moduleEventBus.registerRequestHandler(
      'project.status',
      () => ({
        projectId: activeProject?.id,
        projectName: activeProject?.name,
        dirty: projectDirty || dirtySceneIds.size > 0,
      })
    );

  const unregisterLoad =
    moduleEventBus.registerRequestHandler(
      'project.load',
      async (request) => {
        const payload = request.payload as
          | Partial<ProjectLoadRequest>
          | undefined;

        if (!payload?.projectId || !payload.loadId) {
          throw new Error(
            'project.load requires projectId and loadId.'
          );
        }

        console.warn(
  '===== SACSCAPE ABOUT TO LOAD PROJECT RECORD ====='
);


        const project =
          await projectRepository.loadProject(payload.projectId);

console.warn(
  '===== SACSCAPE PROJECT RECORD LOADED =====',
  project?.id
);

        if (!project) {
          throw new Error(
            `Project "${payload.projectId}" was not found.`
          );
        }

        const projectId = project.id;
        const loadId = payload.loadId;

        void loadProject(project, true)
          .then(() => {
            console.warn(
              '===== SACSCAPE loadProject() COMPLETE ====='
            );
            const loaded: ProjectLoadedPayload = {
              projectId,
              loadId,
            };
            moduleEventBus.emit('project.loaded', loaded);
          })
          .catch((error: unknown) => {
            const failed: ProjectLoadFailedPayload = {
              projectId,
              loadId,
              error: error instanceof Error
                ? error.message
                : 'Project restoration failed.',
            };
            moduleEventBus.emit('project.loadFailed', failed);
          });

        const accepted: ProjectLoadAcceptedPayload = {
          accepted: true,
          projectId,
          loadId,
        };

        return accepted;
      }
    );

  const unregisterSave =
    moduleEventBus.registerRequestHandler(
      'project.save',
      async () => {
        if (!activeProject) {
          return {
            saved: false,
            projectId: undefined,
          };
        }

        const saved = await saveActiveProject();

        if (!saved) {
          throw new Error('Unable to save the active project.');
        }

        return {
          saved: true,
          projectId: activeProject.id,
        };
      }
    );

  const unregisterClose =
    moduleEventBus.registerRequestHandler(
      'project.close',
      (request) => {
        const payload = request.payload as
          | { discardChanges?: boolean }
          | undefined;

        if ((projectDirty || dirtySceneIds.size > 0) &&
            !payload?.discardChanges) {
          throw new Error('Project has unsaved changes.');
        }

        closeActiveProject();

        return {
          closed: true,
        };
      }
    );

  return () => {
    unregisterStatus();
    unregisterLoad();
    unregisterSave();
    unregisterClose();
  };
}, [activeProject, dirtySceneIds, projectDirty]);

  function handleLoadProject(
    project: Project
  ) {
    requestProjectAction(() => {
      void loadProject(project);
    });
  }

  function handleNewScene() {
  if (!activeProject) {
    return;
  }

  const createNewScene = async () => {
  if (currentScene) {
    try {
      await roomAudioEngine
        .fadeOutAndStopScene(
          currentScene.instanceId,
          currentScene.fadeOutMs
        );
    } catch (error) {
      console.error(
        'Unable to fade out current scene:',
        error
      );

      roomAudioEngine.stopScene(
        currentScene.instanceId
      );
    }

    roomAudioEngine.setSceneTransitionGain(
      currentScene.instanceId,
      1
    );
  }

  setCurrentSceneInstanceId(
    null
  );

  setTransitionTargetInstanceId(
    null
  );

  setPreviewingTarget(false);

  setShowNewSceneDialog(true);
};

  requestCurrentSceneAction(
  () => {
    void createNewScene();
  }
);
}

function handleCloseScene() {
  if (!currentScene) {
    return;
  }

  const sceneToClose =
    currentScene;

  const closeScene = async () => {
    const sceneId =
      sceneToClose.instanceId;

    try {
      await roomAudioEngine
        .fadeOutAndStopScene(
          sceneId,
          sceneToClose.fadeOutMs
        );
    } catch (error) {
      console.error(
        'Unable to fade closed scene:',
        error
      );

      roomAudioEngine.stopScene(
        sceneId
      );
    }

    roomAudioEngine
      .setSceneTransitionGain(
        sceneId,
        1
      );

    setLoadedScenes((current) => {
      const updated =
        new Map(current);

      updated.delete(
        sceneId
      );

      return updated;
    });

    setDirtySceneIds((current) => {
      const updated =
        new Set(current);

      updated.delete(
        sceneId
      );

      return updated;
    });

    setCurrentSceneInstanceId(
      null
    );

    setTransitionTargetInstanceId(
      null
    );

    setPreviewingTarget(false);

    await openSceneSelectionDialog();
  };

  requestCurrentSceneAction(
    () => {
      void closeScene();
    }
  );
}

  function handleImportSound() {
    setShowImportSoundDialog(true);
  }

  async function handleSubmitSoundImport(
    data: ImportSoundData
  ) {
    setImportingSound(true);

    try {
      const metadata = {
        name: data.name,
        description: data.description,
        categoryPaths: data.categoryPaths,
        tags: data.tags,
        durationMs: data.durationMs,
        originalFileName: data.originalFileName,
        fileType: data.fileType,
        mimeType: data.mimeType,
        fileSizeBytes: data.fileSizeBytes,
        attribution: data.attribution,
        license: data.license,
        sourceUrl: data.sourceUrl,
      };
      const asset =
  data.sourceType === 'local'
    ? data.file
      ? await hostedSoundLibrary
          .importLocalFile(
            data.file,
            metadata
          )
      : null
    : data.webUrl
      ? await hostedSoundLibrary
          .importWebUrl(
            data.webUrl,
            metadata
          )
      : null;

      if (!asset) {
        throw new Error('The selected import source is incomplete.');
      }

      setSoundAssets((current) => [...current, asset]);

      setShowImportSoundDialog(false);

     setNotification(
  'Sound added to library.'
);

      setTimeout(() => {
        setNotification(null);
      }, 3000);
    } catch (error) {
      console.error(error);

      setNotification(
        error instanceof Error
          ? error.message
          : 'Sound import failed.'
      );

      setTimeout(() => {
        setNotification(null);
      }, 3000);
    } finally {
      setImportingSound(false);
    }
  }

  function createProject(
    trimmedName: string
  ) {
    if (activeProject) {
      teardownProjectRuntime();
    }

    setLoadedScenes(new Map());
    const now = new Date();

    const newProject: Project = {
      id: crypto.randomUUID(),
      name: trimmedName,
      createdAt: now,
      updatedAt: now,
      sceneIds: [],
      reactions: [],
    };

    setActiveProject(newProject);
    setCurrentSceneInstanceId(null);
    setShowRoomSelectionDialog(true);
    setTransitionTargetInstanceId(null);
    setPreviewingTarget(false);
    setActiveRoom(null);
    setDirtySceneIds(new Set());
    setProjectDirty(false);

    setNewProjectName('');
    setShowNewProjectDialog(false);
  }

  function handleCreateProject() {
    const trimmedName = newProjectName.trim();

    if (!trimmedName) {
      return;
    }

    requestProjectAction(() =>
      createProject(trimmedName)
    );
  }

  async function handleCreateScene() {
    if (!activeProject) {
      return;
    }

    const trimmedName = newSceneName.trim();

    if (!trimmedName) {
      return;
    }

    const now = new Date();

    const newInstance: SceneInstance = {
      instanceId: crypto.randomUUID(),
      instanceName: trimmedName,
      description: '',
      transitionMode: 'crossfade',

      positionalObjects: [],
      ambientObjects: [],

      volume: {
        master: 1,
        oneShot: 1,
        loop: 1,
        ambience: 1,
      },

      fadeInMs: 2000,
      fadeOutMs: 2000,
    };

    try {
  await sceneRepository.saveScene(
    newInstance
  );
} catch (error) {
  console.error(
    'Unable to create scene:',
    error
  );

  setNotification(
    'Unable to create scene.'
  );

  setTimeout(() => {
    setNotification(null);
  }, 3000);

  return;
}

    setLoadedScenes((current) => {
      const updated =
        new Map(current);

      updated.set(
        newInstance.instanceId,
        newInstance
      );

      return updated;
    });

    const updatedProject: Project = {
      ...activeProject,
     sceneIds: [
        ...activeProject.sceneIds,
        newInstance.instanceId,
      ],
      activeSceneInstanceId:
        newInstance.instanceId,
      lastSceneId:
        newInstance.instanceId,
      updatedAt: now,
    };

    try {
  const projects =
    await projectRepository.saveProject(
      updatedProject
    );

  setActiveProject(
    updatedProject
  );
  setProjectDirty(false);

  setSavedProjects(
    projects
  );
} catch (error) {
  console.error(
    'Unable to add new scene to project:',
    error
  );

  await sceneRepository.deleteScene(
    newInstance.instanceId
  );

  setLoadedScenes((current) => {
    const updated =
      new Map(current);

    updated.delete(
      newInstance.instanceId
    );

    return updated;
  });

  setNotification(
    'Unable to add new scene to project.'
  );

  setTimeout(() => {
    setNotification(null);
  }, 3000);

  return;
}
    setCurrentSceneInstanceId(
      newInstance.instanceId
    );

    setTransitionTargetInstanceId(null);
    setPreviewingTarget(false);

    setNewSceneName('');
    setShowNewSceneDialog(false);
  }

  function handleSceneChange(
    updatedScene: SceneInstance
  ) {
    if (!activeProject) {
      return;
    }

    setLoadedScenes((current) => {
      const updated =
        new Map(current);

      updated.set(
        updatedScene.instanceId,
        updatedScene
      );

      return updated;
    });

    setDirtySceneIds((current) => {
      const updated = new Set(current);

      updated.add(updatedScene.instanceId);

      return updated;
    });
  }

  function handleSelectTransitionTarget(
    instanceId: string
  ) {
    if (instanceId === currentSceneInstanceId) {
      return;
    }

    setTransitionTargetInstanceId(instanceId);
    setPreviewingTarget(false);
  }

  function handleClearTransitionTarget() {
    setTransitionTargetInstanceId(null);
    setPreviewingTarget(false);
  }

  function handlePreviewTransitionTarget() {
    if (!transitionTargetInstanceId) {
      return;
    }

    setPreviewingTarget(true);
  }

  function handleRevertPreview() {
    setPreviewingTarget(false);
  }

  function rememberSceneActivation(instanceId: string) {
    currentSceneIdRef.current = instanceId;
    setCurrentSceneInstanceId(instanceId);
    setActiveProject((project) => project
      ? {
          ...project,
          activeSceneInstanceId: instanceId,
          lastSceneId: instanceId,
        }
      : project);
    setProjectDirty(true);
  }

  async function transitionToScene(instanceId: string) {
    const project = activeProjectRef.current;
    if (!project?.sceneIds.includes(instanceId)) return;
    if (instanceId === currentSceneIdRef.current) return;
    if (transitionInProgressRef.current) return;

    transitionInProgressRef.current = true;
    setTransitionInProgress(true);
    const transitionRunId = ++transitionRunIdRef.current;

    function clearTransitionSelection() {
      setTransitionTargetInstanceId(null);
      setPreviewingTarget(false);
    }

    try {
      let incomingScene = loadedScenesRef.current.get(instanceId);

      if (!incomingScene) {
        incomingScene = await sceneRepository.loadScene(instanceId) ?? undefined;

        if (!incomingScene) {
          setNotification('Scene could not be found.');
          setTimeout(() => setNotification(null), 3000);
          return;
        }

        if (
          transitionRunId !== transitionRunIdRef.current ||
          activeProjectRef.current?.id !== project.id
        ) {
          return;
        }

        const updatedScenes = new Map(loadedScenesRef.current);
        updatedScenes.set(incomingScene.instanceId, incomingScene);
        loadedScenesRef.current = updatedScenes;
        setLoadedScenes(updatedScenes);
      }

      const destinationScene = incomingScene;

      const outgoingSceneId = currentSceneIdRef.current;
      const outgoingScene = outgoingSceneId
        ? loadedScenesRef.current.get(outgoingSceneId)
        : undefined;

      function activateIncomingScene() {
        rememberSceneActivation(destinationScene.instanceId);
        setSceneOnLoadActivationVersion((version) => version + 1);
        setShowSceneSelectionDialog(false);
      }

      if (!outgoingScene) {
        roomAudioEngine.setSceneTransitionGain(destinationScene.instanceId, 1);
        activateIncomingScene();
        clearTransitionSelection();
        return;
      }

      const transitionMode = outgoingScene.transitionMode ?? 'crossfade';

      if (transitionMode === 'immediate') {
        roomAudioEngine.stopScene(outgoingScene.instanceId);
        roomAudioEngine.setSceneTransitionGain(destinationScene.instanceId, 1);
        activateIncomingScene();
        clearTransitionSelection();
        return;
      }

      if (transitionMode === 'sequential') {
        await roomAudioEngine.fadeOutAndStopScene(
          outgoingScene.instanceId,
          outgoingScene.fadeOutMs
        );

        if (transitionRunId !== transitionRunIdRef.current) return;

        roomAudioEngine.setSceneTransitionGain(destinationScene.instanceId, 0);
        activateIncomingScene();

        const incomingFade = roomAudioEngine.fadeSceneTransitionGain(
          destinationScene.instanceId,
          1,
          destinationScene.fadeInMs
        );

        clearTransitionSelection();
        await incomingFade;
        return;
      }

      roomAudioEngine.setSceneTransitionGain(destinationScene.instanceId, 0);
      activateIncomingScene();

      const transitionFades = [
        roomAudioEngine.fadeOutAndStopScene(
          outgoingScene.instanceId,
          outgoingScene.fadeOutMs
        ),
        roomAudioEngine.fadeSceneTransitionGain(
          destinationScene.instanceId,
          1,
          destinationScene.fadeInMs
        ),
      ];

      clearTransitionSelection();
      await Promise.all(transitionFades);
    } catch (error) {
      console.error('Unable to transition scene:', error);
      setNotification('Unable to transition scene.');
      setTimeout(() => setNotification(null), 3000);
    } finally {
      if (transitionRunId === transitionRunIdRef.current) {
        transitionInProgressRef.current = false;
        setTransitionInProgress(false);
      }
    }
  }

  async function handleTransition() {
    if (!transitionTargetInstanceId) return;
    await transitionToScene(transitionTargetInstanceId);
  }

  function handleManageRooms() {
    setShowRoomManager(true);
  }

  async function handleCreateRoom(): Promise<Room> {
  const newRoom =
    createDefaultRoom();

  const updatedRooms =
    await roomRepository.saveRoom(
      newRoom
    );

  setCustomRooms(
    updatedRooms
  );

  return newRoom;
}

  async function handleDeleteRoom(
  roomId: string
): Promise<void> {
  const updatedRooms =
    await roomRepository.deleteRoom(
      roomId
    );

  setCustomRooms(updatedRooms);

  if (activeRoom?.id === roomId) {
    handleSelectRoom(null);
  }
}

  const refreshSpeakerMap = activeRoom
    ? activeRoom.id === headphonesRoom.id
      ? headphonesSpeakerMap
      : activeRoom.speakerMapId
        ? speakerMaps.find((speakerMap) => speakerMap.id === activeRoom.speakerMapId)
        : undefined
    : undefined;

  async function handleRefreshSpeakerConnection() {
    if (!activeRoom || !refreshSpeakerMap) return;
    const room = activeRoom;
    const speakerMap = refreshSpeakerMap;
    const showRefreshError = (message: string) => {
      setNotification(message);
      setTimeout(() => setNotification(null), 3000);
    };
    try {
      await roomAudioEngine.shutdown();
      await roomAudioEngine.configure(room, speakerMap);
      const status = roomAudioEngine.getStatus();
      if (status.state === 'ready') {
        setSceneOnLoadActivationVersion((version) => version + 1);
        return;
      }
      if (status.state !== 'error') return;
      showRefreshError(status.message || 'Speaker connection refresh failed.');
    } catch (error) {
      showRefreshError(error instanceof Error
        ? `Speaker connection refresh failed: ${error.message}`
        : 'Speaker connection refresh failed.');
    }
  }

  function handleActiveRoomChange(
    room: Room | null
  ) {
    setActiveRoom(room);

    setActiveProject((currentProject) =>
      currentProject
        ? {
            ...currentProject,
            activeRoomId:
              room?.id,
          }
        : currentProject
    );
  }

  async function handleSelectRoom(
    roomId: string | null
  ) {
    if (roomId === null) {
      roomAudioEngine.shutdown();
      handleActiveRoomChange(null);
      setActiveProject((project) => project
        ? {
            ...project,
            activeSceneInstanceId: undefined,
            lastRoomId: undefined,
            lastSceneId: undefined,
          }
        : project);
      setProjectDirty(true);
      if (activeProject) {
        setCurrentSceneInstanceId(null);
        setShowRoomSelectionDialog(true);
        setShowSceneSelectionDialog(false);
      }
      return;
    }

    const room =
      availableRooms.find(
        (candidate) =>
           candidate.id === roomId
      );

    if (!room) {
      return;
    }

    handleActiveRoomChange(room);
    setActiveProject((project) => project
      ? {
          ...project,
          activeSceneInstanceId: undefined,
          lastRoomId: room.id,
          lastSceneId: undefined,
        }
      : project);
    setProjectDirty(true);

    if (activeProject) {
  setCurrentSceneInstanceId(null);
  setShowRoomSelectionDialog(false);

  if (activeProject.sceneIds.length > 0) {
    await openSceneSelectionDialog();

    setShowNewSceneDialog(false);
  } else {
    setShowSceneSelectionDialog(false);
    setShowNewSceneDialog(true);
  }

  setTransitionTargetInstanceId(null);
  setPreviewingTarget(false);

  const selectedSpeakerMap =
    speakerMaps.find(
      (speakerMap) =>
        speakerMap.id ===
        room.speakerMapId
    ) ?? headphonesSpeakerMap;

  void roomAudioEngine
    .configure(
      room,
      selectedSpeakerMap
    )
    .catch((error: unknown) => {
      console.error(
        'Room activation failed.',
        error
      );
    });
}
  }

async function openSceneSelectionDialog() {
  if (!activeProject) {
    return;
  }

  try {
    const scenes =
      await sceneRepository.loadScenes();

    const projectSceneIds =
      new Set(activeProject.sceneIds);

    const summaries: SceneSummary[] =
      scenes
        .filter((scene) =>
          projectSceneIds.has(
            scene.instanceId
          )
        )
        .map((scene) => ({
          instanceId:
            scene.instanceId,

          instanceName:
            scene.instanceName,

          description:
            scene.description ?? '',
        }));

    setSceneSummaries(
      summaries
    );

    setShowSceneSelectionDialog(
      true
    );
  } catch (error) {
    console.error(
      'Unable to load scene list:',
      error
    );

    setNotification(
      'Unable to load scenes.'
    );

    setTimeout(() => {
      setNotification(null);
    }, 3000);
  }
}

async function openLoadSceneDialog() {
  if (!activeProject) {
    return;
  }

  try {
    const scenes =
      await sceneRepository.loadScenes();

    const projectSceneIds =
      new Set(
        activeProject.sceneIds
      );

    const summaries: SceneSummary[] =
      scenes
        .filter((scene) =>
          projectSceneIds.has(
            scene.instanceId
          )
        )
        .map((scene) => ({
          instanceId:
            scene.instanceId,

          instanceName:
            scene.instanceName,

          description:
            scene.description ?? '',
        }));

    setSceneSummaries(
      summaries
    );

    setSelectedSceneIdsToLoad(
      new Set()
    );

    setShowLoadSceneDialog(
      true
    );
  } catch (error) {
    console.error(
      'Unable to load scene list:',
      error
    );

    setNotification(
      'Unable to load scenes.'
    );

    setTimeout(() => {
      setNotification(null);
    }, 3000);
  }
}

async function handleOpenReactions() {
  if (!activeProject) return;

  try {
    const scenes = await sceneRepository.loadScenes();
    const projectSceneIds = new Set(activeProject.sceneIds);
    setReactionScenes(
      scenes
        .filter((scene) => projectSceneIds.has(scene.instanceId))
        .map((scene) => ({
          id: scene.instanceId,
          name: scene.instanceName,
        }))
    );
    setShowReactions(true);
  } catch (error) {
    console.error('Unable to load Scenes for Reactions:', error);
    setNotification('Unable to open Reactions.');
    setTimeout(() => setNotification(null), 3000);
  }
}

function handleReactionsChange(reactions: Project['reactions']) {
  setActiveProject((project) => project
    ? { ...project, reactions, updatedAt: new Date() }
    : project);
  setProjectDirty(true);
}

async function handleLoadSelectedScenes() {
  if (
    !activeProject ||
    selectedSceneIdsToLoad.size === 0
  ) {
    return;
  }

  try {
    const scenesToLoad =
      await Promise.all(
        Array.from(
          selectedSceneIdsToLoad
        ).map(
          (sceneId) =>
            sceneRepository.loadScene(
              sceneId
            )
        )
      );

    setLoadedScenes((current) => {
      const updated =
        new Map(current);

      for (
        const scene of scenesToLoad
      ) {
        if (!scene) {
          continue;
        }

        updated.set(
          scene.instanceId,
          scene
        );
      }

      return updated;
    });

    setSelectedSceneIdsToLoad(
      new Set()
    );

    setShowLoadSceneDialog(
      false
    );
  } catch (error) {
    console.error(
      'Unable to load selected scenes:',
      error
    );

    setNotification(
      'Unable to load selected scenes.'
    );

    setTimeout(() => {
      setNotification(null);
    }, 3000);
  }
}

  async function handleActivateScene(
  instanceId: string
) {
  await transitionToScene(instanceId);
}

useEffect(() => {
  transitionToSceneRef.current = transitionToScene;
});

useEffect(() => {
  return sacscapeActionManager.start(
    () => activeProjectRef.current,
    () => currentSceneIdRef.current,
    (sceneId) => transitionToSceneRef.current(sceneId)
  );
}, []);

  return (
    <div className="app">
      <MenuBar
        onNewProject={handleNewProject}
        onLoadProject={() =>
          void handleOpenProjectPicker()
        }
        onSaveProject={handleSaveProject}
        onCloseProject={handleCloseProject}
        onOpenReactions={() => void handleOpenReactions()}
        onNewScene={handleNewScene}
        onOpenScene={() => {
          void openLoadSceneDialog();
        }}
        onSaveScene={handleSaveScene}
        onCloseScene={handleCloseScene}
        onDeleteScene={handleDeleteScene}
        onImportSound={handleImportSound}
        onManageRooms={handleManageRooms}
        onOpenRoomSelector={() => setShowRoomSelectionDialog(true)}
        onRefreshSpeakerConnection={() => void handleRefreshSpeakerConnection()}
        onOpenSettings={() => setShowSettings(true)}
        onOpenResearchLab={() => setShowResearchLab(true)}
        sceneActionsEnabled={
  Boolean(activeProject) &&
  !showRoomSelectionDialog
}
        currentSceneAvailable={currentScene !== null}

        roomSelectionEnabled={Boolean(activeProject)}
        refreshSpeakerConnectionEnabled={Boolean(activeRoom && refreshSpeakerMap)}
        roomSpeakerVolume={roomSpeakerVolumeStatus.volume}
        roomSpeakerVolumeEnabled={
          Boolean(activeRoom) &&
          roomAudioEngine.usesBackendRoomAudio() &&
          roomSpeakerVolumeStatus.volume !== null
        }
        roomSpeakerVolumeMessage={
          roomSpeakerVolumeStatus.state === 'error'
            ? roomSpeakerVolumeStatus.message
            : ''
        }
        onRoomSpeakerVolumeChange={(volume) => roomAudioEngine.setRoomSpeakerVolume(volume)}

        projectName={activeProject?.name}
        roomName={
          activeRoom?.name ??
          'No Room Selected'
        }
      />

      {displayedScene && (
        <SceneWorkspace
          key={`${activeProject?.id ?? 'none'}:${projectRuntimeKey}`}
          scene={displayedScene}           
          currentScene={currentScene}
          soundAssets={soundAssets}
          activeRoom={activeRoom}
          activeSpeakerMap={activeSpeakerMap}
          sceneOnLoadActivationVersion={sceneOnLoadActivationVersion}
          transitionTarget={transitionTarget}
          previewingTarget={previewingTarget}
          transitionInProgress={transitionInProgress}
          currentSceneDirty={
            currentScene
              ? dirtySceneIds.has(
                  currentScene.instanceId
                )
              : false
          }
          projectScenes={
  Array.from(
    loadedScenes.values()
  )
}
          soundObjectTemplates={soundObjectTemplates}
          onSceneChange={handleSceneChange}          
          onSelectTransitionTarget={
            handleSelectTransitionTarget
          }
          onClearTransitionTarget={
            handleClearTransitionTarget
          }
          onPreviewTransitionTarget={
            handlePreviewTransitionTarget
          }
          onRevertPreview={
            handleRevertPreview
          }
          onTransition={handleTransition}
          onRoomChange={handleActiveRoomChange}
        />
      )}

      {showNewProjectDialog && (
        <div className="dialog-backdrop">
          <div className="dialog">
            <h2>New Project</h2>

            <input
              type="text"
              placeholder="Project name"
              value={newProjectName}
              onChange={(event) =>
                setNewProjectName(
                  event.target.value
                )
              }
              autoFocus
            />

            <div className="dialog-buttons">
              <button
                onClick={() =>
                  setShowNewProjectDialog(false)
                }
              >
                Cancel
              </button>

              <button
                onClick={handleCreateProject}
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {showProjectPicker && (
        <div className="dialog-backdrop">
          <div className="dialog">
            <h2>Load Project</h2>

            {savedProjects.length === 0 ? (
              <p className="project-picker-empty">
                No saved projects.
              </p>
            ) : (
              <div className="project-picker-list">
                {savedProjects.map((project) => (
                  <button
                    key={project.id}
                    className="project-picker-item"
                    onClick={() =>
                      handleLoadProject(project)
                    }
                  >
                    {project.name}
                  </button>
                ))}
              </div>
            )}

            <div className="dialog-buttons">
              <button
                onClick={() =>
                  setShowProjectPicker(false)
                }
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {activeProject &&
  showDeleteSceneDialog && (
    <div className="dialog-backdrop">
      <div className="dialog">
        <h2>
          Delete Scene
        </h2>

        <div className="project-picker-list">
          {sceneSummaries.map(
            (scene) => (
              <button
                key={
                  scene.instanceId
                }
                className={
                  selectedSceneIdToDelete ===
                  scene.instanceId
                    ? 'project-picker-item selected'
                    : 'project-picker-item'
                }
                onClick={() =>
                  setSelectedSceneIdToDelete(
                    scene.instanceId
                  )
                }
              >
                <strong>
                  {
                    scene.instanceName
                  }
                </strong>

                {scene.description && (
                  <span>
                    {
                      scene.description
                    }
                  </span>
                )}
              </button>
            )
          )}
        </div>

        <div className="dialog-buttons">
          <button
            onClick={() => {
              setSelectedSceneIdToDelete(
                null
              );

              setShowDeleteSceneDialog(
                false
              );
            }}
          >
            Cancel
          </button>

          <button
            disabled={
              !selectedSceneIdToDelete
            }
            onClick={() =>
              void confirmDeleteSelectedScene()
            }
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  )}

      {activeProject && showRoomSelectionDialog && (
        <RoomSelectorDialog
          rooms={availableRooms}
          selectedRoomId={activeRoom?.id ?? null}
          onSelectRoom={(roomId) => handleSelectRoom(roomId)}
        />
      )}

      {activeProject &&
  showLoadSceneDialog && (
    <div className="dialog-backdrop">
      <div className="dialog">
        <h2>
          Load Scenes
        </h2>

        <div className="project-picker-list">
          {sceneSummaries.map(
            (scene) => {
              const alreadyLoaded =
                loadedScenes.has(
                  scene.instanceId
                );

              const selected =
                selectedSceneIdsToLoad.has(
                  scene.instanceId
                );

              return (
                <label
                  key={
                    scene.instanceId
                  }
                  className="project-picker-item"
                >
                  <input
                    type="checkbox"
                    checked={
                      alreadyLoaded ||
                      selected
                    }
                    disabled={
                      alreadyLoaded
                    }
                    onChange={() => {
                      setSelectedSceneIdsToLoad(
                        (current) => {
                          const updated =
                            new Set(
                              current
                            );

                          if (
                            updated.has(
                              scene.instanceId
                            )
                          ) {
                            updated.delete(
                              scene.instanceId
                            );
                          } else {
                            updated.add(
                              scene.instanceId
                            );
                          }

                          return updated;
                        }
                      );
                    }}
                  />

                  <span>
                    <strong>
                      {
                        scene.instanceName
                      }
                    </strong>

                    {scene.description && (
                      <span>
                        {
                          scene.description
                        }
                      </span>
                    )}
                  </span>
                </label>
              );
            }
          )}
        </div>

        <div className="dialog-buttons">
          <button
            onClick={() => {
              setSelectedSceneIdsToLoad(
                new Set()
              );

              setShowLoadSceneDialog(
                false
              );
            }}
          >
            Cancel
          </button>

          <button
            disabled={
              selectedSceneIdsToLoad
                .size === 0
            }
            onClick={() =>
              void handleLoadSelectedScenes()
            }
          >
            Load Selected
          </button>
        </div>
      </div>
    </div>
  )}

      {activeProject && showSceneSelectionDialog && (
        <div className="dialog-backdrop">
          <div className="dialog">
            <h2>Select Scene</h2>
            <div className="project-picker-list">
              {sceneSummaries.map(
  (scene) => (
    <button
      key={scene.instanceId}
      className="project-picker-item"
      onClick={() =>
        void handleActivateScene(
          scene.instanceId
        )
      }
    >
      <strong>
        {scene.instanceName}
      </strong>

      {scene.description && (
        <span>
          {scene.description}
        </span>
      )}
    </button>
  )
)}
            </div>
          </div>
        </div>
      )}

      {showUnsavedChangesDialog && (
        <div className="dialog-backdrop unsaved-changes-backdrop">
          <div className="dialog">
            <h2>Unsaved Changes</h2>

            <p>
              Save changes to the current project?
            </p>

            <div className="dialog-buttons">
              <button
                onClick={() =>
                  void finishPendingProjectAction(
                    true
                  )
                }
              >
                Save
              </button>

              <button
                onClick={() =>
                  void finishPendingProjectAction(
                    false
                  )
                }
              >
                Don&apos;t Save
              </button>

              <button
                onClick={cancelPendingProjectAction}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {showNewSceneDialog && (
        <div className="dialog-backdrop">
          <div className="dialog">
            <h2>New Scene</h2>

            <input
              type="text"
              placeholder="Scene name"
              value={newSceneName}
              onChange={(event) =>
                setNewSceneName(
                  event.target.value
                )
              }
              autoFocus
            />

            <div className="dialog-buttons">
              <button onClick={() => setShowNewSceneDialog(false)}>
                Cancel
              </button>

              <button
                onClick={() =>
                  void handleCreateScene()
                }
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {showImportSoundDialog && (
        <ImportSoundDialog
          onCancel={() =>
            setShowImportSoundDialog(false)
          }
          onImport={handleSubmitSoundImport}
          isImporting={importingSound}
        />
      )}

      {showRoomManager && (
        <RoomManagerDialog
          rooms={customRooms}
          speakerMaps={speakerMaps}
          activeRoomId={
            activeRoom?.id ?? null
          }

          onClose={() =>
            setShowRoomManager(false)
          }

          onSelectRoom={(roomId) => {
            handleSelectRoom(roomId);
            setShowRoomManager(false);
          }}

          onDeleteRoom={handleDeleteRoom}
          onCreateRoom={handleCreateRoom}

          onSaveRoom={async (updatedRoom) => {
  const updatedRooms =
    await roomRepository.saveRoom(
      updatedRoom
    );

  setCustomRooms(updatedRooms);

  if (
    activeRoom?.id ===
    updatedRoom.id
  ) {
    handleActiveRoomChange(
      updatedRoom
    );
  }
}}
          
          onSaveSpeakerMap={async (speakerMap) => {
  const updatedMaps =
    await speakerMapRepository
      .saveSpeakerMap(
        speakerMap
      );

  setSpeakerMaps(
    updatedMaps
  );
}}
        />
      )}

      {showResearchLab && (
        <ResearchLabDialog onClose={() => setShowResearchLab(false)} />
      )}

      {activeProject && showReactions && (
        <ReactionsDialog
          reactions={activeProject.reactions}
          actions={availableActions}
          scenes={reactionScenes}
          onChange={handleReactionsChange}
          onClose={() => setShowReactions(false)}
        />
      )}

      {showSettings && (
        <SettingsDialog
          settings={appSettings}
          saving={savingSettings}
          onChange={(settings) => void handleSettingsChange(settings)}
          onViewLog={() => setShowDiagnosticLog(true)}
          onClose={() => setShowSettings(false)}
        />
      )}

      {showDiagnosticLog && <DiagnosticLogDialog onClose={() => setShowDiagnosticLog(false)} />}

      {notification && (
        <div className="notification-toast">
          {notification}
        </div>
      )}
    </div>
  );
}

export default App;
