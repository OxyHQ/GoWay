/**
 * `https://goway.to/street3d/<sceneId>` — one published Street 3D scene.
 *
 * On web this route IS the viewer; `?embed=1` is the same viewer without app
 * chrome, which is what the native app hosts in its WebView. On native it is
 * the native screen around that WebView. See `features/street3d/Street3dScreen`.
 *
 * Public, like the map: viewing a published scene needs no account. Only
 * reporting and contributing are gated, at the moment they are asked for.
 */
export { Street3dScreen as default } from '@/features/street3d/Street3dScreen';
