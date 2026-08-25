import type { LoopingZoneSettings, SceneObjectInstance } from '../models/SceneObjectInstance';
import { DEFAULT_NODE_FADE_MS } from '../models/SceneObjectInstance';
import { createDefaultLoopingZone, normalizeLoopingZoneSettings } from '../audio/LoopingZoneScheduler';
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
  onAddLoopingZoneSound: () => void;
}

function NodeInspector({
  node,
  isAmbient,
  soundAssets,
  soundObjectTemplates,
  onNodeChange,
  onChooseSource,
  onAddLoopingZoneSound,
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
  const loopingZone = node.loopingZone?.enabled ? normalizeLoopingZoneSettings(node.loopingZone) : null;

  function updateLoopingZone(update: Partial<LoopingZoneSettings>) {
    if (!loopingZone) return;
    const next = normalizeLoopingZoneSettings({ ...loopingZone, ...update });
    onNodeChange({ ...node, loopingZone: next, soundAssetIds: next.assets.map((asset) => asset.assetId) });
  }

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

      {!loopingZone && (
        <div className="node-row">
          <label>Source</label>
          <button className="node-source-button" onClick={onChooseSource}>
            {selectedTemplate ? selectedTemplate.name : selectedSound ? selectedSound.originalFileName : 'Choose...'}
          </button>
        </div>
      )}

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

      <div className="node-behavior-controls">
        {!isAmbient && node.playbackMode === 'loop' && (
          <label className="node-checkbox">
            <input
              type="checkbox"
              checked={node.loopingZone?.enabled ?? false}
              onChange={(event) => onNodeChange({
                ...node,
                loopingZone: event.target.checked
                  ? { ...(node.loopingZone ?? createDefaultLoopingZone(node)), enabled: true }
                  : node.loopingZone ? { ...node.loopingZone, enabled: false } : undefined,
              })}
            />
            Enable Looping Zone
          </label>
        )}

        {loopingZone && (
          <div className="looping-zone-controls">
            <h4>Sounds</h4>
            {loopingZone.assets.map((zoneAsset, index) => {
              const asset = soundAssets.find((item) => item.id === zoneAsset.assetId);
              return (
                <div className="looping-zone-asset" key={`${zoneAsset.assetId}:${index}`}>
                  <div className="looping-zone-asset-header">
                    <span title={zoneAsset.assetId}>{asset?.name ?? 'Missing sound'}</span>
                    <button type="button" onClick={() => updateLoopingZone({
                      assets: loopingZone.assets.filter((_, itemIndex) => itemIndex !== index),
                    })}>Remove</button>
                  </div>
                  <label>Gain
                    <div className="node-gain-control looping-zone-gain-control">
                      <input type="range" min="-12" max="12" step="1" value={zoneAsset.gainDb}
                        onChange={(event) => updateLoopingZone({ assets: loopingZone.assets.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, gainDb: Number(event.target.value) } : item) })}
                      />
                      <span>{zoneAsset.gainDb > 0 ? '+' : ''}{zoneAsset.gainDb} dB</span>
                    </div>
                  </label>
                  <label>Weight
                    <input type="number" min="1" step="1" value={zoneAsset.weight}
                      onChange={(event) => updateLoopingZone({ assets: loopingZone.assets.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, weight: Math.max(1, Math.round(Number(event.target.value))) } : item) })}
                    />
                  </label>
                </div>
              );
            })}
            <button type="button" onClick={onAddLoopingZoneSound}>Add Sound</button>

            <h4>Zone</h4>
            <div className="looping-zone-paired-row">
              <label>Distance
                <input type="number" min="0" max="2" step="0.01" value={loopingZone.distanceRange}
                  onChange={(event) => updateLoopingZone({ distanceRange: Number(event.target.value) })} />
              </label>
              <label>Arc
                <span><input type="number" min="0" max="360" step="1" value={loopingZone.arcPositionDegrees}
                  onChange={(event) => updateLoopingZone({ arcPositionDegrees: Number(event.target.value) })} />°</span>
              </label>
            </div>

            <h4>Timing</h4>
            <div className="looping-zone-paired-row">
              <label>Frequency Min
                <span><input type="number" min="0.1" step="0.1" value={loopingZone.frequencyMinMs / 1000}
                  onChange={(event) => updateLoopingZone({ frequencyMinMs: Number(event.target.value) * 1000 })} /> s</span>
              </label>
              <label>Max
                <span><input type="number" min="0.1" step="0.1" value={loopingZone.frequencyMaxMs / 1000}
                  onChange={(event) => updateLoopingZone({ frequencyMaxMs: Number(event.target.value) * 1000 })} /> s</span>
              </label>
            </div>

            <h4>Pitch</h4>
            <div className="looping-zone-paired-row">
              <label>Pitch Min
                <span><input type="number" step="0.1" value={loopingZone.pitchMinSemitones}
                  onChange={(event) => updateLoopingZone({ pitchMinSemitones: Number(event.target.value) })} /> st</span>
              </label>
              <label>Max
                <span><input type="number" step="0.1" value={loopingZone.pitchMaxSemitones}
                  onChange={(event) => updateLoopingZone({ pitchMaxSemitones: Number(event.target.value) })} /> st</span>
              </label>
            </div>
            <p className="looping-zone-note">Pitch is saved but playback pitch is not supported yet.</p>

            <h4>Other</h4>
            <label>Max Concurrent
              <input type="number" min="1" step="1" value={loopingZone.maxConcurrent}
                onChange={(event) => updateLoopingZone({ maxConcurrent: Number(event.target.value) })} />
            </label>
            <label className="node-checkbox">
              <input type="checkbox" checked={loopingZone.avoidImmediateRepeat}
                onChange={(event) => updateLoopingZone({ avoidImmediateRepeat: event.target.checked })} />
              Avoid Immediate Repeat
            </label>
          </div>
        )}

        {(isAmbient || (node.playbackMode === 'loop' && !loopingZone)) && (
          <label className="node-checkbox">
            <input
              type="checkbox"
              checked={node.randomStart ?? false}
              onChange={(event) =>
                onNodeChange({
                  ...node,
                  randomStart: event.target.checked,
                })
              }
            />
            Random Start
          </label>
        )}

        <label className="node-checkbox">
          <input
            type="checkbox"
            checked={node.onLoad ?? isAmbient}
            onChange={(event) =>
              onNodeChange({
                ...node,
                onLoad: event.target.checked,
              })
            }
          />
          On Load
        </label>

        <label className="node-checkbox">
          <input
            type="checkbox"
            checked={node.excludeFromBulkControls ?? false}
            onChange={(event) =>
              onNodeChange({
                ...node,
                excludeFromBulkControls: event.target.checked,
              })
            }
          />
          Exclude from Bulk Controls
        </label>

        <div className="node-fade-row">
          <label className="node-checkbox">
            <input
              type="checkbox"
              checked={node.fadeInEnabled ?? false}
              onChange={(event) =>
                onNodeChange({
                  ...node,
                  fadeInEnabled: event.target.checked,
                })
              }
            />
            Fade In
          </label>
          <input
            type="number"
            min="0"
            aria-label="Fade in milliseconds"
            disabled={!(node.fadeInEnabled ?? false)}
            value={node.fadeInMs ?? DEFAULT_NODE_FADE_MS}
            onChange={(event) =>
              onNodeChange({
                ...node,
                fadeInMs: Math.max(0, Number(event.target.value)),
              })
            }
          />
          <span>ms</span>
        </div>

        <div className="node-fade-row">
          <label className="node-checkbox">
            <input
              type="checkbox"
              checked={node.fadeOutEnabled ?? false}
              onChange={(event) =>
                onNodeChange({
                  ...node,
                  fadeOutEnabled: event.target.checked,
                })
              }
            />
            Fade Out
          </label>
          <input
            type="number"
            min="0"
            aria-label="Fade out milliseconds"
            disabled={!(node.fadeOutEnabled ?? false)}
            value={node.fadeOutMs ?? DEFAULT_NODE_FADE_MS}
            onChange={(event) =>
              onNodeChange({
                ...node,
                fadeOutMs: Math.max(0, Number(event.target.value)),
              })
            }
          />
          <span>ms</span>
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
