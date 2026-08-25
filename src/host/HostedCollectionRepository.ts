import {
  moduleEventBus,
} from './ModuleBus';

export class HostedCollectionRepository {
  get hosted(): boolean {
    return moduleEventBus.hosted;
  }

  async loadAll<T>(
    collection: string
  ): Promise<T[]> {
    return moduleEventBus.request<T[]>(
      'storage.load',
      {
        collection,
      }
    );
  }

  async loadOne<T>(
    collection: string,
    key: string
  ): Promise<T | null> {
    return moduleEventBus.request<T | null>(
      'storage.load',
      {
        collection,
        key,
      }
    );
  }

  async save<T>(
    collection: string,
    key: string,
    data: T
  ): Promise<void> {
    await moduleEventBus.request(
      'storage.save',
      {
        collection,
        key,
        data,
      }
    );
  }

  async delete(
    collection: string,
    key: string
  ): Promise<boolean> {
    const result =
      await moduleEventBus.request<{
        deleted: boolean;
      }>(
        'storage.delete',
        {
          collection,
          key,
        }
      );

    return result.deleted;
  }
}

export const hostedCollectionRepository =
  new HostedCollectionRepository();