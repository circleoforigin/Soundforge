import type { Room } from '../models/Room';

import {
  localStorageService,
} from '../storage/LocalStorageService';

const ROOMS_KEY = 'rooms';

export class RoomRepository {
  loadRooms(): Room[] {
  const rooms =
    localStorageService.get<Room[]>(
      ROOMS_KEY,
      []
    );

  if (!Array.isArray(rooms)) {
    return [];
  }

  const normalizedRooms =
    rooms.map((room) => ({
      ...room,

      speakers: room.speakers.map(
        (speaker, index) => ({
          ...speaker,

          name:
            speaker.name ??
            `Speaker ${index + 1}`,
        })
      ),
    }));

  return normalizedRooms;
}

  saveRooms(
    rooms: Room[]
  ): void {
    localStorageService.set(
      ROOMS_KEY,
      rooms
    );
  }

  saveRoom(
    room: Room
  ): Room[] {
    const rooms =
      this.loadRooms();

    const existingIndex =
      rooms.findIndex(
        (candidate) =>
          candidate.id === room.id
      );

    let updatedRooms: Room[];

    if (existingIndex >= 0) {
      updatedRooms =
        rooms.map((candidate) =>
          candidate.id === room.id
            ? room
            : candidate
        );
    } else {
      updatedRooms = [
        ...rooms,
        room,
      ];
    }

    this.saveRooms(
      updatedRooms
    );

    return updatedRooms;
  }

  deleteRoom(
    roomId: string
  ): Room[] {
    const updatedRooms =
      this.loadRooms().filter(
        (room) =>
          room.id !== roomId
      );

    this.saveRooms(
      updatedRooms
    );

    return updatedRooms;
  }
}

export const roomRepository =
  new RoomRepository();