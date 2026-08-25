import {
  useEffect,
  useRef,
  useState,
} from 'react';

interface MenuBarProps {
  onNewProject: () => void;
  onLoadProject: () => void;
  onSaveProject: () => void;
  onCloseProject: () => void;
  onNewScene: () => void;
  onOpenScene: () => void;
  onSaveScene: () => void;
  onDeleteScene: () => void;
  onImportSound: () => void;
  onManageRooms: () => void;
  onOpenRoomSelector: () => void;
  onRefreshSpeakerConnection: () => void;
  onOpenSettings: () => void;
  onOpenResearchLab: () => void;
  sceneActionsEnabled: boolean;
  currentSceneAvailable: boolean;

  roomSelectionEnabled: boolean;
  refreshSpeakerConnectionEnabled: boolean;
  roomSpeakerVolume: number | null;
  roomSpeakerVolumeEnabled: boolean;
  roomSpeakerVolumeMessage: string;
  onRoomSpeakerVolumeChange: (volume: number) => void;

  projectName?: string;
  roomName?: string;
}

function MenuBar({
  onNewProject,
  onLoadProject,
  onSaveProject,
  onCloseProject,
  onNewScene,
  onOpenScene,
  onSaveScene,
  onDeleteScene,
  onImportSound,
  onManageRooms,
  onOpenRoomSelector,
  onRefreshSpeakerConnection,
  onOpenSettings,
  onOpenResearchLab,
  sceneActionsEnabled,
  currentSceneAvailable,
  roomSelectionEnabled,
  refreshSpeakerConnectionEnabled,
  roomSpeakerVolume,
  roomSpeakerVolumeEnabled,
  roomSpeakerVolumeMessage,
  onRoomSpeakerVolumeChange,

  projectName,
  roomName,
}: MenuBarProps) {
  const menuBarRef =
    useRef<HTMLDivElement>(null);

  const [fileMenuOpen, setFileMenuOpen] =
    useState(false);

  const [sceneMenuOpen, setSceneMenuOpen] =
    useState(false);

  const [soundsMenuOpen, setSoundsMenuOpen] =
    useState(false);

  const [roomsMenuOpen, setRoomsMenuOpen] =
    useState(false);

  const [settingsMenuOpen, setSettingsMenuOpen] =
    useState(false);

  const menuOpen =
    fileMenuOpen ||
    sceneMenuOpen ||
    soundsMenuOpen ||
    roomsMenuOpen ||
    settingsMenuOpen;

  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    function handleOutsidePointerDown(
      event: PointerEvent
    ) {
      const target = event.target;

      if (
        target instanceof Node &&
        !menuBarRef.current?.contains(target)
      ) {
        setFileMenuOpen(false);
        setSceneMenuOpen(false);
        setSoundsMenuOpen(false);
        setRoomsMenuOpen(false);
        setSettingsMenuOpen(false);
      }
    }

    document.addEventListener(
      'pointerdown',
      handleOutsidePointerDown
    );

    return () => {
      document.removeEventListener(
        'pointerdown',
        handleOutsidePointerDown
      );
    };
  }, [menuOpen]);

  function closeAllMenus() {
    setFileMenuOpen(false);
    setSceneMenuOpen(false);
    setSoundsMenuOpen(false);
    setRoomsMenuOpen(false);
    setSettingsMenuOpen(false);
  }

  function handleNewProject() {
    closeAllMenus();
    onNewProject();
  }

  function handleLoadProject() {
    closeAllMenus();
    onLoadProject();
  }

  function handleSaveProject() {
    closeAllMenus();
    onSaveProject();
  }

  function handleCloseProject() {
    closeAllMenus();
    onCloseProject();
  }

  function handleNewScene() {
    closeAllMenus();
    onNewScene();
  }

  function handleOpenScene() { closeAllMenus(); onOpenScene(); }
  function handleSaveScene() { closeAllMenus(); onSaveScene(); }
  function handleDeleteScene() { closeAllMenus(); onDeleteScene(); }

  function handleImportSound() {
    closeAllMenus();
    onImportSound();
  }

  function handleOpenRoomSelector() {
    closeAllMenus();
    onOpenRoomSelector();
  }

  return (
    <div
      ref={menuBarRef}
      className="menu-bar"
    >
      <div className="menu-group">
        <button
          className="menu-item"
          onClick={() => {
            const opening =
              !fileMenuOpen;

            closeAllMenus();

            setFileMenuOpen(opening);
          }}
        >
          File
        </button>

        {fileMenuOpen && (
          <div className="dropdown-menu">
            <button
              className="dropdown-item"
              onClick={handleNewProject}
            >
              New Project
            </button>

            <button
              className="dropdown-item"
              onClick={handleLoadProject}
            >
              Load Project
            </button>

            <button
              className="dropdown-item"
              onClick={handleSaveProject}
              disabled={!projectName}
            >
              Save Project
            </button>

            <div className="dropdown-separator" />

            <button
              className="dropdown-item"
              onClick={handleCloseProject}
              disabled={!projectName}
            >
              Close Project
            </button>
          </div>
        )}
      </div>

      <div className="menu-group">
        <button
          className="menu-item"
          disabled={!sceneActionsEnabled}
          onClick={() => {
            const opening =
              !sceneMenuOpen;

            closeAllMenus();

            setSceneMenuOpen(opening);
          }}
        >
          Scene
        </button>

        {sceneMenuOpen && (
          <div className="dropdown-menu">
            <button
              className="dropdown-item"
              onClick={handleNewScene}
              disabled={!sceneActionsEnabled}
            >
              New Scene
            </button>

            <button className="dropdown-item" onClick={handleOpenScene}>
              Open Scene
            </button>

            <button className="dropdown-item" onClick={handleSaveScene} disabled={!currentSceneAvailable}>
              Save Scene
            </button>

            <div className="dropdown-separator" />

            <button className="dropdown-item">
              Import Scene
            </button>

            <button className="dropdown-item">
              Remove from Project
            </button>

            <button className="dropdown-item" onClick={handleDeleteScene} disabled={!currentSceneAvailable}>
              Delete Scene
            </button>
          </div>
        )}
      </div>

      <div className="menu-group">
        <button
          className="menu-item"
          onClick={() => {
            const opening =
              !soundsMenuOpen;

            closeAllMenus();

            setSoundsMenuOpen(opening);
          }}
        >
          Sounds
        </button>

        {soundsMenuOpen && (
          <div className="dropdown-menu">
            <button
              className="dropdown-item"
              onClick={handleImportSound}
            >
              Import Sound
            </button>
          </div>
        )}
      </div>

      <div className="menu-group">
        <button
          className="menu-item"
          onClick={() => {
            const opening =
              !roomsMenuOpen;

            closeAllMenus();

            setRoomsMenuOpen(opening);
          }}
        >
          Rooms
        </button>

        {roomsMenuOpen && (
          <div className="dropdown-menu">
            <button
              className="dropdown-item"
              onClick={handleOpenRoomSelector}
              disabled={!roomSelectionEnabled}
            >
              Select Room...
            </button>

            <button
              className="dropdown-item"
              onClick={() => {
                closeAllMenus();
                onManageRooms();
              }}
            >
              Manage Rooms...
            </button>

            <div className="dropdown-separator" />

            <label
              className="dropdown-room-volume-control"
              title={roomSpeakerVolumeMessage || undefined}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
            >
              <span>Speaker Volume</span>
              <div className="dropdown-room-volume-input">
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value={roomSpeakerVolume ?? 0}
                  disabled={!roomSpeakerVolumeEnabled}
                  onChange={(event) => onRoomSpeakerVolumeChange(Number(event.target.value))}
                />
                <output>{roomSpeakerVolume ?? '—'}</output>
              </div>
              {roomSpeakerVolumeMessage && (
                <span className="dropdown-room-volume-message">{roomSpeakerVolumeMessage}</span>
              )}
            </label>

            <button
              className="dropdown-item"
              disabled={!refreshSpeakerConnectionEnabled}
              onClick={() => {
                closeAllMenus();
                onRefreshSpeakerConnection();
              }}
            >
              Refresh Connection
            </button>
          </div>
        )}
      </div>

      <div className="menu-group">
        <button
          className="menu-item"
          onClick={() => {
            const opening = !settingsMenuOpen;
            closeAllMenus();
            setSettingsMenuOpen(opening);
          }}
        >
          Settings
        </button>

        {settingsMenuOpen && (
          <div className="dropdown-menu">
            <button
              className="dropdown-item"
              onClick={() => {
                closeAllMenus();
                onOpenResearchLab();
              }}
            >
              Research Lab...
            </button>
            <div className="dropdown-separator" />
            <button className="dropdown-item" onClick={() => { closeAllMenus(); onOpenSettings(); }}>
              Settings...
            </button>
          </div>
        )}
      </div>

      {projectName && (
        <div className="project-name">
          {projectName}.proj
          {roomName &&
            ` — ${roomName}`}
        </div>
      )}
    </div>
  );
}

export default MenuBar;
