import type { Room } from '../models/Room.ts';

export function createDefaultRoom(
  createId: () => string = () => crypto.randomUUID()
): Room {
  const width = 1;
  const height = 1;
  const speakerCount = 2;
  const speakers = Array.from({ length: speakerCount }, (_, index) => {
    const angle = (index / speakerCount) * Math.PI * 2;
    return {
      speakerId: createId(),
      name: `Speaker ${index + 1}`,
      position: {
        x: Math.cos(angle) * (width * 0.4),
        y: Math.sin(angle) * (height * 0.4),
      },
    };
  });

  return {
    id: createId(),
    name: 'Unnamed Room',
    offset: { x: 0, y: 0 },
    width,
    height,
    speakers,
    speakerMapId: undefined,
  };
}
