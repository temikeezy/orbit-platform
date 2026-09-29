import toast from 'react-hot-toast';
import { useState, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { settingsApi } from '../../lib/api/settings';
import { streamsApi } from '../../lib/api/streams';
import { convexHttp as convex } from '../../lib/convex';
import { api } from '../../../convex/_generated/api';
import { authService } from '../../lib/auth';
import { OrbitAdminSetting, OrbitStream } from '../../types/database';
import { Settings, Mail, Key, Globe, Loader2, Save, TestTube, FileCheck, FileText, Database, Upload, Shield, ScrollText, RefreshCw, FlaskConical, Trash2 } from 'lucide-react';
import { storageUtils } from '../../lib/utils/storage';

/**
 * A number input's value, or the fallback when it is not one.
 *
 * Selecting a number field's contents and deleting them yields `''`, and
 * `parseInt('')` is `NaN` — which React reports as a controlled-input warning,
 * renders as "Files larger than NaN MB will be rejected", and serialises to
 * `null` on save. Every number field on this page shared that.
 */
function intOr(raw: string, fallback: number): number {
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}
import { logError } from '../../lib/monitoring';
import { OperationsSettings } from '../../components/admin/OperationsSettings';


interface SettingsPageProps {
  onNavigate?: (page: string) => void;
}

export function SettingsPage({ onNavigate }: SettingsPageProps = {}) {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<'general' | 'email' | 'oauth' | 'submissions' | 'backup' | 'audit' | 'security' | 'seed'>('general');
  const [settings, setSettings] = useState<OrbitAdminSetting[]>([]);
  const [streams, setStreams] = useState<OrbitStream[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingEmail, setTestingEmail] = useState(false);
  const [message, setMessage] = useState({ type: '', text: '' });

  const tabs = [
    { id: 'general', label: 'General Settings', icon: Globe },
    { id: 'email', label: 'Email Configuration', icon: Mail },
    { id: 'oauth', label: 'OAuth Settings', icon: Key },
    { id: 'submissions', label: 'Task Submissions', icon: FileCheck },
    { id: 'backup', label: 'Database Backup', icon: Database },
    { id: 'audit', label: 'Audit Log', icon: ScrollText },
    { id: 'security', label: 'Security', icon: Shield },
    { id: 'seed', label: 'Seed / Demo Data', icon: FlaskConical },
  ] as const;

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      setLoading(true);
      const [settingsData, streamsData] = await Promise.all([
        settingsApi.getAllSettings(),
        streamsApi.getActiveStreams(),
      ]);
      setSettings(settingsData);
      setStreams(streamsData);
    } catch {
      setMessage({ type: 'error', text: 'Failed to load settings' });
    } finally {
      setLoading(false);
    }
  };

  const handleSaveSetting = async (key: string, value: Record<string, unknown>) => {
    try {
      setSaving(true);
      await settingsApi.updateSetting(key, { setting_value: value }, user!.id);
      await loadSettings();
      setMessage({ type: 'success', text: 'Settings saved successfully' });
      setTimeout(() => setMessage({ type: '', text: '' }), 3000);
    } catch {
      setMessage({ type: 'error', text: 'Failed to save settings' });
    } finally {
      setSaving(false);
    }
  };

  const handleTestEmail = async () => {
    try {
      setTestingEmail(true);
      await settingsApi.sendEmail(
        user!.email,
        'Test Email from ORBIT',
        '<h1>Test Email</h1><p>This is a test email from the ORBIT platform.</p>',
        'Test Email - This is a test email from the ORBIT platform.'
      );
      setMessage({ type: 'success', text: 'Test email sent successfully! Check your inbox.' });
    } catch {
      setMessage({ type: 'error', text: 'Failed to send test email' });
    } finally {
      setTestingEmail(false);
    }
  };

  const renderContent = () => {
    const categorySettings = settings.filter((s) => s.category === activeTab);

    switch (activeTab) {
      case 'general':
        return <GeneralSettings settings={categorySettings} streams={streams} onSave={handleSaveSetting} saving={saving} />;
      case 'email':
        return (
          <EmailSettings
            settings={categorySettings}
            onSave={handleSaveSetting}
            onTest={handleTestEmail}
            onViewLogs={() => onNavigate?.('email-logs')}
            saving={saving}
            testing={testingEmail}
          />
        );
      case 'oauth':
        return <OAuthSettings settings={categorySettings} onSave={handleSaveSetting} saving={saving} />;
      case 'submissions':
        return <SubmissionSettings settings={categorySettings} onSave={handleSaveSetting} saving={saving} />;
      case 'backup':
        return <BackupSettings onNavigate={onNavigate} />;
      case 'audit':
        return <AuditLogSettings />;
      case 'security':
        return <SecurityDashboardSettings />;
      case 'seed':
        return <SeedDataSettings />;
      default:
        return null;
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-orbit-canvas flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-iih-green" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-orbit-canvas">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-slate-800 flex items-center gap-3">
            <Settings className="w-8 h-8 text-iih-green" />
            Admin Settings
          </h1>
          <p className="text-slate-600 mt-1">Configure platform settings and integrations</p>
        </div>

        {message.text && (
          <div
            className={`mb-6 px-4 py-3 rounded-lg ${
              message.type === 'success'
                ? 'bg-green-50 border border-green-200 text-green-700'
                : 'bg-red-50 border border-red-200 text-red-700'
            }`}
          >
            {message.text}
          </div>
        )}

        {/*
          A LEFT RAIL, not a tab strip.
          Eight sections with names like "Email Configuration" and "Seed / Demo
          Data" do not fit across a row: they overflowed into a horizontal
          scroller, so which sections existed depended on how wide the window
          was and the ones at the end were effectively hidden. Down the side,
          every label is readable at once and the list can grow without the
          layout deciding what you get to see.
        */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[248px_1fr] lg:items-start">
          <nav aria-label="Settings sections" className="lg:sticky lg:top-6">
            <ul className="flex gap-1 overflow-x-auto rounded-xl bg-white p-2 shadow-sm lg:flex-col lg:overflow-visible">
              {tabs.map((tab) => {
                const Icon = tab.icon;
                const active = activeTab === tab.id;
                return (
                  <li key={tab.id}>
                    <button
                      onClick={() => setActiveTab(tab.id)}
                      aria-current={active ? 'page' : undefined}
                      className={`flex w-full items-center gap-3 whitespace-nowrap rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-colors lg:whitespace-normal ${
                        active
                          ? 'bg-iih-green/10 text-iih-green'
                          : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                      }`}
                    >
                      <Icon className={`h-5 w-5 shrink-0 ${active ? 'text-iih-green' : 'text-slate-400'}`} />
                      {tab.label}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="rounded-xl bg-white p-6 shadow-sm">{renderContent()}</div>
        </div>
      </div>
    </div>
  );
}

function GeneralSettings({
  settings,
  streams,
  onSave,
  saving,
}: {
  settings: OrbitAdminSetting[];
  streams: OrbitStream[];
  onSave: (key: string, value: Record<string, unknown>) => void;
  saving: boolean;
}) {
  const maxStreamsSetting = settings.find((s) => s.setting_key === 'max_streams_per_intern');
  const eventStreamSetting = settings.find((s) => s.setting_key === 'event_stream_id');
  const siteNameSetting = settings.find((s) => s.setting_key === 'site_name');
  const siteTitleSetting = settings.find((s) => s.setting_key === 'site_title');
  const siteLogoSetting = settings.find((s) => s.setting_key === 'site_logo_url');
  const appUrlSetting = settings.find((s) => s.setting_key === 'app_url');

  const [maxStreams, setMaxStreams] = useState<number>(
    (maxStreamsSetting?.setting_value.value as number) || 1
  );
  const [maxStreamsEnabled, setMaxStreamsEnabled] = useState<boolean>(
    // `??`, not `||`. `false || true` is `true`, so a limit an admin had
    // switched OFF rendered as on, and saving the section wrote `enabled: true`
    // straight back over their choice. `??` defaults only when the setting is
    // genuinely absent, which is what "default to enabled" was meant to say.
    (maxStreamsSetting?.setting_value.enabled as boolean) ?? true
  );
  const [eventStreamId, setEventStreamId] = useState<string>(
    (eventStreamSetting?.setting_value.stream_id as string) || ''
  );
  const [siteName, setSiteName] = useState<string>(
    (siteNameSetting?.setting_value as unknown as string) || 'ORBIT'
  );
  const [siteTitle, setSiteTitle] = useState<string>(
    (siteTitleSetting?.setting_value as unknown as string) || 'ORBIT'
  );
  const [siteLogo, setSiteLogo] = useState<string | null>(
    (siteLogoSetting?.setting_value as unknown as string) || null
  );
  const [appUrl, setAppUrl] = useState<string>(
    (appUrlSetting?.setting_value as unknown as string) || 'https://orbit2.iih.ng'
  );
  const [uploadingLogo, setUploadingLogo] = useState(false);

  const handleSave = () => {
    onSave('max_streams_per_intern', { value: maxStreams, enabled: maxStreamsEnabled });
  };

  const handleSaveEventStream = () => {
    onSave('event_stream_id', { stream_id: eventStreamId });
  };

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      toast.error('Please select an image file');
      return;
    }

    try {
      setUploadingLogo(true);
      const { url } = await storageUtils.uploadSiteLogo(file);
      setSiteLogo(url);
      onSave('site_logo_url', url as unknown as Record<string, unknown>);
    } catch (error) {
      logError(error, { context: 'SettingsPage.handleLogoUpload' });
      toast.error('Failed to upload logo');
    } finally {
      setUploadingLogo(false);
    }
  };

  const handleSaveBranding = () => {
    onSave('site_name', siteName as unknown as Record<string, unknown>);
    onSave('site_title', siteTitle as unknown as Record<string, unknown>);
    if (appUrl) onSave('app_url', appUrl as unknown as Record<string, unknown>);
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-bold text-slate-800 mb-4">Site Branding</h3>
        <div className="space-y-4">
          <div>
            <label htmlFor="settings-site-name" className="block text-sm font-medium text-slate-700 mb-2">
              Site Name
            </label>
            <input
              id="settings-site-name"
              type="text"
              value={siteName}
              onChange={(e) => setSiteName(e.target.value)}
              className="w-full max-w-md px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
              placeholder="ORBIT"
            />
            <p className="text-sm text-slate-500 mt-1">
              The name displayed throughout the site
            </p>
          </div>

          <div>
            <label htmlFor="settings-site-title" className="block text-sm font-medium text-slate-700 mb-2">
              Site Title
            </label>
            <input
              id="settings-site-title"
              type="text"
              value={siteTitle}
              onChange={(e) => setSiteTitle(e.target.value)}
              className="w-full max-w-md px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
              placeholder="ORBIT - Onboarding & Resource Building Initiative"
            />
            <p className="text-sm text-slate-500 mt-1">
              The full title of the application
            </p>
          </div>

          <div>
            <label htmlFor="settings-app-url" className="block text-sm font-medium text-slate-700 mb-2">
              Application URL
            </label>
            <input
              id="settings-app-url"
              type="url"
              value={appUrl}
              onChange={(e) => setAppUrl(e.target.value)}
              className="w-full max-w-md px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
              placeholder="https://orbit2.iih.ng"
            />
            <p className="text-sm text-slate-500 mt-1">
              Public URL of the app — used in email links
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">
              Site Logo
            </label>
            {siteLogo && (
              <div className="mb-3">
                <img
                  src={siteLogo}
                  alt="Site Logo"
                  className="h-20 object-contain bg-slate-100 rounded-lg p-2"
                />
              </div>
            )}
            <div className="flex items-center gap-3">
              <label className="cursor-pointer bg-slate-100 hover:bg-slate-200 text-slate-700 px-4 py-2 rounded-lg font-medium flex items-center gap-2 transition-colors">
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleLogoUpload}
                  className="hidden"
                  disabled={uploadingLogo}
                />
                {uploadingLogo ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    Uploading...
                  </>
                ) : (
                  <>
                    <Upload className="w-5 h-5" />
                    Upload Logo
                  </>
                )}
              </label>
            </div>
            <p className="text-sm text-slate-500 mt-1">
              Recommended: PNG or SVG, transparent background, max 500KB
            </p>
          </div>

          <button
            onClick={handleSaveBranding}
            disabled={saving}
            className="bg-iih-green hover:bg-iih-green-dark text-white px-6 py-2 rounded-lg font-medium flex items-center gap-2 transition-colors disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
            Save Branding
          </button>
        </div>
      </div>

      {/* Operational switches — what ORBIT does in the world, rather than how
          it looks. Super-admin only, and gated inside the component. */}
      <OperationsSettings />

      <div>
        <h3 className="text-lg font-bold text-slate-800 mb-4">Stream Membership Settings</h3>
        <div className="space-y-4">
          <div>
            <label htmlFor="settings-max-streams" className="block text-sm font-medium text-slate-700 mb-2">
              Maximum Streams Per Intern
            </label>
            <input
              id="settings-max-streams"
              type="number"
              min="1"
              value={maxStreams}
              onChange={(e) => setMaxStreams(intOr(e.target.value, 1))}
              className="w-full max-w-xs px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
            />
            <p className="text-sm text-slate-500 mt-1">
              How many streams can an intern join simultaneously?
            </p>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="max-streams-enabled"
              checked={maxStreamsEnabled}
              onChange={(e) => setMaxStreamsEnabled(e.target.checked)}
              className="w-4 h-4 text-iih-green rounded focus:ring-2 focus:ring-iih-green"
            />
            <label htmlFor="max-streams-enabled" className="text-sm font-medium text-slate-700">
              Enforce stream limit
            </label>
          </div>

          <button
            onClick={handleSave}
            disabled={saving}
            className="bg-iih-green hover:bg-iih-green-dark text-white px-6 py-2 rounded-lg font-medium flex items-center gap-2 transition-colors disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
            Save Changes
          </button>
        </div>
      </div>

      <div>
        <h3 className="text-lg font-bold text-slate-800 mb-4">Level Progression Settings</h3>
        <div className="space-y-4">
          <div>
            <label htmlFor="settings-event-stream" className="block text-sm font-medium text-slate-700 mb-2">
              Event Stream (Event Orbit Ilorin)
            </label>
            <select
              id="settings-event-stream"
              value={eventStreamId}
              onChange={(e) => setEventStreamId(e.target.value)}
              className="w-full max-w-md px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
            >
              <option value="">No event stream selected</option>
              {streams.map((stream) => (
                <option key={stream.id} value={stream.id}>
                  {stream.name}
                </option>
              ))}
            </select>
            <p className="text-sm text-slate-500 mt-1">
              Members in this stream can reach Level 3 (Event Orbit Ilorin) at 300 points. Other members skip from Level 2 (Active Orbit) to Level 4 (Orbit Stars).
            </p>
          </div>

          <button
            onClick={handleSaveEventStream}
            disabled={saving}
            className="bg-iih-green hover:bg-iih-green-dark text-white px-6 py-2 rounded-lg font-medium flex items-center gap-2 transition-colors disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
            Save Event Stream
          </button>
        </div>
      </div>
    </div>
  );
}

function EmailSettings({
  settings,
  onSave,
  onTest,
  onViewLogs,
  saving,
  testing,
}: {
  settings: OrbitAdminSetting[];
  onSave: (key: string, value: Record<string, unknown>) => void;
  onTest: () => void;
  onViewLogs?: () => void;
  saving: boolean;
  testing: boolean;
}) {
  const smtpSetting = settings.find((s) => s.setting_key === 'zeptomail_config');
  // Defaults describe the shared IIH ZeptoMail account. Credentials (user/pass)
  // deliberately have no defaults — they are entered here after the account
  // password is rotated, and are never seeded by migration.
  const [config, setConfig] = useState({
    host: (smtpSetting?.setting_value.host as string) || 'smtp.zeptomail.com',
    port: (smtpSetting?.setting_value.port as number) || 587,
    user: (smtpSetting?.setting_value.user as string) || '',
    // The verified sending domain. 'noreply@iih.ng' was wrong here — the
    // deployment default is orbit2.iih.ng, and ZeptoMail rejects the other.
    from: (smtpSetting?.setting_value.from as string) || 'noreply@orbit2.iih.ng',
    fromName: (smtpSetting?.setting_value.fromName as string) || 'ORBIT Team',
  });

  const handleSave = () => {
    onSave('zeptomail_config', config);
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-bold text-slate-800 mb-4">SMTP Configuration</h3>
        {/*
          This screen does NOT control delivery, and used to imply that it did:
          it saved a `zeptomail_config` setting that the sender never reads.
          Rotating a credential here reported success and changed nothing, which
          is worse than having no screen at all — you would believe the old
          password was out of use.
        */}
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <strong>Read-only reference.</strong> Delivery is configured on the deployment,
          not here — the sender reads <code className="rounded bg-amber-100 px-1">SMTP_HOST</code>,{' '}
          <code className="rounded bg-amber-100 px-1">SMTP_USER</code> and{' '}
          <code className="rounded bg-amber-100 px-1">SMTP_PASSWORD</code> from the Convex
          environment. Saving here records what you expect to be true; it does not change
          what ORBIT sends with. To rotate credentials, set them on the deployment.
        </div>
        <p className="text-sm text-slate-600 mb-4">
          ORBIT sends through ZeptoMail from the{' '}
          <code className="bg-slate-100 px-1 py-0.5 rounded text-xs">orbit2.iih.ng</code>{' '}
          domain, which is verified for outbound mail. The sender address must stay on a
          verified domain — ZeptoMail rejects anything else with{' '}
          <em>553 Sender is not allowed to relay emails</em>.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label htmlFor="smtp-host" className="block text-sm font-medium text-slate-700 mb-2">SMTP Host</label>
            <input
              id="smtp-host"
              type="text"
              value={config.host}
              onChange={(e) => setConfig({ ...config, host: e.target.value })}
              className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
            />
          </div>

          <div>
            <label htmlFor="smtp-port" className="block text-sm font-medium text-slate-700 mb-2">SMTP Port</label>
            <input
              id="smtp-port"
              type="number"
              value={config.port}
              onChange={(e) => setConfig({ ...config, port: intOr(e.target.value, 587) })}
              className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
            />
          </div>

          <div>
            <label htmlFor="smtp-user" className="block text-sm font-medium text-slate-700 mb-2">SMTP User</label>
            <input
              id="smtp-user"
              type="text"
              value={config.user}
              onChange={(e) => setConfig({ ...config, user: e.target.value })}
              className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
            />
          </div>

          {/*
            NO PASSWORD FIELD, deliberately.

            The sender reads SMTP_PASSWORD from the deployment environment and
            has never read this row, so a password typed here was stored and
            then consulted by nothing — a second copy of a live credential that
            no rotation would ever reach. The input is gone rather than
            disabled: a box that accepts a secret and silently discards it is
            its own kind of lie.
          */}
          <div>
            <span className="block text-sm font-medium text-slate-700 mb-2">SMTP Password</span>
            <p className="text-sm text-slate-500">
              Set on the deployment as{' '}
              <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">SMTP_PASSWORD</code>.
              It is not stored here and cannot be changed from this screen.
            </p>
          </div>

          <div>
            <label htmlFor="smtp-from-email" className="block text-sm font-medium text-slate-700 mb-2">From Email</label>
            <input
              id="smtp-from-email"
              type="email"
              value={config.from}
              onChange={(e) => setConfig({ ...config, from: e.target.value })}
              className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
            />
          </div>

          <div>
            <label htmlFor="smtp-from-name" className="block text-sm font-medium text-slate-700 mb-2">From Name</label>
            <input
              id="smtp-from-name"
              type="text"
              value={config.fromName}
              onChange={(e) => setConfig({ ...config, fromName: e.target.value })}
              className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
            />
          </div>
        </div>

        <div className="flex gap-3 mt-6">
          <button
            onClick={handleSave}
            disabled={saving}
            className="bg-iih-green hover:bg-iih-green-dark text-white px-6 py-2 rounded-lg font-medium flex items-center gap-2 transition-colors disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
            Save Configuration
          </button>

          <button
            onClick={onTest}
            disabled={testing}
            className="bg-slate-100 hover:bg-slate-200 text-slate-700 px-6 py-2 rounded-lg font-medium flex items-center gap-2 transition-colors disabled:opacity-50"
          >
            {testing ? <Loader2 className="w-5 h-5 animate-spin" /> : <TestTube className="w-5 h-5" />}
            Send Test Email
          </button>

          {onViewLogs && (
            <button
              onClick={onViewLogs}
              className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg font-medium flex items-center gap-2 transition-colors"
            >
              <FileText className="w-5 h-5" />
              View Email Logs
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function OAuthSettings({
  settings,
  onSave,
  saving,
}: {
  settings: OrbitAdminSetting[];
  onSave: (key: string, value: Record<string, unknown>) => void;
  saving: boolean;
}) {
  const zohoSetting = settings.find((s) => s.setting_key === 'zoho_oauth_config');
  const [config, setConfig] = useState({
    clientId: (zohoSetting?.setting_value.clientId as string) || '',
    redirectUri: (zohoSetting?.setting_value.redirectUri as string) || '',
    enabled: (zohoSetting?.setting_value.enabled as boolean) || false,
  });

  const handleSave = () => {
    onSave('zoho_oauth_config', config);
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-bold text-slate-800 mb-4">Zoho OAuth Configuration</h3>
        <div className="space-y-4">
          <div>
            <label htmlFor="zoho-client-id" className="block text-sm font-medium text-slate-700 mb-2">Client ID</label>
            <input
              id="zoho-client-id"
              type="text"
              value={config.clientId}
              onChange={(e) => setConfig({ ...config, clientId: e.target.value })}
              className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
            />
          </div>

          <div>
            {/* Same reasoning as the SMTP password above: http.ts reads
                ZOHO_CLIENT_SECRET from the deployment, and this row never fed
                it. */}
            <span className="block text-sm font-medium text-slate-700 mb-2">Client Secret</span>
            <p className="text-sm text-slate-500">
              Set on the deployment as{' '}
              <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">ZOHO_CLIENT_SECRET</code>.
              It is not stored here and cannot be changed from this screen.
            </p>
          </div>

          <div>
            <label htmlFor="zoho-redirect-uri" className="block text-sm font-medium text-slate-700 mb-2">Redirect URI</label>
            <input
              id="zoho-redirect-uri"
              type="text"
              value={config.redirectUri}
              onChange={(e) => setConfig({ ...config, redirectUri: e.target.value })}
              className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
              placeholder="https://your-domain.com/auth/zoho/callback"
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="zoho-enabled"
              checked={config.enabled}
              onChange={(e) => setConfig({ ...config, enabled: e.target.checked })}
              className="w-4 h-4 text-iih-green rounded focus:ring-2 focus:ring-iih-green"
            />
            <label htmlFor="zoho-enabled" className="text-sm font-medium text-slate-700">
              Enable Zoho SSO
            </label>
          </div>

          <button
            onClick={handleSave}
            disabled={saving}
            className="bg-iih-green hover:bg-iih-green-dark text-white px-6 py-2 rounded-lg font-medium flex items-center gap-2 transition-colors disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
            Save Configuration
          </button>
        </div>
      </div>
    </div>
  );
}

function SubmissionSettings({
  settings,
  onSave,
  saving,
}: {
  settings: OrbitAdminSetting[];
  onSave: (key: string, value: Record<string, unknown>) => void;
  saving: boolean;
}) {
  const fileTypesSetting = settings.find((s) => s.setting_key === 'acceptable_file_types');
  const fileSizeSetting = settings.find((s) => s.setting_key === 'max_file_size_mb');

  const [fileTypes, setFileTypes] = useState<string[]>(
    (fileTypesSetting?.setting_value as unknown as string[]) || ['pdf', 'doc', 'docx', 'jpg', 'jpeg', 'png', 'txt', 'zip']
  );
  const [newFileType, setNewFileType] = useState('');
  const [maxFileSize, setMaxFileSize] = useState<number>(
    (fileSizeSetting?.setting_value.size as number) || 10
  );
  const [fileSizeEnabled, setFileSizeEnabled] = useState<boolean>(
    // See maxStreamsEnabled: `||` could not represent a disabled limit.
    (fileSizeSetting?.setting_value.enabled as boolean) ?? true
  );

  const handleAddFileType = () => {
    if (newFileType && !fileTypes.includes(newFileType.toLowerCase())) {
      setFileTypes([...fileTypes, newFileType.toLowerCase()]);
      setNewFileType('');
    }
  };

  const handleRemoveFileType = (type: string) => {
    setFileTypes(fileTypes.filter((t) => t !== type));
  };

  const handleSaveFileTypes = () => {
    onSave('acceptable_file_types', fileTypes as unknown as Record<string, unknown>);
  };

  const handleSaveFileSize = () => {
    onSave('max_file_size_mb', { size: maxFileSize, enabled: fileSizeEnabled });
  };

  return (
    <div className="space-y-8">
      <div>
        <h3 className="text-lg font-bold text-slate-800 mb-4">Maximum File Size</h3>
        <p className="text-sm text-slate-600 mb-4">
          Set the maximum file size allowed for task submissions
        </p>

        <div className="space-y-4">
          <div>
            <label htmlFor="settings-max-file-size" className="block text-sm font-medium text-slate-700 mb-2">
              Maximum File Size (MB)
            </label>
            <input
              id="settings-max-file-size"
              type="number"
              min="1"
              max="100"
              value={maxFileSize}
              onChange={(e) => setMaxFileSize(intOr(e.target.value, 10))}
              className="w-full max-w-xs px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
            />
            <p className="text-sm text-slate-500 mt-1">
              Files larger than {maxFileSize} MB will be rejected
            </p>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="file-size-enabled"
              checked={fileSizeEnabled}
              onChange={(e) => setFileSizeEnabled(e.target.checked)}
              className="w-4 h-4 text-iih-green rounded focus:ring-2 focus:ring-iih-green"
            />
            <label htmlFor="file-size-enabled" className="text-sm font-medium text-slate-700">
              Enforce file size limit
            </label>
          </div>

          <button
            onClick={handleSaveFileSize}
            disabled={saving}
            className="bg-iih-green hover:bg-iih-green-dark text-white px-6 py-2 rounded-lg font-medium flex items-center gap-2 transition-colors disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
            Save File Size Limit
          </button>
        </div>
      </div>

      <div>
        <h3 className="text-lg font-bold text-slate-800 mb-4">Acceptable File Types for Task Submissions</h3>
        <p className="text-sm text-slate-600 mb-4">
          Configure which file types users can upload when submitting tasks. Enter file extensions without the dot (e.g., pdf, jpg, docx).
        </p>

        <div className="space-y-4">
          <div>
            <label htmlFor="settings-add-file-type" className="block text-sm font-medium text-slate-700 mb-2">Add File Type</label>
            <div className="flex gap-2">
              <input
                id="settings-add-file-type"
                type="text"
                value={newFileType}
                onChange={(e) => setNewFileType(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleAddFileType()}
                placeholder="e.g., pdf, jpg, docx"
                className="flex-1 px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
              />
              <button
                onClick={handleAddFileType}
                className="bg-slate-200 hover:bg-slate-300 text-slate-800 px-4 py-2 rounded-lg font-medium transition-colors"
              >
                Add
              </button>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">Allowed File Types</label>
            <div className="flex flex-wrap gap-2">
              {fileTypes.map((type) => (
                <span
                  key={type}
                  className="inline-flex items-center gap-2 bg-green-100 text-slate-900 px-3 py-1 rounded-full text-sm font-medium"
                >
                  .{type}
                  <button
                    onClick={() => handleRemoveFileType(type)}
                    className="hover:text-red-600 transition-colors"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            {fileTypes.length === 0 && (
              <p className="text-sm text-amber-600 mt-2">
                Warning: No file types are allowed. Users will not be able to upload files.
              </p>
            )}
          </div>

          <button
            onClick={handleSaveFileTypes}
            disabled={saving}
            className="bg-iih-green hover:bg-iih-green-dark text-white px-6 py-2 rounded-lg font-medium flex items-center gap-2 transition-colors disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
            Save File Types
          </button>
        </div>
      </div>
    </div>
  );
}

interface BackupRow {
  id: string;
  description?: string;
  file_size?: number;
  created_at: string;
  status?: string;
}

/**
 * `settings` is gone from the signature along with what read it: the
 * backup_frequency and backup_retention_days rows described a pg_dump schedule
 * that no longer exists. Keeping the prop "just in case" would leave the next
 * reader believing this screen is wired to something.
 *
 * `onNavigate` STAYS. Removing it took the "View All Backups" button with it,
 * and that button is the ONLY route to the Backup Management tab — AdminDashboard
 * renders its tabs from useState with no URLs, and this tab is not in the visible
 * tab bar. Deleting the link silently orphaned a whole admin page. Caught by the
 * new smoke matrix, which is a fair advertisement for having built it.
 */
function BackupSettings({ onNavigate }: { onNavigate?: (page: string) => void }) {
  const [backups, setBackups] = useState<BackupRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadBackups();
  }, []);

  /**
   * Recent backups panel.
   *
   * `orbit_backups` recorded pg_dump files written to a Supabase storage
   * bucket. That whole mechanism backs up the database being decommissioned,
   * so there is nothing to list — and listing an empty panel would read as
   * "no backups exist" rather than "this is not how backups work any more".
   *
   * Convex snapshots are taken by the platform and exported with
   * `npx convex export`, which needs deploy credentials the browser does not
   * and should not have. The panel says so instead of pretending.
   */
  const loadBackups = async () => {
    setBackups([]);
    setLoading(false);
  };

  return (
    <div className="space-y-8">
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-6">
        <div className="flex items-start gap-4">
          <Database className="w-6 h-6 text-blue-600 flex-shrink-0 mt-1" />
          <div className="flex-1">
            {/*
              * This panel used to invite you to "configure automated database
              * backups" and printed a Backup Frequency and Retention Period
              * read from settings rows that nothing acts on. Both were
              * Supabase-era: the pg_dump job they described was decommissioned
              * with the database it dumped. A backup screen that reports a
              * schedule it is not keeping is worse than no backup screen — it
              * is the specific thing you check before doing something risky,
              * and it would have told you that you were covered. Since
              * 2026-09-29 a weekly data-only export does run (scripts/agent/
              * cycle.sh), so this states exactly that and no more.
              */}
            <h3 className="text-lg font-bold text-slate-800 mb-2">Database Backups</h3>
            <p className="text-slate-700 mb-4">
              A copy of ORBIT&rsquo;s data is exported every week by the ORBIT Agent&rsquo;s runner,
              verified, and kept on its machine (the newest four). It does not include uploaded
              files. Convex also takes its own platform snapshots. Anything beyond that has to be
              exported deliberately, from a machine holding deploy credentials — which the browser
              does not have and should not.
            </p>
            <p className="text-sm text-slate-600 mb-2">
              <strong>Take an export before anything destructive</strong> — a schema change that
              drops a field, a bulk import, a permanent deletion:
            </p>
            <pre className="text-xs bg-slate-900 text-slate-100 rounded-lg p-3 mb-4 overflow-x-auto">
              npm run convex:export -- --prod --path ./orbit-backup.zip
            </pre>
            <p className="text-sm text-slate-600 mb-4">
              That includes file storage. There is no restore button here either: restoring is a
              deliberate, credentialled operation, and putting a one-click version of it behind an
              admin session would be the most dangerous control on this page.
            </p>
            <button
              onClick={() => onNavigate?.('backup-management')}
              className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-lg font-medium flex items-center gap-2 transition-colors"
            >
              <Database className="w-5 h-5" />
              View All Backups
            </button>
          </div>
        </div>
      </div>

      {/* Recent Backups */}
      <div>
        <h3 className="text-lg font-bold text-slate-800 mb-4">Recent Backups</h3>
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
          </div>
        ) : backups.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-lg p-8 text-center">
            <Database className="w-12 h-12 text-slate-300 mx-auto mb-3" />
            <p className="text-slate-600">Backups are handled by Convex</p>
            <p className="text-sm text-slate-500 mt-1">
              Snapshots are taken by the platform. Export one with{' '}
              <code className="bg-slate-100 px-1.5 py-0.5 rounded text-xs">npx convex export</code>,
              which needs deploy credentials the browser does not have.
            </p>
          </div>
        ) : (
          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <table className="w-full">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="text-left px-6 py-3 text-sm font-semibold text-slate-700">Description</th>
                  <th className="text-left px-6 py-3 text-sm font-semibold text-slate-700">Size</th>
                  <th className="text-left px-6 py-3 text-sm font-semibold text-slate-700">Created</th>
                  <th className="text-left px-6 py-3 text-sm font-semibold text-slate-700">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {backups.map((backup) => (
                  <tr key={backup.id} className="hover:bg-slate-50">
                    <td className="px-6 py-4 text-sm text-slate-900">{backup.description}</td>
                    <td className="px-6 py-4 text-sm text-slate-600">
                      {backup.file_size ? `${(backup.file_size / 1024 / 1024).toFixed(2)} MB` : '-'}
                    </td>
                    <td className="px-6 py-4 text-sm text-slate-600">
                      {new Date(backup.created_at).toLocaleDateString('en-US', {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit'
                      })}
                    </td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex px-2 py-1 rounded-full text-xs font-medium ${
                        backup.status === 'completed'
                          ? 'bg-green-100 text-green-800'
                          : backup.status === 'failed'
                          ? 'bg-red-100 text-red-800'
                          : 'bg-yellow-100 text-yellow-800'
                      }`}>
                        {backup.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div>
        <h3 className="text-lg font-bold text-slate-800 mb-4">Backup Information</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="bg-white border border-slate-200 rounded-lg p-6">
            <h4 className="font-semibold text-slate-800 mb-3">What gets backed up?</h4>
            <ul className="text-sm text-slate-600 space-y-2">
              <li>✓ All user accounts and profiles</li>
              <li>✓ Streams and memberships</li>
              <li>✓ Tasks and submissions</li>
              <li>✓ Points, badges, and levels</li>
              <li>✓ Messages and notifications</li>
              <li>✓ Social features (posts, comments)</li>
              <li>✓ Admin settings and configurations</li>
            </ul>
          </div>

          <div className="bg-white border border-slate-200 rounded-lg p-6">
            <h4 className="font-semibold text-slate-800 mb-3">Backup Features</h4>
            <ul className="text-sm text-slate-600 space-y-2">
              <li>✓ Manual backup creation</li>
              <li>✓ Automated scheduled backups</li>
              <li>✓ Backup restoration</li>
              <li>✓ Backup download</li>
              <li>✓ Backup verification</li>
              <li>✓ Retention management</li>
              <li>✓ Super admin only access</li>
            </ul>
          </div>
        </div>
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded-lg p-6">
        <div className="flex items-start gap-4">
          <div className="text-2xl">⚠️</div>
          <div className="flex-1">
            <h4 className="font-semibold text-slate-800 mb-2">Important Notes</h4>
            <ul className="text-sm text-slate-700 space-y-2">
              <li>
                • Only super administrators can create, download, and restore backups
              </li>
              <li>
                • Backups are encrypted and stored securely
              </li>
              <li>
                • Restoring a backup will overwrite current data - use with caution
              </li>
              <li>
                • Regular backups are recommended for data protection
              </li>
              <li>
                • Test backup restoration periodically to ensure integrity
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Audit Log ─────────────────────────────────────────────────────────── */

interface AuditLogEntry {
  id: string;
  action: string;
  table_name: string;
  record_id: string;
  changed_by: string;
  changed_at: string;
}

function AuditLogSettings() {
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 20;

  /**
   * Reads through `auditLogs.list`, which is admin-gated server-side.
   *
   * Paging is by PAGE COUNT, not offset. `query_audit_logs` took a limit and an
   * offset over a table that grows at the head, so every entry written while an
   * admin paged shifted the window and the next page repeated a row. The list
   * is capped and re-read instead — an audit log is read by scanning the top,
   * not by walking to page forty.
   */
  const loadLogs = async (pageIndex = 0) => {
    setLoading(true);
    setError('');
    try {
      const token = authService.getToken();
      if (!token) {
        setLogs([]);
        return;
      }

      const rows = await convex.query(api.auditLogs.list, {
        token,
        limit: PAGE_SIZE * (pageIndex + 1),
      });

      setLogs(
        rows.slice(pageIndex * PAGE_SIZE).map((r) => ({
          id: r.id,
          action: r.action,
          table_name: r.tableName ?? '',
          record_id: r.recordId ?? '',
          changed_by: r.userEmail ?? 'system',
          changed_at: new Date(r.createdAt).toISOString(),
        })),
      );
      setPage(pageIndex);
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : err && typeof err === 'object' && 'message' in err
            ? String((err as { message: string }).message)
            : 'Failed to load audit logs';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadLogs(0); }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
            <ScrollText className="w-5 h-5 text-iih-green" />
            Audit Log
          </h3>
          <p className="text-sm text-slate-500 mt-1">Read-only log of all administrative actions</p>
        </div>
        <button
          onClick={() => loadLogs(page)}
          className="flex items-center gap-2 text-sm text-slate-600 hover:text-slate-900 border border-slate-300 rounded-lg px-3 py-2"
        >
          <RefreshCw className="w-4 h-4" />
          Refresh
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>
      )}

      {loading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="w-6 h-6 animate-spin text-iih-green" />
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="text-left px-4 py-3 text-slate-600 font-medium">Time</th>
                <th className="text-left px-4 py-3 text-slate-600 font-medium">Action</th>
                <th className="text-left px-4 py-3 text-slate-600 font-medium">Table</th>
                <th className="text-left px-4 py-3 text-slate-600 font-medium">Record</th>
                <th className="text-left px-4 py-3 text-slate-600 font-medium">Changed By</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {logs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="text-center text-slate-400 py-8">No audit log entries found</td>
                </tr>
              ) : (
                logs.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-4 py-3 text-slate-600 whitespace-nowrap">
                      {new Date(log.changed_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                        log.action === 'INSERT' ? 'bg-green-100 text-green-700' :
                        log.action === 'UPDATE' ? 'bg-blue-100 text-blue-700' :
                        'bg-red-100 text-red-700'
                      }`}>
                        {log.action}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-700 font-mono text-xs">{log.table_name}</td>
                    <td className="px-4 py-3 text-slate-500 font-mono text-xs">{log.record_id?.slice(0, 8)}…</td>
                    <td className="px-4 py-3 text-slate-600 font-mono text-xs">{log.changed_by?.slice(0, 8)}…</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center justify-between pt-2">
        <button
          disabled={page === 0}
          onClick={() => loadLogs(page - 1)}
          className="px-4 py-2 border border-slate-300 rounded-lg text-sm disabled:opacity-40"
        >
          Previous
        </button>
        <span className="text-sm text-slate-500">Page {page + 1}</span>
        <button
          disabled={logs.length < PAGE_SIZE}
          onClick={() => loadLogs(page + 1)}
          className="px-4 py-2 border border-slate-300 rounded-lg text-sm disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </div>
  );
}

/* ── Security Dashboard ────────────────────────────────────────────────── */

interface BlockedIp {
  ip_address: string;
  reason: string;
  blocked_until: string | null;
  created_at: string;
}

interface RateLimitEntry {
  ip_address: string;
  endpoint: string;
  request_count: number;
  window_start: string;
}

interface SecurityDashboardData {
  blocked_ips: BlockedIp[];
  recent_failed_logins: RateLimitEntry[];
  total_blocked: number;
}

function SecurityDashboardSettings() {
  const [data, setData] = useState<SecurityDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const token = authService.getToken();
      if (!token) {
        setData({ blocked_ips: [], recent_failed_logins: [], total_blocked: 0 });
        return;
      }
      // blockedIps and rateLimits had no reader at all on the Convex side — the
      // limiter wrote to them and nothing ever looked, which is the state a
      // security control should never be in.
      const result = await convex.query(api.admin.securityDashboard, { token });

      setData({
        blocked_ips: result.blockedIps.map((b) => ({
          ip_address: b.ipAddress,
          reason: b.reason,
          blocked_until: b.blockedUntil ? new Date(b.blockedUntil).toISOString() : null,
          created_at: new Date(b.blockedAt).toISOString(),
        })),
        recent_failed_logins: result.recentFailedLogins.map((r) => ({
          ip_address: r.ipAddress,
          endpoint: r.endpoint,
          request_count: r.requestCount,
          window_start: new Date(r.windowStart).toISOString(),
        })),
        total_blocked: result.totalBlocked,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message
        : (err && typeof err === 'object' && 'message' in err) ? String((err as {message:string}).message)
        : 'Failed to load security dashboard';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
            <Shield className="w-5 h-5 text-iih-green" />
            Security Dashboard
          </h3>
          <p className="text-sm text-slate-500 mt-1">Blocked IPs and failed login attempts</p>
        </div>
        <button
          onClick={load}
          className="flex items-center gap-2 text-sm text-slate-600 hover:text-slate-900 border border-slate-300 rounded-lg px-3 py-2"
        >
          <RefreshCw className="w-4 h-4" />
          Refresh
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>
      )}

      {loading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="w-6 h-6 animate-spin text-iih-green" />
        </div>
      ) : data ? (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-center">
              <p className="text-3xl font-bold text-red-700">{data.total_blocked}</p>
              <p className="text-sm text-red-600 mt-1">Blocked IPs</p>
            </div>
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-center">
              <p className="text-3xl font-bold text-amber-700">{data.recent_failed_logins?.length ?? 0}</p>
              <p className="text-sm text-amber-600 mt-1">Active Rate Limits</p>
            </div>
            <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-center">
              <p className="text-3xl font-bold text-green-700">Active</p>
              <p className="text-sm text-green-600 mt-1">Rate Limit Status</p>
            </div>
          </div>

          <div>
            <h4 className="font-semibold text-slate-700 mb-3">Blocked IPs</h4>
            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="text-left px-4 py-3 text-slate-600 font-medium">IP Address</th>
                    <th className="text-left px-4 py-3 text-slate-600 font-medium">Reason</th>
                    <th className="text-left px-4 py-3 text-slate-600 font-medium">Blocked Until</th>
                    <th className="text-left px-4 py-3 text-slate-600 font-medium">Blocked At</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {(data.blocked_ips ?? []).length === 0 ? (
                    <tr><td colSpan={4} className="text-center text-slate-400 py-6">No blocked IPs</td></tr>
                  ) : (
                    data.blocked_ips.map((ip) => (
                      <tr key={ip.ip_address} className="hover:bg-slate-50">
                        <td className="px-4 py-3 font-mono text-xs text-slate-700">{ip.ip_address}</td>
                        <td className="px-4 py-3 text-slate-600">{ip.reason}</td>
                        <td className="px-4 py-3 text-slate-500 text-xs">
                          {ip.blocked_until ? new Date(ip.blocked_until).toLocaleString() : 'Permanent'}
                        </td>
                        <td className="px-4 py-3 text-slate-500 text-xs">
                          {new Date(ip.created_at).toLocaleString()}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <h4 className="font-semibold text-slate-700 mb-3">Recent Rate-Limited Requests</h4>
            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="text-left px-4 py-3 text-slate-600 font-medium">IP Address</th>
                    <th className="text-left px-4 py-3 text-slate-600 font-medium">Endpoint</th>
                    <th className="text-left px-4 py-3 text-slate-600 font-medium">Requests</th>
                    <th className="text-left px-4 py-3 text-slate-600 font-medium">Window Start</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {(data.recent_failed_logins ?? []).length === 0 ? (
                    <tr><td colSpan={4} className="text-center text-slate-400 py-6">No recent rate-limited requests</td></tr>
                  ) : (
                    data.recent_failed_logins.map((row, i) => (
                      <tr key={i} className="hover:bg-slate-50">
                        <td className="px-4 py-3 font-mono text-xs text-slate-700">{row.ip_address}</td>
                        <td className="px-4 py-3 text-slate-600">{row.endpoint}</td>
                        <td className="px-4 py-3 text-slate-700 font-medium">{row.request_count}</td>
                        <td className="px-4 py-3 text-slate-500 text-xs">
                          {new Date(row.window_start).toLocaleString()}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ── Seed / Demo Data ──────────────────────────────────────────────────── */

interface SeedResult {
  success: boolean;
  message?: string;
  admin_email?: string;
  admin_password?: string;
  intern_email_pattern?: string;
  intern_password?: string;
  streams?: number;
  tasks?: number;
  interns?: number;
  users_removed?: number;
  deleted?: Record<string, number>;
}

function SeedDataSettings() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SeedResult | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  /**
   * Seeding is no longer a button.
   *
   * `install_dummy_data` and `remove_dummy_data` were Postgres functions that
   * inserted and deleted rows across a dozen tables — and, unlike every other
   * RPC this app called, they took NO TOKEN. They were reachable by anyone
   * holding the anon key, and `remove_dummy_data` deleted by an `is_dummy`
   * flag that nothing prevented a real row from carrying.
   *
   * The Convex schema keeps `isDummy` so imported seed rows stay identifiable,
   * but there is no client-callable seeder: fixtures belong in a script run by
   * someone with deploy credentials, not behind a button in a settings page.
   */
  const runRpc = async (fnName: 'install_dummy_data' | 'remove_dummy_data') => {
    setLoading(true);
    setResult({
      success: false,
      message:
        fnName === 'install_dummy_data'
          ? 'Seeding moved out of the app. Run the import script with deploy credentials instead.'
          : 'Seed removal moved out of the app. Run the import script with deploy credentials instead.',
    });
    setLoading(false);
    setConfirmRemove(false);
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
          <FlaskConical className="w-5 h-5 text-iih-green" />
          Seed / Demo Data
        </h3>
        <p className="text-sm text-slate-500 mt-1">
          Install realistic test data for development and demo purposes. All seed records use <code className="bg-slate-100 px-1 rounded text-xs">@orbit.test</code> email addresses and can be removed cleanly.
        </p>
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-800">
        <strong>Warning:</strong> Only use this on a development or staging environment. Removing seed data is permanent.
      </div>

      {result && (
        <div className={`rounded-lg p-4 text-sm ${result.success ? 'bg-green-50 border border-green-200 text-green-800' : 'bg-red-50 border border-red-200 text-red-700'}`}>
          <p className="font-semibold mb-1">{result.success ? '✅ Success' : '❌ Error'}</p>
          <p>{result.message}</p>
          {result.success && result.admin_email && (
            <div className="mt-3 space-y-1 font-mono text-xs bg-white border border-green-200 rounded p-3">
              <p><span className="text-slate-500">Admin:</span> {result.admin_email} / {result.admin_password}</p>
              <p><span className="text-slate-500">Interns:</span> {result.intern_email_pattern} / {result.intern_password}</p>
              <p><span className="text-slate-500">Streams:</span> {result.streams} &nbsp; <span className="text-slate-500">Tasks:</span> {result.tasks} &nbsp; <span className="text-slate-500">Interns:</span> {result.interns}</p>
            </div>
          )}
          {result.success && result.users_removed !== undefined && (
            <p className="mt-1 text-xs">Removed {result.users_removed} demo user(s) and all associated data.</p>
          )}
          {result.success && result.deleted && (
            <div className="mt-3 grid grid-cols-2 gap-2 font-mono text-xs sm:grid-cols-3">
              {Object.entries(result.deleted)
                .filter(([, count]) => count > 0)
                .map(([table, count]) => (
                  <div key={table} className="rounded border border-green-200 bg-white px-2 py-1">
                    <span className="text-slate-500">{table.replace('orbit_', '')}:</span> {count}
                  </div>
                ))}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-4">
        <button
          onClick={() => runRpc('install_dummy_data')}
          disabled={loading}
          className="flex items-center gap-2 bg-iih-green hover:bg-iih-green-dark text-white px-5 py-2.5 rounded-lg font-medium transition-colors disabled:opacity-50"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <FlaskConical className="w-4 h-4" />}
          Install Demo Data
        </button>

        {!confirmRemove ? (
          <button
            onClick={() => setConfirmRemove(true)}
            disabled={loading}
            className="flex items-center gap-2 border border-red-300 text-red-600 hover:bg-red-50 px-5 py-2.5 rounded-lg font-medium transition-colors disabled:opacity-50"
          >
            <Trash2 className="w-4 h-4" />
            Remove Demo Data
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-sm text-red-600 font-medium">Are you sure?</span>
            <button
              onClick={() => runRpc('remove_dummy_data')}
              disabled={loading}
              className="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg text-sm font-medium"
            >
              Yes, Remove
            </button>
            <button
              onClick={() => setConfirmRemove(false)}
              className="border border-slate-300 text-slate-600 px-4 py-2 rounded-lg text-sm font-medium"
            >
              Cancel
            </button>
          </div>
        )}
      </div>

      <div className="border border-slate-200 rounded-lg p-4 text-sm space-y-2">
        <h4 className="font-semibold text-slate-700">What gets installed</h4>
        <ul className="text-slate-600 space-y-1 list-disc list-inside">
          <li>1 demo admin + 2 moderators + 10 interns (all <code className="bg-slate-100 px-1 rounded text-xs">@orbit.test</code>)</li>
          <li>2 streams: Web Development & Data Analytics</li>
          <li>4 tasks across the streams (one featured)</li>
          <li>7 sample submissions at various review stages</li>
          <li>Points ledger entries and login streaks</li>
          <li>3 badge types with awards to qualifying users</li>
          <li>Sample community posts and notifications</li>
        </ul>
      </div>
    </div>
  );
}
