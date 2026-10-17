/**
 * The logo's accessible name, in each platform's own vocabulary.
 *
 * `react-native-svg` on the web hands its props to the DOM `<svg>` as they
 * are, so React Native's `accessible` / `accessibilityRole` /
 * `accessibilityLabel` landed there as unknown attributes: the logo had no
 * accessible name in a browser, and React warned about `accessible` on every
 * map. The web gets ARIA; iOS and Android keep React Native's props, which
 * the native SVG view does read.
 *
 * An empty label hides the logo from assistive technology on both: a
 * decorative logo beside its own name is noise in a screen reader.
 */
export type LogoAccessibility =
  | { role: 'img'; 'aria-label': string }
  | { 'aria-hidden': true }
  | { accessible: true; accessibilityRole: 'image'; accessibilityLabel: string }
  | { accessible: false };

export function logoAccessibility(label: string, os: string): LogoAccessibility {
  if (os === 'web') return label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true };
  return label
    ? { accessible: true, accessibilityRole: 'image', accessibilityLabel: label }
    : { accessible: false };
}
