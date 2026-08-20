import { useEffect, useRef, useState } from 'react';

import type { SceneInstance } from '../models/SceneInstance';
import type { SceneObjectInstance } from '../models/SceneObjectInstance';
import {
  nodeIsExcludedFromBulkControls,
  nodeIsDeployed,
  nodeStartsOnLoad,
} from '../models/SceneObjectInstance';
import type { SoundObjectTemplate } from '../models/SoundObjectTemplate';
import type { SoundAsset } from '../models/SoundAsset';
import type { Room } from '../models/Room';
import type { SpeakerMap } from '../models/SpeakerMap';

import SceneSelector from './SceneSelector';
import SoundStage, { type SoundStageHandle } from './SoundStage';
import NodeInspector from './NodeInspector';
import SoundPickerDialog from './SoundPickerDialog';

interface SceneWorkspaceProps {
  scene: SceneInstance;
  currentScene: SceneInstance | null;
  transitionTarget: SceneInstance | null;
  previewingTarget: boolean;
  transitionInProgress: boolean;
  currentSceneDirty: boolean;
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
  transitionInProgress,
  currentSceneDirty,
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
  const soundStageRef = useRef<SoundStageHandle>(null);
  const loadedSceneIdRef = useRef<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] =
    useState<string | null>(null);
  const [selectedNodeSourceId, setSelectedNodeSourceId] =
    useState<string | null>(null);

  function handleSelectedNodeChange(
    instanceId: string | null,
    sourceNodeId?: string
  ) {
    setSelectedNodeId(instanceId);
    setSelectedNodeSourceId(sourceNodeId ?? null);
  }
  const persistentDeployedNodes = currentScene
    ? (currentScene.deployedObjects ?? []).flatMap((deployment) => {
        const sourceNode = currentScene.positionalObjects.find(
          (node) => node.instanceId === deployment.sourceNodeId
        );

        return sourceNode
          ? [{
              ...sourceNode,
              instanceId: deployment.instanceId,
              placement: 'field' as const,
              position: deployment.position,
            }]
          : [];
      })
    : [];
  useEffect(() => {
    if (selectedNodeId !== null) {
      const activeElement = document.activeElement;

      if (activeElement instanceof HTMLElement) {
        activeElement.blur();
      }
    }
  }, [selectedNodeId]);
  useEffect(() => {
    if (!currentScene) {
      loadedSceneIdRef.current = null;
      return;
    }

    if (loadedSceneIdRef.current === currentScene.instanceId) {
      return;
    }

    loadedSceneIdRef.current = currentScene.instanceId;

    const onLoadNodes = [
      ...currentScene.positionalObjects.filter(
        (node) => nodeIsDeployed(node) && nodeStartsOnLoad(node, false)
      ),
      ...persistentDeployedNodes.filter((node) =>
        nodeStartsOnLoad(node, false)
      ),
      ...currentScene.ambientObjects.filter((node) =>
        nodeStartsOnLoad(node, true)
      ),
    ];

    void soundStageRef.current?.startNodes(onLoadNodes);
  });
  const [showSoundPicker, setShowSoundPicker] =
    useState(false);
  const selectedNode =
    scene.positionalObjects.find(
      (node) => node.instanceId === selectedNodeId
    ) ??
    scene.ambientObjects.find(
      (node) => node.instanceId === selectedNodeId
    ) ??
    scene.positionalObjects.find(
      (node) => node.instanceId === selectedNodeSourceId
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

      playbackMode: selectedNodeIsAmbient
        ? 'loop'
        : selectedNode.playbackMode,

      templateId: undefined,
    });

    setShowSoundPicker(false);
  }

  function getPlaybackNodes(
    group: 'all' | 'loop' | 'ambience',
    action: 'start' | 'pause'
  ) {
    if (!currentScene) {
      return [];
    }

    const loopingNodes = currentScene.positionalObjects.filter(
      (node) =>
        nodeIsDeployed(node) && node.playbackMode === 'loop'
    );
    const deployedLoopingNodes = persistentDeployedNodes.filter(
      (node) => node.playbackMode === 'loop'
    );
    const allLoopingNodes = [...loopingNodes, ...deployedLoopingNodes];

    if (group === 'loop') {
      return allLoopingNodes.filter(
        (node) => !nodeIsExcludedFromBulkControls(node)
      );
    }

    const ambienceNodes = currentScene.ambientObjects.filter(
      (node) =>
        action === 'pause' || node.playbackMode === 'loop'
    );

    if (group === 'ambience') {
      return ambienceNodes.filter(
        (node) => !nodeIsExcludedFromBulkControls(node)
      );
    }

    return [...allLoopingNodes, ...ambienceNodes].filter(
      (node) => !nodeIsExcludedFromBulkControls(node)
    );
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
          transitionInProgress={transitionInProgress}
          sceneDirty={currentSceneDirty}
          projectScenes={projectScenes}
          onSceneChange={onSceneChange}
          onSelectTransitionTarget={onSelectTransitionTarget}
          onClearTransitionTarget={onClearTransitionTarget}
          onPreviewTransitionTarget={onPreviewTransitionTarget}
          onRevertPreview={onRevertPreview}
          onTransition={onTransition}
          onStartPlayback={(group) => {
            void soundStageRef.current?.startNodes(
              getPlaybackNodes(group, 'start')
            );
          }}
          onPausePlayback={(group) => {
            soundStageRef.current?.pauseNodes(
              getPlaybackNodes(group, 'pause')
            );
          }}
        />
      )}

      <div className="scene-content">
        <SoundStage
          ref={soundStageRef}
          scene={scene}
          onSceneChange={onSceneChange}
          selectedNodeId={selectedNodeId}
          onSelectedNodeChange={handleSelectedNodeChange}
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
