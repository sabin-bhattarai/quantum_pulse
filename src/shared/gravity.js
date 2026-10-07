/**
 * Quantum Pulse — Gravity Fracture force model.
 *
 * A Gravity Fracture is a spherical region that pushes or pulls everything
 * inside it: players, enemies, projectiles and pickups. The SAME function runs
 * on the authoritative server and inside client-side movement prediction, so
 * the local player feels fractures without waiting for a round-trip.
 *
 * ---------------------------------------------------------------------------
 * FORCE FORMULA (applied once per fixed simulation step)
 *
 *     deltaV = direction * strength * falloff * envelope * deltaTime / mass
 *
 *   direction : unit vector toward the core (ATTRACT), away from it (REPEL),
 *               or tangential around the vertical axis plus a weak inward pull
 *               (ORBIT).
 *   strength  : configurable effect power in m/s² (clamped to FRACTURE.MAX_STRENGTH).
 *   falloff   : (1 - (d / radius)²) * coreFade. It is 1 near the core and
 *               reaches 0 exactly at the outer radius, so entities feel no
 *               discontinuity when crossing the boundary.
 *               coreFade = smoothstep(0, CORE_RADIUS, d) removes the singular
 *               direction at d -> 0, preventing jitter for entities sitting
 *               in the centre.
 *   envelope  : fades the effect in over the first 0.2 s and out over the last
 *               0.4 s so fractures never switch on/off instantly.
 *   deltaTime : the FIXED simulation step (SIM.DT). Using a variable frame
 *               delta would make the simulation non-deterministic and break
 *               client prediction.
 *   mass      : knockback resistance scale (heavy enemies use > 1).
 *
 * LIMITS: the summed deltaV from all fractures is clamped to
 * FRACTURE.MAX_DELTA_V_PER_TICK, and every entity's final speed is clamped by
 * its own movement code. Together these make it impossible for stacked
 * fractures to launch anything out of the arena.
 *
 * IF MODIFIED: removing the per-tick clamp lets several overlapping
 * fractures accelerate entities to thousands of m/s within a second.
 * ---------------------------------------------------------------------------
 * @module shared/gravity
 */
import { FRACTURE } from './constants.js';
import { clamp, smoothstep } from './math.js';

export const FractureMode = Object.freeze({ ATTRACT: 0, REPEL: 1, ORBIT: 2 });

/**
 * Create a validated fracture description. Parameters are clamped to the
 * global limits so no caller (ability, weapon, enemy, map event) can exceed them.
 * @returns {{id:number,x:number,y:number,z:number,radius:number,strength:number,duration:number,age:number,mode:number,owner:number}}
 */
export function makeFracture(id, x, y, z, radius, strength, duration, mode, owner = 0) {
  return {
    id,
    x, y, z,
    radius: clamp(radius, 1, FRACTURE.MAX_RADIUS),
    strength: clamp(strength, 0, FRACTURE.MAX_STRENGTH),
    duration: clamp(duration, 0.1, FRACTURE.MAX_DURATION),
    age: 0,
    mode: mode | 0,
    owner,
  };
}

/** Fade-in/out envelope in [0, 1]. */
export function fractureEnvelope(f) {
  const fadeIn = clamp(f.age / 0.2, 0, 1);
  const fadeOut = clamp((f.duration - f.age) / 0.4, 0, 1);
  return fadeIn * fadeOut;
}

/**
 * Accumulate the velocity change produced by all active fractures at a point.
 *
 * @param {ArrayLike<object>} fractures active fractures
 * @param {number} count number of entries to read from `fractures`
 * @param {number} px @param {number} py @param {number} pz sample position
 * @param {number} mass knockback resistance (1 = normal)
 * @param {number} dt fixed step
 * @param {{x:number,y:number,z:number}} out receives deltaV (overwritten)
 * @returns {{x:number,y:number,z:number}} out
 */
export function accumulateFractureDeltaV(fractures, count, px, py, pz, mass, dt, out) {
  out.x = 0; out.y = 0; out.z = 0;
  const invMass = 1 / Math.max(0.1, mass);
  for (let i = 0; i < count; i++) {
    const f = fractures[i];
    const dx = f.x - px, dy = f.y - py, dz = f.z - pz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= f.radius * f.radius) continue;
    const d = Math.sqrt(d2);
    const ratio = d / f.radius;
    const falloff = (1 - ratio * ratio) * smoothstep(0, FRACTURE.CORE_RADIUS, d);
    if (falloff <= 0) continue;
    const mag = f.strength * falloff * fractureEnvelope(f) * dt * invMass;
    const inv = 1 / Math.max(d, 1e-4);
    const nx = dx * inv, ny = dy * inv, nz = dz * inv; // unit vector toward the core

    if (f.mode === FractureMode.ATTRACT) {
      out.x += nx * mag; out.y += ny * mag; out.z += nz * mag;
    } else if (f.mode === FractureMode.REPEL) {
      out.x -= nx * mag; out.y -= ny * mag; out.z -= nz * mag;
    } else {
      // ORBIT: tangent = up x toCore = (nz, 0, -nx) on the horizontal plane,
      // plus 35% inward pull so entities circle instead of drifting outward,
      // plus a small lift so grounded entities are not ground into the floor.
      out.x += (nz + nx * 0.35) * mag;
      out.y += (ny * 0.35 + 0.15) * mag;
      out.z += (-nx + nz * 0.35) * mag;
    }
  }
  // Global per-tick clamp (see LIMITS above).
  const l2 = out.x * out.x + out.y * out.y + out.z * out.z;
  const maxDv = FRACTURE.MAX_DELTA_V_PER_TICK;
  if (l2 > maxDv * maxDv) {
    const s = maxDv / Math.sqrt(l2);
    out.x *= s; out.y *= s; out.z *= s;
  }
  return out;
}
