import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import type { Room } from '../models/Room';
import type {SpeakerMap} from '../models/SpeakerMap';
import { apiUrl } from '../config/api';

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

interface SonosHousehold {
  id: string;
}

interface SonosPlayer {
  id: string;
  name: string;
  deviceIds: string[];
}

interface SonosDevice {
  id: string;
  name?: string;
  model?: string;
  modelDisplayName?: string;
}

interface SonosGroup {
  id: string;
  name: string;
  playerIds: string[];
}

interface DiscoveredSonosHousehold extends SonosHousehold {
  groups: SonosGroup[];
  players: SonosPlayer[];
}

type SonosDiscoveryState =
  | { status: 'idle' | 'discovering' | 'notConnected' }
  | { status: 'empty' }
  | { status: 'error'; message: string }
  | { status: 'ready'; households: DiscoveredSonosHousehold[] };

interface SonosTestState {
  speakerId: string;
  status: 'testing' | 'success' | 'error';
  message: string;
}

const ROOM_SCALE_PX = 320;

function getSonosDeviceLabel(device: SonosDevice): string {
  const name = device.name?.trim() || 'Unnamed device';
  const model = device.modelDisplayName?.trim() || device.model?.trim();

  return model ? `${name} · ${model}` : name;
}

function getSonosAssignmentLabel(device: SonosDevice): string {
  const idSuffix = device.id.slice(-8);
  return `${getSonosDeviceLabel(device)} · …${idSuffix}`;
}

function getSonosPhysicalDevices(player: SonosPlayer): SonosDevice[] {
  return (player.deviceIds ?? []).map((deviceId, index) => ({
    id: deviceId,
    name: player.deviceIds.length === 1
      ? player.name
      : `${player.name} · Device ${index + 1}`,
  }));
}

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
  const [sonosDiscovery, setSonosDiscovery] =
    useState<SonosDiscoveryState>({ status: 'idle' });
  const [sonosTestState, setSonosTestState] =
    useState<SonosTestState | null>(null);
  const sonosDiscoveryAbortRef = useRef<AbortController | null>(null);
  const sonosPopupTimerRef = useRef<number | null>(null);

  const discoverSonosDevices = useCallback(async () => {
    sonosDiscoveryAbortRef.current?.abort();
    const abortController = new AbortController();
    sonosDiscoveryAbortRef.current = abortController;
    setSonosDiscovery({ status: 'discovering' });

    try {
      const householdsResponse = await fetch(
        apiUrl('/api/sonos/households'),
        { signal: abortController.signal }
      );
      const householdsData = await householdsResponse.json() as {
        ok?: boolean;
        households?: SonosHousehold[];
        message?: string;
      };

      if (!householdsResponse.ok) {
        const message = householdsData.message ??
          'Unable to discover Sonos households.';

        if (/not connected|token has expired/i.test(message)) {
          setSonosDiscovery({ status: 'notConnected' });
          return;
        }

        throw new Error(message);
      }

      const households = householdsData.households ?? [];

      if (households.length === 0) {
        setSonosDiscovery({ status: 'empty' });
        return;
      }

      const discoveredHouseholds = await Promise.all(
        households.map(async (household) => {
          const groupsResponse = await fetch(
            apiUrl(
              `/api/sonos/households/${encodeURIComponent(household.id)}/groups`
            ),
            { signal: abortController.signal }
          );
          const groupsData = await groupsResponse.json() as {
            groups?: SonosGroup[];
            players?: SonosPlayer[];
            message?: string;
          };

          if (!groupsResponse.ok) {
            throw new Error(
              groupsData.message ??
              `Unable to discover Sonos devices for household ${household.id}.`
            );
          }

          return {
            ...household,
            groups: groupsData.groups ?? [],
            players: groupsData.players ?? [],
          };
        })
      );

      setSonosDiscovery({
        status: 'ready',
        households: discoveredHouseholds,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return;
      }

      setSonosDiscovery({
        status: 'error',
        message: error instanceof Error
          ? error.message
          : 'Unable to discover Sonos devices.',
      });
    } finally {
      if (sonosDiscoveryAbortRef.current === abortController) {
        sonosDiscoveryAbortRef.current = null;
      }
    }
  }, []);

  useEffect(() => () => {
    sonosDiscoveryAbortRef.current?.abort();

    if (sonosPopupTimerRef.current !== null) {
      window.clearInterval(sonosPopupTimerRef.current);
    }
  }, []);

  function handleChooseRoom(
  room: Room
) {
  const roomDraft =
    structuredClone(room);

  setDraftRoom(roomDraft);
  setActiveTab('features');
  setSonosDiscovery({ status: 'idle' });

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
    spatialOutputMode: 'fullSpatial',

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
    const popup = window.open(
        apiUrl('/api/sonos/login'),
        'sonos-auth',
        'width=600,height=750'
    );

    if (!popup) {
      setSonosDiscovery({
        status: 'error',
        message: 'The Sonos sign-in window was blocked by the browser.',
      });
      return;
    }

    if (sonosPopupTimerRef.current !== null) {
      window.clearInterval(sonosPopupTimerRef.current);
    }

    sonosPopupTimerRef.current = window.setInterval(() => {
      if (!popup.closed) {
        return;
      }

      if (sonosPopupTimerRef.current !== null) {
        window.clearInterval(sonosPopupTimerRef.current);
        sonosPopupTimerRef.current = null;
      }

      void discoverSonosDevices();
    }, 500);
  }

  function handleSonosAssignment(
    speakerId: string,
    deviceId: string
  ) {
    if (!draftSpeakerMap) {
      return;
    }

    if (
      deviceId &&
      draftSpeakerMap.speakers.some(
        (speaker) =>
          speaker.speakerId !== speakerId &&
          speaker.deviceId === deviceId
      )
    ) {
      return;
    }

    const discoveredDevices = sonosDiscovery.status === 'ready'
      ? sonosDiscovery.households.flatMap((household) =>
          household.players.flatMap(getSonosPhysicalDevices)
        )
      : [];
    const device = discoveredDevices.find(
      (candidate) => candidate.id === deviceId
    );

    setDraftSpeakerMap({
      ...draftSpeakerMap,
      adapterType: 'sonos',
      spatialOutputMode:
        draftSpeakerMap.adapterType === 'sonos'
          ? draftSpeakerMap.spatialOutputMode
          : 'balanced',
      speakers: draftSpeakerMap.speakers.map((speaker) =>
        speaker.speakerId === speakerId
          ? {
              ...speaker,
              deviceId,
              displayName: device ? getSonosDeviceLabel(device) : '',
            }
          : speaker
      ),
    });
    setSonosTestState(null);
  }

  function updateMappedSpeaker(
    speakerId: string,
    changes: Partial<Pick<
      SpeakerMap['speakers'][number],
      'enabled' | 'trim'
    >>
  ) {
    if (!draftSpeakerMap) {
      return;
    }

    setDraftSpeakerMap({
      ...draftSpeakerMap,
      speakers: draftSpeakerMap.speakers.map((speaker) =>
        speaker.speakerId === speakerId
          ? { ...speaker, ...changes }
          : speaker
      ),
    });
  }

  async function handleTestSonosSpeaker(
    speakerId: string,
    playerId: string
  ) {
    setSonosTestState({
      speakerId,
      status: 'testing',
      message: 'Sending test tone…',
    });

    try {
      const response = await fetch(
        apiUrl(`/api/sonos/test-tone/${encodeURIComponent(playerId)}`),
        { method: 'POST' }
      );
      const responseText = await response.text();
      let message = response.ok
        ? 'Test tone sent.'
        : 'Unable to send the test tone.';

      if (responseText) {
        try {
          const data = JSON.parse(responseText) as { message?: string };
          message = data.message ?? message;
        } catch {
          if (!response.ok) {
            message = responseText;
          }
        }
      }

      setSonosTestState({
        speakerId,
        status: response.ok ? 'success' : 'error',
        message,
      });
    } catch (error) {
      setSonosTestState({
        speakerId,
        status: 'error',
        message: error instanceof Error
          ? error.message
          : 'Unable to send the test tone.',
      });
    }
  }

  const discoveredSonosDevices = sonosDiscovery.status === 'ready'
    ? Array.from(
        new Map(
          sonosDiscovery.households
            .flatMap((household) =>
              household.players.flatMap(getSonosPhysicalDevices)
            )
            .map((device) => [device.id, device])
        ).values()
      )
    : [];

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
                  onClick={() => {
                    setActiveTab('hardware');

                    if (
                      draftSpeakerMap?.adapterType === 'sonos' &&
                      sonosDiscovery.status === 'idle'
                    ) {
                      void discoverSonosDevices();
                    }
                  }}
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
            onChange={(event) => {
              const adapterType = event.target.value;

              setDraftSpeakerMap({
                ...draftSpeakerMap,

                adapterType,
                spatialOutputMode:
                  adapterType === 'sonos' && draftSpeakerMap.adapterType !== 'sonos'
                    ? 'balanced'
                    : draftSpeakerMap.spatialOutputMode,
              });

              if (
                adapterType === 'sonos' &&
                sonosDiscovery.status === 'idle'
              ) {
                void discoverSonosDevices();
              }
            }}
          >
            <option value="none">
              None
            </option>

            <option value="sonos">
              Sonos
            </option>
          </select>
        </div>

        {draftSpeakerMap.adapterType === 'sonos' && (
          <div className="room-feature-row room-spatial-mode-row">
            <label>Spatial Mode</label>

            <div>
              <select
                value={draftSpeakerMap.spatialOutputMode ?? 'balanced'}
                onChange={(event) =>
                  setDraftSpeakerMap({
                    ...draftSpeakerMap,
                    spatialOutputMode: event.target.value === 'fullSpatial'
                      ? 'fullSpatial'
                      : 'balanced',
                  })
                }
              >
                <option value="balanced">Balanced Field</option>
                <option value="fullSpatial">Full Spatial Mix (Experimental)</option>
              </select>

              <small>
                Balanced Field avoids multi-speaker synchronization outside the center.
              </small>
            </div>
          </div>
        )}

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

                <div
                  className={[
                    'room-hardware-device',
                    mappedSpeaker.deviceId ? 'assigned' : 'unassigned',
                  ].join(' ')}
                >
                  {mappedSpeaker.deviceId ? 'Assigned' : 'Unassigned'}
                </div>

                {draftSpeakerMap.adapterType === 'sonos' && (
                  <select
                    className="room-hardware-device-select"
                    aria-label={`Sonos device for ${roomSpeaker.name}`}
                    value={mappedSpeaker.deviceId}
                    onChange={(event) =>
                      handleSonosAssignment(
                        roomSpeaker.speakerId,
                        event.target.value
                      )
                    }
                  >
                    <option value="">Not Assigned</option>

                    {mappedSpeaker.deviceId &&
                      !discoveredSonosDevices.some(
                        (device) => device.id === mappedSpeaker.deviceId
                      ) && (
                        <option value={mappedSpeaker.deviceId}>
                          {mappedSpeaker.displayName || mappedSpeaker.deviceId}
                          {' (not discovered)'}
                        </option>
                      )}

                    {discoveredSonosDevices.map((device) => {
                      const assignedElsewhere = draftSpeakerMap.speakers.some(
                        (speaker) =>
                          speaker.speakerId !== roomSpeaker.speakerId &&
                          speaker.deviceId === device.id
                      );

                      return (
                        <option
                          key={device.id}
                          value={device.id}
                          disabled={assignedElsewhere}
                        >
                          {getSonosAssignmentLabel(device)}
                          {assignedElsewhere ? ' (assigned)' : ''}
                        </option>
                      );
                    })}
                  </select>
                )}

                <div className="room-hardware-speaker-settings">
                  <label>
                    <input
                      type="checkbox"
                      checked={mappedSpeaker.enabled}
                      onChange={(event) =>
                        updateMappedSpeaker(roomSpeaker.speakerId, {
                          enabled: event.target.checked,
                        })
                      }
                    />
                    Enabled
                  </label>

                  <label>
                    Trim
                    <input
                      type="number"
                      step="0.5"
                      value={mappedSpeaker.trim}
                      onChange={(event) =>
                        updateMappedSpeaker(roomSpeaker.speakerId, {
                          trim: Number(event.target.value),
                        })
                      }
                    />
                    dB
                  </label>

                  <button
                    disabled={
                      draftSpeakerMap.adapterType !== 'sonos' ||
                      !mappedSpeaker.deviceId ||
                      (
                        sonosTestState?.speakerId === roomSpeaker.speakerId &&
                        sonosTestState.status === 'testing'
                      )
                    }
                    onClick={() =>
                      void handleTestSonosSpeaker(
                        roomSpeaker.speakerId,
                        mappedSpeaker.deviceId
                      )
                    }
                  >
                    Test
                  </button>
                </div>

                {sonosTestState?.speakerId === roomSpeaker.speakerId && (
                  <div
                    className={`room-sonos-test-status ${sonosTestState.status}`}
                    role="status"
                  >
                    {sonosTestState.message}
                  </div>
                )}
              </div>
            );
          }
        )}

        {draftSpeakerMap.adapterType ===
          'sonos' && (
          <div className="room-sonos-controls">
            <div className="room-sonos-actions">
              <button onClick={handleConnectSonos}>
                Connect Sonos
              </button>

              <button
                onClick={() => void discoverSonosDevices()}
                disabled={sonosDiscovery.status === 'discovering'}
              >
                Refresh Devices
              </button>
            </div>

            {sonosDiscovery.status === 'idle' && (
              <div className="room-feature-placeholder">
                Not connected.
              </div>
            )}

            {sonosDiscovery.status === 'notConnected' && (
              <div className="room-feature-placeholder">
                Not connected. Connect Sonos, then refresh devices.
              </div>
            )}

            {sonosDiscovery.status === 'discovering' && (
              <div className="room-feature-placeholder">
                Discovering…
              </div>
            )}

            {sonosDiscovery.status === 'empty' && (
              <div className="room-feature-placeholder">
                Connected, but no Sonos households were found.
              </div>
            )}

            {sonosDiscovery.status === 'error' && (
              <div className="room-sonos-error" role="alert">
                Discovery error: {sonosDiscovery.message}
              </div>
            )}

            {sonosDiscovery.status === 'ready' && (
              <div className="room-sonos-discovery">
                <div className="room-sonos-status">
                  Devices discovered
                </div>

                {sonosDiscovery.households.map((household) => {
                  const groupedPlayerIds = new Set(
                    household.groups.flatMap((group) => group.playerIds)
                  );
                  const ungroupedPlayers = household.players.filter(
                    (player) => !groupedPlayerIds.has(player.id)
                  );

                  return (
                    <section
                      className="room-sonos-household"
                      key={household.id}
                    >
                      <div className="room-sonos-household-title">
                        <span>Household</span>
                        <code>{household.id}</code>
                      </div>

                      {household.groups.map((group) => {
                        const logicalPlayers = group.playerIds.flatMap(
                          (playerId) => {
                            const player = household.players.find(
                              (candidate) => candidate.id === playerId
                            );

                            return player ? [player] : [];
                          }
                        );

                        return (
                          <div className="room-sonos-group" key={group.id}>
                            <div className="room-sonos-group-name">
                              <span>{group.name || 'Unnamed group'}</span>
                              <small>Logical player/group</small>
                            </div>

                            <div className="room-sonos-players">
                              {logicalPlayers.map((player) => (
                                <div
                                  className="room-sonos-player"
                                  key={player.id}
                                >
                                  <div className="room-sonos-player-title">
                                    <span>{player.name || 'Unnamed player'}</span>
                                    <small>Logical player</small>
                                    <code>{player.id}</code>
                                  </div>

                                  <div className="room-sonos-devices">
                                    {getSonosPhysicalDevices(player).map((device) => (
                                      <div
                                        className="room-sonos-physical-device"
                                        key={device.id}
                                      >
                                        <span>{getSonosDeviceLabel(device)}</span>
                                        <code>{device.id}</code>
                                      </div>
                                    ))}

                                    {(player.deviceIds ?? []).length === 0 && (
                                      <div className="room-sonos-player-empty">
                                        No physical devices reported.
                                      </div>
                                    )}
                                  </div>
                                </div>
                              ))}

                              {logicalPlayers.length === 0 && (
                                <div className="room-sonos-player-empty">
                                  No logical players reported for this group.
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}

                      {ungroupedPlayers.length > 0 && (
                        <div className="room-sonos-group">
                          <div className="room-sonos-group-name">
                            <span>Ungrouped players</span>
                            <small>Logical players</small>
                          </div>

                          <div className="room-sonos-players">
                            {ungroupedPlayers.map((player) => (
                              <div
                                className="room-sonos-player"
                                key={player.id}
                              >
                                <div className="room-sonos-player-title">
                                  <span>{player.name || 'Unnamed player'}</span>
                                  <small>Logical player</small>
                                  <code>{player.id}</code>
                                </div>

                                <div className="room-sonos-devices">
                                  {getSonosPhysicalDevices(player).map((device) => (
                                    <div
                                      className="room-sonos-physical-device"
                                      key={device.id}
                                    >
                                      <span>{getSonosDeviceLabel(device)}</span>
                                      <code>{device.id}</code>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {household.groups.length === 0 &&
                        ungroupedPlayers.length === 0 && (
                          <div className="room-sonos-player-empty">
                            No groups or physical devices found.
                          </div>
                        )}
                    </section>
                  );
                })}
              </div>
            )}
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
