/**
 * ASSET MANIFEST — the contract between BlendKit (Blender) and the runtime.
 *
 * Every asset below has a procedural fallback, so the film is fully watchable
 * with an empty /public/assets folder. Drop a GLB at `file`, run
 * `npm run assets:index` (or restart `npm run dev`), and the runtime swaps the
 * fallback for your asset automatically — no code changes, as long as the node
 * names listed in `nodes` exist.
 *
 * Units: 1 unit = 1 metre. Up axis: +Y in glTF (Blender +Z; the glTF exporter
 * converts). Forward: the side a viewer faces is -Z in glTF (Blender +Y).
 *
 * NODE NAMING CONVENTIONS (case-sensitive, exported as glTF node names)
 *   socket_*   Empty. Where a hand goes. Origin = contact point.
 *              Orientation (glTF): -Z = finger direction, +Y = back of hand
 *              (Blender: +Y = fingers, +Z = back of hand). Suffix _L/_R.
 *              socket_grip_*  palm centre wraps a bar / rail / handle
 *              socket_tip_*   index fingertip presses / flips
 *              socket_pinch_* thumb + index pinch a knob
 *   pivot_*    Empty or bone that the runtime rotates/translates. The motion
 *              axis is documented per asset (`axes`). Children follow.
 *   screen_*   Mesh whose material map is replaced by a live canvas texture.
 *              UVs must fill 0..1 with the screen upright.
 *   light_*    Empty that spawns a light. -Z of the empty = light direction.
 *   emit_*     Empty that spawns a particle emitter (vents, RCS, dust).
 *   cam_*      Empty that a monitor-feed camera is attached to (-Z = view).
 *   anchor_*   Placement marker read by the scene scripts.
 *   col_*      Optional simplified collision / occlusion mesh (hidden).
 */

export const MANIFEST = {
  // ---------------------------------------------------------------- player
  fp_hands_iva: {
    file: 'models/fp_hands_iva.glb',
    kind: 'rig',
    scenes: [1, 2, 3, 4],
    description: 'First-person arms in the white IVA flight suit, touchscreen-tip gloves.',
    bones: handBones(),
    clips: ['pose_relaxed', 'pose_fist', 'pose_grip', 'pose_point', 'pose_pinch', 'pose_flat', 'pose_phone', 'pose_float'],
  },
  fp_hands_eva: {
    file: 'models/fp_hands_eva.glb',
    kind: 'rig',
    scenes: [5],
    description: 'First-person arms in the EVA surface suit: bulkier gloves, wrist display, bearing rings.',
    bones: handBones(),
    nodes: ['screen_wrist_L'],
    clips: ['pose_relaxed', 'pose_grip', 'pose_point', 'pose_flat'],
  },
  fp_boots_eva: {
    file: 'models/fp_boots_eva.glb',
    kind: 'rig',
    scenes: [5],
    description: 'EVA boots + lower legs for the first step. Only seen when looking down.',
    bones: ['thigh_L', 'shin_L', 'foot_L', 'toe_L', 'thigh_R', 'shin_R', 'foot_R', 'toe_R'],
  },

  // ---------------------------------------------------------------- people
  worker_ground: {
    file: 'models/worker_ground.glb',
    kind: 'character',
    scenes: [1, 2],
    description: 'Starbase pad technician: hard hat, headset, hi-vis vest, coveralls. Face hidden.',
    bones: humanoidBones(),
    clips: ['idle', 'walk', 'work', 'radio', 'point', 'carry', 'wave'],
  },
  worker_closeout: {
    file: 'models/worker_closeout.glb',
    kind: 'character',
    scenes: [2],
    description: 'Close-out crew in white coveralls, helmet with dark visor, harness.',
    bones: humanoidBones(),
    clips: ['idle', 'gesture_in', 'turn_handle'],
  },
  crew_seated: {
    file: 'models/crew_seated.glb',
    kind: 'character',
    scenes: [3, 4],
    description: 'Fellow crew member in a pressure suit, visor down, strapped into a seat.',
    bones: humanoidBones(),
    clips: ['seated_idle', 'seated_brace', 'float_idle'],
  },

  // ---------------------------------------------------------------- vehicle
  starship_ship: {
    file: 'models/starship_ship.glb',
    kind: 'model',
    scenes: [1, 2, 3, 5],
    description: 'Crew Starship (upper stage), 52 m × 9 m, origin at the engine plane on the axis.',
    nodes: [
      'pivot_flap_fwd_L', 'pivot_flap_fwd_R', 'pivot_flap_aft_L', 'pivot_flap_aft_R',
      'pivot_hatch_door', 'anchor_hatch', 'pivot_elevator', 'anchor_windows',
      'emit_vent_01', 'emit_vent_02',
    ],
    axes: { pivot_flap: 'rotate about local Y (hinge line, parallel to the ship axis); + folds toward the leeward side', pivot_hatch_door: 'rotate about local Y (hinge on the door edge)', pivot_elevator: 'translate along local -Y' },
  },
  starship_tanker: {
    file: 'models/starship_tanker.glb',
    kind: 'model',
    scenes: [3],
    description: 'Tanker variant: no windows, no hatch, docking port + quick-disconnect at the aft skirt.',
    nodes: ['emit_rcs_01', 'emit_rcs_02', 'anchor_dock'],
  },
  super_heavy: {
    file: 'models/super_heavy.glb',
    kind: 'model',
    scenes: [1, 2],
    description: 'Super Heavy booster, 71 m × 9 m, 33 Raptors, 4 grid fins, vented hot-stage ring.',
    nodes: ['emit_vent_01', 'emit_vent_02', 'emit_vent_03'],
  },

  // ---------------------------------------------------------------- Starbase
  launch_tower: {
    file: 'models/launch_tower.glb',
    kind: 'model',
    scenes: [1, 2, 3],
    description: 'Launch & catch tower (~146 m) with chopsticks, ship QD arm, lightning mast, obstruction lights.',
    nodes: ['pivot_chopstick_L', 'pivot_chopstick_R', 'light_obstruction_01'],
  },
  crew_access_arm: {
    file: 'models/crew_access_arm.glb',
    kind: 'model',
    scenes: [2],
    description: 'Crew access arm: grated walkway, rails, white room at the ship end, latch panel.',
    nodes: ['anchor_tower_end', 'anchor_ship_end', 'socket_grip_R_rail_start', 'socket_grip_R_rail_end', 'anchor_panel'],
  },
  launch_mount: { file: 'models/launch_mount.glb', kind: 'model', scenes: [1, 2, 3], description: 'Orbital launch mount: ring table on legs, hold-down clamps, QD.' },
  starbase_site: {
    file: 'models/starbase_site.glb',
    kind: 'model',
    scenes: [1, 2, 3],
    description: 'Pad apron, tank farm, light masts, fences, roads, distant high bays.',
    nodes: ['light_flood_01', 'light_flood_02', 'anchor_player_start'],
  },
  vehicles: { file: 'models/vehicles.glb', kind: 'model', scenes: [1], description: 'Crew van, pickup, mobile crane.' },

  // ---------------------------------------------------------------- props + controls
  phone: {
    file: 'models/phone.glb',
    kind: 'prop',
    scenes: [1],
    description: 'Ruggedised phone held in landscape. Origin = screen centre.',
    nodes: ['screen_phone', 'socket_grip_L', 'socket_grip_R', 'socket_tip_R_answer'],
  },
  ctrl_lever: {
    file: 'models/ctrl_lever.glb',
    kind: 'control',
    scenes: [2, 4],
    description: 'Latch / landing-mode lever with T-grip.',
    nodes: ['pivot_lever', 'socket_grip_R'],
    axes: { pivot_lever: 'rotate about local X, value 0 → 1 maps to -35° → +35°' },
  },
  ctrl_dial: {
    file: 'models/ctrl_dial.glb',
    kind: 'control',
    scenes: [2, 3],
    description: 'Rotary selector with detents, indicator line, engraved ring.',
    nodes: ['pivot_dial', 'socket_pinch_R'],
    axes: { pivot_dial: 'rotate about local Z, value 0 → 1 maps to 0° → -135°' },
  },
  ctrl_toggle: {
    file: 'models/ctrl_toggle.glb',
    kind: 'control',
    scenes: [3, 4],
    description: 'Guarded toggle switch (flip-up red guard).',
    nodes: ['pivot_guard', 'pivot_toggle', 'socket_tip_R'],
    axes: { pivot_guard: 'rotate about local X 0 → -100°', pivot_toggle: 'rotate about local X -25° → +25°' },
  },
  ctrl_button: {
    file: 'models/ctrl_button.glb',
    kind: 'control',
    scenes: [3, 5],
    description: 'Large illuminated push button with collar.',
    nodes: ['pivot_button', 'socket_tip_R'],
    axes: { pivot_button: 'translate along local -Z by 6 mm' },
  },
  ctrl_hatch_handle: {
    file: 'models/ctrl_hatch_handle.glb',
    kind: 'control',
    scenes: [5],
    description: 'Outer hatch with two-hand rotating handle.',
    nodes: ['pivot_hatch_handle', 'pivot_hatch_door', 'socket_grip_L', 'socket_grip_R'],
    axes: { pivot_hatch_handle: 'rotate about local Z 0 → 90°', pivot_hatch_door: 'rotate about local Y 0 → 105°' },
  },

  // ---------------------------------------------------------------- interiors
  cabin_flightdeck: {
    file: 'models/cabin_flightdeck.glb',
    kind: 'set',
    scenes: [3, 4],
    description: 'Crew deck: curved 9 m hull wall, window band, console, seats, galley, bunks.',
    nodes: [
      'anchor_seat_player', 'anchor_ctrl_lever', 'anchor_ctrl_dial', 'anchor_ctrl_toggle_01', 'anchor_ctrl_toggle_02',
      'anchor_ctrl_toggle_03', 'anchor_ctrl_button', 'screen_main', 'screen_left', 'screen_right', 'screen_feed',
      'socket_grip_L_armrest', 'socket_grip_R_armrest', 'light_panel_01', 'light_panel_02',
    ],
  },
  cabin_shelter: { file: 'models/cabin_shelter.glb', kind: 'set', scenes: [3], description: 'Solar storm shelter: water-wall bags, red work light, dose meter.', nodes: ['screen_dose'] },
  airlock: {
    file: 'models/airlock.glb',
    kind: 'set',
    scenes: [5],
    description: 'Airlock + outer hatch + elevator platform with rails and control pendant.',
    nodes: ['anchor_hatch', 'anchor_ctrl_hatch', 'pivot_platform', 'socket_grip_L_rail', 'socket_grip_R_rail', 'anchor_ctrl_elevator'],
  },
  mars_landing_site: {
    file: 'models/mars_landing_site.glb',
    kind: 'set',
    scenes: [4, 5],
    description: 'Optional hero terrain tile (200 m) for the landing zone. Blends into the procedural plain.',
    nodes: ['anchor_ship', 'anchor_first_step'],
  },
};

/** Optional textures (equirectangular planets, HDR skies). */
export const TEXTURES = {
  earth_day: 'textures/earth_day.jpg',
  earth_clouds: 'textures/earth_clouds.jpg',
  mars_albedo: 'textures/mars_albedo.jpg',
  env_starbase: 'textures/env_starbase_dawn.hdr',
  env_mars: 'textures/env_mars_afternoon.hdr',
};

function handBones() {
  const out = [];
  for (const s of ['L', 'R']) {
    out.push(`upperarm_${s}`, `forearm_${s}`, `hand_${s}`);
    for (const f of ['thumb', 'index', 'middle', 'ring', 'pinky']) {
      out.push(`${f}_01_${s}`, `${f}_02_${s}`, `${f}_03_${s}`);
    }
  }
  return out;
}

function humanoidBones() {
  return [
    'hips', 'spine', 'chest', 'neck', 'head',
    'shoulder_L', 'upperarm_L', 'forearm_L', 'hand_L',
    'shoulder_R', 'upperarm_R', 'forearm_R', 'hand_R',
    'thigh_L', 'shin_L', 'foot_L', 'thigh_R', 'shin_R', 'foot_R',
  ];
}
