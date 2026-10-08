/**
 * Quantum Pulse — authoritative weapon simulation.
 *
 * The client only reports "fire is held / alt is held / reload pressed / I
 * want weapon N" inside its input commands. Everything else — ownership,
 * ammunition, reload timers, fire-rate cooldowns, spread, hit detection,
 * damage and kill credit — is decided here.
 * @module server/Weapons
 */
import { BTN, PLAYER, MODES } from '../shared/constants.js';
import { WEAPONS, WeaponType, computeSpread, momentumDamageScale, falloffScale, lanceDamage } from '../shared/weapons.js';
import { dirFromYawPitch } from '../shared/math.js';
import { EV, PK } from '../shared/protocol.js';

const _dir = { x: 0, y: 0, z: 0 };
const _shot = { x: 0, y: 0, z: 0 };

/**
 * Perturb a unit direction inside a cone of half-angle `spread` using the
 * world's seeded RNG (keeps offline runs reproducible).
 */
function applySpread(rng, d, spread, out) {
  if (spread <= 0) { out.x = d.x; out.y = d.y; out.z = d.z; return out; }
  // Build an orthonormal basis (u, v) perpendicular to d.
  let ux, uy, uz;
  if (Math.abs(d.y) < 0.99) { ux = -d.z; uy = 0; uz = d.x; } else { ux = 1; uy = 0; uz = 0; }
  const ul = Math.hypot(ux, uy, uz);
  ux /= ul; uy /= ul; uz /= ul;
  const vx = d.y * uz - d.z * uy, vy = d.z * ux - d.x * uz, vz = d.x * uy - d.y * ux;
  // Uniform disc sample scaled by tan(spread) ≈ spread for small angles.
  const r = Math.sqrt(rng()) * spread;
  const a = rng() * Math.PI * 2;
  const ca = Math.cos(a) * r, sa = Math.sin(a) * r;
  out.x = d.x + ux * ca + vx * sa;
  out.y = d.y + uy * ca + vy * sa;
  out.z = d.z + uz * ca + vz * sa;
  const l = Math.hypot(out.x, out.y, out.z);
  out.x /= l; out.y /= l; out.z /= l;
  return out;
}

function startReload(world, p, ws) {
  if (ws.def.magazine <= 0 || ws.reloadTimer > 0) return;
  if (ws.ammo >= p.magazineOf(ws)) return;
  ws.reloadTimer = ws.def.reloadTime * p.mods.reloadMult;
  ws.charging = false;
  ws.charge = 0;
  world.emit(EV.RELOAD, p.id, p.weaponIndex);
}

/** Damage multiplier from upgrades, momentum and grapple-launch boost. */
function outgoingScale(p) {
  const m = p.move;
  const speed = Math.hypot(m.vx, m.vy * 0.5, m.vz);
  return p.mods.damageMult * momentumDamageScale(speed) * (m.boostTimer > 0 ? 1.1 : 1);
}

/**
 * Process the weapon part of one input command.
 * @param {import('./World.js').World} world
 * @param {import('./Player.js').Player} p
 * @param {object} input validated input command
 * @param {number} dt fixed step
 */
export function updatePlayerWeapons(world, p, input, dt) {
  const b = input.buttons;
  const prev = p.prevButtons;

  // ---- weapon switching (ownership validated) -------------------------------
  if (input.weapon !== p.weaponIndex && p.weapons[input.weapon] && p.weapons[input.weapon].owned) {
    const cur = p.weapons[p.weaponIndex];
    cur.charging = false;
    cur.charge = 0;
    cur.reloadTimer = 0; // switching cancels a reload
    p.weaponIndex = input.weapon;
    p.switchTimer = 0.22;
  }
  p.switchTimer = Math.max(0, p.switchTimer - dt);

  // ---- timers for all weapons ----------------------------------------------------
  for (let i = 0; i < p.weapons.length; i++) {
    const w = p.weapons[i];
    w.cooldown = Math.max(0, w.cooldown - dt);
    w.deflectTimer = Math.max(0, w.deflectTimer - dt);
    w.deflectCooldown = Math.max(0, w.deflectCooldown - dt);
    if (w.reloadTimer > 0 && i === p.weaponIndex) {
      w.reloadTimer -= dt;
      if (w.reloadTimer <= 0) {
        w.reloadTimer = 0;
        w.ammo = p.magazineOf(w);
      }
    }
  }

  const ws = p.weapons[p.weaponIndex];
  const def = ws.def;
  if (!p.canAct || p.move.phaseTimer > 0 && def.type === WeaponType.PROJECTILE) {
    ws.charging = false;
    return;
  }

  if (b & BTN.RELOAD_P) startReload(world, p, ws);
  if (p.switchTimer > 0 || ws.reloadTimer > 0) return;

  const fireHeld = (b & BTN.FIRE) !== 0;
  const firePressed = fireHeld && !(prev & BTN.FIRE);
  const aiming = (b & BTN.ALT) !== 0;

  switch (def.type) {
    case WeaponType.HITSCAN:
    case WeaponType.ECHO:
    case WeaponType.PELLETS:
    case WeaponType.PROJECTILE: {
      if (!fireHeld || !(def.auto || firePressed) || ws.cooldown > 0) break;
      if (def.magazine > 0 && ws.ammo <= 0) { startReload(world, p, ws); break; }
      fireWeapon(world, p, ws, input, aiming, 0);
      break;
    }
    case WeaponType.CHARGE: {
      if (fireHeld && ws.cooldown <= 0 && ws.ammo > 0) {
        ws.charging = true;
        ws.charge = Math.min(1, ws.charge + dt / def.chargeTime);
      } else if (!fireHeld && ws.charging) {
        fireWeapon(world, p, ws, input, aiming, ws.charge);
        ws.charging = false;
        ws.charge = 0;
      } else if (fireHeld && ws.ammo <= 0) {
        startReload(world, p, ws);
      }
      break;
    }
    case WeaponType.MELEE: {
      if ((b & BTN.ALT) && !(prev & BTN.ALT) && ws.deflectCooldown <= 0) {
        ws.deflectTimer = def.deflectWindow;
        ws.deflectCooldown = def.deflectCooldown;
      }
      if (fireHeld && ws.cooldown <= 0) fireWeapon(world, p, ws, input, false, 0);
      break;
    }
    default:
      break;
  }
}

/** Spawn the effects of one trigger pull. */
function fireWeapon(world, p, ws, input, aiming, charge) {
  const def = ws.def;
  const m = p.move;
  const wi = p.weaponIndex;
  ws.cooldown = def.fireInterval / p.mods.fireRateMult;
  if (def.magazine > 0) ws.ammo -= 1;
  p.protectedTimer = 0; // attacking ends spawn protection
  p.stats.shots += def.type === WeaponType.MELEE ? 0 : 1;

  const ex = m.x, ey = m.y + (m.slideTimer > 0 ? PLAYER.SLIDE_EYE_HEIGHT : PLAYER.EYE_HEIGHT), ez = m.z;
  const view = dirFromYawPitch(m.yaw, m.pitch, _dir);
  const hSpeed = Math.hypot(m.vx, m.vz);
  const spread = computeSpread(def, hSpeed, !m.onGround, aiming);
  const scale = outgoingScale(p);
  const rewind = world.clampRewindTick(input.viewTick);

  switch (def.type) {
    case WeaponType.HITSCAN:
    case WeaponType.ECHO: {
      const d = applySpread(world.rng, view, spread, _shot);
      const res = world.traceShot(p, ex, ey, ez, d.x, d.y, d.z, def.range, 0, rewind);
      const dmg = def.damage * scale;
      applyTraceDamage(world, p, res, dmg, def, wi);
      world.emit(EV.FIRE, p.id, wi, q(ex), q(ey), q(ez), q(res.endX), q(res.endY), q(res.endZ), 0);
      if (def.type === WeaponType.ECHO) {
        world.scheduleEcho(p, ex, ey, ez, d.x, d.y, d.z, def.echoDelay, dmg * def.echoDamageMult, wi);
        world.emit(EV.ECHO_MARK, p.id, q(ex), q(ey), q(ez), q(d.x, 3), q(d.y, 3), q(d.z, 3), def.echoDelay);
      }
      break;
    }
    case WeaponType.CHARGE: {
      const d = applySpread(world.rng, view, spread, _shot);
      const res = world.traceShot(p, ex, ey, ez, d.x, d.y, d.z, def.range, def.pierce, rewind);
      applyTraceDamage(world, p, res, lanceDamage(def, charge) * scale, def, wi);
      world.emit(EV.FIRE, p.id, wi, q(ex), q(ey), q(ez), q(res.endX), q(res.endY), q(res.endZ), q(charge));
      break;
    }
    case WeaponType.PELLETS: {
      // Grapple launches modify projectile behaviour: faster, flatter pellets.
      const speedScale = m.boostTimer > 0 ? 1.2 : 1;
      for (let i = 0; i < def.pellets; i++) {
        const d = applySpread(world.rng, view, spread, _shot);
        world.spawnProjectile({
          kind: PK.PELLET, owner: p, team: p.team, x: ex + d.x * 0.4, y: ey - 0.12 + d.y * 0.4, z: ez + d.z * 0.4,
          vx: d.x * def.projectileSpeed * speedScale + m.vx * 0.3, vy: d.y * def.projectileSpeed * speedScale + m.vy * 0.3,
          vz: d.z * def.projectileSpeed * speedScale + m.vz * 0.3,
          gravity: def.projectileGravity * (m.boostTimer > 0 ? 0.5 : 1), life: def.projectileLife, radius: def.projectileRadius,
          damage: def.damage * scale, weapon: wi, stunLight: def.stunLight, lag: world.tick - rewind,
        });
      }
      world.emit(EV.FIRE, p.id, wi, q(ex), q(ey), q(ez), q(ex + view.x * 6), q(ey + view.y * 6), q(ez + view.z * 6), 0);
      break;
    }
    case WeaponType.PROJECTILE: {
      const sp = def.projectileSpeed * (m.boostTimer > 0 ? 1.25 : 1);
      world.spawnProjectile({
        kind: PK.ORB, owner: p, team: p.team, x: ex + view.x * 0.8, y: ey - 0.2 + view.y * 0.8, z: ez + view.z * 0.8,
        vx: view.x * sp + m.vx * 0.5, vy: view.y * sp + m.vy * 0.5, vz: view.z * sp + m.vz * 0.5,
        gravity: def.projectileGravity, life: def.projectileLife, radius: def.projectileRadius,
        damage: def.damage * scale, splashDamage: def.splashDamage * scale, splashRadius: def.splashRadius,
        fracture: def.fracture, weapon: wi, lag: world.tick - rewind,
      });
      world.emit(EV.FIRE, p.id, wi, q(ex), q(ey), q(ez), q(ex + view.x * 3), q(ey + view.y * 3), q(ez + view.z * 3), 0);
      break;
    }
    case WeaponType.MELEE: {
      // Timing reward: swinging again inside the rhythm window deals bonus damage.
      const since = world.time - ws.lastSwing;
      const onBeat = since >= def.timingWindowStart && since <= def.timingWindowEnd;
      ws.lastSwing = world.time;
      const dmg = def.damage * scale * (onBeat ? def.timingBonus : 1);
      const cx = ex + view.x * 1.5, cy = ey - 0.3 + view.y * 1.5, cz = ez + view.z * 1.5;
      world.emit(EV.FIRE, p.id, wi, q(ex), q(ey), q(ez), q(cx), q(cy), q(cz), onBeat ? 1 : 0);
      let hit = false;
      world.forEachTargetNear(p, ex, ey - 0.4, ez, def.range, (target) => {
        const tx = target.x - ex, ty = (target.y + (target.isPlayer ? 1 : 0)) - ey, tz = target.z - ez;
        const tl = Math.hypot(tx, ty, tz) || 1;
        if ((tx * view.x + ty * view.y + tz * view.z) / tl < def.arcCos) return;
        world.applyDamage(target, dmg, p, { weapon: wi, x: target.x, y: target.y + 1, z: target.z, melee: true });
        hit = true;
      });
      world.damagePropsInRadius(cx, cy, cz, 1.8, dmg);
      if (hit) p.stats.hits += 1;
      p.stats.shots += 1;
      break;
    }
    default:
      break;
  }
}

/** Apply the hits returned by World.traceShot. */
function applyTraceDamage(world, p, res, baseDamage, def, wi) {
  let anyHit = false;
  for (let i = 0; i < res.count; i++) {
    const h = res.hits[i];
    const dmg = baseDamage * falloffScale(def, h.t) * (h.head ? def.headMult : 1);
    world.applyDamage(h.target, dmg, p, { weapon: wi, headshot: h.head, x: h.x, y: h.y, z: h.z });
    anyHit = true;
  }
  if (res.prop) world.damageProp(res.prop, baseDamage);
  if (anyHit) p.stats.hits += 1;
}

/**
 * Deflection check for Phase Blades: called by the projectile system for each
 * hostile projectile near a player with an open deflect window.
 * @returns {boolean} true if the projectile was reflected
 */
export function tryDeflect(world, p, proj) {
  const ws = p.weapons[p.weaponIndex];
  if (ws.def.type !== WeaponType.MELEE || ws.deflectTimer <= 0) return false;
  const m = p.move;
  const d = dirFromYawPitch(m.yaw, m.pitch, _dir);
  const ex = m.x, ey = m.y + PLAYER.EYE_HEIGHT, ez = m.z;
  const tx = proj.x - ex, ty = proj.y - ey, tz = proj.z - ez;
  const tl = Math.hypot(tx, ty, tz);
  if (tl > ws.def.deflectRange || (tx * d.x + ty * d.y + tz * d.z) / (tl || 1) < 0.2) return false;
  const speed = Math.max(20, Math.hypot(proj.vx, proj.vy, proj.vz) * 1.2);
  proj.vx = d.x * speed; proj.vy = d.y * speed; proj.vz = d.z * speed;
  proj.team = p.team;
  proj.owner = p;
  proj.kind = PK.DEFLECTED;
  proj.damage *= 1.5;
  proj.life = 2;
  world.emit(EV.DEFLECT, p.id, q(proj.x), q(proj.y), q(proj.z));
  return true;
}

/** Starting loadouts by mode. */
export function grantLoadout(p, mode) {
  for (const ws of p.weapons) ws.owned = false;
  if (mode === MODES.SURVIVAL) {
    [0, 1, 4].forEach((i) => p.grantWeapon(i));
  } else {
    for (let i = 0; i < WEAPONS.length; i++) p.grantWeapon(i);
  }
  p.weaponIndex = 0;
}

function q(v, d = 2) {
  const m = 10 ** d;
  return Math.round(v * m) / m;
}
