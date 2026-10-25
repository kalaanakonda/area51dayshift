/**
 * The six weapons (keys 1–6). Every craft can carry them; bots fly a
 * three-weapon loadout per style and switch by range.
 *
 *   1 Laser    hitscan beam, long reach, heats up            (style colour)
 *   2 Plasma   eight fat bolts in a cone — point-blank, brutal
 *   3 Seekers  pairs of missiles that home for a few seconds after lock-on,
 *              then fall ballistic
 *   4 Fire     a cone of burning plasma that keeps burning after it hits
 *   5 Arc      lightning that jumps to up to three more craft and stuns
 *   6 Cannon   rapid tracer rounds that drop under gravity and drift with
 *              the wind
 *
 * Bot ranges: min / optimal / max (metres) for picking a weapon and an
 * engagement distance.
 */
export const WEAPONS = {
  laser: {
    id: 'laser',
    key: 1,
    name: 'Laser',
    range: 1400,
    dmg: 8,
    rate: 5.5,
    heatPer: 0.07,
    cool: 0.36,
    overheat: 2.2,
    life: 0.11,
    cone: 0.32,
    bot: [90, 650, 1300],
  },
  plasma: {
    id: 'plasma',
    key: 2,
    name: 'Plasma',
    range: 200,
    dmg: 15,
    pellets: 8,
    rate: 1.0,
    speed: 330,
    spread: 0.075,
    color: [1.4, 0.45, 2.3],
    cone: 0.55,
    bot: [0, 70, 170],
  },
  missile: {
    id: 'missile',
    key: 3,
    name: 'Seekers',
    range: 1700,
    dmg: 40,
    splash: 24,
    rate: 0.45,
    salvo: 2,
    speed: 330,
    turn: 2.6,
    seek: 4.0,
    life: 7.5,
    lockTime: 0.7,
    lockCone: 0.17,
    cone: 0.9,
    bot: [250, 800, 1600],
  },
  fire: {
    id: 'fire',
    key: 4,
    name: 'Fire',
    range: 115,
    dps: 48,
    burnDps: 7,
    burnTime: 4,
    cone: 0.24,
    drain: 0.24,
    regen: 0.12,
    bot: [0, 55, 110],
  },
  arc: {
    id: 'arc',
    key: 5,
    name: 'Arc',
    range: 380,
    dmg: 26,
    chain: 3,
    hop: 170,
    falloff: 0.65,
    rate: 0.8,
    stun: 0.7,
    cone: 0.12,
    color: [0.55, 0.75, 1.6],
    bot: [40, 200, 360],
  },
  cannon: {
    id: 'cannon',
    key: 6,
    name: 'Cannon',
    range: 900,
    dmg: 5,
    rate: 11,
    speed: 560,
    spread: 0.009,
    drag: 0.1,
    life: 2.6,
    color: [2.6, 1.45, 0.45],
    cone: 0.35,
    bot: [60, 320, 800],
  },
};

export const ORDER = ['laser', 'plasma', 'missile', 'fire', 'arc', 'cannon'];

/** Small glyphs for the HUD and kill feed. */
export const GLYPH = { laser: '━', plasma: '✺', missile: '➶', fire: '♨', arc: 'ϟ', cannon: '⁘', crash: '✕', burn: '♨' };
