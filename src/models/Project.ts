import type {
  PersistentEntity,
} from './PersistentEntity';

export interface Project
  extends PersistentEntity {
  name: string;

  sceneIds: string[];

  activeSceneInstanceId?: string;
  activeRoomId?: string;
}