import type { Room } from '../models/Room';

interface RoomSelectorDialogProps {
  rooms: Room[];
  selectedRoomId: string | null;
  onSelectRoom: (roomId: string) => void;
}

export default function RoomSelectorDialog({
  rooms,
  selectedRoomId,
  onSelectRoom,
}: RoomSelectorDialogProps) {
  return (
    <div className="dialog-backdrop">
      <div className="dialog room-selector-dialog">
        <h2>Select Room</h2>
        <p>Choose a Room before opening a Scene.</p>
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
      </div>
    </div>
  );
}
