/**
 * docs/manual/img/  ->  docs/manual/img/opt/
 *
 * build.py embeds from `img/opt/`, base64-inlined into a single self-contained
 * HTML file, because the published page runs under a CSP that blocks every
 * external host. That makes image weight the whole file's weight: the raw
 * captures produce a document around twice the size for no visible gain at
 * print resolution.
 *
 * Like the capture script beside it, the step that produced `img/opt/` was
 * never committed — the manual's README pointed at "the commit history for this
 * directory", which does not contain it either. Rebuilt here from what the
 * existing optimised files actually are: 1200px wide, 8-bit palette PNG.
 *
 * 1200px is chosen against the print target, not the screen. The text column is
 * ~180mm wide, so 1200px lands near 170dpi — comfortably past what any print
 * pipeline resolves, with no benefit to going higher.
 *
 * Uses ImageMagick (`magick`), which is what produced the current files.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const IMG = path.join(process.cwd(), 'docs', 'manual', 'img');
const OPT = path.join(IMG, 'opt');

/** Matches the existing optimised set; see the header for why. */
const TARGET_WIDTH = 1200;
const PALETTE_COLORS = 192;

function optimise(): void {
  mkdirSync(OPT, { recursive: true });

  const sources = readdirSync(IMG)
    .filter((f) => f.toLowerCase().endsWith('.png'))
    .sort();

  if (!sources.length) {
    console.error(`No PNGs in ${IMG}. Run \`npm run capture:manual\` first.`);
    process.exitCode = 1;
    return;
  }

  let rawTotal = 0;
  let optTotal = 0;

  for (const name of sources) {
    const from = path.join(IMG, name);
    const to = path.join(OPT, name);

    execFileSync('magick', [
      from,
      // Only ever shrink. `>` leaves anything already narrower alone rather
      // than upscaling it into softness — 05-application-row is a cropped
      // element shot and is legitimately below the target width.
      '-resize',
      `${TARGET_WIDTH}>`,
      '-colors',
      String(PALETTE_COLORS),
      '-strip',
      to,
    ]);

    rawTotal += statSync(from).size;
    optTotal += statSync(to).size;
  }

  const mb = (n: number) => (n / 1e6).toFixed(2);
  console.log(
    `${sources.length} images  ${mb(rawTotal)} MB -> ${mb(optTotal)} MB ` +
      `(${Math.round((1 - optTotal / rawTotal) * 100)}% smaller)`,
  );
}

optimise();
