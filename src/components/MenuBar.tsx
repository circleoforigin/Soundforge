import { useState } from 'react';

import type { Room } from '../models/Room';

interface MenuBarProps {
  onNewProject: () => void;
  onNewScene: () => void;
  onImportSound: () => void;
  onNewRoom: () => void;
  onManageRooms: () => void;

  rooms: Room[];
  activeRoomId: string | null;
  onSelectRoom: (roomId: string | null) => void;

  projectName?: string;
  roomName?: string;
}

function MenuBar({
  onNewProject,
  onNewScene,
  onImportSound,
  onNewRoom,
  onManageRooms,
  rooms,
  activeRoomId,
  onSelectRoom,

  projectName,
  roomName,
}: MenuBarProps) {
  const [fileMenuOpen, setFileMenuOpen] =
    useState(false);

  const [sceneMenuOpen, setSceneMenuOpen] =
    useState(false);

  const [soundsMenuOpen, setSoundsMenuOpen] =
    useState(false);

  const [roomsMenuOpen, setRoomsMenuOpen] =
    useState(false);

  function closeAllMenus() {
    setFileMenuOpen(false);
    setSceneMenuOpen(false);
    setSoundsMenuOpen(false);
    setRoomsMenuOpen(false);
  }

  function handleNewProject() {
    closeAllMenus();
    onNewProject();
  }

  function handleNewScene() {
    closeAllMenus();
    onNewScene();
  }

  function handleImportSound() {
    closeAllMenus();
    onImportSound();
  }

  function handleSelectRoom(
    roomId: string | null
  ) {
    closeAllMenus();
    onSelectRoom(roomId);
  }

  return (
    <div className="menu-bar">
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

            <button className="dropdown-item">
              Load Project
            </button>

            <button className="dropdown-item">
              Save Project
            </button>

            <div className="dropdown-separator" />

            <button className="dropdown-item">
              Close Project
            </button>
          </div>
        )}
      </div>

      <div className="menu-group">
        <button
          className="menu-item"
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
            >
              New Scene
            </button>

            <button className="dropdown-item">
              Open Scene
            </button>

            <button className="dropdown-item">
              Save Scene
            </button>

            <div className="dropdown-separator" />

            <button className="dropdown-item">
              Import Scene
            </button>

            <button className="dropdown-item">
              Remove from Project
            </button>

            <button className="dropdown-item">
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
              onClick={() =>
                handleSelectRoom(null)
              }
            >
              {activeRoomId === null
                ? '✓ No Room Selected'
                : 'No Room Selected'}
            </button>

            {rooms.length > 0 && (
              <div className="dropdown-separator" />
            )}

            {rooms.map((room) => (
              <button
                key={room.id}
                className="dropdown-item"
                onClick={() =>
                  handleSelectRoom(room.id)
                }
              >
                {activeRoomId === room.id
                  ? `✓ ${room.name}`
                  : room.name}
              </button>
            ))}

            <div className="dropdown-separator" />

            <button
              className="dropdown-item"
              onClick={() => {
                closeAllMenus();
                onNewRoom();
              }}
            >
              New Room...
            </button>

            <div className="dropdown-separator" />

            <button
              className="dropdown-item"
              onClick={() => {
                closeAllMenus();
                onManageRooms();
              }}
            >
              Manage Rooms...
            </button>
          </div>
        )}
      </div>

      <button className="menu-item">
        Settings
      </button>

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