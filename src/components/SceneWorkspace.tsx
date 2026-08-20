import { useEffect, useState } from 'react';

import type { SceneInstance } from '../models/SceneInstance';
import type { SceneObjectInstance } from '../models/SceneObjectInstance';
import type { SoundObjectTemplate } from '../models/SoundObjectTemplate';
import type { SoundAsset } from '../models/SoundAsset';
import type { Room } from '../models/Room';
import type { SpeakerMap } from '../models/SpeakerMap';

import SceneSelector from './SceneSelector';
import SoundStage from './SoundStage';
import NodeInspector from './NodeInspector';
import SoundPickerDialog from './SoundPickerDialog';

interface SceneWorkspaceProps {
  scene: SceneInstance;
  currentScene: SceneInstance | null;
  transitionTarget: SceneInstance | null;
  previewingTarget: boolean;
  projectScenes: SceneInstance[];
  soundObjectTemplates: SoundObjectTemplate[];
  soundAssets: SoundAsset[];
  activeRoom: Room | null;
  activeSpeakerMap: SpeakerMap;

  onSceneChange: (scene: SceneInstance) => void;
  onSelectTransitionTarget: (instanceId: string) => void;
  onClearTransitionTarget: () => void;
  onPreviewTransitionTarget: () => void;
  onRevertPreview: () => void;
  onTransition: () => void;
  
  onRoomChange: (room: Room) => void;
}

function SceneWorkspace({
  scene,
  currentScene,
  transitionTarget,
  previewingTarget,
  projectScenes,
  soundObjectTemplates,
  soundAssets,
  activeRoom,
  activeSpeakerMap,
  onSceneChange,
  onSelectTransitionTarget,
  onClearTransitionTarget,
  onPreviewTransitionTarget,
  onRevertPreview,
  onTransition,
  onRoomChange,
}: SceneWorkspaceProps) {
  const [selectedNodeId, setSelectedNodeId] =
    useState<string | null>(null);
  useEffect(() => {
    if (selectedNodeId !== null) {
      const activeElement = document.activeElement;

      if (activeElement instanceof HTMLElement) {
        activeElement.blur();
      }
    }
  }, [selectedNodeId]);
  const [showSoundPicker, setShowSoundPicker] =
    useState(false);
  const selectedNode =
    scene.positionalObjects.find(
      (node) => node.instanceId === selectedNodeId
    ) ??
    scene.ambientObjects.find(
      (node) => node.instanceId === selectedNodeId
    ) ??
    null;

  const selectedNodeIsAmbient =
    selectedNode !== null &&
    scene.ambientObjects.some(
      (node) => node.instanceId === selectedNode.instanceId
    );

  function handleNodeChange(
    updatedNode: SceneObjectInstance
    ) {
    onSceneChange({
      ...scene,

      positionalObjects:
        scene.positionalObjects.map((node) =>
          node.instanceId === updatedNode.instanceId
            ? updatedNode
            : node
        ),

      ambientObjects:
        scene.ambientObjects.map((node) =>
          node.instanceId === updatedNode.instanceId
            ? updatedNode
            : node
        ),
    });
  }

  function handleConfirmSound(
    soundAsset: SoundAsset
  ) {
    if (!selectedNode) {
      return;
    }

    handleNodeChange({
      ...selectedNode,

      instanceName:
        selectedNode.instanceName ===
          'New Sound' ||
        !selectedNode.instanceName
          ? soundAsset.name
          : selectedNode.instanceName,

      soundAssetIds: [
        soundAsset.id,
      ],

      playbackMode: 'oneShot',

      templateId: undefined,
    });

    setShowSoundPicker(false);
  }

  return (
  <>
    <div className="scene-workspace">
      {selectedNode ? (
        <NodeInspector
          node={selectedNode}
          soundAssets={soundAssets}
          isAmbient={selectedNodeIsAmbient}
          soundObjectTemplates={soundObjectTemplates}
          onNodeChange={handleNodeChange}
          onChooseSource={() => setShowSoundPicker(true)}
        />
      ) : (
        <SceneSelector
          scene={scene}
          currentScene={currentScene}
          transitionTarget={transitionTarget}
          previewingTarget={previewingTarget}
          projectScenes={projectScenes}
          onSceneChange={onSceneChange}
          onSelectTransitionTarget={onSelectTransitionTarget}
          onClearTransitionTarget={onClearTransitionTarget}
          onPreviewTransitionTarget={onPreviewTransitionTarget}
          onRevertPreview={onRevertPreview}
          onTransition={onTransition}
        />
      )}

      <div className="scene-content">
        <SoundStage
          scene={scene}
          onSceneChange={onSceneChange}
          selectedNodeId={selectedNodeId}
          onSelectedNodeChange={setSelectedNodeId}
          soundAssets={soundAssets}
          activeRoom={activeRoom}
          activeSpeakerMap={activeSpeakerMap}
          onRoomChange={onRoomChange}
        />
      </div>
    </div>

    {showSoundPicker && (
      <SoundPickerDialog
        soundAssets={soundAssets}
        soundObjectTemplates={
          soundObjectTemplates
        }
        onCancel={() =>
          setShowSoundPicker(false)
        }
        onConfirmSound={
          handleConfirmSound
        }
      />
    )}
  </>
);
}

export default SceneWorkspace;