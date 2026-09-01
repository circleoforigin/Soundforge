import type {
  PersistentEntity,
} from './PersistentEntity';
import type { SacscapeReaction } from './SacscapeReaction';

export interface Project
  extends PersistentEntity {
  name: string;

  sceneIds: string[];
  reactions: SacscapeReaction[];

  activeSceneInstanceId?: string;
  activeRoomId?: string;
  lastSceneId?: string;
  lastRoomId?: string;
}
