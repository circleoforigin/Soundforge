import type {
  Room,
} from '../models/Room';

import {
  localStorageService,
} from '../storage/LocalStorageService';

import {
  hostedCollectionRepository,
} from '../host/HostedCollectionRepository';

const ROOMS_KEY = 'rooms';
const ROOMS_COLLECTION = 'rooms';

function normalizeRoom(
  room: Room
): Room {
  return {
    ...room,

    speakers: Array.isArray(room.speakers)
      ? room.speakers.map(
          (speaker, index) => ({
            ...speaker,

            name:
              speaker.name ??
              `Speaker ${index + 1}`,
          })
        )
      : [],
  };
}

export class RoomRepository {
  async loadRooms(): Promise<Room[]> {
    if (
      hostedCollectionRepository.hosted
    ) {
      const rooms =
        await hostedCollectionRepository
          .loadAll<Room>(
            ROOMS_COLLECTION
          );

      return Array.isArray(rooms)
        ? rooms.map(normalizeRoom)
        : [];
    }

    const rooms =
      localStorageService.get<Room[]>(
        ROOMS_KEY,
        []
      );

    return Array.isArray(rooms)
      ? rooms.map(normalizeRoom)
      : [];
  }

  async saveRoom(
    room: Room
  ): Promise<Room[]> {
    const normalizedRoom =
      normalizeRoom(room);

    if (
      hostedCollectionRepository.hosted
    ) {
      await hostedCollectionRepository.save(
        ROOMS_COLLECTION,
        normalizedRoom.id,
        normalizedRoom
      );

      return this.loadRooms();
    }

    const rooms =
      await this.loadRooms();

    const exists =
      rooms.some(
        (candidate) =>
          candidate.id ===
          normalizedRoom.id
      );

    const updatedRooms =
      exists
        ? rooms.map(
            (candidate) =>
              candidate.id ===
              normalizedRoom.id
                ? normalizedRoom
                : candidate
          )
        : [
            ...rooms,
            normalizedRoom,
          ];

    localStorageService.set(
      ROOMS_KEY,
      updatedRooms
    );

    return updatedRooms;
  }

  async deleteRoom(
    roomId: string
  ): Promise<Room[]> {
    if (
      hostedCollectionRepository.hosted
    ) {
      await hostedCollectionRepository.delete(
        ROOMS_COLLECTION,
        roomId
      );

      return this.loadRooms();
    }

    const rooms =
      await this.loadRooms();

    const updatedRooms =
      rooms.filter(
        (room) =>
          room.id !== roomId
      );

    localStorageService.set(
      ROOMS_KEY,
      updatedRooms
    );

    return updatedRooms;
  }
}

export const roomRepository =
  new RoomRepository();