import type { SceneObjectInstance } from '../models/SceneObjectInstance';
import type { SoundObjectTemplate } from '../models/SoundObjectTemplate';
import type { SoundAsset } from '../models/SoundAsset';

interface NodeInspectorProps {
  node: SceneObjectInstance;
  isAmbient: boolean;
  soundAssets: SoundAsset[];
  soundObjectTemplates: SoundObjectTemplate[];

  onNodeChange: (
    updatedNode: SceneObjectInstance
  ) => void;

  onChooseSource: () => void;
}

function NodeInspector({
  node,
  isAmbient,
  soundAssets,
  soundObjectTemplates,
  onNodeChange,
  onChooseSource,
}: NodeInspectorProps) {
  const selectedTemplate =
    soundObjectTemplates.find(
      (template) => template.id === node.templateId
    ) ?? null;

  const selectedSound =
    node.soundAssetIds.length > 0
        ? soundAssets.find(
            (asset) =>
                asset.id === node.soundAssetIds[0]
        ) ?? null
    : null;

  return (
    <div className="scene-selector node-inspector">
      <div className="node-row">
        <label>Name</label>

        <input
          type="text"
          value={node.instanceName ?? ''}
          onChange={(event) =>
            onNodeChange({
              ...node,
              instanceName: event.target.value,
            })
          }
        />
      </div>

      <div className="node-row">
        <label>Source</label>

        <button
          className="node-source-button"
          onClick={onChooseSource}
        >
          {selectedTemplate
            ? selectedTemplate.name
            : selectedSound
                ? selectedSound.originalFileName
                : 'Choose...'}
        </button>
      </div>

      <div className="node-row split">
        <div>
          <span className="node-label">Type</span>
          <span>
            {isAmbient ? 'Ambient' : 'Positional'}
          </span>
        </div>

        <label className="node-checkbox">
          <input
            type="checkbox"
            checked={node.muted}
            onChange={(event) =>
              onNodeChange({
                ...node,
                muted: event.target.checked,
              })
            }
          />
          Muted
        </label>
      </div>

      <div className="node-row">
        <label>Gain</label>

        <div className="node-gain-control">
            <input
            type="range"
            min="-12"
            max="12"
            step="1"
            value={node.gainDb ?? 0}
            onChange={(event) =>
                onNodeChange({
                ...node,
                gainDb: Number(event.target.value),
                })
            }
            />

            <span>
                {(node.gainDb ?? 0) > 0 ? '+' : ''}
                {node.gainDb ?? 0} dB
            </span>
        </div>
      </div>

      {selectedTemplate && (
        <div className="node-row split">
          <div>
            <span className="node-label">
              Playback
            </span>
            <span>
              {selectedTemplate.playbackMode === 'oneShot'
                ? 'One Shot'
                : 'Loop'}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export default NodeInspector;