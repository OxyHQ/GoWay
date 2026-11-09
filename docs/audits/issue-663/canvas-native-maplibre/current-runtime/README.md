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
