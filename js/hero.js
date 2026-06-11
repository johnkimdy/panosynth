/* ============================================================================
   PANOSYNTH — HERO SCENE MODULE
   ----------------------------------------------------------------------------
   Self-contained Three.js choreography for the hero canvas.

   Public API:
     initHero(canvas, opts) -> { dispose(), setQuality(level), getPhase() }

   opts:
     static   : boolean — render ONE frame at the "fused map" beat and stop
                (used for prefers-reduced-motion).
     freezeT  : number — render ONE frame at this normalized loop time
                (tuning aid; wired to ?heroT= in main.js).
     onPhase  : (name) => void — fired on timeline phase boundaries.
     onDetect : (meta) => void — fired when the platoon is detected.

   How the point cloud works (this is the "real simulation" part):
     At startup, precomputeCoverage() steps through the loop timeline and runs
     every candidate terrain point through every sensor's actual view frustum
     (yaw sweep + pitch + FOV half-angles + range) including a terrain
     line-of-sight check. Each point that is ever covered gets:
       aSeenT — the loop time it is FIRST swept (it materializes then)
       first  — which sensor saw it (its sub-cloud tint + registration error)
       aOver  — whether 2+ sensors cover it (those "synthesize": glow on fuse)
     Points never covered by any camera are discarded — nothing appears that
     a sensor did not actually look at. The platoon detection moment is found
     the same way: the first loop time any frustum sweeps over the moving
     platoon with clear line of sight.

   All choreography lives in CHOREO below.
   ========================================================================= */

import * as THREE from 'three';

const TAU = Math.PI * 2;

/* ============================================================================
   CHOREOGRAPHY — the tuning surface
   ========================================================================= */
export const CHOREO = {
  loopSeconds: 21,

  phases: [
    { t: 0.000, name: 'scan'  },      // fixed posts sweep, terrain paints in
    { t: 0.220, name: 'sweep' },      // drones arrive, coverage widens
    { t: 0.460, name: 'fuse'  },      // sub-clouds align -> one map
    { t: 0.620, name: 'orbit' },      // long orbital arc around the fused map
    { t: 0.955, name: 'reset' },      // dip to dark, state rewinds, loop
  ],

  // Closed Catmull-Rom camera path (pos + lookAt); index 0 is also the end.
  camera: [
    { pos: [-18,  3.5, 34], look: [ 0, 7, -20] },
    { pos: [ 10,  6.0, 28], look: [ 0, 6, -25] },
    { pos: [ 17, 13.0, 22], look: [ 0, 5, -30] },
    { pos: [  0, 26.0, 30], look: [ 0, 2, -25] },
    { pos: [-24, 19.0, 12], look: [ 0, 2, -22] },
    { pos: [-27,  9.0, 30], look: [ 0, 5, -22] },
  ],

  fuse:     [0.46, 0.62],             // sub-cloud registration errors collapse
  unfuse:   [0.93, 0.975],            // quiet rewind under the reset dip
  unreveal: [0.945, 0.99],

  // Coverage simulation window + resolution (loop-normalized).
  scanWindow: [0.02, 0.62],
  simSteps: 84,

  // Fixed posts: position, mast height, sweep cycles/loop (integer = seamless
  // loop), phase offset. Sweep is ±90° about "north" (-z).
  nodes: [
    { x: -30, z:  -6, mast: 3.4, cycles: 1, ph: 0.0 },
    { x: -14, z:  -1, mast: 3.0, cycles: 2, ph: 1.3 },
    { x:   2, z:  -9, mast: 3.6, cycles: 1, ph: 2.7 },
    { x:  16, z:  -3, mast: 3.1, cycles: 2, ph: 4.1 },
    { x:  30, z: -11, mast: 3.5, cycles: 1, ph: 5.2 },
    { x:  -4, z: -26, mast: 3.8, cycles: 1, ph: 3.4 },
  ],
  // FOV: half-angles are w/len, h/len. `len` is only the drawn cone; `range`
  // is the sensing reach used by the coverage simulation (same angles).
  camFrustum:   { len: 4.6, w: 1.9, h: 1.25, pitch: -0.24, range: 30 },
  droneFrustum: { len: 3.4, w: 1.5, h: 1.05, pitch: -0.90, range: 22 },

  // Drones: entry vector -> hover station; sweep relative to travel heading.
  drones: [
    { from: [-70, 22,  10], to: [-16, 13, -16], delay: 0.10, dur: 0.30, cycles: 2, ph: 0.4 },
    { from: [ 72, 26,  -4], to: [ 14, 15, -22], delay: 0.16, dur: 0.30, cycles: 2, ph: 2.2 },
    { from: [ 10, 34, -90], to: [  2, 17,  -4], delay: 0.22, dur: 0.28, cycles: 1, ph: 4.0 },
  ],

  // The moving platoon (thermal figures, far field — deliberately small).
  // Starts OUTSIDE all sensor ranges and walks into coverage, so the
  // simulated detection lands mid-loop (~t=0.47 with this path).
  platoon: {
    from: [-58, 0, -40], to: [6, 0, -20],
    count: 8,
    walk: [0.05, 0.95],               // walking window in loop time
    figure: { w: 0.26, h: 0.46 },     // sprite size — human-small vs ridges
    boxSize: [2.2, 1.6, 4.6],         // track box: [width, height, along-march]
    object: 'INFANTRY UNIT',
  },

  points: { candidates: 16000, med: 0.55, low: 0.3 },
};

/* Palette — attractor-density blues (navy -> cerulean -> teal -> seafoam),
   matching the CSS custom properties. Amber is reserved for detection. */
const COL = {
  bg:    0x04060d,
  teal:  0x61b6c6,                    // primary accent (teal-cyan)
  cer:   0x2f8bb7,                    // cerulean mid
  tealD: 0x226a9e,                    // steel blue dim
  amber: 0xf5a524,
  ridge: 0x15528b,                    // steel-blue ridge contours
  body:  0x0b1322,
};

/* ============================================================================
   Procedural terrain — deterministic value noise, no assets.
   Generic jagged ridges receding "north" (-z) into haze. Not a real location.
   ========================================================================= */
function hash2(x, z) {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function vnoise(x, z) {
  const xi = Math.floor(x), zi = Math.floor(z);
  const xf = x - xi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
  const a = hash2(xi, zi),     b = hash2(xi + 1, zi);
  const c = hash2(xi, zi + 1), d = hash2(xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, z) {
  let amp = 0.5, f = 1, sum = 0;
  for (let i = 0; i < 4; i++) { sum += amp * vnoise(x * f, z * f); amp *= 0.5; f *= 2.1; }
  return sum;
}
export function terrainHeight(x, z) {
  const bands = Math.pow(0.5 + 0.5 * Math.sin(z * 0.16 + fbm(x * 0.05, z * 0.05) * 4.0), 1.6);
  let r = 1.0 - Math.abs(2.0 * fbm(x * 0.045, z * 0.045) - 1.0);
  r = Math.pow(r, 2.2);
  const far = THREE.MathUtils.smoothstep(-z, -10, 70);
  const h = r * (4.5 + 9.5 * far) * (0.35 + 0.65 * bands) + fbm(x * 0.2, z * 0.2) * 1.2;
  return Math.max(h - 0.6, 0);
}

/* ============================================================================
   Sensor poses + frustum math (shared by the SIMULATION and the VISUALS so
   what you see is exactly what was computed).
   ========================================================================= */
const easeIO = (x) => x * x * (3 - 2 * x);
const env = (t, a, b) => THREE.MathUtils.smoothstep(t, a, b);
const clamp01 = (x) => Math.min(Math.max(x, 0), 1);

/** Build the runtime sensor list: 6 posts then N drones. */
function buildSensors(CH) {
  const sensors = [];
  for (const n of CH.nodes) {
    const f = CH.camFrustum;
    const y = terrainHeight(n.x, n.z) + n.mast;
    sensors.push({
      kind: 'cam',
      tanW: f.w / f.len, tanH: f.h / f.len, range: f.range, pitch: f.pitch,
      pose(t, out) {
        out.x = n.x; out.y = y; out.z = n.z;
        out.yaw = Math.sin(TAU * n.cycles * t + n.ph) * Math.PI * 0.5;
        out.active = true;
        return out;
      },
    });
  }
  for (const d of CH.drones) {
    const f = CH.droneFrustum;
    const heading = Math.atan2(-(d.to[0] - d.from[0]), -(d.to[2] - d.from[2]));
    sensors.push({
      kind: 'drone',
      tanW: f.w / f.len, tanH: f.h / f.len, range: f.range, pitch: f.pitch,
      heading,
      pose(t, out) {
        const u = easeIO(clamp01((t - d.delay) / d.dur));
        out.x = THREE.MathUtils.lerp(d.from[0], d.to[0], u);
        out.y = THREE.MathUtils.lerp(d.from[1], d.to[1], u) + Math.sin(TAU * 6 * t + d.ph) * 0.3;
        out.z = THREE.MathUtils.lerp(d.from[2], d.to[2], u);
        out.yaw = heading + Math.sin(TAU * d.cycles * t + d.ph) * 0.9;
        out.active = u > 0.04;
        return out;
      },
    });
  }
  return sensors;
}

/**
 * World offset (dx,dy,dz) from sensor -> sensor-local frame, for a sensor
 * oriented as Ry(yaw)·Rx(pitch) with the view axis along local -z.
 * Exported so the derivation can be verified against Three.js directly.
 */
export function frustumLocal(dx, dy, dz, yaw, pitch, out) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const lx = cy * dx - sy * dz;
  const lz1 = sy * dx + cy * dz;
  out.x = lx;
  out.y = dy * cp + lz1 * sp;
  out.z = -dy * sp + lz1 * cp;
  return out;
}

const _loc = { x: 0, y: 0, z: 0 };
/** Is world point (px,py,pz) inside this sensor's frustum at pose P? */
function inFrustum(sensor, P, px, py, pz) {
  const dx = px - P.x, dy = py - P.y, dz = pz - P.z;
  if (dx * dx + dy * dy + dz * dz > sensor.range * sensor.range) return false;
  frustumLocal(dx, dy, dz, P.yaw, sensor.pitch, _loc);
  const depth = -_loc.z;
  if (depth < 0.8 || depth > sensor.range) return false;
  if (Math.abs(_loc.x) > sensor.tanW * depth) return false;
  if (Math.abs(_loc.y) > sensor.tanH * depth) return false;
  return true;
}

/** Terrain line-of-sight from sensor to point (sampled heightfield ray). */
function hasLOS(sx, sy, sz, px, py, pz, margin) {
  for (let k = 1; k <= 5; k++) {
    const s = k / 6;                       // skip both endpoints
    const x = sx + (px - sx) * s;
    const y = sy + (py - sy) * s;
    const z = sz + (pz - sz) * s;
    if (terrainHeight(x, z) > y + margin) return false;
  }
  return true;
}

/* ============================================================================
   COVERAGE PRECOMPUTE — the deterministic sweep simulation.
   Returns only points that some sensor actually swept, with first-seen times,
   owning sensor, and overlap flags; plus the platoon detection event.
   ========================================================================= */
export function precomputeCoverage(CH = CHOREO) {
  const sensors = buildSensors(CH);
  const N = CH.points.candidates;

  // candidate terrain samples, biased toward ridge crests for readability
  const cand = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    let x = 0, z = 0, h = 0;
    for (let k = 0; k < 5; k++) {
      x = (Math.random() * 2 - 1) * 55;
      z = 14 - Math.random() * 80;
      h = terrainHeight(x, z);
      if (h > 1.0 || Math.random() < 0.3) break;
    }
    cand[i * 3] = x;
    cand[i * 3 + 1] = h + 0.12 + Math.random() * 0.35;
    cand[i * 3 + 2] = z;
  }

  const seenT = new Float32Array(N).fill(9);
  const mask = new Uint16Array(N);
  const first = new Int8Array(N).fill(-1);
  const P = { x: 0, y: 0, z: 0, yaw: 0, active: false };

  const [t0, t1] = CH.scanWindow;
  for (let s = 0; s < CH.simSteps; s++) {
    const t = t0 + (s / (CH.simSteps - 1)) * (t1 - t0);
    for (let si = 0; si < sensors.length; si++) {
      const sensor = sensors[si];
      sensor.pose(t, P);
      if (!P.active) continue;
      const bit = 1 << si;
      for (let i = 0; i < N; i++) {
        const m = mask[i];
        if ((m & bit) !== 0) continue;                  // this sensor already saw it
        if (seenT[i] < 9 && (m & (m - 1)) !== 0) continue; // seen + overlap settled
        const px = cand[i * 3], py = cand[i * 3 + 1], pz = cand[i * 3 + 2];
        if (!inFrustum(sensor, P, px, py, pz)) continue;
        if (!hasLOS(P.x, P.y, P.z, px, py, pz, 0.4)) continue;
        mask[i] = m | bit;
        if (seenT[i] >= 9) { seenT[i] = t; first[i] = si; }
      }
    }
  }

  // compact: keep only points actually covered by some sensor
  let count = 0;
  for (let i = 0; i < N; i++) if (seenT[i] < 9) count++;
  const targets = new Float32Array(count * 3);
  const outSeenT = new Float32Array(count);
  const outFirst = new Int8Array(count);
  const outOver = new Float32Array(count);
  let w = 0;
  for (let i = 0; i < N; i++) {
    if (seenT[i] >= 9) continue;
    targets.set(cand.subarray(i * 3, i * 3 + 3), w * 3);
    outSeenT[w] = seenT[i];
    outFirst[w] = first[i];
    outOver[w] = (mask[i] & (mask[i] - 1)) !== 0 ? 1 : 0;
    w++;
  }

  return {
    sensors, count,
    targets, seenT: outSeenT, first: outFirst, over: outOver,
    detection: simulateDetection(CH, sensors),
  };
}

/** Platoon centroid along its walk, in loop time. */
function platoonPos(CH, t, out) {
  const [w0, w1] = CH.platoon.walk;
  const u = clamp01((t - w0) / (w1 - w0));
  out.x = THREE.MathUtils.lerp(CH.platoon.from[0], CH.platoon.to[0], u);
  out.z = THREE.MathUtils.lerp(CH.platoon.from[2], CH.platoon.to[2], u);
  out.y = terrainHeight(out.x, out.z) + 0.5;
  return out;
}

/** First loop time any sensor's frustum sweeps the moving platoon with LOS. */
function simulateDetection(CH, sensors) {
  const P = { x: 0, y: 0, z: 0, yaw: 0, active: false };
  const c = { x: 0, y: 0, z: 0 };
  const [w0, w1] = CH.platoon.walk;
  for (let s = 0; s <= 240; s++) {
    const t = w0 + (s / 240) * (w1 - w0);
    if (t < CH.scanWindow[0]) continue;
    platoonPos(CH, t, c);
    for (let si = 0; si < sensors.length; si++) {
      sensors[si].pose(t, P);
      if (!P.active) continue;
      if (!inFrustum(sensors[si], P, c.x, c.y, c.z)) continue;
      if (!hasLOS(P.x, P.y, P.z, c.x, c.y, c.z, 0.6)) continue;
      return makeDetectionMeta(CH, t, si, c);
    }
  }
  // geometry never lined up (shouldn't happen with default CHOREO) — scripted
  platoonPos(CH, 0.5, c);
  return makeDetectionMeta(CH, 0.5, 0, c);
}

function makeDetectionMeta(CH, t, sensorIndex, c) {
  const secs = Math.round(t * CH.loopSeconds);
  const ts = `T+00:00:${String(secs).padStart(2, '0')}`;
  const e = String(410 + Math.round(c.x * 0.8)).padStart(4, '0');
  const n = String(7730 - Math.round(c.z * 0.8)).padStart(4, '0');
  const conf = (82 + ((t * 977) % 16)).toFixed(1);
  return {
    t, sensorIndex,
    object: CH.platoon.object,
    conf, ts,
    grid: `38N ${e} ${n}`,
  };
}

/* ============================================================================
   Geometry builders
   ========================================================================= */

function buildTerrainMesh() {
  const geo = new THREE.PlaneGeometry(150, 120, 110, 80);
  geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i) - 28;
    p.setZ(i, z);
    p.setY(i, terrainHeight(x, z) - 0.05);
  }
  geo.computeVertexNormals();
  const mat = new THREE.MeshBasicMaterial({
    color: 0x060a0e, fog: true,
    polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2,
  });
  return new THREE.Mesh(geo, mat);
}

function buildRidgeLines(rows) {
  const verts = [], cols = [];
  const c = new THREE.Color(COL.ridge), bg = new THREE.Color(COL.bg);
  const xSteps = 150;
  for (let r = 0; r < rows; r++) {
    const z = 18 - (r / (rows - 1)) * 100;
    const haze = 1 - THREE.MathUtils.smoothstep(-z, 0, 78) * 0.85;
    const col = c.clone().lerp(bg, 1 - haze);
    let prev = null;
    for (let i = 0; i <= xSteps; i++) {
      const x = -75 + (i / xSteps) * 150;
      const v = [x, terrainHeight(x, z) + 0.02, z];
      if (prev) { verts.push(...prev, ...v); cols.push(col.r, col.g, col.b, col.r, col.g, col.b); }
      prev = v;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.9, fog: true,
  }));
}

function buildGrid() {
  const verts = [];
  for (let x = -40; x <= 40; x += 5) verts.push(x, 0.01, 2, x, 0.01, 26);
  for (let z = 2; z <= 26; z += 5)   verts.push(-40, 0.01, z, 40, 0.01, z);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
    color: COL.tealD, transparent: true, opacity: 0.10, fog: true,
  }));
}

/** Wireframe view-frustum (apex at origin, opens toward -z) + faint fill. */
function buildFrustum({ len, w, h }) {
  const a = [0, 0, 0];
  const c1 = [-w, h, -len], c2 = [w, h, -len], c3 = [w, -h, -len], c4 = [-w, -h, -len];
  const edges = [a, c1, a, c2, a, c3, a, c4, c1, c2, c2, c3, c3, c4, c4, c1].flat();
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(edges, 3));
  const group = new THREE.Group();
  group.add(new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({
    color: COL.teal, transparent: true, opacity: 0.55, fog: true,
  })));
  const fillGeo = new THREE.BufferGeometry();
  fillGeo.setAttribute('position', new THREE.Float32BufferAttribute(
    [a, c1, c2, a, c2, c3, a, c3, c4, a, c4, c1].flat(), 3));
  group.add(new THREE.Mesh(fillGeo, new THREE.MeshBasicMaterial({
    color: COL.cer, transparent: true, opacity: 0.045, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: true,
  })));
  return group;
}

/* ============================================================================
   FOV footprints — each sensor's frustum projected onto the terrain surface,
   showing the live coverage area. A small grid of rays is cast through the
   frustum every frame and marched against the heightfield; vertices land on
   the surface, so the wedge hugs slopes and stops behind ridges (same
   occlusion behaviour as the coverage simulation).
   ========================================================================= */
const FOOT_M = 9, FOOT_N = 5;                  // horizontal × depth samples

function buildFootprints(sensorCount) {
  const mat = new THREE.MeshBasicMaterial({
    color: COL.cer, transparent: true, opacity: 0.055,
    blending: THREE.AdditiveBlending, depthWrite: false,
    side: THREE.DoubleSide, fog: true,
  });
  const meshes = [];
  for (let s = 0; s < sensorCount; s++) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(FOOT_M * FOOT_N * 3), 3));
    const idx = [];
    for (let j = 0; j < FOOT_N - 1; j++) for (let i = 0; i < FOOT_M - 1; i++) {
      const a = j * FOOT_M + i, b = a + 1, c = a + FOOT_M, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    geo.setIndex(idx);
    const m = new THREE.Mesh(geo, mat);
    m.frustumCulled = false;
    meshes.push(m);
  }
  return { meshes, mat };
}

function updateFootprint(mesh, sensor, P) {
  mesh.visible = P.active;
  if (!P.active) return;
  const pos = mesh.geometry.attributes.position.array;
  const cy = Math.cos(P.yaw), sy = Math.sin(P.yaw);
  const cp = Math.cos(sensor.pitch), sp = Math.sin(sensor.pitch);
  let k = 0;
  for (let j = 0; j < FOOT_N; j++) {
    // bias rays downward (bottom of the FOV up to +30% of the top) so every
    // row intersects ground within range
    const vy = -sensor.tanH + sensor.tanH * 1.3 * (j / (FOOT_N - 1));
    for (let i = 0; i < FOOT_M; i++) {
      const vx = ((i / (FOOT_M - 1)) - 0.5) * 2 * sensor.tanW;
      // local ray (vx, vy, -1) -> world via Ry(yaw)·Rx(pitch)
      const y2 = vy * cp + sp;
      const z2 = vy * sp - cp;
      const wx = cy * vx + sy * z2;
      const wy = y2;
      const wz = -sy * vx + cy * z2;
      const inv = 1 / Math.hypot(vx, vy, 1);
      const step = sensor.range / 14;
      let x = P.x, y = P.y, z = P.z;
      for (let s = 1; s <= 14; s++) {
        const d = s * step * inv;
        x = P.x + wx * d; y = P.y + wy * d; z = P.z + wz * d;
        if (y <= terrainHeight(x, z) + 0.05) break;     // ray hit the surface
      }
      pos[k++] = x; pos[k++] = terrainHeight(x, z) + 0.08; pos[k++] = z;
    }
  }
  mesh.geometry.attributes.position.needsUpdate = true;
}

/** Fixed post: mast from the ground up, sweeping PTZ head + small frustum. */
function buildCameraPost(node, CH) {
  const gy = terrainHeight(node.x, node.z);
  const root = new THREE.Group();
  root.position.set(node.x, gy + node.mast, node.z);

  // mast + guy stubs, drawn down to the terrain
  const mastGeo = new THREE.BufferGeometry();
  mastGeo.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0, 0, -node.mast, 0,
    0, -node.mast * 0.85, 0, 0.5, -node.mast, 0.3,
    0, -node.mast * 0.85, 0, -0.5, -node.mast, -0.3,
  ], 3));
  root.add(new THREE.LineSegments(mastGeo, new THREE.LineBasicMaterial({
    color: COL.tealD, transparent: true, opacity: 0.85, fog: true,
  })));

  // sweeping head: housing box + pitched frustum
  const head = new THREE.Group();
  head.add(new THREE.Mesh(
    new THREE.BoxGeometry(0.34, 0.2, 0.42),
    new THREE.MeshBasicMaterial({ color: COL.body, fog: true })));
  head.add(new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(0.34, 0.2, 0.42)),
    new THREE.LineBasicMaterial({ color: COL.teal, transparent: true, opacity: 0.7, fog: true })));
  const fr = buildFrustum(CH.camFrustum);
  fr.rotation.x = CH.camFrustum.pitch;
  head.add(fr);
  root.add(head);
  root.userData.head = head;
  return root;
}

/** Procedural quadcopter — body, arms, rotor rings, spinning blades, gimbal. */
function buildDroneModel(CH) {
  const g = new THREE.Group();
  const bodyMat = new THREE.MeshBasicMaterial({ color: COL.body, fog: true });
  const edgeMat = new THREE.LineBasicMaterial({ color: COL.teal, transparent: true, opacity: 0.55, fog: true });
  const dimMat = new THREE.LineBasicMaterial({ color: COL.tealD, transparent: true, opacity: 0.8, fog: true });

  const bodyGeo = new THREE.BoxGeometry(0.6, 0.16, 0.6);
  g.add(new THREE.Mesh(bodyGeo, bodyMat));
  g.add(new THREE.LineSegments(new THREE.EdgesGeometry(bodyGeo), edgeMat));

  const armGeo = new THREE.BoxGeometry(0.62, 0.035, 0.05);
  const bladeGeo = new THREE.BoxGeometry(0.44, 0.008, 0.03);
  const ringGeo = new THREE.TorusGeometry(0.24, 0.012, 5, 18);
  ringGeo.rotateX(Math.PI / 2);

  for (let i = 0; i < 4; i++) {
    const sx = i & 1 ? 1 : -1, sz = i & 2 ? 1 : -1;
    const arm = new THREE.Mesh(armGeo, bodyMat);
    arm.position.set(sx * 0.33, 0.02, sz * 0.33);
    arm.rotation.y = Math.atan2(sz, sx);
    g.add(arm);

    const hub = new THREE.Group();
    hub.position.set(sx * 0.62, 0.09, sz * 0.62);
    hub.add(new THREE.LineSegments(new THREE.EdgesGeometry(ringGeo), dimMat));
    const blades = new THREE.Group();
    blades.userData.isRotor = true;
    blades.rotation.y = i * 1.3;
    const b1 = new THREE.Mesh(bladeGeo, bodyMat);
    const b2 = new THREE.Mesh(bladeGeo, bodyMat);
    b2.rotation.y = Math.PI / 2;
    blades.add(b1, b2);
    hub.add(blades);
    g.add(hub);
  }

  // camera gimbal under the nose + its frustum (matches the simulated FOV)
  const gimbal = new THREE.Group();
  gimbal.position.set(0, -0.14, -0.18);
  gimbal.add(new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.14, 0.16), bodyMat));
  gimbal.add(new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(0.16, 0.14, 0.16)), edgeMat));
  const fr = buildFrustum(CH.droneFrustum);
  fr.rotation.x = CH.droneFrustum.pitch;
  gimbal.add(fr);
  g.add(gimbal);

  return g;
}

/* ============================================================================
   Point-cloud shader — points exist only where a sensor swept (aSeenT),
   carry their first-seer's registration error + tint until fusion aligns
   them, and overlap points (seen by 2+ sensors) glow once synthesized.
   ========================================================================= */
const POINT_VERT = /* glsl */`
  attribute float aSeenT;
  attribute float aRand;
  attribute float aTint;
  attribute float aOver;
  attribute vec3 aErr;
  uniform float uT, uTime, uFuse, uSize, uPx, uGlow;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    float seen = smoothstep(aSeenT, aSeenT + 0.012, uT);   // painted in by the sweep
    float f = smoothstep(aRand * 0.4, aRand * 0.4 + 0.6, uFuse);
    f = f * f * (3.0 - 2.0 * f);
    vec3 jit = vec3(
      sin(uTime * 1.7 + aRand * 43.0),
      sin(uTime * 2.3 + aRand * 17.0),
      cos(uTime * 1.3 + aRand * 71.0)) * 0.10 * (1.0 - f);
    vec3 pos = position + aErr * (1.0 - f) + jit;
    pos.y += (1.0 - seen) * 0.9;                            // settle on reveal
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;
    float dist = max(-mv.z, 1.0);
    gl_PointSize = uSize * uPx * (1.35 + 0.3 * f + 0.25 * aOver * f) * (160.0 / dist);
    float fog = 1.0 - exp(-dist * 0.010);
    // attractor density colormap: navy/cerulean sub-clouds -> teal fused map,
    // overlap (2+ sensors) drifts toward seafoam — density reads as light
    vec3 cPre = mix(vec3(0.095, 0.33, 0.53), vec3(0.185, 0.545, 0.72), aTint);
    vec3 col = mix(cPre, vec3(0.275, 0.59, 0.69), f);
    col = mix(col, vec3(0.59, 0.82, 0.78), aOver * 0.4 * f);
    vColor = col;
    vAlpha = seen * (0.32 + 0.20 * f) * uGlow * (1.0 - fog * 0.9);
    vAlpha *= 1.0 - smoothstep(0.945, 0.99, uT);            // reset rewind
  }`;
const POINT_FRAG = /* glsl */`
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.12, d) * vAlpha;
    if (a < 0.012) discard;
    gl_FragColor = vec4(vColor, a);
  }`;

function buildPoints(cov, sensorCount) {
  const N = cov.count;
  const rand = new Float32Array(N);
  const tint = new Float32Array(N);
  const err = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    rand[i] = Math.random();
    const si = Math.max(cov.first[i], 0);
    tint[i] = si / Math.max(sensorCount - 1, 1);
    // per-sensor registration error (golden-angle spread) + small noise:
    // each sub-cloud sits visibly off until fusion aligns them
    const a = si * 2.39996;
    err[i * 3]     = Math.cos(a) * 0.42 + (Math.random() - 0.5) * 0.16;
    err[i * 3 + 1] = Math.sin(si * 1.7) * 0.12 + (Math.random() - 0.5) * 0.08;
    err[i * 3 + 2] = Math.sin(a) * 0.42 + (Math.random() - 0.5) * 0.16;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(cov.targets, 3));
  geo.setAttribute('aSeenT', new THREE.BufferAttribute(cov.seenT, 1));
  geo.setAttribute('aOver', new THREE.BufferAttribute(cov.over, 1));
  geo.setAttribute('aRand', new THREE.BufferAttribute(rand, 1));
  geo.setAttribute('aTint', new THREE.BufferAttribute(tint, 1));
  geo.setAttribute('aErr', new THREE.BufferAttribute(err, 3));
  const mat = new THREE.ShaderMaterial({
    vertexShader: POINT_VERT, fragmentShader: POINT_FRAG,
    uniforms: {
      uT:    { value: 0 }, uTime: { value: 0 }, uFuse: { value: 0 },
      uSize: { value: 1 }, uGlow: { value: 1 }, uPx:   { value: 1 },
    },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  return pts;
}

/* ============================================================================
   Thermal platoon + detection visuals
   ========================================================================= */
function makeThermalTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  g.addColorStop(0, 'rgba(255,246,230,1)');
  g.addColorStop(0.35, 'rgba(255,214,168,0.42)');
  g.addColorStop(1, 'rgba(255,200,150,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

function buildPlatoon(CH) {
  const cfg = CH.platoon;
  const tex = makeThermalTexture();
  const mat = new THREE.SpriteMaterial({
    map: tex, color: 0xf2e9dc, transparent: true, opacity: 0,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const group = new THREE.Group();
  const figures = [];
  // formation axes from the walk direction
  const dx = cfg.to[0] - cfg.from[0], dz = cfg.to[2] - cfg.from[2];
  const L = Math.hypot(dx, dz);
  const dir = { x: dx / L, z: dz / L };
  const perp = { x: -dir.z, z: dir.x };
  for (let i = 0; i < cfg.count; i++) {
    const s = new THREE.Sprite(mat);
    s.scale.set(cfg.figure.w, cfg.figure.h, 1);
    const row = i >> 1, col = i & 1;
    s.userData = {
      along: -row * 0.95 + (col ? -0.18 : 0),
      side: (col ? 0.42 : -0.42) + (hash2(i, 7) - 0.5) * 0.2,
      ph: hash2(i, 3) * TAU,
    };
    figures.push(s);
    group.add(s);
  }
  // single off-white detection blink
  const blink = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, color: 0xf6f3ea, transparent: true, opacity: 0,
    depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  blink.scale.set(1, 1, 1);
  group.add(blink);
  // wireframe track box, oriented along the march direction
  const box = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(...cfg.boxSize)),
    new THREE.LineBasicMaterial({ color: COL.amber, transparent: true, opacity: 0 }));
  box.rotation.y = Math.atan2(dir.x, dir.z);   // local +z -> march direction
  group.add(box);
  return { group, figures, blink, box, mat, dir, perp };
}

/* ============================================================================
   DOM label layer — projected mono tags over sensors + the detection readout.
   ========================================================================= */
function makeLabels(container) {
  const root = document.createElement('div');
  root.className = 'scene-labels';
  root.setAttribute('aria-hidden', 'true');
  container.appendChild(root);
  const items = [];
  const v = new THREE.Vector3();
  return {
    add(html, cls, anchor, visibleFn) {
      const el = document.createElement('div');
      el.className = `scene-label ${cls}`;
      el.innerHTML = html;
      root.appendChild(el);
      items.push({ el, anchor, visibleFn, shown: true });
    },
    update(camera, w, h, t) {
      for (const it of items) {
        const vis = it.visibleFn ? it.visibleFn(t) : true;
        v.copy(it.anchor());
        v.project(camera);
        const on = vis && v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
        if (on !== it.shown) { it.el.style.display = on ? 'block' : 'none'; it.shown = on; }
        if (!on) continue;
        const x = (v.x * 0.5 + 0.5) * w;
        const y = (-v.y * 0.5 + 0.5) * h;
        it.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -130%)`;
      }
    },
    dispose() { root.remove(); },
  };
}

/* ============================================================================
   initHero
   ========================================================================= */
export function initHero(canvas, opts = {}) {
  const onPhase = opts.onPhase || (() => {});
  const onDetect = opts.onDetect || (() => {});
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  } catch (e) {
    return null;                                       // caller shows the SVG still
  }
  renderer.setClearColor(COL.bg, 1);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(COL.bg, 0.011);
  const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 400);
  const CH = CHOREO;

  /* --- static world ------------------------------------------------------ */
  scene.add(buildTerrainMesh(), buildRidgeLines(30), buildGrid());

  /* --- coverage simulation (see header) ----------------------------------- */
  const simStart = performance.now();
  const cov = precomputeCoverage(CH);
  const detection = cov.detection;
  console.debug(`[panosynth] coverage sim: ${cov.count}/${CH.points.candidates} points covered, ` +
    `detection at t=${detection.t.toFixed(3)} by sensor ${detection.sensorIndex}, ` +
    `${(performance.now() - simStart).toFixed(0)}ms`);

  /* --- fixed posts --------------------------------------------------------- */
  const posts = CH.nodes.map((n) => {
    const p = buildCameraPost(n, CH);
    scene.add(p);
    return p;
  });

  /* --- drones -------------------------------------------------------------- */
  const droneProto = buildDroneModel(CH);
  const drones = CH.drones.map(() => {
    const d = droneProto.clone(true);
    const rotors = [];
    d.traverse((o) => { if (o.userData.isRotor) rotors.push(o); });
    d.userData.rotors = rotors;
    scene.add(d);
    return d;
  });

  /* --- point cloud --------------------------------------------------------- */
  const points = buildPoints(cov, cov.sensors.length);
  scene.add(points);
  const uni = points.material.uniforms;

  /* --- FOV footprints projected onto the terrain ---------------------------- */
  const feet = buildFootprints(cov.sensors.length);
  scene.add(...feet.meshes);
  let footTick = 0;

  /* --- platoon + detection ------------------------------------------------- */
  const platoon = buildPlatoon(CH);
  scene.add(platoon.group);

  /* --- labels --------------------------------------------------------------- */
  const labels = makeLabels(canvas.parentElement || document.body);
  const pose = { x: 0, y: 0, z: 0, yaw: 0, active: false };
  cov.sensors.forEach((s, i) => {
    if (s.kind === 'cam') {
      const idx = i + 1;
      const anchorV = new THREE.Vector3();
      labels.add(`CAM ${String(idx).padStart(2, '0')}`, 'cam', () => {
        s.pose(0, pose);
        return anchorV.set(pose.x, pose.y + 0.7, pose.z);
      });
    } else {
      const idx = i - CH.nodes.length + 1;
      const anchorV = new THREE.Vector3();
      let lastT = 0;
      labels.add(`DRONE ${String(idx).padStart(2, '0')}`, 'drone', () => {
        s.pose(lastT, pose);
        return anchorV.set(pose.x, pose.y + 0.8, pose.z);
      }, (t) => { lastT = t; s.pose(t, pose); return pose.active; });
    }
  });
  // detection readout — [object] · % likely · timestamp · coordinates
  const detAnchor = new THREE.Vector3();
  labels.add(
    `<b>⊕ TRK-04 ${detection.object} ×${CH.platoon.count}</b><br>` +
    `${detection.conf}% LIKELY · ${detection.ts}<br>` +
    `${detection.grid} · TRACKING`,
    'det',
    () => detAnchor,
    (t) => t >= detection.t && t < 0.94);

  /* --- camera path ---------------------------------------------------------- */
  const posCurve  = new THREE.CatmullRomCurve3(CH.camera.map((k) => new THREE.Vector3(...k.pos)),  true, 'centripetal');
  const lookCurve = new THREE.CatmullRomCurve3(CH.camera.map((k) => new THREE.Vector3(...k.look)), true, 'centripetal');
  const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();

  /* --- quality tiers --------------------------------------------------------- */
  const TIERS = {
    high: { frac: 1.0,           ratio: Math.min(devicePixelRatio, 2),   size: 1.0 },
    med:  { frac: CH.points.med, ratio: Math.min(devicePixelRatio, 1.5), size: 1.15 },
    low:  { frac: CH.points.low, ratio: 1,                               size: 1.3 },
  };
  let quality = 'high';
  function setQuality(level) {
    if (!TIERS[level]) return;
    quality = level;
    points.geometry.setDrawRange(0, Math.floor(cov.count * TIERS[level].frac));
    uni.uSize.value = TIERS[level].size;
    renderer.setPixelRatio(TIERS[level].ratio);
    resize();
  }

  function resize() {
    const w = canvas.clientWidth || canvas.parentElement.clientWidth;
    const h = canvas.clientHeight || canvas.parentElement.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    uni.uPx.value = h / 900;            // keep point size proportional to viewport
  }
  window.addEventListener('resize', resize);
  setQuality(innerWidth < 560 ? 'low' : innerWidth < 900 ? 'med' : 'high');

  /* --- per-frame state from normalized loop time t --------------------------- */
  const centroid = new THREE.Vector3();
  function applyTimeline(t, time) {
    // camera
    posCurve.getPointAt(t, camPos);
    lookCurve.getPointAt(t, camLook);
    camPos.x += Math.sin(time * 0.31) * 0.5;
    camPos.y += Math.sin(time * 0.23) * 0.3;
    camera.position.copy(camPos);
    camera.lookAt(camLook);

    // footprints are ray-marched against the heightfield — refresh every
    // other frame below the high tier
    const updateFeet = quality === 'high' || (footTick++ & 1) === 0;
    feet.mat.opacity = 0.055 * (1 - env(t, 0.93, 0.98));

    // posts: head yaw from the SAME pose function the simulation used
    posts.forEach((p, i) => {
      const s = cov.sensors[i];
      s.pose(t, pose);
      p.userData.head.rotation.y = pose.yaw;
      if (updateFeet) updateFootprint(feet.meshes[i], s, pose);
    });

    // drones: pose + rotor spin
    drones.forEach((d, j) => {
      const s = cov.sensors[CH.nodes.length + j];
      s.pose(t, pose);
      d.position.set(pose.x, pose.y, pose.z);
      d.rotation.y = pose.yaw;
      d.visible = pose.active || t < CH.drones[j].delay + CH.drones[j].dur;
      for (const r of d.userData.rotors) r.rotation.y = time * 38 + r.id;
      if (updateFeet) updateFootprint(feet.meshes[CH.nodes.length + j], s, pose);
    });

    // platoon walk + thermal flicker
    platoonPos(CH, t, centroid);
    const [w0] = CH.platoon.walk;
    const alive = env(t, w0, w0 + 0.03) * (1 - env(t, 0.92, 0.95));
    platoon.mat.opacity = alive * (0.75 + 0.25 * Math.sin(time * 7));
    for (const f of platoon.figures) {
      const u = f.userData;
      const x = centroid.x + platoon.dir.x * u.along + platoon.perp.x * u.side;
      const z = centroid.z + platoon.dir.z * u.along + platoon.perp.z * u.side;
      f.position.set(x, terrainHeight(x, z) + 0.26 + Math.abs(Math.sin(time * 2.6 + u.ph)) * 0.05, z);
    }
    // the formation trails the centroid: rows sit at along ∈ [-3, 0], so the
    // box centers mid-column on the actual figures, on the actual terrain
    const bx = centroid.x + platoon.dir.x * -1.5;
    const bz = centroid.z + platoon.dir.z * -1.5;
    const by = terrainHeight(bx, bz);

    // detection: single off-white blink, then the track box locks on
    const bp = (t - detection.t) / 0.022;
    if (bp >= 0 && bp <= 1) {
      platoon.blink.position.set(bx, by + 0.9, bz);
      platoon.blink.scale.setScalar(2 + 7 * bp);
      platoon.blink.material.opacity = (1 - bp) * alive;
    } else {
      platoon.blink.material.opacity = 0;
    }
    const locked = t >= detection.t && t < 0.94 ? 1 : 0;
    // hard on/off flicker reads as an alert, not a glow
    platoon.box.material.opacity = locked * alive * (Math.sin(time * 9) > -0.15 ? 0.9 : 0.25);
    platoon.box.position.set(bx, by + CH.platoon.boxSize[1] * 0.5 + 0.12, bz);
    detAnchor.set(bx, by + CH.platoon.boxSize[1] + 0.6, bz);

    // point cloud envelopes — fused map sits still at constant brightness
    uni.uT.value = t;
    uni.uFuse.value = env(t, CH.fuse[0], CH.fuse[1]) * (1 - env(t, CH.unfuse[0], CH.unfuse[1]));
    uni.uGlow.value = 1 + env(t, 0.62, 0.72) * 0.12 - env(t, 0.94, 0.99) * 0.5;
    uni.uTime.value = time;

    labels.update(camera, canvas.clientWidth, canvas.clientHeight, t);
  }

  function phaseAt(t) {
    let name = CH.phases[0].name;
    for (const p of CH.phases) if (t >= p.t) name = p.name;
    return name;
  }

  /* --- still modes (reduced motion / ?heroT= tuning) -------------------------- */
  const stillT = opts.static ? 0.70 : (Number.isFinite(opts.freezeT) ? opts.freezeT : null);
  if (stillT !== null) {
    const renderStill = () => {
      resize();
      applyTimeline(stillT, stillT * CH.loopSeconds);
      renderer.render(scene, camera);
      labels.update(camera, canvas.clientWidth, canvas.clientHeight, stillT);
    };
    onPhase(phaseAt(stillT));
    renderStill();
    window.addEventListener('resize', renderStill);
    return {
      dispose() {
        window.removeEventListener('resize', renderStill);
        window.removeEventListener('resize', resize);
        labels.dispose();
        renderer.dispose();
      },
      setQuality,
      getPhase: () => phaseAt(stillT),
    };
  }

  /* --- animation loop + FPS governor + events --------------------------------- */
  let raf = 0, last = null, startMs = null;
  let fpsEMA = 60, lowFrames = 0, currentPhase = '', prevT = 0;

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (!Number.isFinite(now)) now = performance.now();
    if (startMs === null) { startMs = now; last = now; }
    const dt = Math.min(Math.max(now - last, 0), 100);
    last = now;
    const time = Math.max(now - startMs, 0) / 1000;
    let t = (time % CH.loopSeconds) / CH.loopSeconds;
    t = THREE.MathUtils.clamp(t, 0, 0.99999);

    fpsEMA = fpsEMA * 0.95 + (1000 / Math.max(dt, 1)) * 0.05;
    lowFrames = fpsEMA < 40 ? lowFrames + 1 : 0;
    if (lowFrames > 150) {
      lowFrames = 0;
      if (quality === 'high') setQuality('med');
      else if (quality === 'med') setQuality('low');
    }

    const ph = phaseAt(t);
    if (ph !== currentPhase) { currentPhase = ph; onPhase(ph); }
    if (prevT < detection.t && t >= detection.t) onDetect(detection);
    prevT = t;

    applyTimeline(t, time);
    renderer.render(scene, camera);
  }
  resize();
  raf = requestAnimationFrame(frame);

  const onVis = () => { if (document.hidden) { cancelAnimationFrame(raf); } else { raf = requestAnimationFrame(frame); } };
  document.addEventListener('visibilitychange', onVis);

  return {
    dispose() {
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('resize', resize);
      labels.dispose();
      renderer.dispose();
    },
    setQuality,
    getPhase: () => currentPhase,
  };
}
