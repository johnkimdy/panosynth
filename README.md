# Panosynth — marketing site

Single-page, fully static marketing site. No backend, no database, no
localStorage — all state is in memory. Three.js is loaded from the jsDelivr
CDN via an import map; everything else is hand-rolled.

## Files

| File | Role |
| --- | --- |
| `index.html` | Page structure, copy, modal, SVG fallback still |
| `styles.css` | HUD visual language, CCTV overlay, responsive + reduced-motion rules |
| `js/hero.js` | **Isolated hero scene module** — all 3D choreography |
| `js/main.js` | DOM logic: telemetry tickers, CCTV overlay, forms, modal, reveals |

## Run locally

ES modules require an HTTP origin — **double-clicking `index.html` (`file://`)
shows only the static still** plus a notice, by design:

```sh
python3 -m http.server 8000
# -> http://localhost:8000
```

### Inspecting a single choreography beat

Append `?heroT=<0..1>` to freeze the hero at a normalized timeline position —
useful while tuning. Examples: `?heroT=0.3` (drone sweep), `?heroT=0.55`
(fusion in progress), `?heroT=0.7` (fused map / orbit), `?heroT=0.84`
(CCTV wall).

## Deploy to Netlify (GitHub → Netlify)

Repo: **https://github.com/johnkimdy/panosynth**

The hero animation needs an HTTP origin (ES modules + Three.js). Netlify serves
the folder over HTTPS, so the live scene works out of the box — no build step.

**Live site:** https://dulcet-madeleine-d6675c.netlify.app

Pushes to `main` auto-deploy via Netlify ↔ GitHub sync (`netlify.toml` sets
`publish = "."`, no build command). To deploy manually from a clone:

```sh
git push origin main
```

### Access-request emails → panosynth@gmail.com

Forms use [Netlify Forms](https://docs.netlify.com/forms/setup/) (`data-netlify`
on both the access and demo-queue forms). After the first deploy:

1. **Site configuration → Forms → Form notifications → Add notification → Email
   notification**.
2. Set the recipient to `panosynth@gmail.com` for both **access** and
   **demo-queue** (or one notification for “all forms”).
3. Confirm the address from Netlify’s verification email.

Submissions also appear under **Forms** in the Netlify dashboard. The footer
mailto link points to `panosynth@gmail.com` as a fallback.

Local `python3 -m http.server` previews validate the UI but do not transmit
form data — only the deployed Netlify site posts submissions.

## Tuning the hero choreography

Everything choreographic lives in the exported `CHOREO` object at the top of
`js/hero.js`:

- `loopSeconds` — total loop length (default 21 s).
- `phases` — normalized timeline boundaries; `main.js` receives these names
  via the `onPhase` callback and drives the CCTV overlay / status readouts
  / loop-reset dip from them.
- `camera` — closed Catmull-Rom keyframes (`pos` + `look`); index 0 is also
  the loop end, so the path is seamless. Add/move keys freely.
- `fuse` / `unfuse` / `unreveal` — `[start, end]` envelopes (normalized loop
  time) for the fusion beat and the quiet rewind under the reset dip.
- `nodes` — fixed posts: position, mast height, sweep cycles/loop (keep
  integral for a seamless loop), phase offset.
- `camFrustum` / `droneFrustum` — drawn cone size, pitch, and sensing range.
- `drones` — entry vectors, hover stations, sweep parameters.
- `platoon` — walk path, figure size, track-box size, object label.
- `points` — candidate count for the coverage sim + quality-tier fractions.

### Coverage simulation (why points appear where they do)

Point reveal is not scripted. At startup `precomputeCoverage()` steps the
timeline and tests every candidate terrain point against every sensor's
actual frustum (yaw sweep × pitch × FOV half-angles × range) with a terrain
line-of-sight check. Points materialize at the loop time they are first
swept; each carries its first-seer's registration error and tint until the
fusion beat aligns the sub-clouds, and points covered by 2+ sensors glow as
they are synthesized. Points never covered are discarded. The platoon
detection moment (blink → track box → label) is found by the same geometry:
the platoon starts outside all sensor ranges and walks into coverage, so
changing `platoon.from/to`, node placement, or sweep speeds moves the
detection time. `precomputeCoverage()` is exported — you can run it in Node
(stubbing `three`) to check detection timing without opening a browser.

Quality degrades automatically: initial tier is chosen by viewport width, and
an FPS governor steps down (`high → med → low`) if the page can't hold ~40 fps.
`prefers-reduced-motion` renders a single still frame at the fused-map beat
(or the SVG still in `index.html` if WebGL is unavailable).

## Content constraints

All geometry is procedural. The terrain is generic ridged value noise — not a
real location; coordinates shown in the HUD/footer are decorative placeholders.
No third-party assets beyond Google Fonts and the Three.js CDN build.
