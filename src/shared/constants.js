/**
 * Quantum Pulse — shared constants.
 *
 * Everything that both the authoritative simulation (server / offline sim) and
 * the client prediction must agree on lives here. Changing a movement constant
 * changes gameplay for BOTH sides, so prediction stays in sync automatically.
 *
 * Units: distance in metres, time in seconds, speed in metres/second.
 * @module shared/constants
 */

export const PROTOCOL_VERSION = 3;

/** Fixed-step simulation timing. */
export const SIM = Object.freeze({
  /** Simulation ticks per second (server world + client prediction). */
  TICK_RATE: 60,
  /** Fixed simulation step in seconds. Never use a variable dt for gameplay. */
  DT: 1 / 60,
  /** Snapshots broadcast per second in online modes. */
  SNAPSHOT_RATE: 20,
  /** Maximum ticks the server will catch up in one loop iteration (spiral-of-death guard). */
  MAX_CATCHUP_TICKS: 5,
});

/** Networking limits. Several are overridable through environment variables (see server.js). */
export const NET = Object.freeze({
  MAX_PACKET_BYTES: 4096,
  /** Maximum input commands accepted in a single 'in' packet. */
  MAX_INPUTS_PER_PACKET: 10,
  /** Message token bucket: sustained rate and burst size per connection. */
  MSG_RATE_PER_SEC: 80,
  MSG_BURST: 40,
  /** Protocol violations before a connection is dropped. */
  VIOLATION_LIMIT: 30,
  /**
   * Hard cap on queued input commands per player (1 s). Only exceeded by a
   * client sending faster than real time; the oldest commands are dropped.
   */
  MAX_INPUT_QUEUE: 60,
  /**
   * Server-side input jitter buffer (in ticks). The server consumes one
   * command per tick and keeps this many queued to absorb arrival jitter; the
   * target follows the measured jitter (see World.queueInputs).
   */
  INPUT_BUFFER_MIN: 1,
  INPUT_BUFFER_MAX: 8,
  /** Input packets remembered per player for the arrival-jitter estimate (~4 s at 30 Hz). */
  INPUT_JITTER_WINDOW: 128,
  /** Most commands consumed in one tick while catching up on a backlog. */
  INPUT_CATCHUP_MAX_PER_TICK: 3,
  /**
   * Anti speed-hack time credit: a player earns one command per tick and may
   * bank at most this many (0.5 s), so long-term movement can never run
   * faster than real time, while a legitimately stalled client can catch up.
   */
  INPUT_CREDIT_MAX_TICKS: 30,
  /** After this long without input the server simulates a neutral input for the player. */
  INPUT_TIMEOUT_MS: 400,
  /** Disconnected players keep their slot (and stats) this long for reconnection. */
  RECONNECT_GRACE_MS: 30000,
  /**
   * Lag compensation: maximum rewind the server will honour. A shot needs
   * roughly RTT + interpolation delay + input buffering of rewind, so 500 ms
   * covers round trips up to ~250 ms (measured with scripts/netsim-bench.js).
   * Beyond that, high-latency shooters must lead their targets. A larger
   * window favours laggy shooters more ("shot behind cover"), so do not raise
   * it without re-running the benchmark.
   */
  LAG_COMP_MAX_MS: 500,
  /**
   * Remote entities render this far behind the estimated server time. This is
   * the starting value; the client then adapts it to measured snapshot jitter
   * (see client/Interpolation.js ServerClock) between one snapshot interval
   * and INTERP_DELAY_MAX_MS.
   */
  INTERP_DELAY_MS: 110,
  INTERP_DELAY_MAX_MS: 200,
  /** Extra margin (ticks) on top of interval + jitter. */
  INTERP_SAFETY_TICKS: 0.75,
  /** Snapshots remembered for the jitter estimate (~3 s at 20 Hz). */
  INTERP_JITTER_WINDOW: 60,
  /** Maximum extrapolation when snapshots are late. */
  EXTRAPOLATE_MAX_MS: 120,
  /** Number of snapshots kept for interpolation. */
  SNAPSHOT_BUFFER: 32,
  /** Client sends input packets at this rate (each packet carries all inputs since the last). */
  INPUT_SEND_RATE: 30,
  /** Heartbeat used to detect dead connections. */
  PING_INTERVAL_MS: 2000,
  HEARTBEAT_TIMEOUT_MS: 10000,
});

/** Match configuration defaults (server may override via env). */
export const MATCH = Object.freeze({
  FFA_MIN_PLAYERS: 2,
  FFA_MAX_PLAYERS: 12,
  COOP_MAX_PLAYERS: 4,
  FFA_DURATION_S: 300,
  FFA_WARMUP_S: 10,
  RESPAWN_S: 3,
  SPAWN_PROTECTION_S: 2,
  RESULTS_S: 12,
  ASSIST_WINDOW_S: 6,
  COOP_FINAL_WAVE: 10,
  COOP_DOWNED_BLEEDOUT_S: 20,
  COOP_REVIVE_TIME_S: 2.5,
  COOP_REVIVE_RANGE: 2.8,
  REACTOR_MAX_HP: 2500,
  INTERMISSION_S: 9,
  /** Minimum distance between a respawn point and the nearest enemy/opponent. */
  SPAWN_SAFE_RADIUS: 14,
  /** Anti-stall: in FFA, a player who has not dealt damage for this long gets revealed on the minimap/pinged. */
  ANTI_STALL_S: 25,
  MAX_ROOMS: 64,
});

/** Player body + movement tuning. */
export const PLAYER = Object.freeze({
  HALF_WIDTH: 0.4,
  HEIGHT: 1.8,
  EYE_HEIGHT: 1.62,
  SLIDE_EYE_HEIGHT: 1.0,
  HEAD_RADIUS: 0.3,
  HEAD_CENTER: 1.58,

  MAX_HEALTH: 100,
  MAX_SHIELD: 50,
  SHIELD_REGEN_DELAY: 3.5,
  SHIELD_REGEN_RATE: 20,

  WALK_SPEED: 9.0,
  SPRINT_SPEED: 13.0,
  /**
   * Ground acceleration is GROUND_ACCEL × wishSpeed (m/s²). Scaling with the
   * target speed keeps the top speed reachable over GROUND_FRICTION:
   * per-tick gain (accel·wish·dt) must exceed friction loss at top speed
   * (friction·speed·dt), i.e. GROUND_ACCEL > GROUND_FRICTION.
   */
  GROUND_ACCEL: 12,
  GROUND_FRICTION: 9,
  AIR_ACCEL: 22,
  AIR_SPEED: 9.5,
  GRAVITY: 28,
  JUMP_VELOCITY: 10.2,
  /** Seconds after leaving a ledge during which a jump still counts as grounded. */
  COYOTE_TIME: 0.12,
  /** Seconds a jump press is remembered before landing. */
  JUMP_BUFFER: 0.13,

  SLIDE_MIN_SPEED: 6.5,
  SLIDE_BOOST: 4.5,
  SLIDE_DURATION: 0.85,
  SLIDE_FRICTION: 1.3,
  SLIDE_COOLDOWN: 0.45,
  /** Slide-jump keeps this fraction of extra horizontal speed (capped by MAX_HORIZONTAL_SPEED). */
  SLIDE_JUMP_SCALE: 1.08,

  WALL_JUMP_UP: 9.5,
  WALL_JUMP_PUSH: 8.5,
  WALL_JUMP_COOLDOWN: 0.25,
  WALLRUN_MIN_SPEED: 7.5,
  WALLRUN_MAX_TIME: 1.25,
  WALLRUN_GRAVITY_SCALE: 0.22,

  DASH_SPEED: 21,
  DASH_TIME: 0.16,
  DASH_COOLDOWN: 0.85,
  DASH_CHARGES: 1,

  GRAPPLE_RANGE: 44,
  GRAPPLE_MIN_LENGTH: 2.5,
  GRAPPLE_REEL_SPEED: 14,
  GRAPPLE_PULL_ACCEL: 26,
  GRAPPLE_LAUNCH_UP: 7.5,
  GRAPPLE_LAUNCH_SCALE: 1.12,
  GRAPPLE_COOLDOWN: 0.55,
  GRAPPLE_MAX_TIME: 4.0,

  /** Ledge forgiveness: obstacles whose top is at most this far above the feet are auto-mantled. */
  LEDGE_MANTLE_HEIGHT: 0.95,
  /** Small steps are climbed without jumping. */
  STEP_HEIGHT: 0.45,

  /** Absolute velocity caps (exploit + physics stability guard). */
  MAX_HORIZONTAL_SPEED: 34,
  MAX_VERTICAL_SPEED: 40,

  /** Hard landing creates a shockwave above this downward speed. */
  SHOCKWAVE_MIN_FALL_SPEED: 19,
  SHOCKWAVE_RADIUS: 5.5,
  SHOCKWAVE_DAMAGE: 35,
});

/** Quantum Pulse / abilities. */
export const PULSE = Object.freeze({
  MAX: 100,
  PER_DAMAGE: 0.12,
  PER_KILL: 7,
  AIRBORNE_KILL_BONUS: 6,
  HEADSHOT_BONUS: 2.5,
  NEAR_MISS: 3.5,
  NEAR_MISS_RADIUS: 1.3,
  RING_BONUS: 9,
  SPEED_THRESHOLD: 14,
  PER_SECOND_AT_SPEED: 2.2,
  COMBO_BONUS_PER_STEP: 1.2,
  COMBO_BONUS_CAP: 8,
  ENVIRONMENT_KILL_BONUS: 9,
  /** Hard cap on how much charge may be gained in one second, regardless of source. */
  MAX_GAIN_PER_SECOND: 45,

  PHASE_DURATION: 3.2,
  /** Phase Break reduces non-projectile damage by this fraction; enemy projectiles pass through. */
  PHASE_DAMAGE_REDUCTION: 0.6,
  PHASE_SPEED_SCALE: 1.1,

  GRAVITY_ABILITY_COOLDOWN: 14,
  GRAVITY_ABILITY_RANGE: 32,
  MELEE_COOLDOWN: 1.1,
  MELEE_RANGE: 3.4,
  MELEE_DAMAGE: 32,
  MELEE_KNOCKBACK: 12,

  /** Co-op tether. */
  TETHER_LINK_RANGE: 20,
  TETHER_BREAK_RANGE: 30,
  TETHER_BONUS_MIN: 5,
  TETHER_BONUS_MAX: 18,
  TETHER_SPEED_BONUS: 1.08,
  TETHER_TRANSFER_AMOUNT: 15,
  TETHER_TRANSFER_COOLDOWN: 6,
  TETHER_ARC_DAMAGE: 60,
  TETHER_ARC_COOLDOWN: 6,
  TETHER_ARC_WIDTH: 1.4,
  /** Two tethered players activating Pulse within this window trigger Rift Surge. */
  SYNC_WINDOW_S: 1.5,
});

/** Gravity Fracture limits (see shared/gravity.js for the force formula). */
export const FRACTURE = Object.freeze({
  MAX_ACTIVE: 24,
  MAX_STRENGTH: 60,
  MAX_RADIUS: 16,
  MAX_DURATION: 8,
  /** Velocity change per tick from all fractures combined is clamped to this. */
  MAX_DELTA_V_PER_TICK: 1.6,
  /** Inside this distance the force fades out to avoid a singularity at r -> 0. */
  CORE_RADIUS: 0.8,
});

/** Movement states (finite state machine labels, computed by shared/movement.js). */
export const MoveState = Object.freeze({
  GROUNDED: 0,
  FALLING: 1,
  JUMPING: 2,
  SLIDING: 3,
  WALLRUN: 4,
  GRAPPLING: 5,
  DASHING: 6,
  PHASED: 7,
  STUNNED: 8,
  DEAD: 9,
});
export const MOVE_STATE_NAMES = ['Grounded', 'Falling', 'Jumping', 'Sliding', 'Wall-running', 'Grappling', 'Dashing', 'Phase-shifted', 'Stunned', 'Dead'];

/**
 * Input button bitmask. "Held" bits reflect the current key state, "pressed"
 * bits are edge-triggered (set once in the first command after the key went down)
 * so short taps between 60 Hz samples are never lost.
 */
export const BTN = Object.freeze({
  JUMP: 1 << 0,
  SPRINT: 1 << 1,
  SLIDE: 1 << 2,
  GRAPPLE: 1 << 3,
  FIRE: 1 << 4,
  ALT: 1 << 5,
  INTERACT: 1 << 6,
  JUMP_P: 1 << 7,
  SLIDE_P: 1 << 8,
  GRAPPLE_P: 1 << 9,
  DASH_P: 1 << 10,
  MELEE_P: 1 << 11,
  RELOAD_P: 1 << 12,
  GRAVITY_P: 1 << 13,
  PULSE_P: 1 << 14,
  INTERACT_P: 1 << 15,
});
export const BTN_ALL = (1 << 16) - 1;

/** Game modes. */
export const MODES = Object.freeze({
  SURVIVAL: 'survival',
  FFA: 'ffa',
  COOP: 'coop',
  TRAINING: 'training',
});
export const ONLINE_MODES = Object.freeze([MODES.FFA, MODES.COOP]);

/** Teams used for damage filtering. */
export const TEAM = Object.freeze({ PLAYERS: 1, ENEMIES: 2, NONE: 0 });

/** Survival tuning. */
export const SURVIVAL = Object.freeze({
  BOSS_EVERY: 5,
  ELITE_WAVES_MOD: 5,
  ELITE_WAVE_OFFSET: 3,
  MAX_ALIVE_ENEMIES: 42,
  SPAWN_INTERVAL: 0.55,
  INSTABILITY_START_WAVE: 3,
  UPGRADE_CHOICES: 3,
  COMBO_TIMEOUT_S: 4,
  COMBO_MAX: 10,
});

/** Pool capacities — every pool is bounded. */
export const LIMITS = Object.freeze({
  MAX_PROJECTILES: 512,
  MAX_ENEMIES: 96,
  MAX_PICKUPS: 64,
  MAX_HAZARDS: 64,
  MAX_ECHOES: 96,
  MAX_EVENTS_PER_SNAPSHOT: 256,
  MAX_NAME_LENGTH: 16,
  KILLFEED: 6,
});

/** Grid cell used by the enemy spatial hash. */
export const SPATIAL_CELL = 6;

export const SCORE = Object.freeze({
  FFA_KILL: 100,
  FFA_ASSIST: 40,
  FFA_STREAK_BONUS: 25,
  HEADSHOT_BONUS: 20,
});
