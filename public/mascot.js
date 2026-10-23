// Blots mascots: a small soft 3D ball, ray traced per pixel so light, shadow and the face all sit on the surface.
// Every part is a user choice. Renders are cached by look, mood and size; moods animate with CSS only.
export const LOOK_OPTIONS = {
  body: [['round', 'Round'], ['mochi', 'Mochi'], ['egg', 'Egg']],
  eyes: [['tall', 'Tall'], ['dots', 'Dots'], ['happy', 'Happy'], ['sparkle', 'Sparkle'], ['sleepy', 'Sleepy'], ['wink', 'Wink'], ['calm', 'Calm']],
  mouth: [['smile', 'Smile'], ['grin', 'Grin'], ['oh', 'Oh'], ['cat', 'Cat'], ['flat', 'Flat'], ['none', 'None']],
  extra: [['none', 'None'], ['bear', 'Bear ears'], ['bunny', 'Bunny ears'], ['antenna', 'Antenna'], ['bun', 'Bun'], ['sprout', 'Sprout'], ['glasses', 'Glasses']],
  finish: [['soft', 'Soft'], ['clay', 'Clay'], ['gummy', 'Gummy']],
};
export const SWATCHES = ['#2155ee', '#227f92', '#6b57bb', '#d0567a', '#e0782e', '#3f9a5c', '#c9a227', '#5d6472'];
const BASE = { body: 'round', eyes: 'tall', mouth: 'smile', extra: 'none', finish: 'soft', cheeks: true };
const PRESETS = { scout: { eyes: 'dots', extra: 'antenna' }, quill: { eyes: 'happy', body: 'mochi' } };
export function lookOf(bot) {
  const look = { ...BASE, ...PRESETS[bot?.id], ...bot?.look };
  for (const [key, options] of Object.entries(LOOK_OPTIONS)) if (!options.some(([value]) => value === look[key])) look[key] = BASE[key];
  look.cheeks = look.cheeks !== false;
  return look;
}
export function randomLook() {
  const pick = key => LOOK_OPTIONS[key][Math.floor(Math.random() * LOOK_OPTIONS[key].length)][0];
  return { body: Math.random() < .5 ? 'round' : pick('body'), eyes: pick('eyes'), mouth: pick('mouth'), extra: Math.random() < .35 ? 'none' : pick('extra'), finish: Math.random() < .6 ? 'soft' : pick('finish'), cheeks: Math.random() < .7 };
}

// ── Vectors and color ────────────────────────────────────
const norm = ([x, y, z]) => { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const lin = hex => [1, 3, 5].map(i => (parseInt(hex.slice(i, i + 2), 16) / 255) ** 2.2);
const srgb = v => Math.round(255 * Math.min(1, Math.max(0, v)) ** (1 / 2.2));
const mixl = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const LIGHT = norm([-.5, .72, .58]), HALF = norm([LIGHT[0], LIGHT[1], LIGHT[2] + 1]);
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ── Face: strokes and fills in the face's own surface coordinates (u right, v up; the ball's radius is 1) ──
const quad = (a, c, b, n = 10) => Array.from({ length: n + 1 }, (_, i) => { const t = i / n, s = 1 - t; return [s * s * a[0] + 2 * s * t * c[0] + t * t * b[0], s * s * a[1] + 2 * s * t * c[1] + t * t * b[1]]; });
function segDist(points, u, v) {
  let best = 1e9;
  for (let i = 0; i < points.length - 1; i++) {
    const [ax, ay] = points[i], [bx, by] = points[i + 1], dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((u - ax) * dx + (v - ay) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(u - ax - t * dx, v - ay - t * dy));
  }
  return best;
}
const ellipse = (u, v, x, y, rx, ry) => (Math.hypot((u - x) / rx, (v - y) / ry) - 1) * Math.min(rx, ry);
const EYE_X = .25, EYE_Y = .1, MOUTH_Y = -.13, STROKE = .028, FACE_SCALE = 1.45;
// Each eye: { fill: [x, y, rx, ry] } is a glossy bead; { lines } are drawn strokes. Relative to the eye's center.
const EYES = {
  tall: () => ({ fill: [0, 0, .07, .11] }),
  dots: () => ({ fill: [0, 0, .075, .075] }),
  sparkle: () => ({ fill: [0, 0, .105, .115], sparkle: true }),
  happy: () => ({ lines: [quad([-.085, -.025], [0, .12], [.085, -.025])] }),
  sleepy: () => ({ lines: [quad([-.085, .02], [0, -.075], [.085, .02])] }),
  calm: () => ({ lines: [[[-.075, 0], [.075, 0]]] }),
  annoyed: side => ({ lines: [[[-.06 * side, .06], [.055 * side, 0], [-.06 * side, -.06]]] }),
  dizzy: () => ({ lines: [Array.from({ length: 40 }, (_, i) => { const t = i / 39 * 4 * Math.PI, r = .012 + t * .0068; return [r * Math.cos(t), r * Math.sin(t)]; })] }),
};
const MOUTHS = {
  smile: { lines: [quad([-.085, .015], [0, -.075], [.085, .015])] },
  cat: { lines: [quad([-.1, .01], [-.05, -.07], [0, .01]), quad([0, .01], [.05, -.07], [.1, .01])] },
  flat: { lines: [[[-.06, 0], [.06, 0]]] },
  wobble: { lines: [Array.from({ length: 16 }, (_, i) => [-.09 + i / 15 * .18, Math.sin(i / 15 * 3 * Math.PI) * .018])] },
  oh: { hole: [0, -.01, .045, .058] },
  grin: { grin: true },
  none: {},
};
const MOOD_EYES = { done: 'happy', waiting: 'sparkle', paused: 'sleepy', annoyed: 'annoyed', dizzy: 'dizzy', working: 'dots' };
const MOOD_MOUTH = { waiting: 'oh', annoyed: 'wobble', dizzy: 'oh', paused: 'flat', done: 'grin' };
const MOOD_GAZE = { thinking: [.5, .5], working: [0, -.5], paused: [0, -.5] };

// How the face covers one surface point: ink coverage, bead tilt, and tongue, cheek and sparkle blends.
function faceAt(u, v, face, aa) {
  const out = { ink: 0, bead: 0, bu: 0, bv: 0, tongue: 0, cheek: 0, white: 0 };
  const cover = d => Math.min(1, Math.max(0, .5 - d / aa));
  for (const [side, ex] of [[-1, -EYE_X], [1, EYE_X]]) {
    const eye = face.eyes[side < 0 ? 0 : 1], du = u - ex, dv = v - EYE_Y;
    if (Math.abs(du) > .2 || Math.abs(dv) > .2) continue;
    if (eye.fill) {
      const [x, y, rx, ry] = eye.fill, c = cover(ellipse(du, dv, x, y, rx, ry));
      if (c > 0) { out.ink = Math.max(out.ink, c); out.bead = c; out.bu = (du - x) / rx; out.bv = (dv - y) / ry; }
      if (eye.sparkle) out.white = Math.max(out.white, cover(Math.hypot(du + .035, dv - .045) - .03) * c, cover(Math.hypot(du - .03, dv + .04) - .014) * c);
    }
    for (const points of eye.lines || []) out.ink = Math.max(out.ink, cover(segDist(points, du, dv) - STROKE));
  }
  if (face.glasses) {
    for (const ex of [-EYE_X, EYE_X]) out.ink = Math.max(out.ink, cover(Math.abs(Math.hypot(u - ex, v - EYE_Y) - .15) - .014));
    out.ink = Math.max(out.ink, cover(segDist(quad([-.1, EYE_Y + .01], [0, EYE_Y + .05], [.1, EYE_Y + .01], 6), u, v) - .014));
  }
  const mv = v - MOUTH_Y, m = face.mouth;
  if (Math.abs(u) < .2 && Math.abs(mv) < .16) {
    for (const points of m.lines || []) out.ink = Math.max(out.ink, cover(segDist(points, u, mv) - STROKE * .9));
    if (m.hole) out.ink = Math.max(out.ink, cover(ellipse(u, mv, ...m.hole)));
    if (m.grin) {
      const c = cover(Math.max(Math.hypot(u, mv - .02) - .095, mv - .02));
      out.ink = Math.max(out.ink, c); out.tongue = c * cover(Math.hypot(u, mv + .07) - .05);
    }
  }
  if (face.cheeks) for (const cx of [-.38, .38]) out.cheek = Math.max(out.cheek, .55 * (1 - smooth(.02, .11, Math.hypot((u - cx) * .9, (v + .04) * 1.5))));
  return out;
}

// ── Scene: ellipsoids. The body rests on an invisible floor; extras are small parts on top. ──
const BODIES = { round: [0, -.06, 0, .7, .7, .7], mochi: [0, -.12, 0, .76, .62, .7], egg: [0, -.04, 0, .64, .74, .64] };
function scene(look, color) {
  const [x, y, z, rx, ry, rz] = BODIES[look.body], top = y + ry, darker = mixl(color, [0, 0, 0], .25), parts = [{ c: [x, y, z], r: [rx, ry, rz], albedo: color, body: true }];
  const add = (c, r, albedo, gloss = 0) => parts.push({ c, r, albedo, gloss });
  if (look.extra === 'bear') for (const s of [-1, 1]) add([s * rx * .66, top - .1, -.12], [.19, .19, .15], color);
  if (look.extra === 'bunny') for (const s of [-1, 1]) add([s * .24, top + .18, -.14], [.11, .3, .09], color);
  if (look.extra === 'bun') add([0, top + .02, -.12], [.2, .18, .2], darker);
  if (look.extra === 'antenna') { add([0, top + .12, -.05], [.022, .16, .022], darker); add([0, top + .3, -.05], [.075, .075, .075], lin('#ffd36e'), .5); }
  if (look.extra === 'sprout') { add([0, top + .05, -.04], [.02, .1, .02], lin('#3f9a5c')); add([-.1, top + .16, -.04], [.11, .045, .06], lin('#6bd18a')); add([.1, top + .19, -.04], [.11, .045, .06], lin('#4caf6a')); }
  return { parts, floor: y - ry };
}
// Orthographic rays along -z: the nearest ellipsoid surface under (x, y).
function hit(parts, x, y) {
  let best = null, bestZ = -1e9;
  for (const p of parts) {
    const qx = (x - p.c[0]) / p.r[0], qy = (y - p.c[1]) / p.r[1], k = 1 - qx * qx - qy * qy;
    if (k < 0) continue;
    const z = p.c[2] + Math.sqrt(k) * p.r[2];
    if (z > bestZ) { bestZ = z; best = p; }
  }
  if (!best) return null;
  const qx = (x - best.c[0]) / best.r[0], qy = (y - best.c[1]) / best.r[1], qz = (bestZ - best.c[2]) / best.r[2];
  return { part: best, y, q: [qx, qy, qz], n: norm([qx / best.r[0], qy / best.r[1], qz / best.r[2]]) };
}

const FINISH = { soft: { ks: .16, shine: 14, sss: .55 }, clay: { ks: .04, shine: 6, sss: .35 }, gummy: { ks: .32, shine: 26, sss: .9 } };
function render(color, look, mood, gaze, px) {
  const albedo = lin(color), { parts, floor } = scene(look, albedo), finish = FINISH[look.finish];
  const eyeKind = MOOD_EYES[mood] || look.eyes, mouthKind = MOOD_MOUTH[mood] || look.mouth;
  const eye = side => (eyeKind === 'wink' ? (side < 0 ? EYES.tall : EYES.happy) : EYES[eyeKind])(side);
  const face = { eyes: [eye(-1), eye(1)], mouth: MOUTHS[mouthKind], cheeks: look.cheeks, glasses: look.extra === 'glasses' };
  // The face is painted around direction f on the body, so turning f turns the whole face over the curve.
  const f = norm([gaze[0] * .42, gaze[1] * .32 - .04, 1]), R = norm([f[2], 0, -f[0]]), U = [f[1] * R[2] - f[2] * R[1], f[2] * R[0] - f[0] * R[2], f[0] * R[1] - f[1] * R[0]];
  const ink = mixl(albedo, [0, 0, 0], .93), tongue = lin('#ff7a93'), blush = lin('#ff6f9c'), bleed = albedo.map(v => Math.min(1, v * v * 3.2 + v * .2));
  const ss = 2, n = px * ss, data = new Float32Array(px * px * 4), aa = 2.6 / n / .7;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const h = hit(parts, ((i + .5) / n * 2 - 1) * 1.08, (1 - (j + .5) / n * 2) * 1.08 + .04);
    if (!h) continue;
    let nn = h.n, a = h.part.albedo, ks = h.part.gloss || finish.ks, shine = finish.shine;
    if (h.part.body) {
      const q = norm(h.q), facing = dot(q, f);
      if (facing > .3) {
        const ft = faceAt(dot(q, R) / FACE_SCALE, dot(q, U) / FACE_SCALE, face, aa / FACE_SCALE / Math.max(.35, facing));
        if (ft.cheek) a = mixl(a, blush, ft.cheek * .5);
        if (ft.ink) {
          a = mixl(a, ink, ft.ink);
          if (ft.bead) { nn = norm([nn[0] + (R[0] * ft.bu + U[0] * ft.bv) * .55 * ft.bead, nn[1] + (R[1] * ft.bu + U[1] * ft.bv) * .55 * ft.bead, nn[2]]); ks += (.9 - ks) * ft.bead; shine += (70 - shine) * ft.bead; }
          else ks *= 1 - ft.ink;
        }
        if (ft.tongue) a = mixl(a, tongue, ft.tongue);
        if (ft.white) a = mixl(a, [1, 1, 1], ft.white);
      }
    }
    // Wrapped key light, sky fill, color bleeding into the shadow side, ground bounce, contact darkening, rim, soft sheen.
    const wrap = Math.max(0, (dot(nn, LIGHT) + .45) / 1.45), sky = .26 + .16 * nn[1];
    const ao = 1 - .5 * Math.exp(-(h.y - floor) / .1) * Math.max(0, .2 - nn[1]);
    const rim = (1 - Math.max(0, nn[2])) ** 3 * .16 * Math.max(0, nn[1] + .4), spec = Math.max(0, dot(nn, HALF)) ** shine * ks;
    const o = ((j / ss | 0) * px + (i / ss | 0)) * 4, bleedAmount = h.part.body ? (1 - wrap) * wrap * finish.sss * 1.6 : 0;
    for (let c = 0; c < 3; c++) data[o + c] += ((a[c] * (wrap * 1.02 + sky + Math.max(0, -nn[1]) * .14) + bleed[c] * bleedAmount) * ao + rim * [.85, .9, 1][c] + spec) / (ss * ss);
    data[o + 3] += 1 / (ss * ss);
  }
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = px;
  const ctx = canvas.getContext('2d'), out = ctx.createImageData(px, px);
  for (let k = 0; k < data.length; k += 4) {
    const alpha = data[k + 3];
    if (!alpha) continue;
    for (let c = 0; c < 3; c++) out.data[k + c] = srgb(data[k + c] / alpha);
    out.data[k + 3] = Math.round(alpha * 255);
  }
  ctx.putImageData(out, 0, 0);
  return canvas.toDataURL();
}

const cache = new Map();
function image(color, look, mood, gaze, px) {
  const key = [color, look.body, look.eyes, look.mouth, look.extra, look.finish, look.cheeks, mood, gaze, px].join('|');
  if (!cache.has(key)) {
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    cache.set(key, render(color, look, mood, gaze, px));
  }
  return cache.get(key);
}
const bucket = size => [32, 48, 64, 96, 128, 192, 256].find(v => v >= size * Math.min(2, window.devicePixelRatio || 1)) || 256;
const colorOf = bot => /^#[0-9a-f]{6}$/i.test(bot?.color) ? bot.color.toLowerCase() : '#2155ee';

// mood: idle | thinking | working | waiting | done | paused | annoyed | dizzy. alive: animate (breath, blink, mood motion).
// gaze: [x, y] in -1..1 turns the face toward a point.
export function mascot(bot, { size = 28, mood = 'idle', alive = false, look = lookOf(bot), gaze } = {}) {
  const color = colorOf(bot), px = bucket(size), g = gaze || MOOD_GAZE[mood] || [0, 0];
  const canBlink = alive && ['tall', 'dots', 'sparkle', 'wink'].includes(MOOD_EYES[mood] || look.eyes);
  const blink = canBlink ? `<img class="m-blink" src="${image(color, { ...look, eyes: 'sleepy' }, mood === 'waiting' || mood === 'working' ? 'idle' : mood, g, px)}" alt="">` : '';
  const extras = mood === 'thinking' ? '<svg class="m-over" viewBox="0 0 100 100"><g class="m-think"><circle cx="82" cy="20" r="3"/><circle cx="89" cy="11" r="3.6"/><circle cx="96" cy="2" r="4.2"/></g></svg>'
    : mood === 'waiting' ? '<svg class="m-over" viewBox="0 0 100 100"><g class="m-badge"><circle cx="86" cy="16" r="9" fill="#e9b25c"/><path d="M86 10.5V17" stroke="#1b1b1e" stroke-width="2.6" stroke-linecap="round"/><circle cx="86" cy="21" r="1.5" fill="#1b1b1e"/></g></svg>'
    : mood === 'paused' ? '<svg class="m-over" viewBox="0 0 100 100"><text class="m-z" x="80" y="20">z</text></svg>' : '';
  const phase = alive ? `;--phase:-${(Date.now() / 1000 % 3600).toFixed(2)}s` : '';
  return `<span class="avatar mascot${alive ? ' alive' : ''}" data-mood="${mood}" style="--size:${size}px;--m-color:${color}${phase}" aria-hidden="true"><span class="m-float"><span class="m-body"><img class="m-img" src="${image(color, look, mood, g, px)}" alt="">${blink}</span></span>${extras}</span>`;
}
// Turns an existing mascot's face toward a point without rebuilding it. Gaze snaps to a small grid so renders are reused.
export function gazeAt(el, bot, gx, gy, { mood = 'idle', look = lookOf(bot) } = {}) {
  const img = el?.querySelector('.m-img'); if (!img) return;
  const q = v => Math.round(Math.max(-1, Math.min(1, v)) * 2) / 2, g = [q(gx), q(gy)];
  if (el.dataset.gaze === g.join()) return;
  el.dataset.gaze = g.join();
  const color = colorOf(bot), px = bucket(parseFloat(el.style.getPropertyValue('--size')) || 28);
  img.src = image(color, look, mood, g, px);
  const blink = el.querySelector('.m-blink'); if (blink) blink.src = image(color, { ...look, eyes: 'sleepy' }, mood, g, px);
}
