import { useState } from 'react';

import type {
  SceneInstance,
  SceneTransitionMode,
} from '../models/SceneInstance';
import type { SoundAsset } from '../models/SoundAsset';

export type ScenePlaybackGroup = 'all' | 'loop' | 'ambience';

interface SceneSelectorProps {
  scene: SceneInstance;
  currentScene: SceneInstance | null;
  transitionTarget: SceneInstance | null;
  previewingTarget: boolean;
  transitionInProgress: boolean;
  sceneDirty: boolean;
  projectScenes: SceneInstance[];
  soundAssets: SoundAsset[];

  onSceneChange: (scene: SceneInstance) => void;
  onSelectTransitionTarget: (instanceId: string) => void;
  onClearTransitionTarget: () => void;
  onPreviewTransitionTarget: () => void;
  onRevertPreview: () => void;
  onTransition: () => void;
  onStartPlayback: (group: ScenePlaybackGroup) => void;
  onPausePlayback: (group: ScenePlaybackGroup) => void;
  onChooseOnLoadOneShot: () => void;
}

function SceneSelector({
  scene,
  currentScene,
  transitionTarget,
  previewingTarget,
  transitionInProgress,
  sceneDirty,
  projectScenes,
  soundAssets,
  onSceneChange,
  onSelectTransitionTarget,
  onClearTransitionTarget,
  onPreviewTransitionTarget,
  onRevertPreview,
  onTransition,
  onStartPlayback,
  onPausePlayback,
  onChooseOnLoadOneShot,
}: SceneSelectorProps) {
  const [invalidSceneNameDraft, setInvalidSceneNameDraft] =
    useState<{ instanceId: string; value: string } | null>(null);
  const [transitionModeMenuOpen, setTransitionModeMenuOpen] =
    useState(false);

  function handleSceneNameChange(
    value: string
  ) {
    if (!currentScene) {
      return;
    }

    if (!value.trim()) {
      setInvalidSceneNameDraft({
        instanceId: currentScene.instanceId,
        value,
      });
      return;
    }

    setInvalidSceneNameDraft(null);
    onSceneChange({
      ...currentScene,
      instanceName: value,
    });
  }

  function handleSceneNameBlur() {
    if (!currentScene) {
      return;
    }

    const sceneName = invalidSceneNameDraft?.instanceId === currentScene.instanceId
      ? invalidSceneNameDraft.value
      : currentScene.instanceName;
    const trimmedName = sceneName.trim();

    if (!trimmedName) {
      setInvalidSceneNameDraft(null);
      return;
    }

    setInvalidSceneNameDraft(null);

    if (
      trimmedName !==
      currentScene.instanceName
    ) {
      onSceneChange({
        ...currentScene,
        instanceName: trimmedName,
      });
    }
  }

  function updateVolume(
    type: keyof SceneInstance['volume'],
    value: number
  ) {
    onSceneChange({
      ...scene,
      volume: {
        ...scene.volume,
        [type]: value,
      },
    });
  }

  function setTransitionMode(mode: SceneTransitionMode) {
    if (!currentScene) {
      return;
    }

    onSceneChange({
      ...currentScene,
      transitionMode: mode,
    });
    setTransitionModeMenuOpen(false);
  }

  const transitionMode =
    currentScene?.transitionMode ?? 'crossfade';
  const transitionModeLabels: Record<SceneTransitionMode, string> = {
    crossfade: 'Crossfade',
    sequential: 'Fade Out → Fade In',
    immediate: 'Immediate',
  };
  const onLoadOneShotAsset = soundAssets.find(
    (asset) => asset.id === currentScene?.onLoadOneShotAssetId
  ) ?? null;
  const displayedSceneName = currentScene
    && invalidSceneNameDraft?.instanceId === currentScene.instanceId
    ? invalidSceneNameDraft.value
    : currentScene?.instanceName ?? '';

  return (
  <div className="scene-selector">

    <div className="scene-name-row">
      <input
        className="scene-name-input"
        type="text"
        aria-label="Scene name"
        value={displayedSceneName}
        onChange={(event) =>
          handleSceneNameChange(
            event.target.value
          )
        }
        onBlur={handleSceneNameBlur}
      />

      {sceneDirty && (
        <span
          className="scene-dirty-indicator"
          title="Unsaved changes"
          aria-label="Unsaved changes"
        >
          *
        </span>
      )}
    </div>

    <textarea
      className="scene-description-input"
      aria-label="Scene description"
      placeholder="Scene description..."
      value={currentScene?.description ?? ''}
      onChange={(event) => {
        if (currentScene) {
          onSceneChange({
            ...currentScene,
            description: event.target.value,
          });
        }
      }}
    />

    <div className="scene-on-load-one-shot">
      <span>On Load One-Shot</span>
      <div>
        <button type="button" onClick={onChooseOnLoadOneShot} disabled={!currentScene}>
          {onLoadOneShotAsset?.name ?? (currentScene?.onLoadOneShotAssetId ? 'Missing sound' : 'Choose sound...')}
        </button>
        <button
          type="button"
          disabled={!currentScene?.onLoadOneShotAssetId}
          onClick={() => currentScene && onSceneChange({
            ...currentScene,
            onLoadOneShotAssetId: undefined,
          })}
        >
          Clear
        </button>
      </div>
    </div>

    <div className="transition-target">

      <select
        value={transitionTarget?.instanceId ?? ''}
        onChange={(event) =>
          onSelectTransitionTarget(event.target.value)
        }
      >
        <option value="">Transition Target...</option>

        {projectScenes
          .filter(
            (projectScene) =>
              projectScene.instanceId !== currentScene?.instanceId
          )
          .map((projectScene) => (
            <option
              key={projectScene.instanceId}
              value={projectScene.instanceId}
            >
              {projectScene.instanceName}
            </option>
          ))}
      </select>

      {transitionTarget && (
        <div className="transition-buttons">
          <button onClick={onClearTransitionTarget}>
            Clear
          </button>

          <button
            onClick={
              previewingTarget
                ? onRevertPreview
                : onPreviewTransitionTarget
            }
          >
            {previewingTarget ? 'Revert' : 'Preview'}
          </button>

          <div className="transition-split-button">
            <button
              className="transition-primary"
              onClick={onTransition}
              disabled={transitionInProgress}
              title={`Transition mode: ${transitionModeLabels[transitionMode]}`}
            >
              Transition
            </button>

            <button
              className="transition-mode-toggle"
              aria-label="Select transition mode"
              aria-expanded={transitionModeMenuOpen}
              onClick={() =>
                setTransitionModeMenuOpen((open) => !open)
              }
            >
              ▾
            </button>

            {transitionModeMenuOpen && (
              <div className="transition-mode-menu">
                {(
                  Object.keys(transitionModeLabels) as SceneTransitionMode[]
                ).map((mode) => (
                  <button
                    key={mode}
                    className={mode === transitionMode ? 'selected' : ''}
                    onClick={() => setTransitionMode(mode)}
                  >
                    {transitionModeLabels[mode]}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>

    <div className="scene-fade-controls">
      <span className="fade-heading">Fade</span>

      <label>
        <span>In</span>
        <input
          type="number"
          min="0"
          value={scene.fadeInMs}
          onChange={(event) =>
            onSceneChange({
              ...scene,
              fadeInMs: Number(event.target.value),
            })
          }
        />
      </label>

      <label>
        <span>Out</span>
        <input
          type="number"
          min="0"
          value={scene.fadeOutMs}
          onChange={(event) =>
            onSceneChange({
              ...scene,
              fadeOutMs: Number(event.target.value),
            })
          }
        />
      </label>

      <span className="fade-unit">ms</span>
    </div>

    <div className="scene-volume-section">
    <div className="scene-controls">
      <div className="scene-control-group">
        <div className="scene-control compact">
        <span>Master</span>

        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={scene.volume.master}
          onChange={(event) =>
            updateVolume('master', Number(event.target.value))
          }
        />

        <span>{Math.round(scene.volume.master * 100)}%</span>
        </div>
        <div className="scene-playback-buttons">
          <button onClick={() => onStartPlayback('all')}>Start All</button>
          <button onClick={() => onPausePlayback('all')}>Pause All</button>
        </div>
      </div>

      <div className="scene-control compact">
        <span>One-Shot</span>

        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={scene.volume.oneShot}
          onChange={(event) =>
            updateVolume('oneShot', Number(event.target.value))
          }
        />

        <span>{Math.round(scene.volume.oneShot * 100)}%</span>
      </div>

      <div className="scene-control-group">
        <div className="scene-control compact">
        <span>Loop</span>

        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={scene.volume.loop}
          onChange={(event) =>
            updateVolume('loop', Number(event.target.value))
          }
        />

        <span>{Math.round(scene.volume.loop * 100)}%</span>
        </div>
        <div className="scene-playback-buttons">
          <button onClick={() => onStartPlayback('loop')}>Start Looping</button>
          <button onClick={() => onPausePlayback('loop')}>Pause Looping</button>
        </div>
      </div>

      <div className="scene-control-group">
        <div className="scene-control compact">
        <span>Ambience</span>

        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={scene.volume.ambience}
          onChange={(event) =>
            updateVolume('ambience', Number(event.target.value))
          }
        />

        <span>{Math.round(scene.volume.ambience * 100)}%</span>
        </div>
        <div className="scene-playback-buttons">
          <button onClick={() => onStartPlayback('ambience')}>Start Ambience</button>
          <button onClick={() => onPausePlayback('ambience')}>Pause Ambience</button>
        </div>
      </div>
    </div>
    </div>
  </div>
);
}

export default SceneSelector;
