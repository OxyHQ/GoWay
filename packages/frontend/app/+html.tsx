import { ScrollViewStyleReset } from 'expo-router/html';
import type { PropsWithChildren } from 'react';

/**
 * The web document shell — **and today it does not ship.**
 *
 * `app.config.js` sets `web.output: 'single'`, and expo-router only renders
 * `+html.tsx` when it is rendering HTML per route: `output: 'static'` or
 * `'server'`. In single-output mode the export writes its own `index.html` from
 * Expo's built-in template, and nothing in this file reaches it. That was
 * measured on this tree, not inferred — `bun run export:web` and then reading
 * `dist/index.html`, which carries Expo's `X-UA-Compatible` and
 * `shrink-to-fit=no` and neither of the `theme-color` entries below, both of
 * which have been sitting here being ignored since the file was written.
 *
 * It is kept, with the note, rather than deleted: the day GoWay wants a
 * crawlable document (`output: 'static'` — the obvious reason being that a
 * place page should have a title in a search result) this file becomes live on
 * that one config change, and everything in it is already right. What must not
 * happen is somebody adding a tag here and believing it shipped.
 *
 * ## So how does the brand reach a browser tab
 *
 * Through the two channels that need no HTML from us, both verified in the
 * export:
 *
 *  - `web.favicon` in `app.config.js`. Expo rasterises it into
 *    `dist/favicon.ico` and injects the one `<link rel="icon">` that the
 *    template does emit. The tab icon IS the GoWay mark.
 *  - `public/apple-touch-icon.png`, at the ROOT of the site. iOS ignores
 *    `rel="icon"` when adding to the home screen and, with no `<link>`
 *    declared, falls back to fetching `/apple-touch-icon.png` — which is
 *    exactly why that file is at the root and not only under `/brand/`. With
 *    nothing there, iOS screenshots the page.
 *
 * What genuinely cannot be delivered this way is `og:image`: a link unfurler
 * does not run JavaScript, so a share card needs the tag in the served HTML.
 * `https://goway.to/brand/goway-og.png` is generated and served, ready for the
 * day this file is live; until then a link to goway.to unfurls without a card.
 * The fix is `output: 'static'`, not a hand-rolled HTML rewrite in the Worker —
 * see `wrangler.toml` on why widening `run_worker_first` is a bigger decision
 * than it looks.
 */
export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover"
        />
        {/* Startup fallback; Bloom adopts one entry and becomes the runtime owner. */}
        <meta name="theme-color" content="#faf1f6" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#100d10" media="(prefers-color-scheme: dark)" />

        {/* Preferred over the .ico wherever a browser understands it: the mark
            is a heavy-outlined bubble letter that closes up at 16 CSS px, and
            an SVG lets a 2x display rasterise it at 32 device pixels, where it
            reads. See the limit recorded on `GOWAY_MARK`. */}
        <link rel="icon" type="image/svg+xml" href="/brand/goway-mark.svg" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <meta property="og:image" content="https://goway.to/brand/goway-og.png" />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta property="og:site_name" content="GoWay" />

        <ScrollViewStyleReset />
      </head>
      <body>{children}</body>
    </html>
  );
}
