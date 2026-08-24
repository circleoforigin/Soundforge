import type { Room } from '../models/Room';

type RoomAudioState = 'idle' | 'connecting' | 'ready' | 'degraded' | 'error';

interface RoomSelectorDialogProps {
  rooms: Room[];
  selectedRoomId: string | null;
  roomAudioStatus: { state: RoomAudioState; message: string };
  onSelectRoom: (roomId: string) => void;
  onContinue: () => void;
}

function canContinueRoomSelection(
  selectedRoomId: string | null,
  state: RoomAudioState
): boolean {
  return selectedRoomId !== null && state === 'ready';
}

function connectionMessage(
  selectedRoomId: string | null,
  status: RoomSelectorDialogProps['roomAudioStatus']
): string {
  if (!selectedRoomId) return 'No Room selected';
  if (status.state === 'ready') return 'Room connected';
  if (status.state === 'connecting') return 'Connecting…';
  if (status.state === 'error' || status.state === 'degraded') {
    return status.message || 'Connection failed';
  }
  return 'Waiting to connect…';
}

export default function RoomSelectorDialog({
  rooms,
  selectedRoomId,
  roomAudioStatus,
  onSelectRoom,
  onContinue,
}: RoomSelectorDialogProps) {
  const canContinue = canContinueRoomSelection(selectedRoomId, roomAudioStatus.state);

  return (
    <div className="dialog-backdrop">
      <div className="dialog room-selector-dialog">
        <h2>Select Room</h2>
        <p>Choose a Room to connect before continuing.</p>
        <div className="project-picker-list">
          {rooms.map((room) => (
            <button
              key={room.id}
              className={`project-picker-item${selectedRoomId === room.id ? ' selected' : ''}`}
              onClick={() => onSelectRoom(room.id)}
            >
              {room.name}
            </button>
          ))}
        </div>
        <div className="room-selector-status" role="status">
          {connectionMessage(selectedRoomId, roomAudioStatus)}
        </div>
        <div className="dialog-buttons">
          <button disabled={!canContinue} onClick={onContinue}>Continue</button>
        </div>
      </div>
    </div>
  );
}
