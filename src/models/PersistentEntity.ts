/**
 * Base interface implemented by every persistent entity in Soundforge.
 */
export interface PersistentEntity {
  /** Unique identifier. Never changes. */
  id: string;

  /** UTC date/time the entity was created. */
  createdAt: Date;

  /** UTC date/time of the last modification. */
  updatedAt: Date;
}

export interface LibraryEntity extends PersistentEntity {
    name: string;
    categoryPaths: string[][];
    tags: string[];
}