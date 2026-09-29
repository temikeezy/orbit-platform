import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Builds ONE self-contained HTML gallery from the sidecars screens.capture.ts
 * wrote — inline base64 thumbnails, no external requests, so it can be opened
 * from a file:// URL or dropped in a Slack thread with nothing left behind.
 *
 * 42 screens x 4 roles x 2 viewports is 336 shots. At a rough ~35KB average
 * PNG (full-page, frozen, no animation) that is close to 12MB BEFORE the ~33%
 * base64 inflation — around 15-16MB inlined. The default scope here (and in
 * `npm run capture`) is admin + intern, both viewports: half the roles, all
 * the screens that actually differ in an interesting way between an admin and
 * a member. `npm run capture:all` plus `--roles=` overrides here are how to
 * get the rest when it is actually needed.
 *
 * Flags (all optional):
 *   --roles=admin,intern         default: admin,intern
 *   --viewports=desktop,mobile   default: desktop,mobile
 *   --area=<substring>           filters screen ids, e.g. --area=admin-
 *   --out=<path>                 default: e2e/capture/gallery.html
 */

interface Sidecar {
  id: string;
  role: string;
  viewport: 'desktop' | 'mobile';
  permitted: boolean;
  deniedShown: boolean;
  capturedAt: string;
  path: string; // relative to output dir; empty when the shot failed
  error?: string;
}

interface Args {
  roles: string[];
  viewports: string[];
  area: string | null;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  for (const arg of argv) {
    const match = /^--([a-z]+)=(.*)$/.exec(arg);
    if (match) flags.set(match[1], match[2]);
  }
  return {
    roles: (flags.get('roles') ?? 'admin,intern').split(',').filter(Boolean),
    viewports: (flags.get('viewports') ?? 'desktop,mobile').split(',').filter(Boolean),
    area: flags.get('area') ?? null,
    out: flags.get('out') ?? path.join(process.cwd(), 'e2e', 'capture', 'gallery.html'),
  };
}

const OUTPUT_DIR = path.join(process.cwd(), 'e2e', 'capture', 'output');

function loadSidecars(args: Args): Sidecar[] {
  if (!existsSync(OUTPUT_DIR)) {
    console.error(`[gallery] nothing captured yet — expected sidecars under ${OUTPUT_DIR}`);
    console.error('[gallery] run `npm run capture` first.');
    process.exit(1);
  }

  const out: Sidecar[] = [];
  for (const role of readdirSync(OUTPUT_DIR)) {
    if (!args.roles.includes(role)) continue;
    const roleDir = path.join(OUTPUT_DIR, role);
    if (!statSync(roleDir).isDirectory()) continue;

    for (const viewport of readdirSync(roleDir)) {
      if (!args.viewports.includes(viewport)) continue;
      const viewportDir = path.join(roleDir, viewport);
      if (!statSync(viewportDir).isDirectory()) continue;

      for (const file of readdirSync(viewportDir)) {
        if (!file.endsWith('.json')) continue;
        const sidecar = JSON.parse(readFileSync(path.join(viewportDir, file), 'utf8')) as Sidecar;
        if (args.area && !sidecar.id.includes(args.area)) continue;
        out.push(sidecar);
      }
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id) || a.role.localeCompare(b.role));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function toDataUri(sidecar: Sidecar): string | null {
  if (!sidecar.path) return null;
  const file = path.join(OUTPUT_DIR, sidecar.path);
  if (!existsSync(file)) return null;
  /**
   * JPEG when a sibling .jpg exists, PNG otherwise.
   *
   * Full-page screenshots of a UI are tall, and inlining 146 of them as PNG
   * produced a 121MB page — unopenable, and eight times the artifact limit.
   * The capture step keeps the lossless originals; this reads a downscaled
   * JPEG beside them when one has been generated, which is the difference
   * between a gallery that can be shared and one that cannot.
   */
  const jpg = file.replace(/\.png$/, '.jpg');
  if (existsSync(jpg)) {
    return `data:image/jpeg;base64,${readFileSync(jpg).toString('base64')}`;
  }
  return `data:image/png;base64,${readFileSync(file).toString('base64')}`;
}

/** Escapes text for safe interpolation into the HTML this file writes. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildHtml(sidecars: Sidecar[]): string {
  const roles = [...new Set(sidecars.map((s) => s.role))].sort();
  const viewports = [...new Set(sidecars.map((s) => s.viewport))].sort();

  const cards = sidecars
    .map((s) => {
      const uri = toDataUri(s);
      const key = `${s.role}__${s.id}`;
      return `
        <figure class="card" data-role="${esc(s.role)}" data-viewport="${esc(s.viewport)}" data-id="${esc(s.id)}" data-key="${esc(key)}">
          ${
            uri
              ? `<img loading="lazy" src="${uri}" alt="${esc(s.id)} — ${esc(s.role)} — ${esc(s.viewport)}" />`
              : `<div class="gap">gap — ${esc(s.error ?? 'not captured')}</div>`
          }
          <figcaption>
            <strong>${esc(s.id)}</strong>
            <span>${esc(s.role)} · ${esc(s.viewport)}</span>
            ${s.permitted ? '' : '<span class="badge refused">refused</span>'}
            ${s.deniedShown ? '<span class="badge denied">denial shown</span>' : ''}
          </figcaption>
        </figure>`;
    })
    .join('\n');

  // The lightbox is built client-side from a JSON index of the same data
  // rather than a second server round trip — there is no server, this is a
  // single static file.
  const index = sidecars.map((s) => ({
    id: s.id,
    role: s.role,
    viewport: s.viewport,
    permitted: s.permitted,
    deniedShown: s.deniedShown,
    key: `${s.role}__${s.viewport}__${s.id}`,
  }));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>ORBIT screen gallery</title>
<style>
  :root { color-scheme: light; }
  body { font-family: system-ui, sans-serif; margin: 0; background: #f8fafc; color: #1e293b; }
  header { position: sticky; top: 0; background: #fff; border-bottom: 1px solid #e2e8f0; padding: 16px 24px; z-index: 10; display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
  header h1 { font-size: 18px; margin: 0 16px 0 0; }
  header input, header select { padding: 6px 10px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 14px; }
  main { padding: 24px; display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px; }
  .card { margin: 0; background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden; cursor: pointer; }
  .card img { width: 100%; height: 160px; object-fit: cover; object-position: top; display: block; background: #f1f5f9; }
  .card .gap { height: 160px; display: flex; align-items: center; justify-content: center; color: #94a3b8; font-size: 12px; padding: 8px; text-align: center; }
  .card figcaption { padding: 8px 10px; font-size: 12px; display: flex; flex-direction: column; gap: 2px; }
  .card figcaption span { color: #64748b; }
  .badge { display: inline-block; font-size: 10px; font-weight: 600; border-radius: 999px; padding: 1px 8px; width: fit-content; }
  .badge.refused { background: #fef3c7; color: #92400e; }
  .badge.denied { background: #fee2e2; color: #991b1b; }
  #lightbox { position: fixed; inset: 0; background: rgba(15,23,42,.85); display: none; align-items: center; justify-content: center; z-index: 100; padding: 24px; }
  #lightbox.open { display: flex; }
  #lightbox .panel { background: #fff; border-radius: 12px; max-width: 95vw; max-height: 95vh; overflow: auto; padding: 20px; }
  #lightbox .panel h2 { margin-top: 0; font-size: 16px; }
  #lightbox .pair { display: flex; gap: 16px; flex-wrap: wrap; align-items: flex-start; }
  #lightbox .pair figure { margin: 0; }
  #lightbox .pair img { max-width: 45vw; max-height: 80vh; border: 1px solid #e2e8f0; border-radius: 8px; }
  #lightbox .close { position: absolute; top: 24px; right: 32px; background: #fff; border: none; border-radius: 999px; width: 36px; height: 36px; font-size: 18px; cursor: pointer; }
  .hidden { display: none !important; }
</style>
</head>
<body>
<header>
  <h1>ORBIT screen gallery</h1>
  <input id="search" type="search" placeholder="Search screen id…" />
  <select id="role-filter"><option value="">All roles</option>${roles.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join('')}</select>
  <select id="viewport-filter"><option value="">All viewports</option>${viewports.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('')}</select>
  <span id="count"></span>
</header>
<main id="grid">
${cards}
</main>
<div id="lightbox">
  <div class="panel">
    <button class="close" aria-label="Close">×</button>
    <h2 id="lightbox-title"></h2>
    <div class="pair" id="lightbox-pair"></div>
  </div>
</div>
<script>
  const INDEX = ${JSON.stringify(index)};
  const grid = document.getElementById('grid');
  const cards = Array.from(grid.querySelectorAll('.card'));
  const search = document.getElementById('search');
  const roleFilter = document.getElementById('role-filter');
  const viewportFilter = document.getElementById('viewport-filter');
  const count = document.getElementById('count');

  function applyFilters() {
    const q = search.value.trim().toLowerCase();
    const role = roleFilter.value;
    const viewport = viewportFilter.value;
    let visible = 0;
    for (const card of cards) {
      const matches =
        (!q || card.dataset.id.toLowerCase().includes(q)) &&
        (!role || card.dataset.role === role) &&
        (!viewport || card.dataset.viewport === viewport);
      card.classList.toggle('hidden', !matches);
      if (matches) visible++;
    }
    count.textContent = visible + ' / ' + cards.length + ' shots';
  }

  search.addEventListener('input', applyFilters);
  roleFilter.addEventListener('change', applyFilters);
  viewportFilter.addEventListener('change', applyFilters);
  applyFilters();

  const lightbox = document.getElementById('lightbox');
  const lightboxTitle = document.getElementById('lightbox-title');
  const lightboxPair = document.getElementById('lightbox-pair');

  function openLightbox(id, role) {
    lightboxTitle.textContent = id + ' — ' + role;
    lightboxPair.innerHTML = '';
    for (const viewport of ['desktop', 'mobile']) {
      const img = grid.querySelector(
        '.card[data-id="' + CSS.escape(id) + '"][data-role="' + CSS.escape(role) + '"][data-viewport="' + CSS.escape(viewport) + '"] img',
      );
      const fig = document.createElement('figure');
      const label = document.createElement('div');
      label.textContent = viewport;
      label.style.fontSize = '12px';
      label.style.color = '#64748b';
      label.style.marginBottom = '4px';
      fig.appendChild(label);
      if (img) {
        const clone = img.cloneNode(true);
        clone.style.height = 'auto';
        fig.appendChild(clone);
      } else {
        const gap = document.createElement('div');
        gap.textContent = 'not captured';
        gap.style.color = '#94a3b8';
        fig.appendChild(gap);
      }
      lightboxPair.appendChild(fig);
    }
    lightbox.classList.add('open');
  }

  grid.addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    openLightbox(card.dataset.id, card.dataset.role);
  });

  lightbox.querySelector('.close').addEventListener('click', () => lightbox.classList.remove('open'));
  lightbox.addEventListener('click', (e) => {
    if (e.target === lightbox) lightbox.classList.remove('open');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') lightbox.classList.remove('open');
  });
</script>
</body>
</html>`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sidecars = loadSidecars(args);

  if (sidecars.length === 0) {
    console.error('[gallery] no sidecars matched the given scope — nothing to build.');
    process.exit(1);
  }

  const projectedBytes = sidecars.reduce((sum, s) => {
    if (!s.path) return sum;
    const file = path.join(OUTPUT_DIR, s.path);
    const jpg = file.replace(/\.png$/, '.jpg');
    const real = existsSync(jpg) ? jpg : file;
    return existsSync(real) ? sum + Math.ceil(statSync(real).size * 1.34) : sum; // base64 inflation
  }, 0);

  const gaps = sidecars.filter((s) => !s.path).length;

  console.log(
    `[gallery] ${sidecars.length} shots (${gaps} gaps), roles=${args.roles.join(',')} viewports=${args.viewports.join(',')}`,
  );
  console.log(`[gallery] projected file size: ~${formatBytes(projectedBytes)}`);

  const html = buildHtml(sidecars);
  writeFileSync(args.out, html);
  console.log(`[gallery] wrote ${args.out} (${formatBytes(Buffer.byteLength(html))})`);
}

main();
