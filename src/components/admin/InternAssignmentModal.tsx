import { useState, FormEvent } from 'react';
import { Loader2, X } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { ORG_SHORT_NAME } from '../../config/org';
import { internProfilesApi } from '../../lib/api/internProfiles';
import {
  OrbitInternProfile,
  OrbitCohort,
  OrbitDepartment,
  OrbitUser,
  ParticipationMode,
  InternProfileStatus,
} from '../../types/database';

interface InternAssignmentModalProps {
  profile?: OrbitInternProfile | null;
  cohorts: OrbitCohort[];
  departments: OrbitDepartment[];
  users: OrbitUser[];
  onClose: () => void;
  onSaved: () => void;
}

const PARTICIPATION_MODES: { value: ParticipationMode; label: string }[] = [
  { value: 'virtual', label: 'Virtual' },
  { value: 'hybrid', label: 'Hybrid' },
  { value: 'physical', label: 'Physical' },
];

const INTERN_STATUSES: { value: InternProfileStatus; label: string }[] = [
  { value: 'pending', label: 'Pending' },
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'completed', label: 'Completed' },
  { value: 'withdrawn', label: 'Withdrawn' },
];

const DAY_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Cohort default' },
  { value: '0', label: 'Sunday' },
  { value: '1', label: 'Monday' },
  { value: '2', label: 'Tuesday' },
  { value: '3', label: 'Wednesday' },
  { value: '4', label: 'Thursday' },
  { value: '5', label: 'Friday' },
  { value: '6', label: 'Saturday' },
];

const INPUT_CLS =
  'w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent';

export function InternAssignmentModal({
  profile,
  cohorts,
  departments,
  users,
  onClose,
  onSaved,
}: InternAssignmentModalProps) {
  const isEditing = Boolean(profile?.id);

  const internCandidates = users.filter((u) => u.roles.includes('intern'));
  const supervisorCandidates = users.filter(
    (u) =>
      u.roles.includes('moderator') || u.roles.includes('admin') || u.roles.includes('super_admin')
  );

  // Assignment fields
  const [userId, setUserId] = useState(profile?.user_id ?? '');
  const [cohortId, setCohortId] = useState(profile?.cohort_id ?? '');
  const [participationMode, setParticipationMode] = useState<ParticipationMode>(
    profile?.participation_mode ?? 'virtual'
  );
  /**
   * The programme, which decides whether this person keeps a logbook.
   *
   * Editable here because this is the only screen that can correct one: an
   * account created by hand or by import arrives with whatever it was given,
   * and getting it wrong silently removes someone's logbook or hands one to
   * somebody who owes none.
   */
  const [programmeType, setProgrammeType] = useState(profile?.programme_type ?? 'siwes');

  const [supervisorId, setSupervisorId] = useState(profile?.iih_supervisor_id ?? '');
  const [departmentId, setDepartmentId] = useState(profile?.department_id ?? '');
  const [physicalDay, setPhysicalDay] = useState<string>(
    profile?.physical_day != null ? String(profile.physical_day) : ''
  );
  const [status, setStatus] = useState<InternProfileStatus>(profile?.status ?? 'pending');

  // SIWES details fields
  const [institutionName, setInstitutionName] = useState(profile?.institution_name ?? '');
  const [faculty, setFaculty] = useState(profile?.faculty ?? '');
  const [courseOfStudy, setCourseOfStudy] = useState(profile?.course_of_study ?? '');
  const [matricNumber, setMatricNumber] = useState(profile?.matric_number ?? '');
  const [siwesStartDate, setSiwesStartDate] = useState(
    profile?.siwes_start_date?.slice(0, 10) ?? ''
  );
  const [siwesEndDate, setSiwesEndDate] = useState(profile?.siwes_end_date?.slice(0, 10) ?? '');
  const [instSupervisorName, setInstSupervisorName] = useState(
    profile?.institution_supervisor_name ?? ''
  );
  const [instSupervisorEmail, setInstSupervisorEmail] = useState(
    profile?.institution_supervisor_email ?? ''
  );
  const [instSupervisorPhone, setInstSupervisorPhone] = useState(
    profile?.institution_supervisor_phone ?? ''
  );
  const [emergencyContactName, setEmergencyContactName] = useState(
    profile?.emergency_contact_name ?? ''
  );
  const [emergencyContactPhone, setEmergencyContactPhone] = useState(
    profile?.emergency_contact_phone ?? ''
  );

  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!isEditing && !userId) {
      toast.error('Please select an intern user');
      return;
    }
    if (!cohortId) {
      toast.error('Please select a cohort');
      return;
    }
    setSaving(true);
    try {
      await internProfilesApi.saveInternProfile({
        id: profile?.id,
        user_id: isEditing ? undefined : userId,
        cohort_id: cohortId,
        participation_mode: participationMode,
        programme_type: programmeType,
        iih_supervisor_id: supervisorId || null,
        department_id: departmentId || null,
        physical_day: physicalDay !== '' ? Number(physicalDay) : null,
        status,
        institution_name: institutionName.trim() || undefined,
        faculty: faculty.trim() || undefined,
        course_of_study: courseOfStudy.trim() || undefined,
        matric_number: matricNumber.trim() || undefined,
        siwes_start_date: siwesStartDate || undefined,
        siwes_end_date: siwesEndDate || undefined,
        institution_supervisor_name: instSupervisorName.trim() || undefined,
        institution_supervisor_email: instSupervisorEmail.trim() || undefined,
        institution_supervisor_phone: instSupervisorPhone.trim() || undefined,
        emergency_contact_name: emergencyContactName.trim() || undefined,
        emergency_contact_phone: emergencyContactPhone.trim() || undefined,
      });
      toast.success(isEditing ? 'Intern profile updated' : 'Intern assigned');
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="intern-assignment-modal-title"
    >
      <div className="bg-white rounded-lg max-w-2xl w-full p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <h2 id="intern-assignment-modal-title" className="text-xl font-bold text-slate-800">
            {isEditing ? 'Edit Intern Assignment' : 'Assign Intern'}
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-slate-100 text-slate-500 transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <section>
            <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-3">
              Assignment
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label htmlFor="assign-intern" className="block text-sm font-medium text-slate-700 mb-1">
                  Intern <span className="text-red-500">*</span>
                </label>
                {isEditing ? (
                  <input
                    id="assign-intern"
                    type="text"
                    value={profile?.full_name ?? profile?.user_id ?? ''}
                    disabled
                    className={`${INPUT_CLS} bg-slate-50 text-slate-500 cursor-not-allowed`}
                  />
                ) : (
                  <select
                    id="assign-intern"
                    value={userId}
                    onChange={(e) => setUserId(e.target.value)}
                    required
                    className={INPUT_CLS}
                  >
                    <option value="">Select intern</option>
                    {internCandidates.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.full_name} ({u.email})
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div>
                <label htmlFor="assign-programme" className="block text-sm font-medium text-slate-700 mb-1">
                  Programme <span className="text-red-500">*</span>
                </label>
                <select
                  id="assign-programme"
                  value={programmeType}
                  onChange={(e) => setProgrammeType(e.target.value)}
                  required
                  className={INPUT_CLS}
                >
                  <option value="siwes">SIWES</option>
                  <option value="internship">Internship</option>
                  <option value="nysc">NYSC</option>
                  <option value="volunteer">Volunteer</option>
                </select>
                <p className="mt-1 text-xs text-slate-500">
                  Only SIWES interns keep a logbook and receive an acceptance letter.
                </p>
              </div>

              <div>
                <label htmlFor="assign-cohort" className="block text-sm font-medium text-slate-700 mb-1">
                  Cohort <span className="text-red-500">*</span>
                </label>
                <select
                  id="assign-cohort"
                  value={cohortId}
                  onChange={(e) => setCohortId(e.target.value)}
                  required
                  className={INPUT_CLS}
                >
                  <option value="">Select cohort</option>
                  {cohorts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="assign-participation-mode" className="block text-sm font-medium text-slate-700 mb-1">
                  Participation Mode
                </label>
                <select
                  id="assign-participation-mode"
                  value={participationMode}
                  onChange={(e) => setParticipationMode(e.target.value as ParticipationMode)}
                  className={INPUT_CLS}
                >
                  {PARTICIPATION_MODES.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="assign-supervisor" className="block text-sm font-medium text-slate-700 mb-1">
                  {ORG_SHORT_NAME} Supervisor
                </label>
                <select
                  id="assign-supervisor"
                  value={supervisorId}
                  onChange={(e) => setSupervisorId(e.target.value)}
                  className={INPUT_CLS}
                >
                  <option value="">None</option>
                  {supervisorCandidates.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.full_name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="assign-department" className="block text-sm font-medium text-slate-700 mb-1">Department</label>
                <select
                  id="assign-department"
                  value={departmentId}
                  onChange={(e) => setDepartmentId(e.target.value)}
                  className={INPUT_CLS}
                >
                  <option value="">None</option>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-slate-400 mt-1">Required for physical shadowing</p>
              </div>

              <div>
                <label htmlFor="assign-physical-day" className="block text-sm font-medium text-slate-700 mb-1">
                  Physical Day Override
                </label>
                <select
                  id="assign-physical-day"
                  value={physicalDay}
                  onChange={(e) => setPhysicalDay(e.target.value)}
                  className={INPUT_CLS}
                >
                  {DAY_OPTIONS.map((d) => (
                    <option key={d.value} value={d.value}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="md:col-span-2">
                <label htmlFor="assign-status" className="block text-sm font-medium text-slate-700 mb-1">Status</label>
                <select
                  id="assign-status"
                  value={status}
                  onChange={(e) => setStatus(e.target.value as InternProfileStatus)}
                  className={INPUT_CLS}
                >
                  {INTERN_STATUSES.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-3">
              SIWES Details
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label htmlFor="assign-institution-name" className="block text-sm font-medium text-slate-700 mb-1">
                  Institution Name
                </label>
                <input
                  id="assign-institution-name"
                  type="text"
                  value={institutionName}
                  onChange={(e) => setInstitutionName(e.target.value)}
                  placeholder="e.g., University of Lagos"
                  className={INPUT_CLS}
                />
              </div>

              <div>
                <label htmlFor="assign-faculty" className="block text-sm font-medium text-slate-700 mb-1">
                  Faculty / College
                </label>
                <input
                  id="assign-faculty"
                  type="text"
                  value={faculty}
                  onChange={(e) => setFaculty(e.target.value)}
                  placeholder="e.g., Faculty of Engineering"
                  className={INPUT_CLS}
                />
              </div>

              <div>
                <label htmlFor="assign-course" className="block text-sm font-medium text-slate-700 mb-1">
                  Course / Department
                </label>
                <input
                  id="assign-course"
                  type="text"
                  value={courseOfStudy}
                  onChange={(e) => setCourseOfStudy(e.target.value)}
                  placeholder="e.g., Computer Engineering"
                  className={INPUT_CLS}
                />
              </div>

              <div>
                <label htmlFor="assign-matric" className="block text-sm font-medium text-slate-700 mb-1">
                  Matric Number
                </label>
                <input
                  id="assign-matric"
                  type="text"
                  value={matricNumber}
                  onChange={(e) => setMatricNumber(e.target.value)}
                  placeholder="e.g., ENG/2020/001"
                  className={INPUT_CLS}
                />
              </div>

              <div>
                <label htmlFor="assign-siwes-start" className="block text-sm font-medium text-slate-700 mb-1">
                  SIWES Start Date
                </label>
                <input
                  id="assign-siwes-start"
                  type="date"
                  value={siwesStartDate}
                  onChange={(e) => setSiwesStartDate(e.target.value)}
                  className={INPUT_CLS}
                />
              </div>

              <div>
                <label htmlFor="assign-siwes-end" className="block text-sm font-medium text-slate-700 mb-1">
                  SIWES End Date
                </label>
                <input
                  id="assign-siwes-end"
                  type="date"
                  value={siwesEndDate}
                  onChange={(e) => setSiwesEndDate(e.target.value)}
                  className={INPUT_CLS}
                />
              </div>

              <div>
                <label htmlFor="assign-inst-supervisor-name" className="block text-sm font-medium text-slate-700 mb-1">
                  Institution Supervisor Name
                </label>
                <input
                  id="assign-inst-supervisor-name"
                  type="text"
                  value={instSupervisorName}
                  onChange={(e) => setInstSupervisorName(e.target.value)}
                  placeholder="Full name"
                  className={INPUT_CLS}
                />
              </div>

              <div>
                <label htmlFor="assign-inst-supervisor-email" className="block text-sm font-medium text-slate-700 mb-1">
                  Institution Supervisor Email
                </label>
                <input
                  id="assign-inst-supervisor-email"
                  type="email"
                  value={instSupervisorEmail}
                  onChange={(e) => setInstSupervisorEmail(e.target.value)}
                  placeholder="supervisor@university.edu"
                  className={INPUT_CLS}
                />
              </div>

              <div>
                <label htmlFor="assign-inst-supervisor-phone" className="block text-sm font-medium text-slate-700 mb-1">
                  Institution Supervisor Phone
                </label>
                <input
                  id="assign-inst-supervisor-phone"
                  type="tel"
                  value={instSupervisorPhone}
                  onChange={(e) => setInstSupervisorPhone(e.target.value)}
                  placeholder="+234 800 000 0000"
                  className={INPUT_CLS}
                />
              </div>

              <div>
                <label htmlFor="assign-emergency-name" className="block text-sm font-medium text-slate-700 mb-1">
                  Emergency Contact Name
                </label>
                <input
                  id="assign-emergency-name"
                  type="text"
                  value={emergencyContactName}
                  onChange={(e) => setEmergencyContactName(e.target.value)}
                  placeholder="Full name"
                  className={INPUT_CLS}
                />
              </div>

              <div className="md:col-span-2">
                <label htmlFor="assign-emergency-phone" className="block text-sm font-medium text-slate-700 mb-1">
                  Emergency Contact Phone
                </label>
                <input
                  id="assign-emergency-phone"
                  type="tel"
                  value={emergencyContactPhone}
                  onChange={(e) => setEmergencyContactPhone(e.target.value)}
                  placeholder="+234 800 000 0000"
                  className={INPUT_CLS}
                />
              </div>
            </div>
          </section>

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-700 px-4 py-2 rounded-lg font-medium transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 bg-iih-green hover:bg-iih-green-dark text-white px-4 py-2 rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
            >
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              {isEditing ? 'Save Changes' : 'Assign Intern'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
