export interface RoomSpeakerPosition {
  speakerId: string;
  name: string;

  position: {
    x: number;
    y: number;
  };
}

export interface Room {
  id: string;
  name: string;

  /**
   * Offset of the Room beneath the fixed SoundStage.
   */
  offset: {
    x: number;
    y: number;
  };

  /**
   * Visual dimensions only.
   * These are not real-world feet/meters.
   */
  width: number;
  height: number;

  speakers: RoomSpeakerPosition[];
  speakerMapId?: string;
}