# Contributing to Quantum Pulse

Thank you for helping build Quantum Pulse. This is a real-time, server-authoritative multiplayer game, and small mistakes can turn into exploits, desyncs or frame drops. These rules are strict on purpose. A pull request that doesn't follow them will be asked to change before review continues.

---

## 1. Ground rules

- **The server is the authority.** Never move a gameplay decision (damage, hits, ammunition, cooldowns, kills, score, position) into the browser. The client may *predict* or *preview*, and the server decides.
- **Determinism matters.** Code in `src/shared/movement.js` and `src/shared/gravity.js` runs on both sides. It must be a pure function of state, input, environment and the fixed `dt`: no `Math.random()`, no wall-clock time, no variable timestep.
- **Everything is bounded.** Every array that grows during play needs a cap and a defined behaviour when the cap is reached.
- **No per-frame garbage in hot paths.** Reuse scratch objects and pools in render, tick and network loops.
- **Original work only.** Don't add copyrighted assets or code copied from other games. Procedural or self-made content only, and new third-party libraries need a compatible licence and a short justification in the PR.
- **Never commit secrets** (`.env` files, keys, tokens).

## 2. Branch strategy

| Branch | Purpose | Merges into |
|---|---|---|
| `main` | Production-ready code only. Every commit must pass CI and be deployable. | — |
| `develop` | Active integration branch | `main` (release PRs only) |
| `feature/<mechanic-name>` | New features, e.g. `feature/gravity-rails` | `develop` |
| `fix/<bug-description>` | Bug fixes, e.g. `fix/grapple-ceiling-snag` | `develop` (hotfixes: `main` + back-merge) |
| `refactor/<system-name>` | Internal restructuring with no behaviour change, e.g. `refactor/enemy-fsm` | `develop` |
| `docs/<topic>` | Documentation-only changes, e.g. `docs/networking-diagram` | `develop` |
| `performance/<optimization-name>` | Performance work, e.g. `performance/instanced-players` | `develop` |

- Branch names are lowercase and kebab-case.
- Don't push directly to `main` or `develop`.
- Rebase on the latest `develop` before requesting review, and keep history linear.

## 3. Commits

- One logical change per commit. Don't mix unrelated changes, and keep formatting-only changes in their own commit.
- Write commit messages in the imperative mood with a short summary (≤ 72 characters) and a body explaining *why*:

  ```
  Clamp fracture delta-v per tick

  Stacked fractures could accelerate players past the arena bounds.
  ```
- Every commit should build and pass `npm test` and `npm run check`.

## 4. Pull request requirements

Every PR **must** include:

1. **A clear title** that describes the change, e.g. "Add rotating corridors to The Folded Archive".
2. **Problem**: what is wrong or missing, and why it matters.
3. **Solution**: what you changed and why you chose this approach over the alternatives.
4. **Testing steps** a reviewer can follow, including the mode, arena and inputs.
5. **Screenshots or recordings** for any visual change (before/after).
6. **Network testing details** for anything touching multiplayer: number of clients, simulated latency/jitter/loss (e.g. Chrome DevTools throttling or `tc netem`), and what you observed (corrections, rubber-banding, hit registration).
7. **Performance metrics** for rendering or simulation changes: FPS and frame time from the debug overlay, draw calls, particle counts and server tick time, before vs. after, on stated hardware.
8. **Migration notes** for protocol changes: bump `PROTOCOL_VERSION` in `src/shared/constants.js`, list the changed messages or fields, and explain how old clients behave (they are rejected with a version mismatch).
9. **Documentation updates** whenever behaviour, controls, configuration or the protocol changes (README, in-game How to Play, code comments).
10. **Tests for deterministic logic.** New or changed movement, gravity, validation, weapon, damage or scoring rules need unit tests in `tests/`.

Also:
- Keep PRs focused. Split large features into reviewable steps behind sensible defaults.
- Resolve every review comment, either with a change or with a reasoned reply, before merging. The reviewer resolves the thread.
- Merging requires at least one approving review and green checks (`npm test`, `npm run check`).

### PR template

```markdown
## Problem
## Solution
## Testing steps
## Screenshots / recordings
## Network testing (if multiplayer)
## Performance (if rendering/simulation)
## Protocol migration notes (if protocol changed)
## Checklist
- [ ] Tests added/updated for deterministic logic
- [ ] Docs updated
- [ ] No client-trusted gameplay values
- [ ] No unbounded arrays / per-frame allocations in hot paths
- [ ] Mandatory math/physics comments present (section 6)
```

## 5. Code review requirements

Reviewers must explicitly check:

| Area | Questions |
|---|---|
| **Gameplay correctness** | Does it behave as described in every mode it affects? Are edge cases handled (death mid-action, respawn, reconnect, match end)? |
| **Server authority** | Is every gameplay outcome computed on the server? Could a modified client gain anything? |
| **Exploit resistance** | Are inputs validated, clamped and rate-limited? Can it be spammed, stacked or chained without bound? Are speeds and forces capped? |
| **Performance** | Allocations in loops? New draw calls? Pool sizes? Algorithmic complexity at maximum entity counts? |
| **Accessibility** | Readable telegraphs (shape, sound and colour, never colour alone)? Works with the colour-blind palette, reduced flashes and rebinding? |
| **Error handling** | Graceful failure (no WebGL, no WebSocket, storage blocked, server down)? Clear messages? |
| **Backward compatibility** | Protocol version bumped when needed? Saved settings and best scores still load? |
| **Visual readability** | Can a new player tell what is dangerous, interactive or friendly within a second? |

## 6. Mandatory documentation comments

Any code involving **Boids, gravity vectors, client prediction, server reconciliation, interpolation, lag compensation, collision response, procedural generation, spatial hashing, or quaternion/matrix math** must include a comment block explaining:

1. **What the math does.**
2. **Why it is needed.**
3. **What assumptions it makes.**
4. **What limits or clamps are applied.**
5. **What could go wrong if it is modified.**

Existing examples to follow: the force formula in `src/shared/gravity.js`, the collision response in `src/shared/movement.js` (`sweepAxis`), the Boids explanation in `src/server/Enemy.js` (`updateSwarm`), the spatial hash in `src/server/SpatialHash.js`, `src/client/Prediction.js`, `src/client/Interpolation.js` and `World.clampRewindTick`.

PRs that add such code without this comment block will not be merged.

## 7. Style

- ES modules and ES2022 syntax, `class` for stateful systems, plain functions for pure logic.
- JSDoc on every exported function and class.
- Named constants in `src/shared/constants.js` (or a local `const` with a comment), never unexplained magic numbers.
- 2-space indentation, single quotes and semicolons, matching the existing code.
- Browser modules import shared code with absolute paths (`/shared/...`). Code in `src/` uses relative imports. Simulation code in `src/server/` (except `GameServer.js`) must stay isomorphic: no Node built-ins and no DOM.
- Never use `eval`, `new Function` or `innerHTML` with dynamic data. Insert text with `textContent`.

## 8. Testing

```bash
npm test         # node:test suite
npm run check    # syntax-check every JS file
```

- Unit-test pure logic directly. Test server systems through `Room` and `World` with scripted inputs (see `tests/weapons.test.js` and `tests/coop.test.js`).
- Before merging anything that touches gameplay, play it: Solo Survival to at least wave 5, plus a two-client online session for networked features.

## 9. Reporting security issues

Please don't open public issues for exploits. Report them privately to the maintainers with reproduction steps, and allow reasonable time for a fix before disclosure.
