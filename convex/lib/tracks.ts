/**
 * The seven programme tracks.
 *
 * A track is what the concept note organises the programme around: an IIH
 * department owns it, that department's lead runs Monday task-setting and weekly
 * sign-off for it, and it groups one or more platform streams.
 *
 * THE SLUGS ARE A NATURAL KEY AND ARE NEVER EDITED. They are written into every
 * `applications.trackInterests` row and into the "Tracks" column of the Google
 * Sheet mirror, so renaming one silently orphans historical applications and
 * breaks the sheet. Display names are editable on the `tracks` row; these are
 * the seed and the validator.
 *
 * This is the single source. The same list previously existed three times — a
 * private Set in lib/intake.ts, a labelled array in the public application form,
 * and a shorter-labelled map in the admin queue — with labels that had already
 * drifted apart between the second and third.
 */

export interface TrackSeed {
  slug: string;
  name: string;
  /** For dense surfaces like the admissions table. */
  shortName: string;
  displayOrder: number;
}

export const TRACK_SEED: readonly TrackSeed[] = [
  {
    slug: 'software-product-digital-tools',
    name: 'Software, Product, and Digital Tools',
    shortName: 'Software/Product',
    displayOrder: 1,
  },
  {
    slug: 'design-media-content',
    name: 'Design, Media, and Content',
    shortName: 'Design/Media',
    displayOrder: 2,
  },
  {
    slug: 'programmes-community',
    name: 'Programmes and Community',
    shortName: 'Programmes',
    displayOrder: 3,
  },
  {
    slug: 'research-documentation-reporting',
    name: 'Research, Documentation, and Reporting',
    shortName: 'Research/Reporting',
    displayOrder: 4,
  },
  {
    slug: 'operations-admin-support',
    name: 'Operations, Admin, and Support',
    shortName: 'Operations/Admin',
    displayOrder: 5,
  },
  {
    slug: 'entrepreneurship-innovation',
    name: 'Entrepreneurship and Innovation Support',
    shortName: 'Entrepreneurship',
    displayOrder: 6,
  },
  {
    slug: 'engineering-special-projects',
    name: 'Engineering and Special Projects',
    shortName: 'Engineering',
    displayOrder: 7,
  },
] as const;

/** The validator's set. Public intake checks against this, not the database. */
export const TRACK_SLUGS: ReadonlySet<string> = new Set(TRACK_SEED.map((t) => t.slug));

const BY_SLUG = new Map(TRACK_SEED.map((t) => [t.slug, t]));

/** The full label, falling back to the slug so an unknown value still renders. */
export function trackLabel(slug: string): string {
  return BY_SLUG.get(slug)?.name ?? slug;
}

/** The short label, for tables. */
export function trackShortLabel(slug: string): string {
  return BY_SLUG.get(slug)?.shortName ?? slug;
}

/**
 * Marks a `streamModerators` row as materialised by a track-lead grant.
 *
 * A row with no source was granted directly by an admin, and reassigning the
 * track lead must never revoke it — that would silently strip authority someone
 * deliberately gave. Absent-means-manual is the safe reading for every row that
 * predates this field.
 */
export const TRACK_LEAD_GRANT = 'track_lead';
