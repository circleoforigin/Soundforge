import { useState } from 'react';

export type RoomShape =
  | 'square'
  | 'rectangle';

export interface NewRoomData {
  name: string;
  shape: RoomShape;
  speakerCount: number;
}

interface NewRoomDialogProps {
  onCancel: () => void;

  onCreate: (
    data: NewRoomData
  ) => void;
}

function NewRoomDialog({
  onCancel,
  onCreate,
}: NewRoomDialogProps) {
  const [name, setName] =
    useState('');

  const [shape, setShape] =
    useState<RoomShape>('square');

  const [speakerCount, setSpeakerCount] =
    useState(2);

  function handleCreate() {
    const trimmedName =
      name.trim();

    if (!trimmedName) {
      return;
    }

    if (speakerCount < 1) {
      return;
    }

    onCreate({
      name: trimmedName,
      shape,
      speakerCount,
    });
  }

  return (
    <div className="dialog-backdrop">
      <div className="dialog">
        <h2>New Room</h2>

        <div className="new-room-row">
          <label>Name</label>

          <input
            type="text"
            value={name}
            placeholder="Room name"
            onChange={(event) =>
              setName(
                event.target.value
              )
            }
            autoFocus
          />
        </div>

        <div className="new-room-row">
          <label>Shape</label>

          <select
            value={shape}
            onChange={(event) =>
              setShape(
                event.target.value as RoomShape
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

        <div className="new-room-row">
          <label>Speakers</label>

          <input
            type="number"
            min="1"
            max="16"
            value={speakerCount}
            onChange={(event) =>
              setSpeakerCount(
                Number(
                  event.target.value
                )
              )
            }
          />
        </div>

        <div className="dialog-buttons">
          <button onClick={onCancel}>
            Cancel
          </button>

          <button
            disabled={
              !name.trim() ||
              speakerCount < 1
            }
            onClick={handleCreate}
          >
            Create Room
          </button>
        </div>
      </div>
    </div>
  );
}

export default NewRoomDialog;