// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';

/**
 * THE AUTH INVARIANT, ENFORCED MECHANICALLY.
 *
 * Convex has no row-level security and cannot have any. Authorization is
 * entirely function-level: every public function that touches non-public data
 * takes `token: v.string()` and resolves it through convex/lib/auth.ts. There is
 * no second line of defence — a function that forgets its check fails silently,
 * forever, and this codebase has shipped that bug before (posts, friendships,
 * reactions and notificationPreferences each shipped without a guard).
 *
 * SECURITY.md is the prose version of this rule. Until now that was ALL there
 * was: no lint rule, no test, nothing that enumerates the surface. This is the
 * mechanical half.
 *
 * ── Two implementation choices that look wrong and are not ──────────────────
 *
 * 1. IT READS THE SOURCE OFF DISK RATHER THAN IMPORTING THE MODULES.
 *    Importing all 34 convex modules would let us read Convex's own runtime
 *    markers (`isPublic === true`), which is more direct. It also drags ~3,300
 *    unexecuted lines into the coverage denominator, taking line coverage from
 *    ~51% to ~35% against the 45% floor in vitest.config.ts — so CI would fail
 *    on coverage rather than on authz, which is the wrong signal entirely.
 *    `src/test/**` is excluded from coverage, so a pure fs+AST analyzer costs
 *    nothing. Verified once against the runtime markers: both agree at 181
 *    public functions, zero drift. Re-run that comparison by hand if the convex
 *    major version moves.
 *
 * 2. IT WALKS THE AST RATHER THAN REGEXING `_handler.toString()`.
 *    Vite's SSR transform rewrites `requireUser(ctx, token)` into
 *    `(0,__vite_ssr_import_3__.requireUser)(ctx, token)`. A `/requireUser\s*\(/`
 *    regex matches under tsx and fails under vitest — the test would report
 *    ~150 false violations in the one runner that actually runs it.
 */

const CONVEX_DIR = fileURLToPath(new URL('../../../convex/', import.meta.url));

/**
 * The ONLY public functions permitted to skip token resolution.
 *
 * Adding an entry here is a security decision, not a formality. It needs a
 * reason as specific as the four below, and SECURITY.md must agree. A stale
 * entry — one whose function no longer exists, or which now resolves its token
 * properly — FAILS this test, so the list is forced to shrink on its own rather
 * than rotting into a list of everything.
 */
const UNAUTHENTICATED: Record<string, string> = {
  'levels.infoForPoints':
    'Public reference data — the level ladder. Carries no user data and takes no token at all.',
  'levels.list':
    'Public reference data, same class as infoForPoints. Its vestigial optional token was removed so R2 and R3 below could hold with no exemptions at all.',
  'mcp.authenticate':
    'Runs before any token exists — this is the function that mints one, from MCP_SERVER_SECRET.',
  'zoho.exchangeOAuthCode':
    'Redeems a short-lived single-use exchange code. The code itself IS the credential.',
};

/** Public functions allowed `v.optional(v.string())` rather than a required token. */
const OPTIONAL_TOKEN: Record<string, string> = {
  'auth.me':
    'Resolves through userFromToken and returns null for signed-out callers instead of throwing. The frontend calls it before it knows whether a session exists.',
  'errorReports.report':
    'Records a caught error or a reported bug. The signed-out path is the point: an error on the login page or a failed magic link is exactly the kind nobody would otherwise hear about, and requiring a token would blind the platform to its own front door. Resolves the token when present to attribute the report, records it anonymously when not. Rate limited, because an error inside a render loop can fire hundreds of times a second. It reads nothing and returns nothing but an acknowledgement, so an anonymous caller learns only that their report was accepted.',
};

/**
 * The ways a bearer token legitimately becomes an identity in this codebase.
 * A call only counts if its second argument is actually named `token` — that is
 * what catches `requireUser(ctx, someOtherArg)`, which is a real guard call
 * wired to the wrong value and reads as authenticated without being it.
 */
const ROOT_RESOLVERS = new Set([
  'userFromToken',
  'requireUser',
  'requireAdmin',
  'requireModerator',
  'isMcpSession',
]);

const PUBLIC_BUILDERS = new Set(['query', 'mutation', 'action']);
const ALL_BUILDERS = new Set([
  ...PUBLIC_BUILDERS,
  'internalQuery',
  'internalMutation',
  'internalAction',
  'httpAction',
]);

interface Registration {
  key: string;
  file: string;
  line: number;
  builder: string;
  isPublic: boolean;
  hasToken: boolean;
  tokenOptional: boolean;
  resolvedVia: string | null;
}

interface Unrecognised {
  key: string;
  file: string;
  line: number;
}

function isTokenArg(node: ts.Node | undefined): boolean {
  if (!node) return false;
  if (ts.isIdentifier(node)) return node.text === 'token';
  if (ts.isPropertyAccessExpression(node)) return node.name.text === 'token';
  return false;
}

/**
 * Does this handler resolve its token — directly, or through a helper in the
 * same module that does?
 *
 * The transitive step is load-bearing, not defensive: fourteen public functions
 * have no `require*` call of their own. `tasks.ts` routes five through
 * `requireStreamModerator`, and `mcp.ts` routes three through
 * `requireMcpSession`, which resolves by reading `sessions` on its token index
 * rather than by calling lib/auth at all. Both are real resolution.
 */
function resolvesToken(
  node: ts.Node | undefined,
  helpers: Map<string, ts.Node>,
  seen = new Set<string>(),
): string | null {
  if (!node) return null;
  let hit: string | null = null;

  const walk = (n: ts.Node): void => {
    if (hit) return;

    if (ts.isCallExpression(n)) {
      const e = n.expression;
      const name = ts.isIdentifier(e)
        ? e.text
        : ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name)
          ? e.name.text
          : '';

      if (ROOT_RESOLVERS.has(name)) {
        if (isTokenArg(n.arguments[1])) {
          hit = name;
          return;
        }
        // A resolver called with something other than `token` is not resolution
        // of THIS function's token. Keep walking — there may be a real one.
      }

      // Hand-rolled resolution: reading the sessions table by its token index.
      // auth.logout and mcp.requireMcpSession both do exactly this.
      if (
        name === 'withIndex' &&
        n.arguments[0] &&
        ts.isStringLiteral(n.arguments[0]) &&
        n.arguments[0].text === 'by_token'
      ) {
        hit = 'sessions.by_token';
        return;
      }

      if (helpers.has(name) && !seen.has(name)) {
        seen.add(name);
        const via = resolvesToken(helpers.get(name), helpers, seen);
        if (via) {
          hit = `${name} -> ${via}`;
          return;
        }
      }
    }

    ts.forEachChild(n, walk);
  };

  walk(node);
  return hit;
}

function analyseModule(
  file: string,
  registrations: Registration[],
  unrecognised: Unrecognised[],
): void {
  const modName = path.basename(file, '.ts');
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  // alias -> builder, resolved from the import so `import { mutation as mut }`
  // cannot slip past a name-only match.
  const builders = new Map<string, string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st)) continue;
    const spec = st.moduleSpecifier;
    if (!ts.isStringLiteral(spec) || !spec.text.endsWith('_generated/server')) continue;
    const nb = st.importClause?.namedBindings;
    if (nb && ts.isNamedImports(nb)) {
      for (const el of nb.elements) {
        const original = (el.propertyName ?? el.name).text;
        if (ALL_BUILDERS.has(original)) builders.set(el.name.text, original);
      }
    }
  }
  if (!builders.size) return; // not a function module (convex/lib/*, schema, crons)

  // Module-local helpers, for the transitive resolver walk.
  const helpers = new Map<string, ts.Node>();
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && st.body) {
      helpers.set(st.name.text, st.body);
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (
          ts.isIdentifier(d.name) &&
          d.initializer &&
          (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))
        ) {
          helpers.set(d.name.text, d.initializer.body);
        }
      }
    }
  }

  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    const exported = st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;

    for (const d of st.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !d.initializer) continue;
      const key = `${modName}.${d.name.text}`;

      const direct =
        ts.isCallExpression(d.initializer) &&
        ts.isIdentifier(d.initializer.expression) &&
        builders.has(d.initializer.expression.text);

      if (!direct) {
        // Not a registration — unless it MENTIONS a builder, in which case the
        // analyzer cannot model it and must say so rather than skip it. This is
        // what closes `export const foo = withAudit(query({...}))`.
        const src = d.initializer.getText(sf);
        if ([...builders.keys()].some((b) => new RegExp(`\\b${b}\\s*\\(`).test(src))) {
          unrecognised.push({ key, file, line: lineOf(d) });
        }
        continue;
      }

      const call = d.initializer as ts.CallExpression;
      const builder = builders.get((call.expression as ts.Identifier).text)!;
      const config = call.arguments[0];

      let hasToken = false;
      let tokenOptional = false;
      let handler: ts.Node | undefined;

      if (config && ts.isObjectLiteralExpression(config)) {
        for (const prop of config.properties) {
          if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;

          if (prop.name.text === 'args' && ts.isObjectLiteralExpression(prop.initializer)) {
            for (const a of prop.initializer.properties) {
              if (!ts.isPropertyAssignment(a) || !ts.isIdentifier(a.name)) continue;
              if (a.name.text !== 'token') continue;
              hasToken = true;
              const init = a.initializer;
              tokenOptional =
                ts.isCallExpression(init) &&
                ts.isPropertyAccessExpression(init.expression) &&
                init.expression.name.text === 'optional';
            }
          }

          if (prop.name.text === 'handler') handler = prop.initializer;
        }
      }

      registrations.push({
        key,
        file,
        line: lineOf(d),
        builder,
        isPublic: PUBLIC_BUILDERS.has(builder),
        hasToken,
        tokenOptional,
        resolvedVia: resolvesToken(handler, helpers),
      });
    }
  }
}

const registrations: Registration[] = [];
const unrecognised: Unrecognised[] = [];

for (const entry of readdirSync(CONVEX_DIR, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
  analyseModule(path.join(CONVEX_DIR, entry.name), registrations, unrecognised);
}

const publicFns = registrations.filter((r) => r.isPublic);
const rel = (f: string) => path.relative(path.join(CONVEX_DIR, '..'), f);
const cite = (r: Registration) => `  ${rel(r.file)}:${r.line}  ${r.key}`;

describe('convex public function surface', () => {
  it('found the function surface at all', () => {
    // A guard on the analyzer itself. If a refactor moved the registrations or
    // renamed the generated server module, every rule below would pass by
    // finding nothing — the most dangerous way for a security test to be green.
    expect(publicFns.length).toBeGreaterThan(150);
  });

  it('models every registration (R0)', () => {
    const msg = unrecognised
      .map((u) => `  ${rel(u.file)}:${u.line}  ${u.key}`)
      .join('\n');
    expect(
      unrecognised.length,
      `These exports use a Convex builder in a shape this analyzer cannot read, so their\n` +
        `authorization is UNCHECKED by this test:\n\n${msg}\n\n` +
        `Either register them as a direct query()/mutation()/action() call, or teach the\n` +
        `analyzer the new shape. Do not leave them unmodelled.`,
    ).toBe(0);
  });

  it('requires a token argument on every public function (R1)', () => {
    const offenders = publicFns.filter((r) => !r.hasToken && !(r.key in UNAUTHENTICATED));
    expect(
      offenders.length,
      `Public functions with no \`token\` argument:\n\n${offenders.map(cite).join('\n')}\n\n` +
        `Convex has no row-level security. A public function without a token is readable\n` +
        `and writable by anyone who knows its name.\n\n` +
        `Either add \`token: v.string()\` and resolve it, or — if it is genuinely public\n` +
        `reference data — add an entry to UNAUTHENTICATED in this file with a written\n` +
        `reason, and say the same thing in SECURITY.md.`,
    ).toBe(0);
  });

  it('resolves every token it declares (R2)', () => {
    const offenders = publicFns.filter((r) => r.hasToken && !r.resolvedVia);
    expect(
      offenders.length,
      `Public functions that declare a token and never resolve it:\n\n${offenders.map(cite).join('\n')}\n\n` +
        `This is the dangerous case. A function that takes a token and ignores it is not\n` +
        `authenticated — it just LOOKS authenticated, to every reader and every reviewer.\n\n` +
        `Fix it by calling requireUser / requireAdmin / requireModerator (convex/lib/auth.ts)\n` +
        `with \`token\`, or a module-local helper that does.\n\n` +
        `There is deliberately no allowlist for this rule. Do not silence it by passing\n` +
        `\`token\` to something that discards it.`,
    ).toBe(0);
  });

  it('requires the token to be non-optional (R3)', () => {
    const offenders = publicFns.filter(
      (r) => r.hasToken && r.tokenOptional && !(r.key in OPTIONAL_TOKEN),
    );
    expect(
      offenders.length,
      `Public functions with an OPTIONAL token:\n\n${offenders.map(cite).join('\n')}\n\n` +
        `An optional token means the function has a signed-out code path. That is\n` +
        `occasionally correct (see OPTIONAL_TOKEN in this file) and usually an oversight.\n` +
        `Make it \`v.string()\`, or allowlist it with a reason.`,
    ).toBe(0);
  });

  it('has no stale exemptions', () => {
    const live = new Set(publicFns.map((r) => r.key));

    const gone = Object.keys(UNAUTHENTICATED).filter((k) => !live.has(k));
    const nowGuarded = publicFns
      .filter((r) => r.key in UNAUTHENTICATED && r.hasToken && r.resolvedVia)
      .map((r) => r.key);
    const optionalGone = Object.keys(OPTIONAL_TOKEN).filter((k) => !live.has(k));
    const nowRequired = publicFns
      .filter((r) => r.key in OPTIONAL_TOKEN && r.hasToken && !r.tokenOptional)
      .map((r) => r.key);

    const stale = [...gone, ...nowGuarded, ...optionalGone, ...nowRequired];
    expect(
      stale.length,
      `These exemptions are no longer needed and must be deleted:\n\n` +
        stale.map((s) => `  ${s}`).join('\n') +
        `\n\nThe list of functions allowed to skip authorization should only ever shrink.\n` +
        `An exemption that outlives its reason is how the list becomes meaningless.`,
    ).toBe(0);

    // Every reason must actually say something.
    for (const [key, reason] of Object.entries({ ...UNAUTHENTICATED, ...OPTIONAL_TOKEN })) {
      expect(reason.length, `${key} needs a real written reason, not a placeholder`).toBeGreaterThan(
        20,
      );
    }
  });
});
