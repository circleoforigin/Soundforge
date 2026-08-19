import type { LibraryManifest } from './LibraryManifest';
import type { SoundAsset } from '../../models/SoundAsset';

function normalizeSoundAsset(raw: unknown): SoundAsset | null {
  if (
    typeof raw !== 'object' ||
    raw === null
  ) {
    return null;
  }

  const asset = raw as Partial<SoundAsset>;

  if (
    typeof asset.id !== 'string' ||
    typeof asset.name !== 'string' ||
    !asset.source ||
    typeof asset.source.path !== 'string'
  ) {
    return null;
  }

  return {
    id: asset.id,
    name: asset.name,

    createdAt:
      asset.createdAt instanceof Date
        ? asset.createdAt
        : new Date(asset.createdAt ?? Date.now()),

    updatedAt:
      asset.updatedAt instanceof Date
        ? asset.updatedAt
        : new Date(asset.updatedAt ?? Date.now()),

    categoryPaths:
      Array.isArray(asset.categoryPaths)
        ? asset.categoryPaths
        : [],

    tags:
      Array.isArray(asset.tags)
        ? asset.tags
        : [],

    source: {
      type:
        asset.source.type === 'local'
          ? 'local'
          : 'url',

      path: asset.source.path,
    },

    durationMs:
      typeof asset.durationMs === 'number'
        ? asset.durationMs
        : undefined,
  };
}

export function normalizeLibraryManifest(
  raw: unknown
): LibraryManifest {
  if (
    typeof raw !== 'object' ||
    raw === null
  ) {
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      assets: [],
    };
  }

  const manifest =
    raw as Partial<LibraryManifest>;

  const rawAssets =
    Array.isArray(manifest.assets)
      ? manifest.assets
      : [];

  const assets = rawAssets
    .map(normalizeSoundAsset)
    .filter(
      (asset): asset is SoundAsset =>
        asset !== null
    );

  return {
    version:
      typeof manifest.version === 'number'
        ? manifest.version
        : 1,

    updatedAt:
      typeof manifest.updatedAt === 'string'
        ? manifest.updatedAt
        : new Date().toISOString(),

    assets,
  };
}