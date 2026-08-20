import { useRef, useState } from 'react';

import type { SoundAsset } from '../models/SoundAsset';
import { getSoundAssetPlaybackUrl } from '../models/SoundAsset';
import type { SoundObjectTemplate } from '../models/SoundObjectTemplate';

type PickerMode = 'sound' | 'template';

interface SoundPickerDialogProps {
  soundAssets: SoundAsset[];
  soundObjectTemplates: SoundObjectTemplate[];

  onCancel: () => void;

  onConfirmSound: (
    soundAsset: SoundAsset
  ) => void;
}

function SoundPickerDialog({
  soundAssets,
  soundObjectTemplates,
  onCancel,
  onConfirmSound,
}: SoundPickerDialogProps) {
  const audioRef =
    useRef<HTMLAudioElement | null>(null);

  const [mode, setMode] =
    useState<PickerMode>('sound');

  const [selectedCategory, setSelectedCategory] =
    useState<string | null>(null);

  const [selectedSubcategory, setSelectedSubcategory] =
    useState<string | null>(null);

  const [selectedSoundId, setSelectedSoundId] =
    useState<string | null>(null);

  const [isPreviewing, setIsPreviewing] =
    useState(false);

  const categories = Array.from(
    new Set(
      soundAssets.flatMap((asset) =>
        asset.categoryPaths
          .map((path) => path[0])
          .filter(
            (category): category is string =>
              Boolean(category)
          )
      )
    )
  ).sort();

  const subcategories =
    selectedCategory === null
      ? []
      : Array.from(
          new Set(
            soundAssets.flatMap((asset) =>
              asset.categoryPaths
                .filter(
                  (path) =>
                    path[0] === selectedCategory &&
                    path.length > 1
                )
                .map((path) => path[1])
                .filter(
                  (
                    subcategory
                  ): subcategory is string =>
                    Boolean(subcategory)
                )
            )
          )
        ).sort();

  const filteredSounds =
    selectedCategory === null
      ? []
      : soundAssets.filter((asset) =>
          asset.categoryPaths.some((path) => {
            if (path[0] !== selectedCategory) {
              return false;
            }

            if (selectedSubcategory === null) {
              return path.length === 1;
            }

            return (
              path[1] === selectedSubcategory
            );
          })
        );

  const selectedSound =
    soundAssets.find(
      (asset) => asset.id === selectedSoundId
    ) ?? null;

  function stopPreview() {
    if (!audioRef.current) {
      return;
    }

    audioRef.current.pause();
    audioRef.current.currentTime = 0;
    audioRef.current = null;

    setIsPreviewing(false);
  }

  async function handlePreview() {
    if (!selectedSound) {
      return;
    }

    stopPreview();

    const audio =
      new Audio(getSoundAssetPlaybackUrl(selectedSound));

    audioRef.current = audio;

    audio.onended = () => {
      audioRef.current = null;
      setIsPreviewing(false);
    };

    audio.onerror = () => {
      audioRef.current = null;
      setIsPreviewing(false);

      console.error(
        `Unable to preview sound: ${selectedSound.name}`
      );
    };

    try {
      await audio.play();
      setIsPreviewing(true);
    } catch (error) {
      audioRef.current = null;
      setIsPreviewing(false);

      console.error(error);
    }
  }

  function handleModeChange(
    newMode: PickerMode
  ) {
    stopPreview();

    setMode(newMode);
    setSelectedCategory(null);
    setSelectedSubcategory(null);
    setSelectedSoundId(null);
  }

  function handleCategorySelect(
    category: string
  ) {
    stopPreview();

    setSelectedCategory(category);
    setSelectedSubcategory(null);
    setSelectedSoundId(null);
  }

  function handleSubcategorySelect(
    subcategory: string
  ) {
    stopPreview();

    setSelectedSubcategory(subcategory);
    setSelectedSoundId(null);
  }

  function handleSoundSelect(
    soundId: string
  ) {
    stopPreview();
    setSelectedSoundId(soundId);
  }

  function handleCancel() {
    stopPreview();
    onCancel();
  }

  function handleConfirm() {
    if (
      mode !== 'sound' ||
      !selectedSound
    ) {
      return;
    }

    stopPreview();

    onConfirmSound(selectedSound);
  }

  return (
    <div className="dialog-backdrop">
      <div className="sound-picker-dialog">
        <div className="sound-picker-header">
          <h2>Choose Sound</h2>

          <div className="sound-picker-mode">
            <button
              className={
                mode === 'sound'
                  ? 'active'
                  : ''
              }
              onClick={() =>
                handleModeChange('sound')
              }
            >
              Sound Library
            </button>

            <button
              className={
                mode === 'template'
                  ? 'active'
                  : ''
              }
              onClick={() =>
                handleModeChange('template')
              }
            >
              Templates
            </button>
          </div>
        </div>

        <div className="sound-picker-browser">
          <div className="sound-picker-column">
            <div className="sound-picker-column-title">
              Categories
            </div>

            <div className="sound-picker-list">
              {mode === 'sound' &&
                categories.map((category) => (
                  <button
                    key={category}
                    className={[
                      'sound-picker-entry',
                      selectedCategory ===
                      category
                        ? 'selected'
                        : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() =>
                      handleCategorySelect(
                        category
                      )
                    }
                  >
                    {category}
                  </button>
                ))}
            </div>
          </div>

          <div className="sound-picker-column">
            <div className="sound-picker-column-title">
              Subcategories
            </div>

            <div className="sound-picker-list">
              {mode === 'sound' &&
                subcategories.map(
                  (subcategory) => (
                    <button
                      key={subcategory}
                      className={[
                        'sound-picker-entry',
                        selectedSubcategory ===
                        subcategory
                          ? 'selected'
                          : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      onClick={() =>
                        handleSubcategorySelect(
                          subcategory
                        )
                      }
                    >
                      {subcategory}
                    </button>
                  )
                )}
            </div>
          </div>

          <div className="sound-picker-column sound-picker-items">
            <div className="sound-picker-column-title">
              {mode === 'sound'
                ? 'Sounds'
                : 'Templates'}
            </div>

            <div className="sound-picker-list">
              {mode === 'sound' &&
                filteredSounds.map(
                  (asset) => (
                    <button
                      key={asset.id}
                      className={[
                        'sound-picker-entry',
                        selectedSoundId ===
                        asset.id
                          ? 'selected'
                          : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      onClick={() =>
                        handleSoundSelect(
                          asset.id
                        )
                      }
                    >
                      {asset.name}
                    </button>
                  )
                )}

              {mode === 'template' &&
                soundObjectTemplates.map(
                  (template) => (
                    <button
                      key={template.id}
                      className="sound-picker-entry"
                    >
                      {template.name}
                    </button>
                  )
                )}
            </div>
          </div>
        </div>

        <div className="sound-picker-footer">
          <div className="sound-picker-preview">
            <button
              disabled={!selectedSound}
              onClick={handlePreview}
            >
              Preview
            </button>

            <button
              disabled={!isPreviewing}
              onClick={stopPreview}
            >
              Stop
            </button>
          </div>

          <div className="sound-picker-actions">
            <button onClick={handleCancel}>
              Cancel
            </button>

            <button
              disabled={
                mode !== 'sound' ||
                !selectedSound
              }
              onClick={handleConfirm}
            >
              Confirm
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default SoundPickerDialog;
