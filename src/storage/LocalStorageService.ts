const STORAGE_PREFIX = 'sacscape.';

export class LocalStorageService {
  get<T>(
    key: string,
    fallback: T
  ): T {
    const fullKey =
      STORAGE_PREFIX + key;

    const raw =
      window.localStorage.getItem(
        fullKey
      );

    if (!raw) {
      return fallback;
    }

    try {
      return JSON.parse(raw) as T;
    } catch (error) {
      console.error(
        `Unable to read local storage key "${fullKey}":`,
        error
      );

      return fallback;
    }
  }

  set<T>(
    key: string,
    value: T
  ): void {
    const fullKey =
      STORAGE_PREFIX + key;

    try {
      window.localStorage.setItem(
        fullKey,
        JSON.stringify(
          value,
          null,
          2
        )
      );
    } catch (error) {
      console.error(
        `Unable to write local storage key "${fullKey}":`,
        error
      );
    }
  }

  remove(
    key: string
  ): void {
    const fullKey =
      STORAGE_PREFIX + key;

    window.localStorage.removeItem(
      fullKey
    );
  }

  has(
    key: string
  ): boolean {
    const fullKey =
      STORAGE_PREFIX + key;

    return (
      window.localStorage.getItem(
        fullKey
      ) !== null
    );
  }
}

export const localStorageService =
  new LocalStorageService();