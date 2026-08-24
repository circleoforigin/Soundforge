import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { SoundAsset } from './models/SoundAsset';
import './App.css';

import type { Project } from './models/Project';
import type { SceneInstance } from './models/SceneInstance';
import type { SceneTemplate } from './models/SceneTemplate';
import type { SoundObjectTemplate } from './models/SoundObjectTemplate';
import type { Room } from './models/Room';
import type { SpeakerMap } from './models/SpeakerMap';

import MenuBar from './components/MenuBar';
import SceneWorkspace from './components/SceneWorkspace';
import { headphonesRoom } from './rooms/DefaultRoom';
import { headphonesSpeakerMap } from './speakers/DefaultSpeakerMaps';
import { roomRepository } from './rooms/RoomRepository';
import NewRoomDialog, {
  type NewRoomData,
} from './components/NewRoomDialog';
import RoomManagerDialog from './components/RoomManagerDialog';
import ResearchLabDialog from './components/ResearchLabDialog';
import SettingsDialog from './components/SettingsDialog';
import DiagnosticLogDialog from './components/DiagnosticLogDialog';
import RoomSelectorDialog from './components/RoomSelectorDialog';
import { DEFAULT_APP_SETTINGS, type AppSettings } from './models/AppSettings';
import { runtimeUrl } from './config/runtime';
import { speakerMapRepository } from './speakers/SpeakerMapRepository';
import { projectRepository } from './projects/ProjectRepository';

import ImportSoundDialog, {
  type ImportSoundData,
} from './components/ImportSoundDialog';
import { localSoundLibrary } from './services/library/browser/LocalSoundLibraryService';
import { roomAudioEngine } from './audio/RoomAudioEngine';

function App() {
  const [showNewProjectDialog, setShowNewProjectDialog] = useState(false);
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [savedProjects, setSavedProjects] = useState<Project[]>([]);
  const [soundAssets, setSoundAssets] = useState<SoundAsset[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [dirtySceneIds, setDirtySceneIds] =
    useState<Set<string>>(() => new Set());
  const [showUnsavedChangesDialog, setShowUnsavedChangesDialog] =
    useState(false);
  const pendingProjectActionRef =
    useRef<(() => void) | null>(null);
  const [notification, setNotification] = useState<string | null>(null);
  const [currentSceneInstanceId, setCurrentSceneInstanceId] =
    useState<string | null>(null);
  const [showRoomSelectionDialog, setShowRoomSelectionDialog] = useState(false);
  const [showSceneSelectionDialog, setShowSceneSelectionDialog] = useState(false);
  const [importingSound, setImportingSound] = useState(false);
  const [libraryFolderConfigured, setLibraryFolderConfigured] =
    useState(false);
  const [transitionTargetInstanceId, setTransitionTargetInstanceId] =
    useState<string | null>(null);
  const [previewingTarget, setPreviewingTarget] = useState(false);
  const [transitionInProgress, setTransitionInProgress] = useState(false);
  const transitionInProgressRef = useRef(false);
  const transitionRunIdRef = useRef(0);
  const [projectRuntimeKey, setProjectRuntimeKey] = useState(0);
  const [newProjectName, setNewProjectName] = useState('');
  const [showNewSceneDialog, setShowNewSceneDialog] = useState(false);
  const [newSceneName, setNewSceneName] = useState('');
  const [showImportSoundDialog, setShowImportSoundDialog] =
    useState(false);
  const [, setSceneTemplates] =
    useState<SceneTemplate[]>([]);
  const [soundObjectTemplates] =
    useState<SoundObjectTemplate[]>([]);
  const [activeRoom, setActiveRoom] = useState<Room | null>(null);
  const [customRooms, setCustomRooms] = useState<Room[]>(() => roomRepository.loadRooms());
  const availableRooms: Room[] = [
    headphonesRoom,
    ...customRooms,
  ];
  const [showNewRoomDialog, setShowNewRoomDialog] =
    useState(false);
  const [showRoomManager, setShowRoomManager] =
    useState(false);
  const [showResearchLab, setShowResearchLab] =
    useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showDiagnosticLog, setShowDiagnosticLog] = useState(false);
  const [appSettings, setAppSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [savingSettings, setSavingSettings] = useState(false);
  const [speakerMaps, setSpeakerMaps] = useState<SpeakerMap[]>(
    () => speakerMapRepository.loadSpeakerMaps()
  );
  const activeSpeakerMap: SpeakerMap =
    speakerMaps.find((speakerMap) => speakerMap.id === activeRoom?.speakerMapId) ??
    headphonesSpeakerMap;
  useSyncExternalStore(roomAudioEngine.subscribe, roomAudioEngine.getVersion);
  const roomAudioStatus = roomAudioEngine.getStatus();
  const roomSpeakerVolumeStatus = roomAudioEngine.getRoomSpeakerVolumeStatus();
  
useEffect(() => {
  async function loadSoundLibrary() {
    try {
      const assets = await localSoundLibrary.initialize();
      setSoundAssets(assets);
      setLibraryFolderConfigured(localSoundLibrary.directoryConfigured);
    } catch (error) {
      console.error(error);

      setNotification(
        'Unable to load sound library.'
      );

      setTimeout(() => {
        setNotification(null);
      }, 3000);
    }
  }

  loadSoundLibrary();
}, []);

useEffect(() => {
  void fetch(runtimeUrl('/api/settings'))
    .then((response) => response.ok ? response.json() as Promise<AppSettings> : Promise.reject())
    .then(setAppSettings)
    .catch(() => undefined);
}, []);

async function handleSettingsChange(settings: AppSettings) {
  const previous = appSettings;
  setAppSettings(settings);
  setSavingSettings(true);
  try {
    const response = await fetch(runtimeUrl('/api/settings'), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings),
    });
    if (!response.ok) throw new Error();
    setAppSettings(await response.json() as AppSettings);
  } catch {
    setAppSettings(previous);
    setNotification('Unable to save application settings.');
  } finally { setSavingSettings(false); }
}

  const currentScene =
    activeProject?.scenes.find(
      (scene) => scene.instanceId === currentSceneInstanceId
    ) ?? null;

  const transitionTarget =
    activeProject?.scenes.find(
      (scene) => scene.instanceId === transitionTargetInstanceId
    ) ?? null;

  const displayedScene =
    previewingTarget && transitionTarget
      ? transitionTarget
      : currentScene;

  function handleNewProject() {
    setShowNewProjectDialog(true);
  }

  function saveActiveProject(): boolean {
    if (!activeProject) {
      return false;
    }

    const projectToSave: Project = {
      ...activeProject,
      activeSceneInstanceId:
        currentSceneInstanceId ?? undefined,
      activeRoomId:
        activeRoom?.id ?? undefined,
      updatedAt: new Date(),
    };

    const projects =
      projectRepository.saveProject(
        projectToSave
      );

    setActiveProject(projectToSave);
    setSavedProjects(projects);
    setDirtySceneIds(new Set());
    setNotification('Project saved.');

    setTimeout(() => {
      setNotification(null);
    }, 3000);

    return true;
  }

  function handleSaveProject() {
    saveActiveProject();
  }

  function requestProjectAction(
    action: () => void
  ) {
    if (dirtySceneIds.size === 0) {
      action();
      return;
    }

    pendingProjectActionRef.current = action;
    setShowUnsavedChangesDialog(true);
  }

  function finishPendingProjectAction(
    saveFirst: boolean
  ) {
    const action =
      pendingProjectActionRef.current;

    if (!action) {
      return;
    }

    if (saveFirst && !saveActiveProject()) {
      return;
    }

    pendingProjectActionRef.current = null;
    setShowUnsavedChangesDialog(false);
    action();
  }

  function cancelPendingProjectAction() {
    pendingProjectActionRef.current = null;
    setShowUnsavedChangesDialog(false);
  }

  function teardownProjectRuntime(project: Project) {
    roomAudioEngine.shutdown();
    for (const scene of project.scenes) {
      roomAudioEngine.stopScene(scene.instanceId);
      roomAudioEngine.setSceneTransitionGain(scene.instanceId, 1);
    }

    transitionRunIdRef.current += 1;
    transitionInProgressRef.current = false;
    setTransitionInProgress(false);
    setTransitionTargetInstanceId(null);
    setPreviewingTarget(false);
    setDirtySceneIds(new Set());
    setShowNewSceneDialog(false);
    setShowRoomSelectionDialog(false);
    setShowSceneSelectionDialog(false);
    setProjectRuntimeKey((current) => current + 1);
  }

  function closeActiveProject() {
    if (!activeProject) {
      return;
    }

    teardownProjectRuntime(activeProject);
    setActiveProject(null);
    setCurrentSceneInstanceId(null);
    setActiveRoom(null);
  }

  function handleCloseProject() {
    if (!activeProject) {
      return;
    }

    requestProjectAction(closeActiveProject);
  }

  function handleOpenProjectPicker() {
    setSavedProjects(
      projectRepository.loadProjects()
    );
    setShowProjectPicker(true);
  }

  function loadProject(
    project: Project
  ) {
    if (activeProject) {
      teardownProjectRuntime(activeProject);
    }

    setActiveProject(project);
    setCurrentSceneInstanceId(null);
    setTransitionTargetInstanceId(null);
    setPreviewingTarget(false);
    setActiveRoom(null);
    setDirtySceneIds(new Set());
    setShowProjectPicker(false);
    setShowRoomSelectionDialog(true);
    setShowSceneSelectionDialog(false);
  }

  function handleLoadProject(
    project: Project
  ) {
    requestProjectAction(() =>
      loadProject(project)
    );
  }

  function handleNewScene() {
    if (
      !activeProject ||
      roomAudioStatus.state !== 'ready'
    ) {
      return;
    }

    setShowNewSceneDialog(true);
  }

  function handleImportSound() {
    setShowImportSoundDialog(true);
  }

  async function handleChooseLibraryFolder() {
    const assets = await localSoundLibrary.chooseDirectory();
    setSoundAssets(assets);
    setLibraryFolderConfigured(true);
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
      const asset = data.sourceType === 'local'
        ? data.file
          ? await localSoundLibrary.importLocalFile(data.file, metadata)
          : null
        : data.webUrl
          ? await localSoundLibrary.importWebUrl(data.webUrl, metadata)
          : null;

      if (!asset) {
        throw new Error('The selected import source is incomplete.');
      }

      setSoundAssets((current) => [...current, asset]);

      setShowImportSoundDialog(false);

      setNotification(
        'Sound added to local library.'
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
      teardownProjectRuntime(activeProject);
    }

    const now = new Date();

    const newProject: Project = {
      id: crypto.randomUUID(),
      name: trimmedName,
      createdAt: now,
      updatedAt: now,
      scenes: [],
    };

    setActiveProject(newProject);
    setCurrentSceneInstanceId(null);
    setShowRoomSelectionDialog(true);
    setTransitionTargetInstanceId(null);
    setPreviewingTarget(false);
    setActiveRoom(null);
    setDirtySceneIds(new Set());

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

  function handleCreateScene() {
    if (!activeProject) {
      return;
    }

    const trimmedName = newSceneName.trim();

    if (!trimmedName) {
      return;
    }

    const now = new Date();

    const newTemplate: SceneTemplate = {
      id: crypto.randomUUID(),
      name: trimmedName,
      createdAt: now,
      updatedAt: now,
      categoryPaths: [],
      tags: [],
      positionalObjects: [],
      ambientObjects: [],
    };

    const newInstance: SceneInstance = {
      instanceId: crypto.randomUUID(),
      templateId: newTemplate.id,
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

    const updatedProject: Project = {
      ...activeProject,
      scenes: [
        ...activeProject.scenes,
        newInstance,
      ],
      updatedAt: now,
    };

    setSceneTemplates((current) => [
      ...current,
      newTemplate,
    ]);

    setActiveProject(updatedProject);
    setDirtySceneIds((current) => {
      const updated = new Set(current);

      updated.add(newInstance.instanceId);

      return updated;
    });

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

    setActiveProject((currentProject) => {
      if (!currentProject) {
        return currentProject;
      }

      return {
        ...currentProject,

        scenes: currentProject.scenes.map((scene) =>
          scene.instanceId === updatedScene.instanceId
            ? updatedScene
            : scene
        ),

        updatedAt: new Date(),
      };
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

  async function handleTransition() {
    if (
      transitionInProgressRef.current ||
      !currentScene ||
      !transitionTarget
    ) {
      return;
    }

    transitionInProgressRef.current = true;
    setTransitionInProgress(true);
    const transitionRunId = ++transitionRunIdRef.current;

    const outgoingScene = currentScene;
    const incomingScene = transitionTarget;
    const transitionMode = outgoingScene.transitionMode ?? 'crossfade';

    function activateIncomingScene() {
      setCurrentSceneInstanceId(incomingScene.instanceId);
    }

    function clearTransitionSelection() {
      setTransitionTargetInstanceId(null);
      setPreviewingTarget(false);
    }

    try {
      if (transitionMode === 'immediate') {
        roomAudioEngine.stopScene(outgoingScene.instanceId);
        roomAudioEngine.setSceneTransitionGain(incomingScene.instanceId, 1);
        activateIncomingScene();
        clearTransitionSelection();
        return;
      }

      if (transitionMode === 'sequential') {
        await roomAudioEngine.fadeOutAndStopScene(
          outgoingScene.instanceId,
          outgoingScene.fadeOutMs
        );

        if (transitionRunId !== transitionRunIdRef.current) {
          return;
        }

        roomAudioEngine.setSceneTransitionGain(incomingScene.instanceId, 0);
        activateIncomingScene();

        const incomingFade = roomAudioEngine.fadeSceneTransitionGain(
          incomingScene.instanceId,
          1,
          incomingScene.fadeInMs
        );

        clearTransitionSelection();
        await incomingFade;
        return;
      }

      roomAudioEngine.setSceneTransitionGain(incomingScene.instanceId, 0);
      activateIncomingScene();

      const transitionFades = [
        roomAudioEngine.fadeOutAndStopScene(
          outgoingScene.instanceId,
          outgoingScene.fadeOutMs
        ),
        roomAudioEngine.fadeSceneTransitionGain(
          incomingScene.instanceId,
          1,
          incomingScene.fadeInMs
        ),
      ];

      clearTransitionSelection();
      await Promise.all(transitionFades);
    } finally {
      if (transitionRunId === transitionRunIdRef.current) {
        transitionInProgressRef.current = false;
        setTransitionInProgress(false);
      }
    }
  }

  function handleManageRooms() {
    setShowRoomManager(true);
  }

  function handleNewRoom() {
    setShowNewRoomDialog(true);
  }

  function handleCreateRoom(
    data: NewRoomData
  ) {
    let width = 1;
    let height = 1;

    if (data.shape === 'rectangle') {
      width = 1.6;
      height = 1;
    }

    const speakers = Array.from(
      { length: data.speakerCount },
      (_, index) => {
        const angle =
          (index / data.speakerCount) *
          Math.PI *
          2;

        return {
          speakerId: crypto.randomUUID(),
          name: 'Speaker ${index + 1}',

          position: {
            x:
              Math.cos(angle) *
              (width * 0.4),

            y:
              Math.sin(angle) *
              (height * 0.4),
          },
        };
      }
    );

    const newRoom: Room = {
      id: crypto.randomUUID(),

      name: data.name,

      offset: {
        x: 0,
        y: 0,
      },

      width,
      height,

      speakers,

      speakerMapId: undefined,
    };

    const updatedRooms =
      roomRepository.saveRoom(newRoom);

    setCustomRooms(updatedRooms);
    handleActiveRoomChange(newRoom);
    setShowNewRoomDialog(false);
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

  function handleSelectRoom(
    roomId: string | null
  ) {
    if (roomId === null) {
      roomAudioEngine.shutdown();
      handleActiveRoomChange(null);
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

    if (activeRoom?.id !== room.id) {
      roomAudioEngine.shutdown();
    }
    handleActiveRoomChange(room);
    if (activeProject) {
      setCurrentSceneInstanceId(null);
      setShowRoomSelectionDialog(false);
      setShowSceneSelectionDialog(activeProject.scenes.length > 0);
      setShowNewSceneDialog(activeProject.scenes.length === 0);
      setTransitionTargetInstanceId(null);
      setPreviewingTarget(false);
      const selectedSpeakerMap = speakerMaps.find(
        (speakerMap) => speakerMap.id === room.speakerMapId
      ) ?? speakerMapRepository.loadSpeakerMaps().find(
        (speakerMap) => speakerMap.id === room.speakerMapId
      ) ?? headphonesSpeakerMap;
      void roomAudioEngine.configure(room, selectedSpeakerMap).catch((error: unknown) => {
        console.error('Room activation failed.', error);
      });
    }
  }

  function handleActivateScene(instanceId: string) {
    if (!activeProject?.scenes.some((scene) => scene.instanceId === instanceId)) return;
    setCurrentSceneInstanceId(instanceId);
    setShowSceneSelectionDialog(false);
  }

  return (
    <div className="app">
      <MenuBar
        onNewProject={handleNewProject}
        onLoadProject={handleOpenProjectPicker}
        onSaveProject={handleSaveProject}
        onCloseProject={handleCloseProject}
        onNewScene={handleNewScene}
        onImportSound={handleImportSound}
        onNewRoom={handleNewRoom}
        onManageRooms={handleManageRooms}
        onOpenSettings={() => setShowSettings(true)}
        onOpenResearchLab={() => setShowResearchLab(true)}
        sceneActionsEnabled={
          Boolean(activeProject) &&
          roomAudioStatus.state === 'ready' &&
          !showRoomSelectionDialog &&
          currentScene !== null
        }

        rooms={availableRooms}
        activeRoomId={activeRoom?.id ?? null}
        onSelectRoom={handleSelectRoom}
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
          projectScenes={activeProject?.scenes ?? []}
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

      {activeProject && currentScene === null && showRoomSelectionDialog && (
        <RoomSelectorDialog
          rooms={availableRooms}
          selectedRoomId={activeRoom?.id ?? null}
          onSelectRoom={(roomId) => handleSelectRoom(roomId)}
        />
      )}

      {activeProject && showSceneSelectionDialog && (
        <div className="dialog-backdrop">
          <div className="dialog">
            <h2>Select Scene</h2>
            <div className="project-picker-list">
              {activeProject.scenes.map((scene) => (
                <button
                  key={scene.instanceId}
                  className="project-picker-item"
                  onClick={() => handleActivateScene(scene.instanceId)}
                >
                  {scene.instanceName}
                </button>
              ))}
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
                  finishPendingProjectAction(true)
                }
              >
                Save
              </button>

              <button
                onClick={() =>
                  finishPendingProjectAction(false)
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
                onClick={handleCreateScene}
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
          onChooseLibraryFolder={handleChooseLibraryFolder}
          libraryFolderConfigured={libraryFolderConfigured}
          directoryPickerSupported={
            localSoundLibrary.directoryPickerSupported
          }
          isImporting={importingSound}
        />
      )}

      {showNewRoomDialog && (
        <NewRoomDialog
          onCancel={() =>
            setShowNewRoomDialog(false)
          }
          onCreate={handleCreateRoom}
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

          onSaveRoom={(updatedRoom) => {
            const updatedRooms =
              roomRepository.saveRoom(
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
          
          onSaveSpeakerMap={(speakerMap) => {
            const updatedMaps =
              speakerMapRepository
                .saveSpeakerMap(
                speakerMap
              );

            setSpeakerMaps(updatedMaps);
          }}
        />
      )}

      {showResearchLab && (
        <ResearchLabDialog onClose={() => setShowResearchLab(false)} />
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
