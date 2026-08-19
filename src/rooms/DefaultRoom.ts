import type { Room } from '../models/Room';

export const headphonesRoom: Room = {
  id: 'builtin-headphones-room',
  name: 'Headphones',

  offset: {
    x: 0,
    y: 0,
  },

  width: 2,
  height: 1,

  speakers: [
    {
      speakerId: 'headphones-left',
      name: 'Left',

      position: {
        x: -1,
        y: 0,
      },
    },

    {
      speakerId: 'headphones-right',
      name: 'Right',

      position: {
        x: 1,
        y: 0,
      },
    },
  ],
};