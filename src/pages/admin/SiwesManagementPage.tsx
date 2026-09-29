import { useState, useEffect, useCallback, useMemo } from 'react';
import { toast } from 'react-hot-toast';
import { Plus, Edit2, BookOpen, Building2, Users, BarChart3, ClipboardList, Layers } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { SearchBox } from '../../components/admin/SearchBox';
import { cohortsApi } from '../../lib/api/cohorts';
import { departmentsApi } from '../../lib/api/departments';
import { internProfilesApi } from '../../lib/api/internProfiles';
import { usersApi } from '../../lib/api/users';
import {
  OrbitCohort,
  OrbitDepartment,
  OrbitInternProfile,
  OrbitUser,
  CohortStatus,
  InternProfileStatus,
  ParticipationMode,
} from '../../types/database';
import { formatDate } from '../../lib/utils/date';
import { SkeletonList } from '../../components/common/SkeletonLoader';
import { EmptyState } from '../../components/common/EmptyState';
import { CohortFormModal } from '../../components/admin/CohortFormModal';
import { DepartmentFormModal } from '../../components/admin/DepartmentFormModal';
import { InternAssignmentModal } from '../../components/admin/InternAssignmentModal';
import { SiwesReportsTab } from '../../components/admin/SiwesReportsTab';
import { TracksTab } from '../../components/admin/TracksTab';
import { ApplicationsTab } from '../../components/admin/ApplicationsTab';

// ── Constants ────────────────────────────────────────────────────────────────

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const SUB_TABS = [
  { key: 'cohorts', label: 'Cohorts', icon: BookOpen },
  { key: 'departments', label: 'Departments', icon: Building2 },
  { key: 'tracks', label: 'Tracks', icon: Layers },
  { key: 'interns', label: 'Interns', icon: Users },
  { key: 'applications', label: 'Applications', icon: ClipboardList },
  { key: 'reports', label: 'Reports', icon: BarChart3 },
] as const;

type SubTab = (typeof SUB_TABS)[number]['key'];

// ── Status pills ─────────────────────────────────────────────────────────────

function CohortStatusPill({ status }: { status: CohortStatus }) {
  const cls: Record<CohortStatus, string> = {
    draft: 'bg-slate-100 text-slate-600',
    active: 'bg-green-100 text-green-700',
    completed: 'bg-blue-100 text-blue-700',
    archived: 'bg-slate-100 text-slate-500',
  };
  return (
    <span className={`rounded-full px-3 py-1 text-xs font-semibold ${cls[status]}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

function InternStatusPill({ status }: { status: InternProfileStatus }) {
  const cls: Record<InternProfileStatus, string> = {
    pending: 'bg-amber-100 text-amber-700',
    active: 'bg-green-100 text-green-700',
    paused: 'bg-orange-100 text-orange-700',
    completed: 'bg-blue-100 text-blue-700',
    withdrawn: 'bg-red-100 text-red-600',
  };
  return (
    <span className={`rounded-full px-3 py-1 text-xs font-semibold ${cls[status]}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

function ModeLabel({ mode }: { mode: ParticipationMode }) {
  const map: Record<ParticipationMode, string> = {
    virtual: 'Virtual',
    hybrid: 'Hybrid',
    physical: 'Physical',
  };
  return <span className="text-sm text-slate-700">{map[mode]}</span>;
}

// ── Cohorts tab ───────────────────────────────────────────────────────────────

interface CohortsTabProps {
  cohorts: OrbitCohort[];
  loading: boolean;
  onNewCohort: () => void;
  onEditCohort: (c: OrbitCohort) => void;
}

function CohortsTab({ cohorts, loading, onNewCohort, onEditCohort }: CohortsTabProps) {
  const [search, setSearch] = useState('');
  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return cohorts;
    return cohorts.filter((c) =>
      [c.name, c.description, c.status].filter(Boolean).some((f) => String(f).toLowerCase().includes(needle)),
    );
  }, [cohorts, search]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-lg font-semibold text-slate-800">Cohorts</h2>
        <div className="flex flex-1 items-center justify-end gap-3">
          <SearchBox
            value={search}
            onChange={setSearch}
            placeholder="Search cohort name or status…"
            resultCount={shown.length}
            totalCount={cohorts.length}
            className="w-full sm:w-80"
          />
          <button
            onClick={onNewCohort}
            className="whitespace-nowrap bg-iih-green hover:bg-iih-green-dark text-white px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            New Cohort
          </button>
        </div>
      </div>

      {loading ? (
        <SkeletonList count={3} />
      ) : cohorts.length === 0 ? (
        <EmptyState
          illustration={<BookOpen className="h-7 w-7" />}
          title="No cohorts yet"
          description="Create the first cohort to start managing SIWES placements."
          cta={{ label: 'New Cohort', onClick: onNewCohort }}
        />
      ) : (
        <div className="bg-white rounded-lg shadow-sm border border-slate-200 overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50">
              <tr>
                {['Name', 'Dates', 'Status', 'Mode', 'Physical Day', 'Interns', 'Cadence', ''].map(
                  (h) => (
                    <th
                      key={h}
                      className="px-6 py-3 text-left text-xs font-semibold text-slate-500 uppercase"
                    >
                      {h}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-slate-200">
              {shown.map((c) => (
                <tr key={c.id} className="hover:bg-slate-50 transition-colors">
                  <td className="px-6 py-4">
                    <p className="text-sm font-semibold text-slate-800">{c.name}</p>
                    {c.description && (
                      <p className="text-xs text-slate-400 mt-0.5 max-w-xs truncate">
                        {c.description}
                      </p>
                    )}
                  </td>
                  <td className="px-6 py-4 text-sm text-slate-600 whitespace-nowrap">
                    {formatDate(c.start_date)} — {formatDate(c.end_date)}
                  </td>
                  <td className="px-6 py-4">
                    <CohortStatusPill status={c.status} />
                  </td>
                  <td className="px-6 py-4">
                    <ModeLabel mode={c.default_participation_mode} />
                  </td>
                  <td className="px-6 py-4 text-sm text-slate-600">
                    {c.default_physical_day != null ? DAY_NAMES[c.default_physical_day] : '—'}
                  </td>
                  <td className="px-6 py-4 text-sm text-slate-700">{c.intern_count ?? 0}</td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {c.daily_logs_required && (
                        <span className="bg-blue-50 text-blue-700 text-xs rounded-full px-2 py-0.5 font-medium">
                          Daily
                        </span>
                      )}
                      {c.weekly_summary_required && (
                        <span className="bg-purple-50 text-purple-700 text-xs rounded-full px-2 py-0.5 font-medium">
                          Weekly
                        </span>
                      )}
                      {c.signoff_required && (
                        <span className="bg-amber-50 text-amber-700 text-xs rounded-full px-2 py-0.5 font-medium">
                          Sign-off
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-4 text-right">
                    <button
                      onClick={() => onEditCohort(c)}
                      className="bg-slate-100 hover:bg-slate-200 text-slate-700 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5"
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Departments tab ───────────────────────────────────────────────────────────

interface DepartmentsTabProps {
  departments: OrbitDepartment[];
  users: OrbitUser[];
  loading: boolean;
  onNewDepartment: () => void;
  onEditDepartment: (d: OrbitDepartment) => void;
}

function DepartmentsTab({
  departments,
  users,
  loading,
  onNewDepartment,
  onEditDepartment,
}: DepartmentsTabProps) {
  const [search, setSearch] = useState('');
  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return departments;
    return departments.filter((d) => {
      // The row's own lead name first: `users` is one 200-row page, and the
      // table renders `d.lead_name` — matching only through the lookup meant a
      // visible lead beyond that page could not be found.
      const lead = users.find((u) => u.id === d.lead_user_id);
      return [d.name, d.description, d.lead_name, lead?.full_name]
        .filter(Boolean)
        .some((f) => String(f).toLowerCase().includes(needle));
    });
  }, [departments, users, search]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-lg font-semibold text-slate-800">Departments</h2>
        <div className="flex flex-1 items-center justify-end gap-3">
          <SearchBox
            value={search}
            onChange={setSearch}
            placeholder="Search department or lead…"
            resultCount={shown.length}
            totalCount={departments.length}
            className="w-full sm:w-80"
          />
        <button
          onClick={onNewDepartment}
          className="bg-iih-green hover:bg-iih-green-dark text-white px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2"
        >
          <Plus className="w-4 h-4" />
          New Department
        </button>
        </div>
      </div>

      {loading ? (
        <SkeletonList count={3} />
      ) : departments.length === 0 ? (
        <EmptyState
          illustration={<Building2 className="h-7 w-7" />}
          title="No departments yet"
          description="Add departments to organise physical interns by team."
          cta={{ label: 'New Department', onClick: onNewDepartment }}
        />
      ) : (
        <div className="bg-white rounded-lg shadow-sm border border-slate-200 overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50">
              <tr>
                {['Name', 'Lead', 'Interns', 'Active', ''].map((h) => (
                  <th
                    key={h}
                    className="px-6 py-3 text-left text-xs font-semibold text-slate-500 uppercase"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-slate-200">
              {shown.map((d) => (
                <tr key={d.id} className="hover:bg-slate-50 transition-colors">
                  <td className="px-6 py-4">
                    <p className="text-sm font-semibold text-slate-800">{d.name}</p>
                    {d.description && (
                      <p className="text-xs text-slate-400 mt-0.5 max-w-xs truncate">
                        {d.description}
                      </p>
                    )}
                  </td>
                  <td className="px-6 py-4 text-sm text-slate-600">
                    {d.lead_name ?? (d.lead_user_id
                      ? (users.find((u) => u.id === d.lead_user_id)?.full_name ?? '—')
                      : '—')}
                  </td>
                  <td className="px-6 py-4 text-sm text-slate-700">{d.intern_count ?? 0}</td>
                  <td className="px-6 py-4 text-sm text-slate-600">
                    {d.is_active ? 'Yes' : 'No'}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <button
                      onClick={() => onEditDepartment(d)}
                      className="bg-slate-100 hover:bg-slate-200 text-slate-700 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5"
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Interns tab ───────────────────────────────────────────────────────────────

interface InternsTabProps {
  profiles: OrbitInternProfile[];
  cohorts: OrbitCohort[];
  departments: OrbitDepartment[];
  users: OrbitUser[];
  loading: boolean;
  selectedCohortId: string;
  onCohortFilter: (id: string) => void;
  onAssignIntern: () => void;
  onEditProfile: (p: OrbitInternProfile) => void;
}

function InternsTab({
  profiles,
  cohorts,
  departments,
  users,
  loading,
  selectedCohortId,
  onCohortFilter,
  onAssignIntern,
  onEditProfile,
}: InternsTabProps) {
  const [search, setSearch] = useState('');

  /**
   * Filtered here rather than on the server: the roster is already loaded in
   * full for the cohort filter beside it, so a round trip would add latency
   * without adding reach.
   */
  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return profiles;

    return profiles.filter((p) => {
      /**
       * The PROFILE's own name and email lead.
       *
       * `users` is one 200-row page, and the table renders `p.full_name` — so
       * matching only through a `users.find` meant that past 200 accounts a
       * search could miss someone whose name was visibly on screen. The lookup
       * stays as a secondary source for rows where the profile carries neither.
       */
      const person = users.find((u) => u.id === p.user_id);
      return [
        p.full_name,
        p.email,
        person?.full_name,
        person?.email,
        p.matric_number,
        p.institution_name,
        p.course_of_study,
      ]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(needle));
    });
  }, [profiles, users, search]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-slate-800">Interns</h2>
          <select
            value={selectedCohortId}
            onChange={(e) => onCohortFilter(e.target.value)}
            aria-label="Filter by cohort"
            className="px-3 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-iih-green focus:border-transparent"
          >
            <option value="">All cohorts</option>
            {cohorts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <SearchBox
            value={search}
            onChange={setSearch}
            placeholder="Search name, email, matric or institution…"
            resultCount={shown.length}
            totalCount={profiles.length}
            className="w-full sm:w-96"
          />
        </div>
        <button
          onClick={onAssignIntern}
          className="bg-iih-green hover:bg-iih-green-dark text-white px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2"
        >
          <Plus className="w-4 h-4" />
          Assign Intern
        </button>
      </div>

      {loading ? (
        <SkeletonList count={4} />
      ) : profiles.length === 0 ? (
        <EmptyState
          illustration={<Users className="h-7 w-7" />}
          title="No interns found"
          description={
            selectedCohortId
              ? 'No interns assigned to this cohort yet.'
              : 'No intern profiles exist yet.'
          }
          cta={{ label: 'Assign Intern', onClick: onAssignIntern }}
        />
      ) : (
        <div className="bg-white rounded-lg shadow-sm border border-slate-200 overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50">
              <tr>
                {['Intern', 'Cohort', 'Mode', 'Supervisor', 'Department', 'Status', ''].map((h) => (
                  <th
                    key={h}
                    className="px-6 py-3 text-left text-xs font-semibold text-slate-500 uppercase"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-slate-200">
              {shown.map((p) => (
                <tr key={p.id} className="hover:bg-slate-50 transition-colors">
                  <td className="px-6 py-4">
                    <p className="text-sm font-semibold text-slate-800">{p.full_name ?? '—'}</p>
                    <p className="text-xs text-slate-400">{p.email ?? ''}</p>
                  </td>
                  <td className="px-6 py-4 text-sm text-slate-600">
                    {p.cohort_name ??
                      cohorts.find((c) => c.id === p.cohort_id)?.name ??
                      '—'}
                  </td>
                  <td className="px-6 py-4">
                    <ModeLabel mode={p.participation_mode} />
                  </td>
                  <td className="px-6 py-4 text-sm text-slate-600">
                    {p.supervisor_name ??
                      (p.iih_supervisor_id
                        ? (users.find((u) => u.id === p.iih_supervisor_id)?.full_name ?? '—')
                        : '—')}
                  </td>
                  <td className="px-6 py-4 text-sm text-slate-600">
                    {p.department_name ??
                      (p.department_id
                        ? (departments.find((d) => d.id === p.department_id)?.name ?? '—')
                        : '—')}
                  </td>
                  <td className="px-6 py-4">
                    <InternStatusPill status={p.status} />
                  </td>
                  <td className="px-6 py-4 text-right">
                    <button
                      onClick={() => onEditProfile(p)}
                      className="bg-slate-100 hover:bg-slate-200 text-slate-700 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5"
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function SiwesManagementPage() {
  useAuth(); // ensure auth context is connected

  const [activeTab, setActiveTab] = useState<SubTab>('cohorts');

  // Data
  const [cohorts, setCohorts] = useState<OrbitCohort[]>([]);
  const [departments, setDepartments] = useState<OrbitDepartment[]>([]);
  const [users, setUsers] = useState<OrbitUser[]>([]);
  const [profiles, setProfiles] = useState<OrbitInternProfile[]>([]);

  // Loading states
  const [loadingCohorts, setLoadingCohorts] = useState(true);
  const [loadingDepts, setLoadingDepts] = useState(true);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [loadingProfiles, setLoadingProfiles] = useState(false);

  // Intern tab filter
  const [selectedCohortFilter, setSelectedCohortFilter] = useState('');

  // Modals
  const [cohortModal, setCohortModal] = useState<OrbitCohort | null | 'new'>(null);
  const [deptModal, setDeptModal] = useState<OrbitDepartment | null | 'new'>(null);
  const [internModal, setInternModal] = useState<OrbitInternProfile | null | 'new'>(null);

  const loadCohorts = useCallback(async () => {
    setLoadingCohorts(true);
    try {
      const data = await cohortsApi.getCohorts();
      setCohorts(data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load cohorts');
    } finally {
      setLoadingCohorts(false);
    }
  }, []);

  const loadDepartments = useCallback(async () => {
    setLoadingDepts(true);
    try {
      const data = await departmentsApi.getDepartments();
      setDepartments(data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load departments');
    } finally {
      setLoadingDepts(false);
    }
  }, []);

  const loadUsers = useCallback(async () => {
    setLoadingUsers(true);
    try {
      const data = await usersApi.getActiveUsers(0, 200);
      setUsers(data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load users');
    } finally {
      setLoadingUsers(false);
    }
  }, []);

  const loadProfiles = useCallback(async (cohortId?: string) => {
    setLoadingProfiles(true);
    try {
      const data = await internProfilesApi.getInternProfiles(cohortId || undefined);
      setProfiles(data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load intern profiles');
    } finally {
      setLoadingProfiles(false);
    }
  }, []);

  useEffect(() => {
    loadCohorts();
    loadDepartments();
    loadUsers();
  }, [loadCohorts, loadDepartments, loadUsers]);

  useEffect(() => {
    if (activeTab === 'interns') {
      loadProfiles(selectedCohortFilter || undefined);
    }
  }, [activeTab, selectedCohortFilter, loadProfiles]);

  const handleCohortFilter = (id: string) => {
    setSelectedCohortFilter(id);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">SIWES Management</h1>
        <p className="text-slate-500 text-sm mt-1">
          Manage cohorts, departments, intern assignments, and compliance reports.
        </p>
      </div>

      {/* Sub-tab bar */}
      <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-1 flex gap-1 w-fit">
        {SUB_TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            /* Addressable without ambiguity. "Applications" now names both a
               top-level admin tab and this sub-tab, so a role+name lookup
               matches two controls on the same page. */
            data-siwes-tab={key}
            onClick={() => setActiveTab(key)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              activeTab === key
                ? 'bg-iih-green text-white'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'cohorts' && (
        <div className="bg-white rounded-lg shadow-sm p-6 border border-slate-200">
          <CohortsTab
            cohorts={cohorts}
            loading={loadingCohorts}
            onNewCohort={() => setCohortModal('new')}
            onEditCohort={(c) => setCohortModal(c)}
          />
        </div>
      )}

      {activeTab === 'departments' && (
        <div className="bg-white rounded-lg shadow-sm p-6 border border-slate-200">
          <DepartmentsTab
            departments={departments}
            users={users}
            loading={loadingDepts || loadingUsers}
            onNewDepartment={() => setDeptModal('new')}
            onEditDepartment={(d) => setDeptModal(d)}
          />
        </div>
      )}

      {activeTab === 'interns' && (
        <div className="bg-white rounded-lg shadow-sm p-6 border border-slate-200">
          <InternsTab
            profiles={profiles}
            cohorts={cohorts}
            departments={departments}
            users={users}
            loading={loadingProfiles || loadingUsers}
            selectedCohortId={selectedCohortFilter}
            onCohortFilter={handleCohortFilter}
            onAssignIntern={() => setInternModal('new')}
            onEditProfile={(p) => setInternModal(p)}
          />
        </div>
      )}

      {activeTab === 'applications' && (
        <div className="bg-white rounded-lg shadow-sm p-6 border border-slate-200">
          {/* SIWES candidates only. Every programme's applications used to
              land here, under a heading that said SIWES — on the live platform
              two thirds of them are not. The general queue is its own admin
              tab now. */}
          <ApplicationsTab
            programmeType="siwes"
            heading="SIWES Applications"
            description="SIWES candidates only. Other programmes are under Admin → Applications."
          />
        </div>
      )}

      {activeTab === 'tracks' && (
        <div className="bg-white rounded-lg shadow-sm p-6 border border-slate-200">
          <TracksTab />
        </div>
      )}

      {activeTab === 'reports' && (
        <div className="bg-white rounded-lg shadow-sm p-6 border border-slate-200">
          <SiwesReportsTab cohorts={cohorts} />
        </div>
      )}

      {/* Modals */}
      {cohortModal != null && (
        <CohortFormModal
          cohort={cohortModal === 'new' ? null : cohortModal}
          onClose={() => setCohortModal(null)}
          onSaved={() => {
            setCohortModal(null);
            loadCohorts();
          }}
        />
      )}

      {deptModal != null && (
        <DepartmentFormModal
          department={deptModal === 'new' ? null : deptModal}
          users={users}
          onClose={() => setDeptModal(null)}
          onSaved={() => {
            setDeptModal(null);
            loadDepartments();
          }}
        />
      )}

      {internModal != null && (
        <InternAssignmentModal
          profile={internModal === 'new' ? null : internModal}
          cohorts={cohorts}
          departments={departments}
          users={users}
          onClose={() => setInternModal(null)}
          onSaved={() => {
            setInternModal(null);
            loadProfiles(selectedCohortFilter || undefined);
          }}
        />
      )}
    </div>
  );
}
