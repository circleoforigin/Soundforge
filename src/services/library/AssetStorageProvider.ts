export interface StoredAssetLocation {
  path: string;
  url?: string;
}

export interface AssetStorageProvider {
  uploadAudio(
    assetId: string,
    file: File
  ): Promise<StoredAssetLocation>;

  deleteAudio(
    assetId: string
  ): Promise<void>;
}