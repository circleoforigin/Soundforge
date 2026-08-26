import {
  moduleEventBus,
} from './ModuleBus';

interface SavedFileResult {
  folder: string;
  fileName: string;
}

interface DeletedFileResult {
  deleted: boolean;
  folder: string;
  fileName: string;
}

export class HostedFileRepository {
  async save(
    folder: string,
    fileName: string,
    bytes: number[]
  ): Promise<SavedFileResult> {
    return moduleEventBus.request<SavedFileResult>(
      'file.save',
      {
        folder,
        fileName,
        bytes,
      }
    );
  }

  async read(
    folder: string,
    fileName: string
  ): Promise<number[] | null> {
    return moduleEventBus.request<
      number[] | null
    >(
      'file.read',
      {
        folder,
        fileName,
      }
    );
  }

  async delete(
    folder: string,
    fileName: string
  ): Promise<boolean> {
    const result =
      await moduleEventBus.request<
        DeletedFileResult
      >(
        'file.delete',
        {
          folder,
          fileName,
        }
      );

    return result.deleted;
  }

  async saveFile(
    folder: string,
    fileName: string,
    file: File
  ): Promise<SavedFileResult> {
    const buffer =
      await file.arrayBuffer();

    const bytes =
      Array.from(
        new Uint8Array(buffer)
      );

    return this.save(
      folder,
      fileName,
      bytes
    );
  }

  async readBlob(
    folder: string,
    fileName: string,
    mimeType = 'application/octet-stream'
  ): Promise<Blob | null> {
    const bytes =
      await this.read(
        folder,
        fileName
      );

    if (!bytes) {
      return null;
    }

    return new Blob(
      [
        new Uint8Array(
          bytes
        ),
      ],
      {
        type: mimeType,
      }
    );
  }
}

export const hostedFileRepository =
  new HostedFileRepository();