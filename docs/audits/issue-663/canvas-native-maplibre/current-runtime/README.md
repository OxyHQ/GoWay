# Pixel 8a keyboard and map chrome observation

Scope: Android portion of issue #663 §5, keyboard positioning of search and
map chrome. This does not verify the full §5 positioning checklist.

- App: `to.goway.app.dev`, version `0.2.1`, debug APK; APK SHA-256
  `80cc1d77410960bb3ff150063a2e2de966b1a620e39c5e0de124e5432e8b7f9e`.
  Pulled the installed `base.apk` from the Pixel; its SHA-256 matched exactly.
- JavaScript source: GoWay `feat/issue-663-canvas`, commit `4dbd66e` served
  by the local development Metro server.
- Device: Google Pixel 8a, Android 16, 1080×2400, 420 dpi.
- State: real 3D MapLibre canvas, Places panel collapsed, search focused,
  Android IME open.
- Steps: focused the visible “Search places and addresses” field and captured
  the screen and UI hierarchy while the keyboard was open.
- Observed: the field remained visible at `[120,1293][944,1387]`; the panel
  occupied `[0,1146][1080,1892]`; map controls moved to `[398,819][1038,935]`;
  map credits moved to `[891,998][1059,1135]`, both above the keyboard. The
  focused search field stayed visible; the keyboard covered the lower part of
  the panel. The map remained rendered behind the panel.
- Result: **verified** for this device/build/state. This is a development build,
  not a release-performance measurement. Desktop, other panel detents, legal
  targets, overlays, TalkBack and iPhone remain separate checks.
- Screenshot: `pixel8a-keyboard-search.png`, SHA-256
  `9dcd55344ee0493336f6ef3ce0c5d21e710c9d8827821305c0a5dff71c1bc25c`.

## Expanded mobile panel and map input

In the same app/device session, I dragged the live panel handle through three
positions. The measured panel top was y=1981 px at the starting collapsed
position, y=1321 px at an intermediate position, and y=756 px when expanded.
The panel remained a sibling over the full-screen map. With it expanded, a
single-finger swipe in the still-visible map region moved the map while the
panel stayed at y=756 px. The before/after screenshots show the changed map
labels and framing.

- Before pan: `pixel8a-panel-expanded-before-pan.png`, SHA-256
  `84baeb95ef10369c9b462e63393be73232529241804c65c7a24b74ce7c592647`.
- After pan: `pixel8a-expanded-panel-map-pan.png`, SHA-256
  `268d3a7aed433ee181e08e07a0209238b79dfa56a96a8da6ef100a208a3b2247`.

This mobile record verifies panel movement and interaction in the released map
area; desktop behavior is measured separately below. It does not verify
two-finger pinch.

## Chromium desktop/mobile composition

I ran the GoWay development web export built by CI run `42552012280` from
source SHA `7c62521` (Bloom `17.24.0`) with Chromium `149.0.7827.55`:

- At 1440×900, the lateral panel measured x=16, y=76, 384×808 px. The map
  remained full viewport (1440×900). Dragging the exposed map changed its
  center from `[2.1686,41.3874]` to `[2.1136621793,41.3873986252]`.
- Resizing the same page to 390×844 changed the panel to a bottom sheet. Its
  handle reported `Half open`; the visible sheet region measured y=464.2 to
  844 px. The MapLibre object and canvas identities were unchanged and the
  camera center remained at its desktop-pan value.
- Dragging the map above the mobile sheet changed the center to
  `[2.0587270595,41.3873980897]` while the panel stayed in place. Neither
  viewport had an `aria-modal` element; the browser reported no uncaught errors.

The Android captures above verify collapsed/intermediate/expanded handle
movement on device; this Chromium run verifies the desktop sidebar and retained
map through a responsive resize. Together they verify the §5 panel criterion.
The machine-readable measurements are in `chromium-responsive.json`.

- Desktop: `chromium-desktop-sidebar-1440x900.png`, SHA-256
  `87809ad96cc6e35214543a120936a4fa86c6dc00ccc9f68d57570f1a3075ce3d`.
- Mobile: `chromium-mobile-sheet-390x844.png`, SHA-256
  `bf400a5cd97020cc5d9d58666a0e04be139525b06164cd2bd70df1242df0f2d1`.
- Measurements: `chromium-responsive.json`, SHA-256
  `d774b999a504e26781c063bba7c3c02c9f0c2123726a6e13856b0d71fcfcceed`.
