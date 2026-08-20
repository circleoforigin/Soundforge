import { useEffect, useState } from 'react';
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
import { speakerMapRepository } from './speakers/SpeakerMapRepository';
import { projectRepository } from './projects/ProjectRepository';

import ImportSoundDialog, {
  type ImportSoundData,
} from './components/ImportSoundDialog';
import { apiUrl } from './config/api';

function App() {
  const [showNewProjectDialog, setShowNewProjectDialog] = useState(false);
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [savedProjects, setSavedProjects] = useState<Project[]>([]);
  const [soundAssets, setSoundAssets] = useState<SoundAsset[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [notification, setNotification] = useState<string | null>(null);
  const [currentSceneInstanceId, setCurrentSceneInstanceId] =
    useState<string | null>(null);
  const [importingSound, setImportingSound] = useState(false);
  const [transitionTargetInstanceId, setTransitionTargetInstanceId] =
    useState<string | null>(null);
  const [previewingTarget, setPreviewingTarget] = useState(false);
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
  const [activeSpeakerMap] =
    useState<SpeakerMap>(headphonesSpeakerMap);
  const [customRooms, setCustomRooms] =  useState<Room[]>([]);
  const availableRooms: Room[] = [
    headphonesRoom,
    ...customRooms,
  ];
  const [showNewRoomDialog, setShowNewRoomDialog] =
    useState(false);
  const [showRoomManager, setShowRoomManager] =
    useState(false);
  const [speakerMaps, setSpeakerMaps] = useState<SpeakerMap[]>([]);
  
useEffect(() => {
  async function loadSoundLibrary() {
    try {
      const response = await fetch(
        apiUrl('/api/library/manifest')
      );

      if (!response.ok) {
        throw new Error(
          `Library load failed: ${response.status}`
        );
      }

      const manifest = await response.json();

      setSoundAssets(manifest.assets ?? []);
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
  setCustomRooms(
    roomRepository.loadRooms()
  );
}, []);

useEffect(() => {
  setSpeakerMaps(
    speakerMapRepository
      .loadSpeakerMaps()
  );
}, []);

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

  function handleSaveProject() {
    if (!activeProject) {
      return;
    }

    const projectToSave: Project = {
      ...activeProject,
      activeSceneInstanceId:
        currentSceneInstanceId ?? undefined,
      updatedAt: new Date(),
    };

    const projects =
      projectRepository.saveProject(
        projectToSave
      );

    setActiveProject(projectToSave);
    setSavedProjects(projects);
    setNotification('Project saved.');

    setTimeout(() => {
      setNotification(null);
    }, 3000);
  }

  function handleOpenProjectPicker() {
    setSavedProjects(
      projectRepository.loadProjects()
    );
    setShowProjectPicker(true);
  }

  function handleLoadProject(
    project: Project
  ) {
    const activeSceneId =
      project.scenes.some(
        (scene) =>
          scene.instanceId ===
          project.activeSceneInstanceId
      )
        ? project.activeSceneInstanceId ?? null
        : project.scenes[0]?.instanceId ?? null;

    setActiveProject(project);
    setCurrentSceneInstanceId(activeSceneId);
    setTransitionTargetInstanceId(null);
    setPreviewingTarget(false);
    setShowProjectPicker(false);
  }

  function handleNewScene() {
    if (!activeProject) {
      return;
    }

    setShowNewSceneDialog(true);
  }

  function handleImportSound() {
    setShowImportSoundDialog(true);
  }

  async function handleSubmitSoundImport(
    data: ImportSoundData
  ) {
    setImportingSound(true);
    const formData = new FormData();

    formData.append('file', data.file);
    formData.append('name', data.name);
    formData.append('description', data.description);

    formData.append(
      'categoryPaths',
      JSON.stringify(data.categoryPaths)
    );

    formData.append(
      'tags',
      JSON.stringify(data.tags)
    );

    if (data.durationMs !== undefined) {
      formData.append(
        'durationMs',
        String(data.durationMs)
      );
    }

    formData.append(
      'originalFileName',
      data.originalFileName
    );

    formData.append(
      'fileType',
      data.fileType
    );

    formData.append(
      'mimeType',
      data.mimeType
    );

    formData.append(
      'fileSizeBytes',
      String(data.fileSizeBytes)
    );

    if (data.attribution) {
      formData.append(
        'attribution',
        data.attribution
      );
    }

    if (data.license) {
      formData.append(
        'license',
        data.license
      );
    }

    if (data.sourceUrl) {
      formData.append(
        'sourceUrl',
        data.sourceUrl
      );
    }

    try {
      const response = await fetch(
        apiUrl('/api/library/import'),
        {
          method: 'POST',
          body: formData,
        }
      );

      if (!response.ok) {
        const errorText = await response.text();

        throw new Error(
          `Import failed: ${response.status} ${errorText}`
        );
      }

      setShowImportSoundDialog(false);

      setNotification(
        'Sound committed to repository.'
      );

      setTimeout(() => {
        setNotification(null);
      }, 3000);
    } catch (error) {
      console.error(error);

      setNotification(
        'Sound import failed.'
      );

      setTimeout(() => {
        setNotification(null);
      }, 3000);
    } finally {
      setImportingSound(false);
    }
  }

  function handleCreateProject() {
    const trimmedName = newProjectName.trim();

    if (!trimmedName) {
      return;
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
    setTransitionTargetInstanceId(null);
    setPreviewingTarget(false);

    setNewProjectName('');
    setShowNewProjectDialog(false);
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

    setActiveProject({
      ...activeProject,

      scenes: activeProject.scenes.map((scene) =>
        scene.instanceId === updatedScene.instanceId
          ? updatedScene
          : scene
      ),

      updatedAt: new Date(),
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

  function handleTransition() {
    if (!transitionTargetInstanceId) {
      return;
    }

    // Playback fades will eventually happen here.

    setCurrentSceneInstanceId(
      transitionTargetInstanceId
    );

    setTransitionTargetInstanceId(null);
    setPreviewingTarget(false);
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
    setActiveRoom(newRoom);
    setShowNewRoomDialog(false);
  }

  function handleSelectRoom(
    roomId: string | null
  ) {
    if (roomId === null) {
      setActiveRoom(null);
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

    setActiveRoom(room);
  }

  return (
    <div className="app">
      <MenuBar
        onNewProject={handleNewProject}
        onLoadProject={handleOpenProjectPicker}
        onSaveProject={handleSaveProject}
        onNewScene={handleNewScene}
        onImportSound={handleImportSound}
        onNewRoom={handleNewRoom}
        onManageRooms={handleManageRooms}

        rooms={availableRooms}
        activeRoomId={activeRoom?.id ?? null}
        onSelectRoom={handleSelectRoom}

        projectName={activeProject?.name}
        roomName={
          activeRoom?.name ??
          'No Room Selected'
        }
      />

      {displayedScene && (
        <SceneWorkspace
          scene={displayedScene}           
          currentScene={currentScene}
          soundAssets={soundAssets}
          activeRoom={activeRoom}
          activeSpeakerMap={activeSpeakerMap}
          transitionTarget={transitionTarget}
          previewingTarget={previewingTarget}
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
          onRoomChange={setActiveRoom}
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
              <button
                onClick={() =>
                  setShowNewSceneDialog(false)
                }
              >
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
              setActiveRoom(updatedRoom);
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

      {notification && (
        <div className="notification-toast">
          {notification}
        </div>
      )}
    </div>
  );
}

export default App;
