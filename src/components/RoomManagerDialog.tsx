import { useState } from 'react';

import type { Room } from '../models/Room';
import type {SpeakerMap} from '../models/SpeakerMap';

interface RoomManagerDialogProps {
  rooms: Room[];
  activeRoomId: string | null;
  speakerMaps: SpeakerMap[];

  onClose: () => void;
  onSelectRoom: (roomId: string | null) => void;
  onSaveRoom: (room: Room) => void;
  onSaveSpeakerMap: (speakerMap: SpeakerMap) => void;
}

type RoomShape =
  | 'square'
  | 'rectangle';

type RoomManagerTab =
  | 'features'
  | 'hardware';

const ROOM_SCALE_PX = 320;

function getRoomShape(
  room: Room
): RoomShape {
  return room.width === room.height
    ? 'square'
    : 'rectangle';
}

function getRoomDimensions(
  shape: RoomShape
) {
  if (shape === 'rectangle') {
    return {
      width: 1.6,
      height: 1,
    };
  }

  return {
    width: 1,
    height: 1,
  };
}

function stageSpeakersAcrossTop(
  room: Room,
  width: number,
  height: number
) {
  const speakerCount =
    room.speakers.length;

  if (speakerCount === 0) {
    return [];
  }

  const spacing =
    width / (speakerCount + 1);

  return room.speakers.map(
    (speaker, index) => ({
      ...speaker,

      position: {
        x:
          -width / 2 +
          spacing * (index + 1),

        y:
          height / 2 - 0.1,
      },
    })
  );
}

function RoomManagerDialog({
  rooms,
  speakerMaps,
  activeRoomId,
  onClose,
  onSelectRoom,
  onSaveRoom,
  onSaveSpeakerMap,
}: RoomManagerDialogProps) {
  const [draftRoom, setDraftRoom] =
    useState<Room | null>(null);
  const [activeTab, setActiveTab] =
    useState<RoomManagerTab>('features');
  const [draftSpeakerMap, setDraftSpeakerMap] =
  useState<SpeakerMap | null>(null);

  function handleChooseRoom(
  room: Room
) {
  const roomDraft =
    structuredClone(room);

  setDraftRoom(roomDraft);
  setActiveTab('features');

  const existingMap =
    room.speakerMapId
      ? speakerMaps.find(
          (map) =>
            map.id === room.speakerMapId
        ) ?? null
      : null;

  if (existingMap) {
    setDraftSpeakerMap(
      structuredClone(existingMap)
    );

    return;
  }

  const now = new Date();

  setDraftSpeakerMap({
    id: crypto.randomUUID(),

    name: `${room.name} Speaker Map`,

    createdAt: now,
    updatedAt: now,

    adapterType: 'none',

    speakers:
      room.speakers.map(
        (speaker) => ({
          speakerId:
            speaker.speakerId,

          deviceId: '',

          displayName:
            speaker.name,

          enabled: true,
          trim: 0,
        })
      ),
  });
}

  function handleBack() {
  setDraftRoom(null);
  setDraftSpeakerMap(null);
  setActiveTab('features');
}

  function handleSave() {
  if (!draftRoom) {
    return;
  }

  let roomToSave =
    draftRoom;

  if (draftSpeakerMap) {
    const updatedMap = {
      ...draftSpeakerMap,
      updatedAt: new Date(),
    };

    onSaveSpeakerMap(
      updatedMap
    );

    roomToSave = {
      ...draftRoom,
      speakerMapId:
        updatedMap.id,
    };
  }

  onSaveRoom(roomToSave);

  setDraftRoom(null);
  setDraftSpeakerMap(null);
  setActiveTab('features');
}

  function handleShapeChange(
    shape: RoomShape
  ) {
    if (!draftRoom) {
      return;
    }

    const {
      width,
      height,
    } = getRoomDimensions(shape);

    const speakers =
      stageSpeakersAcrossTop(
        draftRoom,
        width,
        height
      );

    setDraftRoom({
      ...draftRoom,
      width,
      height,
      speakers,
    });
  }

  function handleAddSpeaker() {
    if (!draftRoom) {
      return;
    }

    const newSpeaker = {
      speakerId:
        crypto.randomUUID(),

      name:
        `Speaker ${
          draftRoom.speakers.length + 1
        }`,

      position: {
        x: 0,
        y: 0,
      },
    };

    const roomWithSpeaker: Room = {
      ...draftRoom,

      speakers: [
        ...draftRoom.speakers,
        newSpeaker,
      ],
    };

    setDraftRoom({
      ...roomWithSpeaker,

      speakers:
        stageSpeakersAcrossTop(
          roomWithSpeaker,
          roomWithSpeaker.width,
          roomWithSpeaker.height
        ),
    });
  }

  function handleRemoveSpeaker(
    speakerId: string
  ) {
    if (!draftRoom) {
      return;
    }

    setDraftRoom({
      ...draftRoom,

      speakers:
        draftRoom.speakers.filter(
          (speaker) =>
            speaker.speakerId !==
            speakerId
        ),
    });
  }

  function handleSpeakerPointerDown(
    event: React.PointerEvent<HTMLDivElement>,
    speakerId: string
  ) {
    if (!draftRoom) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const editor =
      event.currentTarget.closest(
        '.room-layout-canvas'
      ) as HTMLDivElement | null;

    if (!editor) {
      return;
    }

    const roomEditor = editor;

    function handlePointerMove(
      moveEvent: PointerEvent
    ) {
      const bounds =
        roomEditor.getBoundingClientRect();

      const localX =
        moveEvent.clientX -
        bounds.left;

      const localY =
        moveEvent.clientY -
        bounds.top;

      const normalizedX =
        localX / bounds.width;

      const normalizedY =
        localY / bounds.height;

      setDraftRoom((current) => {
        if (!current) {
          return current;
        }

        const x =
          normalizedX *
            current.width -
          current.width / 2;

        const y =
          current.height / 2 -
          normalizedY *
            current.height;

        const clampedX =
          Math.max(
            -current.width / 2,
            Math.min(
              current.width / 2,
              x
            )
          );

        const clampedY =
          Math.max(
            -current.height / 2,
            Math.min(
              current.height / 2,
              y
            )
          );

        return {
          ...current,

          speakers:
            current.speakers.map(
              (speaker) =>
                speaker.speakerId ===
                speakerId
                  ? {
                      ...speaker,

                      position: {
                        x: clampedX,
                        y: clampedY,
                      },
                    }
                  : speaker
            ),
        };
      });
    }

    function handlePointerUp() {
      window.removeEventListener(
        'pointermove',
        handlePointerMove
      );

      window.removeEventListener(
        'pointerup',
        handlePointerUp
      );

      window.removeEventListener(
        'pointercancel',
        handlePointerUp
      );
    }

    window.addEventListener(
      'pointermove',
      handlePointerMove
    );

    window.addEventListener(
      'pointerup',
      handlePointerUp
    );

    window.addEventListener(
      'pointercancel',
      handlePointerUp
    );
  }

  function handleConnectSonos() {
    window.open(
        'https://sacscape-server.tail7d5063.ts.net/api/sonos/login',
        'sonos-auth',
        'width=600,height=750'
    );
  }

  return (
  <div className="dialog-backdrop">
    <div className="room-manager-dialog">
      <div className="room-manager-header">
        <h2>Manage Rooms</h2>

        <button onClick={onClose}>
          Close
        </button>
      </div>

      <div className="room-manager-body">
        <div className="room-manager-list">
          {!draftRoom ? (
            <>
              <div className="room-manager-list-title">
                Rooms
              </div>

              {rooms.map((room) => (
                <button
                  key={room.id}
                  className={[
                    'room-manager-room-entry',

                    activeRoomId === room.id
                      ? 'selected'
                      : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() =>
                    handleChooseRoom(room)
                  }
                >
                  {room.name}
                </button>
              ))}
            </>
          ) : (
            <div className="room-manager-features">
              <div className="room-manager-tabs">
                <button
                  className={
                    activeTab === 'features'
                      ? 'active'
                      : ''
                  }
                  onClick={() =>
                    setActiveTab('features')
                  }
                >
                  Features
                </button>

                <button
                  className={
                    activeTab === 'hardware'
                      ? 'active'
                      : ''
                  }
                  onClick={() =>
                    setActiveTab('hardware')
                  }
                >
                  Hardware
                </button>
              </div>

              {activeTab === 'features' && (
                <>
                  <div className="room-feature-row">
                    <label>Name</label>

                    <input
                      type="text"
                      value={draftRoom.name}
                      onChange={(event) =>
                        setDraftRoom({
                          ...draftRoom,

                          name:
                            event.target.value,
                        })
                      }
                    />
                  </div>

                  <div className="room-feature-row">
                    <label>Shape</label>

                    <select
                      value={
                        getRoomShape(
                          draftRoom
                        )
                      }
                      onChange={(event) =>
                        handleShapeChange(
                          event.target
                            .value as RoomShape
                        )
                      }
                    >
                      <option value="square">
                        Square
                      </option>

                      <option value="rectangle">
                        Rectangle
                      </option>
                    </select>
                  </div>

                  <div className="room-feature-row">
                    <label>Speakers</label>

                    <div className="room-speaker-count">
                      <span>
                        {
                          draftRoom
                            .speakers
                            .length
                        }
                      </span>

                      <button
                        onClick={
                          handleAddSpeaker
                        }
                      >
                        +
                      </button>
                    </div>
                  </div>

                  <div className="room-feature-section">
                    Speakers
                  </div>

                  {draftRoom.speakers.map(
                    (speaker) => (
                      <div
                        key={
                          speaker.speakerId
                        }
                        className="room-speaker-feature"
                      >
                        <input
                          type="text"
                          value={speaker.name}
                          onChange={(event) =>
                            setDraftRoom({
                              ...draftRoom,

                              speakers:
                                draftRoom.speakers.map(
                                  (candidate) =>
                                    candidate.speakerId ===
                                    speaker.speakerId
                                      ? {
                                          ...candidate,

                                          name:
                                            event
                                              .target
                                              .value,
                                        }
                                      : candidate
                                ),
                            })
                          }
                        />

                        <button
                          onClick={() =>
                            handleRemoveSpeaker(
                              speaker.speakerId
                            )
                          }
                        >
                          Remove
                        </button>
                      </div>
                    )
                  )}
                </>
              )}

              {activeTab === 'hardware' && (
  <div className="room-hardware-panel">
    {draftSpeakerMap && (
      <>
        <div className="room-feature-row">
          <label>System</label>

          <select
            value={
              draftSpeakerMap.adapterType
            }
            onChange={(event) =>
              setDraftSpeakerMap({
                ...draftSpeakerMap,

                adapterType:
                  event.target.value,
              })
            }
          >
            <option value="none">
              None
            </option>

            <option value="sonos">
              Sonos
            </option>
          </select>
        </div>

        <div className="room-feature-section">
          Speaker Mapping
        </div>

        {draftRoom.speakers.map(
          (roomSpeaker) => {
            const mappedSpeaker =
              draftSpeakerMap.speakers.find(
                (speaker) =>
                  speaker.speakerId ===
                  roomSpeaker.speakerId
              );

            if (!mappedSpeaker) {
              return null;
            }

            return (
              <div
                key={
                  roomSpeaker.speakerId
                }
                className="room-hardware-speaker"
              >
                <div className="room-hardware-speaker-name">
                  {roomSpeaker.name}
                </div>

                <div className="room-hardware-device">
                  {mappedSpeaker.deviceId
                    ? mappedSpeaker.displayName
                    : 'Not Assigned'}
                </div>

                <button disabled>
                  Test
                </button>
              </div>
            );
          }
        )}

        {draftSpeakerMap.adapterType ===
          'sonos' && (
          <div className="room-sonos-controls">
            <button
                onClick={handleConnectSonos}
            >
                Connect Sonos
            </button>

            <div className="room-feature-placeholder">
              Sonos device discovery will appear here.
            </div>
          </div>
        )}
      </>
    )}
  </div>
)}

              <div className="room-manager-feature-actions">
                <button
                  onClick={handleBack}
                >
                  Back
                </button>

                <button
                  onClick={handleSave}
                  disabled={
                    !draftRoom.name.trim()
                  }
                >
                  Save
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="room-manager-editor">
          {draftRoom ? (
            <>
              <div className="room-manager-room-header">
                <h3>
                  {draftRoom.name}
                </h3>

                <button
                  onClick={() =>
                    onSelectRoom(
                      draftRoom.id
                    )
                  }
                >
                  Use This Room
                </button>
              </div>

              <div className="room-layout-area">
                <div
                  className="room-layout-canvas"
                  style={{
                    width:
                      `${
                        draftRoom.width *
                        ROOM_SCALE_PX
                      }px`,

                    height:
                      `${
                        draftRoom.height *
                        ROOM_SCALE_PX
                      }px`,
                  }}
                >
                  <div className="room-layout-name">
                    {draftRoom.name}
                  </div>

                  {draftRoom.speakers.map(
                    (speaker) => {
                      const left =
                        ((speaker.position.x +
                          draftRoom.width /
                            2) /
                          draftRoom.width) *
                        100;

                      const top =
                        ((draftRoom.height /
                          2 -
                          speaker.position.y) /
                          draftRoom.height) *
                        100;

                      return (
                        <div
                          key={
                            speaker.speakerId
                          }
                          className="room-layout-speaker"
                          style={{
                            left:
                              `${left}%`,

                            top:
                              `${top}%`,
                          }}
                          onPointerDown={(
                            event
                          ) =>
                            handleSpeakerPointerDown(
                              event,
                              speaker.speakerId
                            )
                          }
                        >
                          <div className="room-layout-speaker-icon" />

                          <div className="room-layout-speaker-name">
                            {speaker.name}
                          </div>
                        </div>
                      );
                    }
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="room-manager-placeholder">
              Select a Room to manage.
            </div>
          )}
        </div>
      </div>
    </div>
  </div>
);
}

export default RoomManagerDialog;