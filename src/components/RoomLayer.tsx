import type { Room } from '../models/Room';
import type { SpeakerMap } from '../models/SpeakerMap';
import type { SpeakerGeometry } from '../utils/roomSpeakerMath';
import type { SpeakerMix } from '../utils/spatialMixMath';

interface RoomLayerProps {
  room: Room;
  viewScale: number;
  speakerMap: SpeakerMap;
  speakerGeometry: SpeakerGeometry[];
  speakerMix: SpeakerMix[];
}

function RoomLayer({
  room,
  viewScale,
  speakerMap,
  speakerGeometry,
  speakerMix,
}: RoomLayerProps) {
  return (
    <div
      className="room-layer"
      style={{
        left: `${50 + room.offset.x * 50}%`,
        top: `${50 - room.offset.y * 50}%`,
        width: `${room.width * 50}%`,
        height: `${room.height * 50}%`,
        transform:
          `translate(-50%, -50%) scale(${viewScale})`,
      }}
    >
      {room.speakers.map((roomSpeaker) => {
        const geometry =
            speakerGeometry.find(
                (item) =>
                    item.speakerId === roomSpeaker.speakerId
            );

        const mix =
            speakerMix.find(
                (item) =>
                    item.speakerId === roomSpeaker.speakerId
            );

        const mappedSpeaker =
          speakerMap.speakers.find(
            (speaker) =>
              speaker.speakerId ===
              roomSpeaker.speakerId
          );

        const left =
          ((roomSpeaker.position.x +
            room.width / 2) /
            room.width) *
          100;

        const top =
          ((room.height / 2 -
            roomSpeaker.position.y) /
            room.height) *
          100;

        return (
          <div
            key={roomSpeaker.speakerId}
            className={[
              'room-speaker',
              mappedSpeaker?.enabled === false
                ? 'disabled'
                : '',
            ]
              .filter(Boolean)
              .join(' ')}
            style={{
              left: `${left}%`,
              top: `${top}%`,
            }}
          >
            <div className="room-speaker-icon" />

            <div className="room-speaker-label">
              {mappedSpeaker?.displayName ??
                roomSpeaker.name}
            </div>

            {geometry && (
                <div className="room-speaker-debug">
                    {Math.round(geometry.angleDegrees)}°
                    {' · '}
                    {geometry.distanceFromCenter.toFixed(2)}

                    {mix && (
                    <>
                        {' · '}
                        {Math.round(mix.gain * 100)}%
                    </>
                    )}
                </div>
                )}
          </div>
        );
      })}
    </div>
  );
}

export default RoomLayer;
