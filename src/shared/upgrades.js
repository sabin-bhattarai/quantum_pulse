/**
 * Quantum Pulse — upgrade catalogue (display data only).
 *
 * The client uses this to render upgrade cards; the authoritative effects live
 * in src/server/Abilities.js and are looked up by `id`.
 * @module shared/upgrades
 */
export const UPGRADE_INFO = Object.freeze([
  { id: 'vitality', name: 'Quantum Vitality', desc: '+25 max health' },
  { id: 'overclock', name: 'Overclock', desc: '+12% weapon damage' },
  { id: 'quickhands', name: 'Quick Hands', desc: '20% faster reloads' },
  { id: 'capacitor', name: 'Deep Capacitor', desc: '+25% magazine size' },
  { id: 'resonance', name: 'Resonance', desc: '+25% Pulse Charge gain' },
  { id: 'aegis', name: 'Aegis Lattice', desc: '+25 max shield, faster regeneration' },
  { id: 'tempo', name: 'Tempo Core', desc: '+10% fire rate' },
  { id: 'leech', name: 'Rift Leech', desc: 'Kills restore 6 health' },
  { id: 'stride', name: 'Long Stride', desc: '+5% movement speed' },
  { id: 'unlock_lance', name: 'Vector Lance', desc: 'Unlock the piercing charge beam', weapon: 2 },
  { id: 'unlock_singularity', name: 'Singularity Launcher', desc: 'Unlock the gravity orb launcher', weapon: 3 },
  { id: 'unlock_echo', name: 'Echo Repeater', desc: 'Unlock delayed echo shots', weapon: 5 },
]);

export function upgradeInfo(id) {
  return UPGRADE_INFO.find((u) => u.id === id) || null;
}
