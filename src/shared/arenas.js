/**
 * Quantum Pulse — arena definitions.
 *
 * Arenas are pure data built from axis-aligned boxes so that the server,
 * client-side prediction and the renderer all use identical geometry.
 * Visual-only decoration is generated procedurally on the client from
 * `decorSeed` and never affects gameplay.
 *
 * Collider kinds:
 *   SOLID — always blocks.
 *   PHASE — "phase barrier": blocks unless the player is Phase-shifted.
 *   PROP  — destructible cover: blocks while alive, has hit points.
 * @module shared/arenas
 */

export const ColliderKind = Object.freeze({ SOLID: 0, PHASE: 1, PROP: 2 });

/** Zone/accent indices shared with the renderer palette. */
export const Zone = Object.freeze({ NEUTRAL: 0, CYAN: 1, MAGENTA: 2, VIOLET: 3, AMBER: 4 });

const STEP_RISE = 0.4; // below PLAYER.STEP_HEIGHT so stairs are walkable without jumping

class ArenaBuilder {
  constructor() {
    this.colliders = [];
  }

  /**
   * Add a box by centre (x, z), size (w, d) and vertical span [y0, y1].
   * @returns {object} the collider
   */
  box(x, z, w, d, y0, y1, opts = {}) {
    const c = {
      id: this.colliders.length,
      minX: x - w / 2, maxX: x + w / 2,
      minY: y0, maxY: y1,
      minZ: z - d / 2, maxZ: z + d / 2,
      kind: opts.kind ?? ColliderKind.SOLID,
      zone: opts.zone ?? Zone.NEUTRAL,
      hp: opts.hp ?? 0,
      maxHp: opts.hp ?? 0,
      alive: true,
      invisible: !!opts.invisible,
      landmark: !!opts.landmark,
      noGrapple: !!opts.noGrapple,
    };
    this.colliders.push(c);
    return c;
  }

  /**
   * Straight staircase. Starts at (x0, z0) and climbs along the axis direction
   * (dirX, dirZ) — exactly one of them must be ±1 — from y0 to y1.
   */
  stairs(x0, z0, dirX, dirZ, width, y0, y1, zone = Zone.NEUTRAL, depth = 0.6) {
    const n = Math.ceil((y1 - y0) / STEP_RISE);
    const rise = (y1 - y0) / n;
    for (let i = 0; i < n; i++) {
      const along = (i + 0.5) * depth;
      const cx = x0 + dirX * along;
      const cz = z0 + dirZ * along;
      const w = dirX !== 0 ? depth : width;
      const d = dirZ !== 0 ? depth : width;
      this.box(cx, cz, w, d, y0 - 0.5, y0 + rise * (i + 1), { zone });
    }
  }

  /** Four tall boundary walls (invisible ones are used for floating arenas). */
  walls(half, height, thickness = 2, invisible = false, zones = [Zone.NEUTRAL, Zone.NEUTRAL, Zone.NEUTRAL, Zone.NEUTRAL]) {
    const len = half * 2 + thickness * 2;
    this.box(0, -half - thickness / 2, len, thickness, -4, height, { invisible, zone: zones[0], noGrapple: invisible });
    this.box(half + thickness / 2, 0, thickness, len, -4, height, { invisible, zone: zones[1], noGrapple: invisible });
    this.box(0, half + thickness / 2, len, thickness, -4, height, { invisible, zone: zones[2], noGrapple: invisible });
    this.box(-half - thickness / 2, 0, thickness, len, -4, height, { invisible, zone: zones[3], noGrapple: invisible });
  }
}

/* ------------------------------------------------------------------------ */
/* A. NEON RUPTURE — floating city fragments over a void                    */
/* ------------------------------------------------------------------------ */
function buildNeonRupture() {
  const b = new ArenaBuilder();
  // Central plaza
  b.box(0, 0, 32, 32, -3, 0, { zone: Zone.NEUTRAL });
  // Central spire — primary landmark and grapple anchor
  b.box(0, 0, 4, 4, 0, 12, { zone: Zone.CYAN, landmark: true });
  // Plaza cover
  b.box(0, -8, 5, 1, 0, 1.3);
  b.box(0, 8, 5, 1, 0, 1.3);
  b.box(-8, 0, 1, 5, 0, 2.2);
  b.box(8, 0, 1, 5, 0, 2.2);
  // Four raised plaza terraces (y = 5) with stairs
  const terraceZones = [Zone.CYAN, Zone.MAGENTA, Zone.AMBER, Zone.VIOLET];
  const corners = [[1, -1], [1, 1], [-1, 1], [-1, -1]];
  corners.forEach(([sx, sz], i) => {
    b.box(sx * 11, sz * 11, 7, 7, 4.4, 5, { zone: terraceZones[i] });
    // stairs climbing along +/-X from near the spire toward the terrace
    b.stairs(sx * 0.3, sz * 11, sx, 0, 2.2, 0, 5, terraceZones[i], 0.6);
  });

  // Cardinal islands with broken skybridges
  const cardinals = [
    { x: 34, z: 0, zone: Zone.MAGENTA, dir: [1, 0] },
    { x: -34, z: 0, zone: Zone.VIOLET, dir: [-1, 0] },
    { x: 0, z: -34, zone: Zone.CYAN, dir: [0, -1] },
    { x: 0, z: 34, zone: Zone.AMBER, dir: [0, 1] },
  ];
  for (const c of cardinals) {
    b.box(c.x, c.z, 14, 14, -3, 0, { zone: c.zone });
    // skybridge pieces with a 2.5 m gap in the middle ("broken")
    const [dx, dz] = c.dir;
    const seg = (a0, a1) => {
      const mid = (a0 + a1) / 2;
      const len = a1 - a0;
      if (dx !== 0) b.box(dx * mid, 0, len, 3, -0.6, 0, { zone: c.zone });
      else b.box(0, dz * mid, 3, len, -0.6, 0, { zone: c.zone });
    };
    seg(16, 20.25);
    seg(22.75, 27);
    // island cover
    if (dx !== 0) {
      b.box(c.x + dx * 3, 4, 1, 3, 0, 1.6);
      b.box(c.x + dx * 3, -4, 1, 3, 0, 1.6);
    } else {
      b.box(4, c.z + dz * 3, 3, 1, 0, 1.6);
      b.box(-4, c.z + dz * 3, 3, 1, 0, 1.6);
    }
  }

  // Elevated corner islands (y = 7) with colour landmarks
  const cornerZones = [Zone.CYAN, Zone.MAGENTA, Zone.AMBER, Zone.VIOLET];
  corners.forEach(([sx, sz], i) => {
    b.box(sx * 30, sz * 30, 12, 12, 4, 7, { zone: cornerZones[i] });
    b.box(sx * 34, sz * 34, 2.5, 2.5, 7, 19, { zone: cornerZones[i], landmark: true });
    b.box(sx * 27, sz * 30, 1, 4, 7, 8.4);
  });

  // Floating fragments (grapple & ring routes)
  b.box(17, -24, 4, 4, 9.5, 10, { zone: Zone.CYAN });
  b.box(-17, 24, 4, 4, 9.5, 10, { zone: Zone.AMBER });
  b.box(24, 17, 4, 4, 9.5, 10, { zone: Zone.MAGENTA });
  b.box(-24, -17, 4, 4, 9.5, 10, { zone: Zone.VIOLET });
  b.box(0, 0, 8, 8, 16.5, 17, { zone: Zone.CYAN }); // halo above the spire

  // Invisible containment walls keep players from flying away from the map.
  b.walls(50, 40, 2, true);

  return {
    id: 'neon_rupture',
    name: 'Neon Rupture',
    tagline: 'Floating city fragments and broken skybridges.',
    half: 50,
    killY: -22,
    ceiling: 40,
    decorSeed: 1337,
    palette: { sky: [0x05060f, 0x120a2a], fog: 0x070818, fill: 0x0c0f22, ink: 0x9ff8ff },
    colliders: b.colliders,
    spawns: [
      { x: 4, y: 0, z: 5, yaw: 0 }, { x: -4, y: 0, z: -5, yaw: Math.PI },
      { x: 12, y: 0, z: 0, yaw: Math.PI / 2 }, { x: -12, y: 0, z: 0, yaw: -Math.PI / 2 },
      { x: 38, y: 0, z: 0, yaw: Math.PI / 2 }, { x: -38, y: 0, z: 0, yaw: -Math.PI / 2 },
      { x: 4, y: 0, z: 34, yaw: 0 }, { x: -4, y: 0, z: -34, yaw: Math.PI },
      { x: 30, y: 7, z: 30, yaw: Math.PI * 0.25 }, { x: -30, y: 7, z: -30, yaw: -Math.PI * 0.75 },
      { x: 30, y: 7, z: -30, yaw: Math.PI * 0.75 }, { x: -30, y: 7, z: 30, yaw: -Math.PI * 0.25 },
    ],
    rifts: [
      { x: 34, y: 6, z: 0 }, { x: -34, y: 6, z: 0 }, { x: 0, y: 6, z: 34 }, { x: 0, y: 6, z: -34 },
      { x: 30, y: 13, z: 30 }, { x: -30, y: 13, z: -30 }, { x: 30, y: 13, z: -30 }, { x: -30, y: 13, z: 30 },
    ],
    pads: [
      // cardinal islands -> elevated corners
      { x: 34, y: 0, z: -5, r: 1.3, vy: 23, tx: 30, tz: -30, push: 17 },
      { x: 34, y: 0, z: 5, r: 1.3, vy: 23, tx: 30, tz: 30, push: 17 },
      { x: -34, y: 0, z: 5, r: 1.3, vy: 23, tx: -30, tz: 30, push: 17 },
      { x: -34, y: 0, z: -5, r: 1.3, vy: 23, tx: -30, tz: -30, push: 17 },
    ],
    rings: [
      { x: 17, y: 13, z: -24, r: 2.2 }, { x: -17, y: 13, z: 24, r: 2.2 },
      { x: 24, y: 13, z: 17, r: 2.2 }, { x: -24, y: 13, z: -17, r: 2.2 },
      { x: 0, y: 21, z: 0, r: 2.6 },
    ],
    hazards: [],
    healZones: [
      { x: 30, y: 7, z: 30, r: 2.4 }, { x: -30, y: 7, z: -30, r: 2.4 },
      { x: 30, y: 7, z: -30, r: 2.4 }, { x: -30, y: 7, z: 30, r: 2.4 },
    ],
    landmarks: [
      { x: 0, y: 18, z: 0, zone: Zone.CYAN, label: 'SPIRE' },
      { x: 34, y: 19, z: -34, zone: Zone.CYAN, label: 'A' },
      { x: 34, y: 19, z: 34, zone: Zone.MAGENTA, label: 'B' },
      { x: -34, y: 19, z: 34, zone: Zone.AMBER, label: 'C' },
      { x: -34, y: 19, z: -34, zone: Zone.VIOLET, label: 'D' },
    ],
    reactor: null,
    pulseHazard: null,
  };
}

/* ------------------------------------------------------------------------ */
/* B. THE FOLDED ARCHIVE — abstract library stacks and phase barriers        */
/* ------------------------------------------------------------------------ */
function buildFoldedArchive() {
  const b = new ArenaBuilder();
  const H = 42;
  b.box(0, 0, H * 2, H * 2, -2, 0); // floor
  b.walls(H, 22, 2, false, [Zone.CYAN, Zone.MAGENTA, Zone.AMBER, Zone.VIOLET]);

  const SHELF_H = 6;
  const SHELF_D = 2.6;
  // Rows of stacks along X (z = ±16, ±29) with gaps
  const rowSegs = [[-39, -22], [-18, -4], [4, 18], [22, 39]];
  const rows = [
    { z: -16, zone: Zone.CYAN }, { z: 16, zone: Zone.AMBER },
    { z: -29, zone: Zone.CYAN }, { z: 29, zone: Zone.AMBER },
  ];
  for (const r of rows) {
    for (const [a, c] of rowSegs) b.box((a + c) / 2, r.z, c - a, SHELF_D, 0, SHELF_H, { zone: r.zone });
  }
  // Columns of stacks along Z at x = ±16 (atrium sides) with a centre gap
  for (const sx of [-1, 1]) {
    const zone = sx > 0 ? Zone.MAGENTA : Zone.VIOLET;
    b.box(sx * 16, -8, SHELF_D, 10, 0, SHELF_H, { zone });
    b.box(sx * 16, 8, SHELF_D, 10, 0, SHELF_H, { zone });
    b.box(sx * 30, 0, SHELF_D, 16, 0, SHELF_H, { zone });
  }
  // Phase barriers: shortcuts into the atrium that only Phase Break can cross
  b.box(0, -16, 8, 0.5, 0, SHELF_H, { kind: ColliderKind.PHASE, zone: Zone.VIOLET, noGrapple: true });
  b.box(0, 16, 8, 0.5, 0, SHELF_H, { kind: ColliderKind.PHASE, zone: Zone.VIOLET, noGrapple: true });
  b.box(20, -29, 4, 0.5, 0, SHELF_H, { kind: ColliderKind.PHASE, zone: Zone.VIOLET, noGrapple: true });
  b.box(-20, 29, 4, 0.5, 0, SHELF_H, { kind: ColliderKind.PHASE, zone: Zone.VIOLET, noGrapple: true });

  // Stairs onto the stacks (mezzanine walkways on top of the shelves). Each run
  // climbs parallel to a shelf row so the top step sits right beside the shelf top.
  b.stairs(-22, -13.6, -1, 0, 2.2, 0, SHELF_H, Zone.CYAN);
  b.stairs(22, 13.6, 1, 0, 2.2, 0, SHELF_H, Zone.AMBER);

  // Central atrium: the Index tower and a floating reading platform
  b.box(0, 0, 3, 3, 0, 18, { zone: Zone.MAGENTA, landmark: true });
  b.box(0, 0, 9, 9, 8.5, 9, { zone: Zone.MAGENTA });
  b.box(-6, 6, 1.2, 4, 0, 1.4);
  b.box(6, -6, 1.2, 4, 0, 1.4);
  b.box(6, 6, 4, 1.2, 0, 1.4);
  b.box(-6, -6, 4, 1.2, 0, 1.4);

  // Folded pages — floating platforms in the upper volume
  b.box(-29, -36, 6, 3, 10, 10.5, { zone: Zone.CYAN });
  b.box(29, 36, 6, 3, 10, 10.5, { zone: Zone.AMBER });
  b.box(36, -22, 3, 6, 11, 11.5, { zone: Zone.MAGENTA });
  b.box(-36, 22, 3, 6, 11, 11.5, { zone: Zone.VIOLET });
  // Reading tables (low cover) in the outer aisles
  for (const [x, z] of [[-28, -22], [28, 22], [-28, 22], [28, -22], [-8, -36], [8, 36]]) b.box(x, z, 4, 1.6, 0, 1.1);

  return {
    id: 'folded_archive',
    name: 'The Folded Archive',
    tagline: 'Endless stacks, mezzanines and phase barriers.',
    half: H,
    killY: -20,
    ceiling: 22,
    decorSeed: 4242,
    palette: { sky: [0x07040f, 0x1a0b26], fog: 0x0b0716, fill: 0x120d22, ink: 0xffb0f6 },
    colliders: b.colliders,
    spawns: [
      { x: 0, y: 0, z: 22, yaw: 0 }, { x: 0, y: 0, z: -22, yaw: Math.PI },
      { x: 22, y: 0, z: 0, yaw: Math.PI / 2 }, { x: -22, y: 0, z: 0, yaw: -Math.PI / 2 },
      { x: 35, y: 0, z: 35, yaw: Math.PI / 4 }, { x: -35, y: 0, z: -35, yaw: -Math.PI * 0.75 },
      { x: 35, y: 0, z: -35, yaw: Math.PI * 0.75 }, { x: -35, y: 0, z: 35, yaw: -Math.PI / 4 },
      { x: 8, y: 0, z: 8, yaw: 0 }, { x: -8, y: 0, z: -8, yaw: Math.PI },
      { x: 22, y: 0, z: -22, yaw: Math.PI }, { x: -22, y: 0, z: 22, yaw: 0 },
    ],
    rifts: [
      { x: 0, y: 5, z: -36 }, { x: 0, y: 5, z: 36 }, { x: 36, y: 5, z: 0 }, { x: -36, y: 5, z: 0 },
      { x: 30, y: 12, z: 30 }, { x: -30, y: 12, z: -30 },
    ],
    pads: [
      { x: 10, y: 0, z: 0, r: 1.2, vy: 24.5, tx: 0, tz: 0, push: 6.5 },
      { x: -10, y: 0, z: 0, r: 1.2, vy: 24.5, tx: 0, tz: 0, push: 6.5 },
    ],
    rings: [
      { x: 0, y: 13, z: 0, r: 2.4 }, { x: -29, y: 14, z: -36, r: 2.2 }, { x: 29, y: 14, z: 36, r: 2.2 },
      { x: 36, y: 15, z: -22, r: 2.2 }, { x: -36, y: 15, z: 22, r: 2.2 },
    ],
    hazards: [],
    healZones: [{ x: 0, y: 9, z: 0, r: 2.6 }, { x: -36, y: 6, z: -16, r: 1.6 }, { x: 36, y: 6, z: 16, r: 1.6 }],
    landmarks: [
      { x: 0, y: 18, z: 0, zone: Zone.MAGENTA, label: 'INDEX' },
      { x: 0, y: 14, z: -41, zone: Zone.CYAN, label: 'NORTH STACKS' },
      { x: 0, y: 14, z: 41, zone: Zone.AMBER, label: 'SOUTH STACKS' },
    ],
    reactor: null,
    pulseHazard: null,
  };
}

/* ------------------------------------------------------------------------ */
/* C. REACTOR NULL — central reactor, energy channels, destructible cover   */
/* ------------------------------------------------------------------------ */
function buildReactorNull() {
  const b = new ArenaBuilder();
  const H = 42;
  b.box(0, 0, H * 2, H * 2, -2, 0);
  b.walls(H, 18, 2, false, [Zone.CYAN, Zone.MAGENTA, Zone.AMBER, Zone.VIOLET]);
  // Reactor core housing (visual is a cylinder; collision is a box)
  b.box(0, 0, 7, 7, 0, 9, { zone: Zone.AMBER, landmark: true });

  // Destructible cover ring
  const PROP_HP = 160;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + Math.PI / 12;
    const r = i % 2 === 0 ? 13 : 17;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const tangentAlongX = Math.abs(Math.sin(a)) > 0.7;
    b.box(x, z, tangentAlongX ? 3.2 : 0.9, tangentAlongX ? 0.9 : 3.2, 0, 1.6, { kind: ColliderKind.PROP, hp: PROP_HP });
  }
  // Pillars (grapple anchors, hard cover)
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    b.box(Math.cos(a) * 24, Math.sin(a) * 24, 2, 2, 0, 14, { zone: [Zone.CYAN, Zone.MAGENTA, Zone.AMBER, Zone.VIOLET][i % 4] });
  }
  // Corner catwalk platforms (y = 5) + perimeter walkways
  const corners = [[1, -1], [1, 1], [-1, 1], [-1, -1]];
  const zones = [Zone.CYAN, Zone.MAGENTA, Zone.AMBER, Zone.VIOLET];
  corners.forEach(([sx, sz], i) => {
    b.box(sx * 34, sz * 34, 12, 12, 4.4, 5, { zone: zones[i] });
    // Stairs run along X just inside the perimeter walkway and end on the platform edge.
    b.stairs(sx * 20.5, sz * 34.5, sx, 0, 2.4, 0, 5, zones[i]);
  });
  b.box(0, -38.5, 56, 3, 4.4, 5, { zone: Zone.CYAN });
  b.box(0, 38.5, 56, 3, 4.4, 5, { zone: Zone.AMBER });
  // Reactor gantry above the core
  b.box(0, 0, 16, 2, 12, 12.5, { zone: Zone.AMBER });
  b.box(0, 0, 2, 16, 12, 12.5, { zone: Zone.AMBER });

  return {
    id: 'reactor_null',
    name: 'Reactor Null',
    tagline: 'Defend — or contest — the unstable reactor core.',
    half: H,
    killY: -20,
    ceiling: 20,
    decorSeed: 9001,
    palette: { sky: [0x050812, 0x0c1a24], fog: 0x061016, fill: 0x0b1420, ink: 0xffd68a },
    colliders: b.colliders,
    spawns: [
      { x: 0, y: 0, z: 9, yaw: 0 }, { x: 0, y: 0, z: -9, yaw: Math.PI },
      { x: 9, y: 0, z: 0, yaw: Math.PI / 2 }, { x: -9, y: 0, z: 0, yaw: -Math.PI / 2 },
      { x: 34, y: 5, z: 34, yaw: Math.PI / 4 }, { x: -34, y: 5, z: -34, yaw: -Math.PI * 0.75 },
      { x: 34, y: 5, z: -34, yaw: Math.PI * 0.75 }, { x: -34, y: 5, z: 34, yaw: -Math.PI / 4 },
      { x: 30, y: 0, z: 5, yaw: Math.PI / 2 }, { x: -30, y: 0, z: -5, yaw: -Math.PI / 2 },
      { x: 5, y: 0, z: 30, yaw: 0 }, { x: -5, y: 0, z: -30, yaw: Math.PI },
    ],
    rifts: [
      { x: 36, y: 3, z: 0 }, { x: -36, y: 3, z: 0 }, { x: 0, y: 3, z: 36 }, { x: 0, y: 3, z: -36 },
      { x: 28, y: 9, z: -10 }, { x: -28, y: 9, z: 10 },
    ],
    pads: [
      // launch from the floor up onto the perimeter walkways
      { x: 12, y: 0, z: -33, r: 1.2, vy: 19, tx: 12, tz: -38.5, push: 5.5 },
      { x: -12, y: 0, z: 33, r: 1.2, vy: 19, tx: -12, tz: 38.5, push: 5.5 },
    ],
    rings: [
      { x: 0, y: 15, z: 18, r: 2.3 }, { x: 0, y: 15, z: -18, r: 2.3 },
      { x: 18, y: 15, z: 0, r: 2.3 }, { x: -18, y: 15, z: 0, r: 2.3 },
    ],
    // Energy channels: damage while standing in them (jump or slide across)
    hazards: [
      { minX: -1.1, maxX: 1.1, minZ: 6, maxZ: 40, maxY: 0.35, dps: 28 },
      { minX: -1.1, maxX: 1.1, minZ: -40, maxZ: -6, maxY: 0.35, dps: 28 },
      { minX: 6, maxX: 40, minZ: -1.1, maxZ: 1.1, maxY: 0.35, dps: 28 },
      { minX: -40, maxX: -6, minZ: -1.1, maxZ: 1.1, maxY: 0.35, dps: 28 },
    ],
    healZones: [
      { x: 34, y: 5, z: 34, r: 2.4 }, { x: -34, y: 5, z: -34, r: 2.4 },
      { x: 34, y: 5, z: -34, r: 2.4 }, { x: -34, y: 5, z: 34, r: 2.4 },
    ],
    landmarks: [
      { x: 0, y: 12.5, z: 0, zone: Zone.AMBER, label: 'REACTOR' },
      { x: 34, y: 9, z: -34, zone: Zone.CYAN, label: 'A' },
      { x: 34, y: 9, z: 34, zone: Zone.MAGENTA, label: 'B' },
      { x: -34, y: 9, z: 34, zone: Zone.AMBER, label: 'C' },
      { x: -34, y: 9, z: -34, zone: Zone.VIOLET, label: 'D' },
    ],
    reactor: { x: 0, y: 4.5, z: 0, radius: 4.2, height: 9 },
    /** Periodic arena-wide pulse: grounded players below `safeY` take damage unless airborne. */
    pulseHazard: { interval: 40, telegraph: 2.5, damage: 18, safeY: 3.5 },
  };
}

const BUILDERS = {
  neon_rupture: buildNeonRupture,
  folded_archive: buildFoldedArchive,
  reactor_null: buildReactorNull,
};

export const ARENA_IDS = Object.freeze(Object.keys(BUILDERS));

/**
 * Build a fresh arena instance. Each World gets its own copy because
 * destructible props mutate collider state.
 * @param {string} id
 */
export function createArena(id) {
  const build = BUILDERS[id] || BUILDERS.neon_rupture;
  return build();
}

export function arenaName(id) {
  return { neon_rupture: 'Neon Rupture', folded_archive: 'The Folded Archive', reactor_null: 'Reactor Null' }[id] || id;
}
