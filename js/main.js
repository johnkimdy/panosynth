/* ============================================================================
   PANOSYNTH — page logic
   Hero choreography lives in js/hero.js; this file owns everything DOM:
   HUD telemetry, forms, modal, scroll reveals.
   No backend, no storage — all state lives in memory and is discarded.
   ========================================================================= */

import { initHero } from './hero.js';

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ============================================================================
   Phase-driven HUD state
   ========================================================================= */
const dip = document.getElementById('heroDip');
const sysStatus = document.getElementById('sysStatus');
const STATUS = {
  scan:  'SYS // SECTOR SWEEP',
  sweep: 'SYS // TRACKS INBOUND',
  fuse:  'SYS // FUSING SOURCES',
  orbit: 'SYS // MAP LIVE',
  reset: 'SYS // REACQUIRING',
};
// fusion-% telemetry target per phase (random-walks toward these)
const FUSION_TARGET = {
  scan: 12, sweep: 41, fuse: 86, orbit: 99.4, reset: 4,
};
let phase = 'scan';

function onPhase(name) {
  phase = name;
  sysStatus.classList.remove('alert');
  if (STATUS[name]) sysStatus.textContent = STATUS[name];
  if (name === 'reset') dip.classList.add('on');
  if (name === 'scan') dip.classList.remove('on');
}

/* ============================================================================
   Hero init — animated by default, single still frame under reduced motion,
   SVG fallback if WebGL is unavailable.
   ========================================================================= */
const canvas = document.getElementById('heroCanvas');
const still = document.getElementById('heroStill');
// detection event from the hero's coverage simulation
function onDetect(meta) {
  sysStatus.classList.add('alert');
  sysStatus.textContent = `SYS // CONTACT — ${meta.object}`;
}

let hero = null;
// ?heroT=0.55 freezes the hero at a normalized timeline position (tuning aid)
const freezeT = parseFloat(new URLSearchParams(location.search).get('heroT'));
try {
  hero = initHero(canvas, { static: reducedMotion, freezeT, onPhase, onDetect });
} catch (e) {
  hero = null;
}
if (!hero) {
  canvas.hidden = true;
  still.hidden = false;
}
if (reducedMotion) {
  sysStatus.textContent = 'SYS // MAP LIVE';
  document.getElementById('hudFusion').textContent = 'FUSION 99.4%';
}

/* ============================================================================
   Telemetry tickers — monospaced numbers that feel instrumented.
   Pure theater: no real data, paused when hidden or reduced motion.
   ========================================================================= */
if (!reducedMotion && hero) {
  const hudGrid = document.getElementById('hudGrid');
  const hudAz = document.getElementById('hudAz');
  const hudFusion = document.getElementById('hudFusion');
  const hudClock = document.getElementById('hudClock');
  let gridE = 412, gridN = 7731, az = 274.6, el = 3.2, fusion = 0;
  const t0 = Date.now();

  setInterval(() => {
    if (document.hidden) return;
    gridE += (Math.random() - 0.5) * 2;
    gridN += (Math.random() - 0.5) * 2;
    az = (az + (Math.random() - 0.45) * 1.6 + 360) % 360;
    el += (Math.random() - 0.5) * 0.3;
    fusion += (FUSION_TARGET[phase] - fusion) * 0.12;
    hudGrid.textContent = `GRID 38N ${String(Math.round(gridE)).padStart(4, '0')} ${String(Math.round(gridN)).padStart(4, '0')}`;
    hudAz.textContent = `AZ ${az.toFixed(1).padStart(5, '0')}° · EL ${el >= 0 ? '+' : '−'}${Math.abs(el).toFixed(1).padStart(4, '0')}°`;
    hudFusion.textContent = `FUSION ${fusion.toFixed(1).padStart(4, '0')}%`;
    const s = Math.floor((Date.now() - t0) / 1000);
    const hh = String(Math.floor(s / 3600)).padStart(2, '0');
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    hudClock.textContent = `T+${hh}:${mm}:${ss}`;
  }, 250);
}

/* ============================================================================
   Email capture — Netlify Forms on deploy; local preview stays in-memory only.
   ========================================================================= */
const CONTACT_EMAIL = 'panosynth@gmail.com';
const isLocalPreview = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);

function wireForm(formId, noteId) {
  const form = document.getElementById(formId);
  const note = document.getElementById(noteId);
  const formName = form.getAttribute('name');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = form.email.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      note.classList.remove('ok');
      note.textContent = 'INVALID CONTACT FORMAT — CHECK AND RESEND';
      return;
    }
    note.classList.remove('ok');
    note.textContent = 'TRANSMITTING…';
    if (isLocalPreview) {
      form.classList.add('done');
      note.classList.add('ok');
      note.textContent = 'REQUEST LOGGED (LOCAL PREVIEW) — DEPLOY TO NETLIFY TO TRANSMIT';
      return;
    }
    try {
      const body = new URLSearchParams({ 'form-name': formName, email });
      const res = await fetch('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (!res.ok) throw new Error('submit failed');
      form.classList.add('done');
      note.classList.add('ok');
      note.textContent = 'REQUEST LOGGED // CHANNEL SECURE — WE WILL BE IN CONTACT';
    } catch {
      note.textContent = `TRANSMISSION FAILED — EMAIL ${CONTACT_EMAIL.toUpperCase()} DIRECTLY`;
    }
  });
}
wireForm('accessForm', 'accessNote');
wireForm('modalForm', 'modalNote');

/* ============================================================================
   Demo modal (invite-only notice) — native <dialog> for focus/ESC handling.
   ========================================================================= */
const modal = document.getElementById('demoModal');
document.getElementById('ctaTry').addEventListener('click', () => modal.showModal());
document.getElementById('modalClose').addEventListener('click', () => modal.close());
modal.addEventListener('click', (e) => {            // click on backdrop closes
  if (e.target === modal) modal.close();
});

/* ============================================================================
   Scroll reveals
   ========================================================================= */
if (!reducedMotion && 'IntersectionObserver' in window) {
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (en.isIntersecting) { en.target.classList.add('visible'); io.unobserve(en.target); }
    }
  }, { threshold: 0.18 });
  document.querySelectorAll('.reveal').forEach((el) => io.observe(el));
} else {
  document.querySelectorAll('.reveal').forEach((el) => el.classList.add('visible'));
}
