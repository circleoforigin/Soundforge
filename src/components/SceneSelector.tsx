import type { SceneInstance } from '../models/SceneInstance';

interface SceneSelectorProps {
  scene: SceneInstance;
  currentScene: SceneInstance | null;
  transitionTarget: SceneInstance | null;
  previewingTarget: boolean;
  projectScenes: SceneInstance[];

  onSceneChange: (scene: SceneInstance) => void;
  onSelectTransitionTarget: (instanceId: string) => void;
  onClearTransitionTarget: () => void;
  onPreviewTransitionTarget: () => void;
  onRevertPreview: () => void;
  onTransition: () => void;
}

function SceneSelector({
  scene,
  currentScene,
  transitionTarget,
  previewingTarget,
  projectScenes,
  onSceneChange,
  onSelectTransitionTarget,
  onClearTransitionTarget,
  onPreviewTransitionTarget,
  onRevertPreview,
  onTransition,
}: SceneSelectorProps) {

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

  return (
  <div className="scene-selector">

    <h2>{currentScene?.instanceName}</h2>

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

          <button onClick={onTransition}>
            Transition
          </button>
        </div>
      )}
    </div>

    <div className="scene-controls">
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
  </div>
);
}

export default SceneSelector;