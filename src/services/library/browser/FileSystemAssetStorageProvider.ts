import type {
  AssetStorageProvider,
  StoredAssetLocation,
} from '../AssetStorageProvider';

function getFileExtension(file: File): string {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  return /^[a-z0-9]{1,10}$/.test(extension) ? `.${extension}` : '';
}

export class FileSystemAssetStorageProvider
  implements AssetStorageProvider
{
  private readonly directoryHandle: FileSystemDirectoryHandle;

  constructor(directoryHandle: FileSystemDirectoryHandle) {
    this.directoryHandle = directoryHandle;
  }

  async uploadAudio(
    assetId: string,
    file: File
  ): Promise<StoredAssetLocation> {
    const audioDirectory = await this.directoryHandle.getDirectoryHandle(
      'Audio',
      { create: true }
    );
    const managedFileName = `${assetId}${getFileExtension(file)}`;
    const fileHandle = await audioDirectory.getFileHandle(
      managedFileName,
      { create: true }
    );
    const writable = await fileHandle.createWritable();

    try {
      await writable.write(file);
    } finally {
      await writable.close();
    }

    return { path: `Audio/${managedFileName}` };
  }

  async resolveAudio(path: string): Promise<string> {
    return URL.createObjectURL(await this.readAudio(path));
  }

  async readAudio(path: string): Promise<File> {
    const [directoryName, fileName] = path.split('/');

    if (directoryName !== 'Audio' || !fileName) {
      throw new Error(`Invalid managed audio path: ${path}`);
    }

    const audioDirectory = await this.directoryHandle.getDirectoryHandle(
      directoryName
    );
    const fileHandle = await audioDirectory.getFileHandle(fileName);
    return fileHandle.getFile();
  }

  async deleteAudio(assetId: string): Promise<void> {
    const audioDirectory = await this.directoryHandle.getDirectoryHandle('Audio');

    for await (const name of audioDirectory.keys()) {
      if (name === assetId || name.startsWith(`${assetId}.`)) {
        await audioDirectory.removeEntry(name);
      }
    }
  }
}
