import { useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  ClipboardList,
  Loader2,
  ShieldCheck,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { convexSiteUrl } from '../lib/convex';
import { ORG_NAME, ORG_SHORT_NAME } from '../config/org';
import { TRACK_SEED } from '../../convex/lib/tracks';

/**
 * From the one list the server validates against, so a label shown here can
 * never drift from a slug intake would reject.
 */
const TRACKS = TRACK_SEED.map((track) => ({ id: track.slug, label: track.name }));

type FormState = {
  programme_type: 'siwes' | 'internship' | 'nysc' | 'volunteer';
  full_name: string;
  email: string;
  phone: string;
  /** '' is "prefer not to say", which the intake stores as absent. */
  gender: '' | 'male' | 'female';
  location: string;
  institution_name: string;
  faculty: string;
  course_of_study: string;
  matric_number: string;
  level_or_year: string;
  siwes_start_date: string;
  siwes_end_date: string;
  institution_supervisor_name: string;
  institution_supervisor_email: string;
  institution_supervisor_phone: string;
  track_interests: string[];
  skills_summary: string;
  motivation: string;
  portfolio_url: string;
  emergency_contact_name: string;
  emergency_contact_phone: string;
  consent_logbook: boolean;
  consent_data_use: boolean;
  website: string;
};

const initialForm: FormState = {
  programme_type: 'siwes',
  full_name: '',
  email: '',
  phone: '',
  gender: '',
  location: '',
  institution_name: '',
  faculty: '',
  course_of_study: '',
  matric_number: '',
  level_or_year: '',
  siwes_start_date: '',
  siwes_end_date: '',
  institution_supervisor_name: '',
  institution_supervisor_email: '',
  institution_supervisor_phone: '',
  track_interests: [],
  skills_summary: '',
  motivation: '',
  portfolio_url: '',
  emergency_contact_name: '',
  emergency_contact_phone: '',
  consent_logbook: false,
  consent_data_use: false,
  website: '',
};

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-2 block text-sm font-semibold text-orbit-graphite">
        {label} {required && <span className="text-red-500">*</span>}
      </span>
      {children}
    </label>
  );
}

const inputClass = 'orbit-input';

function isIlorinLocation(location: string) {
  return /\bilorin\b/i.test(location);
}

/** Mirrors convex/lib/intake.ts — SIWES is virtual wherever the student lives. */
function participationPolicy(location: string, programmeType: string) {
  const onSite = isIlorinLocation(location) && programmeType !== 'siwes';
  return {
    preferred_participation_mode: onSite ? 'hybrid' : 'virtual',
    available_physical_day: onSite ? 1 : null,
  } as const;
}

export function ApplicationPage() {
  const [form, setForm] = useState<FormState>(initialForm);
  const [passportPhoto, setPassportPhoto] = useState<File | null>(null);
  const [siwesLetter, setSiwesLetter] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [reference, setReference] = useState('');

  const isSiwes = form.programme_type === 'siwes';

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const toggleTrack = (track: string) => {
    setForm((current) => {
      const exists = current.track_interests.includes(track);
      const next = exists
        ? current.track_interests.filter((id) => id !== track)
        : [...current.track_interests, track].slice(0, 3);
      return { ...current, track_interests: next };
    });
  };

  const fileToDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('File could not be read'));
    reader.readAsDataURL(file);
  });

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');

    if (!passportPhoto) {
      setError('Passport photo is required');
      return;
    }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(passportPhoto.type)) {
      setError('Passport photo must be a JPG, PNG, or WebP image');
      return;
    }
    if (passportPhoto.size > 3 * 1024 * 1024) {
      setError('Passport photo must be 3 MB or smaller');
      return;
    }
    if (isSiwes && !siwesLetter) {
      setError('SIWES form or letter is required for SIWES applications');
      return;
    }
    if (siwesLetter && !['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(siwesLetter.type)) {
      setError('SIWES form or letter must be a PDF, JPG, PNG, or WebP file');
      return;
    }
    if (siwesLetter && siwesLetter.size > 5 * 1024 * 1024) {
      setError('SIWES form or letter must be 5 MB or smaller');
      return;
    }

    setSubmitting(true);

    try {
      let submittedReference = '';
      const passportPhotoDataUrl = await fileToDataUrl(passportPhoto);
      const siwesLetterDataUrl = siwesLetter ? await fileToDataUrl(siwesLetter) : null;
      /**
       * Posts DIRECTLY to the Convex httpAction.
       *
       * It used to post to `/.netlify/functions/orbit-application`, and when
       * that function was deleted a Netlify redirect was added to forward the
       * path to Convex. Netlify REJECTS that redirect — "path field must not
       * start with /.netlify" — so the rule never loaded and the public
       * application form posted to a function that no longer exists. The
       * endpoint sets `Access-Control-Allow-Origin: *` deliberately (the form
       * is also served from the marketing site), so no proxy is needed.
       */
      const response = await fetch(`${convexSiteUrl}/applications/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          ...participationPolicy(form.location, form.programme_type),
          passport_photo: {
            name: passportPhoto.name,
            type: passportPhoto.type,
            size: passportPhoto.size,
            data_url: passportPhotoDataUrl,
          },
          siwes_letter: siwesLetter && siwesLetterDataUrl ? {
            name: siwesLetter.name,
            type: siwesLetter.type,
            size: siwesLetter.size,
            data_url: siwesLetterDataUrl,
          } : null,
        }),
      });
      /**
       * A non-JSON response is a real possibility, not a theoretical one.
       *
       * A platform 502, a proxy error page, a gateway timeout — all arrive as
       * HTML, and parsing them blindly showed the applicant a raw
       * "Unexpected token '<'" instead of anything they could act on. This is
       * the only page a stranger sees; its error message is the whole recovery
       * path.
       */
      const contentType = response.headers.get('content-type') ?? '';
      const result = contentType.includes('application/json')
        ? await response.json()
        : { success: false, error: '' };

      if (response.ok && result.success) {
        submittedReference = result.reference_code;
      } else {
        throw new Error(
          result.error ||
            'We could not submit your application just now. Please check your connection and try again — nothing was saved.',
        );
      }
      setReference(submittedReference);
      setForm(initialForm);
      setPassportPhoto(null);
      setSiwesLetter(null);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Application could not be submitted');
    } finally {
      setSubmitting(false);
    }
  };

  if (reference) {
    return (
      <div className="min-h-screen bg-orbit-canvas px-4 py-10">
        <div className="orbit-panel mx-auto max-w-2xl p-8">
          <CheckCircle2 className="mb-5 h-12 w-12 text-iih-green-dark" />
          <h1 className="text-2xl font-bold text-orbit-ink">Application received</h1>
          <p className="mt-3 text-orbit-muted">
            Your ORBIT application has been submitted. Keep this reference for follow-up:
          </p>
          <div className="mt-5 rounded-lg border border-orbit-line bg-orbit-mint px-4 py-3 text-lg font-bold text-orbit-ink">
            {reference}
          </div>
          <div className="mt-8 flex flex-wrap gap-3">
            <button
              onClick={() => setReference('')}
              className="rounded-lg bg-iih-green px-5 py-3 font-bold text-orbit-ink hover:bg-iih-green-dark hover:text-white"
            >
              Submit another application
            </button>
            <Link
              to="/"
              className="rounded-lg border border-orbit-line px-5 py-3 font-semibold text-orbit-graphite hover:bg-orbit-mint/60"
            >
              Back to sign in
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-orbit-canvas">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
        <Link to="/" className="mb-6 inline-flex items-center gap-2 text-sm font-semibold text-orbit-muted hover:text-orbit-ink">
          <ArrowLeft className="h-4 w-4" />
          Back to sign in
        </Link>

        <div className="orbit-panel-dark mb-8 p-6">
          <div className="flex items-start gap-4">
            <div className="rounded-lg bg-iih-green p-3">
              <ClipboardList className="h-7 w-7 text-orbit-ink" />
            </div>
            <div>
              <p className="mb-1 text-xs font-bold uppercase text-iih-green">ORBIT Control Intake</p>
              <h1 className="text-2xl font-bold text-white">ORBIT Programme Application</h1>
              <p className="mt-2 max-w-3xl text-slate-300">
                Apply for ORBIT SIWES, internship, NYSC, or volunteer placement with {ORG_NAME}.
                SIWES applicants should complete all institution and logbook fields.
              </p>
            </div>
          </div>
        </div>

        {error && (
          <div className="mb-6 flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-red-700">
            <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0" />
            <p className="text-sm font-medium">{error}</p>
          </div>
        )}

        <form onSubmit={submit} className="space-y-6">
          <section className="orbit-panel p-6">
            <h2 className="mb-5 text-lg font-bold text-orbit-ink">Applicant Details</h2>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Programme type" required>
                <select className={inputClass} value={form.programme_type} onChange={(e) => update('programme_type', e.target.value as FormState['programme_type'])}>
                  <option value="siwes">SIWES</option>
                  <option value="internship">Internship</option>
                  <option value="nysc">NYSC</option>
                  <option value="volunteer">Volunteer</option>
                </select>
              </Field>
              <Field label="Full name" required>
                <input className={inputClass} value={form.full_name} onChange={(e) => update('full_name', e.target.value)} required />
              </Field>
              <Field label="Email" required>
                <input type="email" className={inputClass} value={form.email} onChange={(e) => update('email', e.target.value)} required />
              </Field>
              <Field label="Phone number" required>
                <input className={inputClass} value={form.phone} onChange={(e) => update('phone', e.target.value)} required />
              </Field>
              {/* Optional, and asked for exactly one reason: the SIWES
                  acceptance letter sent to a university reads "He will undergo
                  his industrial training". Declining is a real answer — the
                  letter then uses the approved template's own "He/She … his/her"
                  rather than guessing. */}
              <Field label="Gender">
                <select className={inputClass} value={form.gender} onChange={(e) => update('gender', e.target.value as FormState['gender'])}>
                  <option value="">Prefer not to say</option>
                  <option value="male">Male</option>
                  <option value="female">Female</option>
                </select>
              </Field>
              <Field label="Current location" required>
                <input className={inputClass} value={form.location} onChange={(e) => update('location', e.target.value)} placeholder="Ilorin, Kwara State" required />
              </Field>
              <Field label="Portfolio or LinkedIn URL">
                <input className={inputClass} value={form.portfolio_url} onChange={(e) => update('portfolio_url', e.target.value)} placeholder="https://" />
              </Field>
            </div>
            <div className="mt-4">
              <Field label="Passport photograph" required>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={(e) => setPassportPhoto(e.target.files?.[0] ?? null)}
                  required
                  className="block w-full rounded-lg border border-orbit-line bg-orbit-surface px-4 py-3 text-sm text-orbit-graphite shadow-orbit-sm file:mr-4 file:rounded-md file:border-0 file:bg-orbit-mint file:px-3 file:py-2 file:text-sm file:font-semibold file:text-orbit-ink hover:file:bg-iih-green/30"
                />
                <span className="mt-2 block text-xs text-orbit-muted">
                  Upload a clear passport-style headshot. JPG, PNG, or WebP, maximum 3 MB. This will become your ORBIT profile photo if your application is approved.
                </span>
              </Field>
            </div>
          </section>

          <section className="orbit-panel p-6">
            <h2 className="mb-5 text-lg font-bold text-orbit-ink">SIWES and Institution Details</h2>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Institution name" required={isSiwes}>
                <input className={inputClass} value={form.institution_name} onChange={(e) => update('institution_name', e.target.value)} required={isSiwes} />
              </Field>
              <Field label="Faculty or college">
                <input className={inputClass} value={form.faculty} onChange={(e) => update('faculty', e.target.value)} />
              </Field>
              <Field label="Course or department" required={isSiwes}>
                <input className={inputClass} value={form.course_of_study} onChange={(e) => update('course_of_study', e.target.value)} required={isSiwes} />
              </Field>
              <Field label="Matriculation number" required={isSiwes}>
                <input className={inputClass} value={form.matric_number} onChange={(e) => update('matric_number', e.target.value)} required={isSiwes} />
              </Field>
              <Field label="Level or year">
                <input className={inputClass} value={form.level_or_year} onChange={(e) => update('level_or_year', e.target.value)} placeholder="300 level" />
              </Field>
              <Field label="SIWES start date" required={isSiwes}>
                <input type="date" className={inputClass} value={form.siwes_start_date} onChange={(e) => update('siwes_start_date', e.target.value)} required={isSiwes} />
              </Field>
              <Field label="SIWES end date" required={isSiwes}>
                <input type="date" className={inputClass} value={form.siwes_end_date} onChange={(e) => update('siwes_end_date', e.target.value)} required={isSiwes} />
              </Field>
              <Field label="Institution supervisor name">
                <input className={inputClass} value={form.institution_supervisor_name} onChange={(e) => update('institution_supervisor_name', e.target.value)} />
              </Field>
              <Field label="Institution supervisor email">
                <input type="email" className={inputClass} value={form.institution_supervisor_email} onChange={(e) => update('institution_supervisor_email', e.target.value)} />
              </Field>
              <Field label="Institution supervisor phone">
                <input className={inputClass} value={form.institution_supervisor_phone} onChange={(e) => update('institution_supervisor_phone', e.target.value)} />
              </Field>
            </div>
            <div className="mt-4">
              <Field label="SIWES form or placement letter" required={isSiwes}>
                <input
                  type="file"
                  accept="application/pdf,image/jpeg,image/png,image/webp"
                  onChange={(e) => setSiwesLetter(e.target.files?.[0] ?? null)}
                  required={isSiwes}
                  className="block w-full rounded-lg border border-orbit-line bg-orbit-surface px-4 py-3 text-sm text-orbit-graphite shadow-orbit-sm file:mr-4 file:rounded-md file:border-0 file:bg-orbit-mint file:px-3 file:py-2 file:text-sm file:font-semibold file:text-orbit-ink hover:file:bg-iih-green/30"
                />
                <span className="mt-2 block text-xs text-orbit-muted">
                  Upload your school SIWES form, posting or placement letter, or introductory letter. PDF, JPG, PNG, or WebP, maximum 5 MB.
                </span>
              </Field>
            </div>
          </section>

          <section className="orbit-panel p-6">
            <h2 className="mb-5 text-lg font-bold text-orbit-ink">Participation and Track Fit</h2>
            <div className="rounded-lg border border-orbit-line bg-orbit-subtle p-4 text-sm text-orbit-graphite">
              ORBIT sets participation mode after application review. SIWES placements run virtually wherever you are based. For other programmes, Ilorin-based applicants attend in person once a week on Mondays; applicants outside Ilorin participate virtually.
            </div>

            <div className="mt-5">
              <span className="mb-2 block text-sm font-semibold text-orbit-graphite">Track interests, choose up to 3</span>
              <div className="grid gap-3 md:grid-cols-2">
                {TRACKS.map((track) => (
                  <label key={track.id} className="flex items-center gap-3 rounded-lg border border-orbit-line bg-orbit-surface px-4 py-3 text-sm font-medium text-orbit-graphite">
                    <input
                      type="checkbox"
                      checked={form.track_interests.includes(track.id)}
                      onChange={() => toggleTrack(track.id)}
                      disabled={!form.track_interests.includes(track.id) && form.track_interests.length >= 3}
                      className="h-4 w-4 rounded border-slate-300 text-iih-green focus:ring-iih-green"
                    />
                    {track.label}
                  </label>
                ))}
              </div>
            </div>

            <div className="mt-5 grid gap-4 md:grid-cols-2">
              <Field label="Skills summary">
                <textarea className={inputClass} rows={5} value={form.skills_summary} onChange={(e) => update('skills_summary', e.target.value)} />
              </Field>
              <Field label="Why do you want to join ORBIT?">
                <textarea className={inputClass} rows={5} value={form.motivation} onChange={(e) => update('motivation', e.target.value)} />
              </Field>
            </div>
          </section>

          <section className="orbit-panel p-6">
            <h2 className="mb-5 text-lg font-bold text-orbit-ink">Emergency Contact and Consent</h2>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Emergency contact name" required>
                <input className={inputClass} value={form.emergency_contact_name} onChange={(e) => update('emergency_contact_name', e.target.value)} required />
              </Field>
              <Field label="Emergency contact phone" required>
                <input className={inputClass} value={form.emergency_contact_phone} onChange={(e) => update('emergency_contact_phone', e.target.value)} required />
              </Field>
            </div>
            <div className="mt-5 space-y-3 rounded-lg border border-orbit-line bg-orbit-canvas p-4">
              <label className="flex gap-3 text-sm text-orbit-graphite">
                <input id="consent-programme" type="checkbox" checked={form.consent_logbook} onChange={(e) => update('consent_logbook', e.target.checked)} required className="mt-1 h-4 w-4 rounded border-slate-300 text-iih-green focus:ring-iih-green" />
                {isSiwes
                  ? 'I understand that SIWES participation requires daily logs, weekly summaries, attendance records where applicable, supervisor review, and exportable logbook evidence.'
                  : 'I understand that taking part requires me to complete assigned work, keep attendance records where applicable, and take part in supervisor review.'}
              </label>
              <label className="flex gap-3 text-sm text-orbit-graphite">
                <input id="consent-data-use" type="checkbox" checked={form.consent_data_use} onChange={(e) => update('consent_data_use', e.target.checked)} required className="mt-1 h-4 w-4 rounded border-slate-300 text-iih-green focus:ring-iih-green" />
                I consent to {ORG_SHORT_NAME} using this information to review my application, set up my ORBIT profile, assign supervision, and maintain programme records.
              </label>
            </div>
            {/* Honeypot. Named and plausible-looking so an automated filler
                treats it as a real field; hidden and tab-skipped so a person
                never reaches it. Anything in it means the submission was not
                typed by a human, and intake drops it. */}
            <input
              name="website"
              className="hidden"
              tabIndex={-1}
              autoComplete="off"
              aria-hidden="true"
              value={form.website}
              onChange={(e) => update('website', e.target.value)}
            />
          </section>

          <div className="flex flex-col gap-3 rounded-lg border border-orbit-line bg-orbit-mint p-5 md:flex-row md:items-center md:justify-between">
            <div className="flex items-start gap-3">
              <ShieldCheck className="mt-0.5 h-5 w-5 flex-shrink-0 text-iih-green-dark" />
              <p className="text-sm text-orbit-ink">
                Applications enter a staff review queue before account creation or SIWES profile assignment.
              </p>
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-orbit-ink px-6 py-3 font-bold text-white transition hover:bg-orbit-ink-soft disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting && <Loader2 className="h-5 w-5 animate-spin" />}
              Submit application
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
