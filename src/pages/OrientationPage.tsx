// v2026-07-29-2347
import {
  BookOpen, Layers, CheckSquare, Trophy, MessageCircle, Bell,
  Users, Shield, Star, Target, Award, ArrowRight, HelpCircle,
  Flame, BarChart3, Upload, Mail
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { ORG_NAME, ORG_SHORT_NAME } from '../config/org';
import { onboardingApi } from '../lib/api/onboarding';
import { ManualCard, type ManualRole } from '../components/manual/ManualCard';

interface SectionProps {
  id: string;
  icon: React.ElementType;
  title: string;
  children: React.ReactNode;
}

function Section({ id, icon: Icon, title, children }: SectionProps) {
  return (
    <section id={id} className="scroll-mt-24">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 rounded-lg bg-emerald-50 flex items-center justify-center flex-shrink-0">
          <Icon className="w-5 h-5 text-emerald-600" />
        </div>
        <h2 className="text-xl font-bold text-slate-800">{title}</h2>
      </div>
      <div className="text-slate-700 space-y-3 leading-relaxed">{children}</div>
    </section>
  );
}

const tocItems = [
  { id: 'about', label: 'About ORBIT' },
  { id: 'how-it-works', label: 'How It Works' },
  { id: 'streams', label: 'Streams' },
  { id: 'tasks', label: 'Tasks & Submissions' },
  { id: 'gamification', label: 'Points, Levels & Badges' },
  { id: 'leaderboard', label: 'Leaderboard' },
  { id: 'community', label: 'Community & Feed' },
  { id: 'messaging', label: 'Messaging' },
  { id: 'notifications', label: 'Notifications & Email' },
  { id: 'roles', label: 'Roles & Permissions' },
  { id: 'portal-guide', label: 'Portal Navigation Guide' },
  { id: 'faq', label: 'FAQ' },
];

/**
 * What each role can actually do.
 *
 * Hoisted so the section below can be filtered by who is reading it.
 */
const ROLE_GUIDE: { role: string; perms: string[] }[] = [
                  {
                    role: 'Intern (Member)',
                    perms: [
                      'View your assigned stream and its tasks',
                      'Accept tasks and submit deliverables (text, link, or file)',
                      'Post to the community activity feed and reply to threads',
                      'Send direct messages to any member',
                      'View the leaderboard (overall, monthly, weekly), badges, and member profiles',
                      'Manage your profile settings and notification preferences',
                    ],
                  },
                  {
                    role: 'Moderator (Stream Lead)',
                    perms: [
                      'Everything an intern can do, plus…',
                      'Create and manage tasks in their stream (set points, deadlines, submission types)',
                      'Review and score submissions — approve, reject, or request changes',
                      'View all submissions in their stream for monitoring progress',
                    ],
                  },
                  {
                    role: 'Admin / Super Admin',
                    perms: [
                      'Full system access — manage all streams, tasks, and users',
                      'Bulk import users via CSV or Excel spreadsheet with column matching',
                      'Create, edit, and delete streams; assign interns to streams',
                      'Manage badges, levels, and gamification rules',
                      'Access admin dashboard with platform-wide statistics',
                      'Configure platform settings (email, branding, features)',
                      'Database backup and restore',
                    ],
                  },
];

export function OrientationPage() {
  const { user } = useAuth();
  /**
   * Staff see every role; a member sees only their own. The manual is the one
   * place a reader takes at face value, so it must not describe capabilities
   * their account does not have.
   */
  const isStaff = (user?.roles ?? []).some((r) => r === 'admin' || r === 'super_admin' || r === 'moderator');
  const visibleRoles = ROLE_GUIDE.filter((r) => isStaff || r.role.startsWith('Intern'));

  /**
   * Which manual this reader gets.
   *
   * Admin outranks moderator: someone holding both roles reaches everything, so
   * they get the complete manual rather than the shorter supervisor one. Anyone
   * else is an intern and gets the intern handbook.
   */
  const roles = user?.roles ?? [];
  const manualRole: ManualRole | null = !user
    ? null
    : roles.some((r) => r === 'admin' || r === 'super_admin')
      ? 'admin'
      : roles.includes('moderator')
        ? 'moderator'
        : 'intern';

  /**
   * Marking the manual read is an explicit click, not a scroll position.
   * Reaching the bottom of a page proves scrolling, not reading, and this is
   * one of the three things a new member is asked to do in their first week —
   * so it should take an actual answer. Idempotent server-side, so a second
   * click is harmless.
   */
  const [readState, setReadState] = useState<'unknown' | 'unread' | 'saving' | 'read'>('unknown');

  useEffect(() => {
    if (isStaff) return; // staff have no checklist to satisfy
    let cancelled = false;
    onboardingApi
      .status()
      .then((s) => {
        if (cancelled) return;
        const step = s.steps.find((x) => x.key === 'manual');
        setReadState(!s.applicable || step?.done ? 'read' : 'unread');
      })
      .catch(() => {
        if (!cancelled) setReadState('unknown');
      });
    return () => {
      cancelled = true;
    };
  }, [isStaff]);

  const confirmRead = async () => {
    setReadState('saving');
    try {
      await onboardingApi.markOrientationRead();
      setReadState('read');
    } catch {
      setReadState('unread'); // let them try again rather than stranding the step
    }
  };

  return (
    <div className="min-h-screen bg-orbit-canvas">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-slate-800 flex items-center gap-3 mb-2">
            <BookOpen className="w-8 h-8 text-iih-green" />
            ORBIT Internship Manual
          </h1>
          <p className="text-slate-600">
            Everything you need to know about the ORBIT program and how to use this portal.
          </p>
          {user && (
            <p className="text-sm text-emerald-600 mt-2 font-medium">
              Welcome, {user.full_name}! Read through this guide to get the most out of your internship.
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
          {/* Table of Contents sidebar */}
          <aside className="lg:col-span-1">
            <div className="bg-white rounded-xl border border-slate-200 p-4 sticky top-24">
              <h3 className="font-bold text-slate-800 mb-3 text-sm uppercase tracking-wider">Contents</h3>
              <nav className="space-y-1">
                {tocItems.map((item) => (
                  <a
                    key={item.id}
                    href={`#${item.id}`}
                    className="block text-sm text-slate-600 hover:text-emerald-600 hover:bg-emerald-50 px-3 py-1.5 rounded-lg transition-colors"
                  >
                    {item.label}
                  </a>
                ))}
              </nav>
            </div>
          </aside>

          {/* Main Content */}
          {/*
            The reading column sits on WHITE, not on the page canvas.

            Everything here was rendered straight onto the canvas (#EDF2F0) in
            slate-600 — fine for a dashboard of cards, tiring for the longest
            continuous prose in the app. This is the one screen someone reads
            end to end rather than scans, and it is the in-app twin of a PDF
            that has always been white.
          */}
          <main className="lg:col-span-3 space-y-10 bg-white rounded-2xl border border-slate-200 p-6 sm:p-8 shadow-orbit-sm">
            {/*
              FIRST, the reader's own manual. Everything below explains ORBIT
              from a member's point of view; the manual is the screen-by-screen
              version for their role.
            */}
            {manualRole && <ManualCard role={manualRole} />}

            <Section id="about" icon={Star} title="About ORBIT">
              <p>
                <strong>ORBIT</strong> stands for <strong>Onboarding & Resource Building Initiative for Transformation</strong>.
                It is a structured internship program run by the <strong>{ORG_NAME} ({ORG_SHORT_NAME})</strong> designed to give
                interns hands-on experience across multiple professional streams such as Web Development, Data Analytics,
                Graphic Design, Product Testing, E-Learning, and more.
              </p>
              <p>
                The ORBIT portal is your central hub for all program activities. It replaces scattered spreadsheets,
                email chains, and manual tracking with a single, integrated platform that handles everything from
                task assignments to leaderboard rankings, gamification, and direct messaging.
              </p>
              <p>
                Whether you are a new intern getting started or a returning member, this manual covers everything
                you need to succeed — from accepting your first task to climbing to <strong>Orbit Stars</strong> status.
              </p>
              <div className="bg-emerald-50 rounded-lg p-4 mt-4">
                <h4 className="font-semibold text-emerald-800 mb-2">Program Goals</h4>
                <ul className="space-y-1 text-sm text-emerald-700">
                  <li className="flex items-start gap-2"><ArrowRight className="w-4 h-4 mt-0.5 flex-shrink-0" /> Provide structured, real-world learning and professional accountability</li>
                  <li className="flex items-start gap-2"><ArrowRight className="w-4 h-4 mt-0.5 flex-shrink-0" /> Enable collaboration across streams and mentoring from experienced leads</li>
                  <li className="flex items-start gap-2"><ArrowRight className="w-4 h-4 mt-0.5 flex-shrink-0" /> Reduce admin overhead to near-zero via automation (email notifications, scoring, tracking)</li>
                  <li className="flex items-start gap-2"><ArrowRight className="w-4 h-4 mt-0.5 flex-shrink-0" /> Gamify the experience with points, levels, badges, and leaderboards to drive engagement</li>
                  <li className="flex items-start gap-2"><ArrowRight className="w-4 h-4 mt-0.5 flex-shrink-0" /> Build a professional portfolio of completed work and earned credentials</li>
                </ul>
              </div>
            </Section>

            <Section id="how-it-works" icon={Target} title="How It Works">
              <p>
                The internship follows a clear cycle: <strong>assign → work → submit → review → earn</strong>.
                Here's how a typical week looks:
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {[
                  { step: '1', title: 'Join a Stream', desc: 'When you are accepted you are placed in a stream from the track you chose first (e.g. Software, Design & Media). You can join other streams yourself from the Streams page.' },
                  { step: '2', title: 'Accept & Complete Tasks', desc: 'Every week the ORBIT Agent posts new tasks in each stream, with deadlines and point values. Accept the ones you want, then submit your work — as text, a link, or a file upload.' },
                  { step: '3', title: 'Get Marked', desc: 'Two independent automated markers read your work and must agree on a score, with feedback on what would raise it. You receive an email and an in-app notification.' },
                  { step: '4', title: 'Level Up & Climb the Board', desc: 'Points accumulate toward ORBIT\'s four levels — from Orbit Entry to Orbit Stars. Unlock badges for streaks, milestones, and quality work. Top performers are spotlighted on the leaderboard.' },
                ].map((item) => (
                  <div key={item.step} className="bg-white border border-slate-200 rounded-lg p-4">
                    <div className="w-8 h-8 rounded-full bg-emerald-50 flex items-center justify-center text-emerald-600 font-bold text-sm mb-3">
                      {item.step}
                    </div>
                    <h4 className="font-semibold text-slate-800 mb-1">{item.title}</h4>
                    <p className="text-sm">{item.desc}</p>
                  </div>
                ))}
              </div>
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 mt-2">
                <h4 className="font-semibold text-slate-800 mb-1">Login Streak</h4>
                <p className="text-sm">
                  ORBIT tracks your daily login streak. Logging in consistently builds your streak count,
                  which can unlock streak-based badges. Keep the fire going!
                </p>
              </div>
            </Section>

            <Section id="streams" icon={Layers} title="Streams">
              <p>
                Streams are specialized departments or focus areas within the internship.
                Each stream operates like a mini-team with its own tasks, discussions, and rankings.
              </p>
              <p>
                Every stream has a dedicated page showing its <strong>member count</strong>, <strong>task count</strong>,
                active tasks, and member list. You can browse all streams on
                the <Link to="/streams" className="text-emerald-600 hover:underline font-medium">Streams page</Link>,
                but you can only submit tasks in streams you are a member of.
              </p>
              <p>
                The ORBIT Agent runs each stream day to day — writing the week's tasks, marking submissions
                and answering questions. Stream leads and admins can still step in.
              </p>
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                <h4 className="font-semibold text-amber-800 mb-1">More than one stream</h4>
                <p className="text-sm text-amber-700">
                  You can belong to more than one stream. Join another from its page on the Streams list,
                  and you will see its tasks as well as your own.
                </p>
              </div>
            </Section>

            <Section id="tasks" icon={CheckSquare} title="Tasks & Submissions">
              <p>
                Tasks are the core unit of work in ORBIT. Each task includes a title, description,
                point value, submission type, and a deadline.
              </p>
              <h4 className="font-semibold text-slate-800">Submission Types</h4>
              <p className="text-sm">Each task says which of three ways to hand it in:</p>
              <ul className="space-y-1 text-sm list-disc list-inside ml-2">
                <li><strong>Text</strong> — Write your answer directly in the text box (essays, reports, code snippets)</li>
                <li><strong>Link</strong> — Submit a URL to external work (GitHub repo, design file, published article)</li>
                <li><strong>File</strong> — Upload a file (documents, images, spreadsheets, presentations)</li>
              </ul>

              <h4 className="font-semibold text-slate-800 mt-4">Task Lifecycle</h4>
              <ol className="list-decimal list-inside space-y-1 text-sm ml-2">
                <li><strong>Available</strong> — Posted in your stream, usually by the ORBIT Agent. You get one message listing the week's tasks.</li>
                <li><strong>Accepted</strong> — You click "Accept Task" to signal you're working on it</li>
                <li><strong>Submitted</strong> — You upload your deliverable before the deadline. You receive a <em>submission confirmed</em> email.</li>
                <li><strong>Marked</strong> — Two automated markers agree a score and write feedback. Work that answers a different task is returned for you to redo. You receive an email either way.</li>
                <li><strong>Scored</strong> — Points are credited to your total and the leaderboard updates instantly</li>
              </ol>

              <div className="bg-sky-50 border border-sky-200 rounded-lg p-4 mt-3">
                <h4 className="font-semibold text-sky-800 mb-1">Editing & Late Submissions</h4>
                <p className="text-sm text-sky-700">
                  You can edit a submission until it is marked — even after the deadline — with <strong>Edit
                  submission</strong> on the task. Once a deadline passes you cannot start that task, but work
                  that was returned to you can still be resubmitted. Links must open for anyone without signing
                  in. A reminder email is sent 48 hours before each deadline.
                </p>
              </div>
              <p className="text-sm mt-2">
                View your tasks on the <Link to="/tasks" className="text-emerald-600 hover:underline font-medium">Tasks page</Link>.
                Featured tasks are highlighted on the Home page.
              </p>
            </Section>

            <Section id="gamification" icon={Award} title="Points, Levels & Badges">
              <p>
                Every approved task submission earns you points. Points accumulate toward levels, and
                specific achievements unlock badges. A celebration animation plays each time you level up!
              </p>

              <h4 className="font-semibold text-slate-800">ORBIT Levels</h4>
              <p className="text-sm mb-2">There are four progression levels:</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {[
                  { emoji: '🚀', name: 'Orbit Entry', pts: '0 pts', desc: 'Starting level — access updates, tasks, and community' },
                  { emoji: '⭐', name: 'Active Orbit', pts: '100 pts', desc: 'Regular task participation with recognized contributions' },
                  { emoji: '🎯', name: 'Event Orbit (Ilorin)', pts: '300 pts', desc: 'Volunteer pool for on-ground event support in Ilorin' },
                  { emoji: '🌟', name: 'Orbit Stars', pts: '600 pts', desc: 'Elite — top contributors with spotlight & priority pathways' },
                ].map(({ emoji, name, pts, desc }) => (
                  <div key={name} className="bg-white border border-slate-200 rounded-lg p-4 flex items-start gap-3">
                    <span className="text-2xl">{emoji}</span>
                    <div>
                      <h4 className="font-semibold text-slate-800">{name} <span className="text-emerald-600 font-normal text-xs">({pts})</span></h4>
                      <p className="text-xs text-slate-600">{desc}</p>
                    </div>
                  </div>
                ))}
              </div>

              <h4 className="font-semibold text-slate-800 mt-4">Badges</h4>
              <p className="text-sm">Badges are awarded automatically for specific achievements. Badge types include:</p>
              <ul className="space-y-1 text-sm list-disc list-inside ml-2">
                <li><strong>Streak</strong> — Maintain a daily login streak (e.g. 7 days, 30 days)</li>
                <li><strong>Tasks</strong> — Complete a certain number of tasks (e.g. first task, 10 tasks, 50 tasks)</li>
                <li><strong>Points</strong> — Reach point milestones (e.g. 100 pts, 500 pts)</li>
                <li><strong>Quality</strong> — Consistently high scores on submissions</li>
                <li><strong>Consistency</strong> — Sustained activity over time</li>
              </ul>
              <p className="text-sm mt-2">
                View all available badges on the <Link to="/badges" className="text-emerald-600 hover:underline font-medium">Badges page</Link>.
                Your earned badges appear on your <Link to="/profile" className="text-emerald-600 hover:underline font-medium">Profile</Link>,
                and badge unlocks are posted to the activity feed for the community to celebrate.
              </p>
            </Section>

            <Section id="leaderboard" icon={Trophy} title="Leaderboard">
              <p>
                The <Link to="/leaderboard" className="text-emerald-600 hover:underline font-medium">Leaderboard</Link> ranks
                all active members by points. It has three views:
              </p>
              <ul className="space-y-2 text-sm">
                <li className="flex items-start gap-2">
                  <BarChart3 className="w-4 h-4 mt-0.5 text-emerald-600" />
                  <div><strong>Overall</strong> — All-time cumulative points across the entire program</div>
                </li>
                <li className="flex items-start gap-2">
                  <BarChart3 className="w-4 h-4 mt-0.5 text-emerald-600" />
                  <div><strong>Monthly</strong> — Points earned since the first day of the current month</div>
                </li>
                <li className="flex items-start gap-2">
                  <BarChart3 className="w-4 h-4 mt-0.5 text-emerald-600" />
                  <div><strong>Weekly</strong> — Points earned since Monday of the current week</div>
                </li>
              </ul>
              <p className="text-sm">
                Top performers are displayed on the podium. Keep completing tasks to climb the ranks!
              </p>
            </Section>

            <Section id="community" icon={Users} title="Community & Feed">
              <p>
                The <Link to="/" className="text-emerald-600 hover:underline font-medium">Home page</Link> features
                a community activity feed where you can:
              </p>
              <ul className="space-y-1 text-sm list-disc list-inside ml-2">
                <li>Post text updates, share links, and engage with other members</li>
                <li>Like and comment on posts</li>
                <li>See automated activity (badge unlocks, task completions, level-ups)</li>
                <li>View stream-specific feeds within your stream page</li>
              </ul>
              <p className="text-sm">
                Visit the <Link to="/community" className="text-emerald-600 hover:underline font-medium">Community page</Link> to
                see all members, filter by role or stream, and view profiles.
              </p>
            </Section>

            <Section id="messaging" icon={MessageCircle} title="Messaging">
              <p>
                Send direct messages to any member through the <Link to="/messages" className="text-emerald-600 hover:underline font-medium">Messages page</Link>.
                Use messaging to coordinate with teammates or connect with other interns — and message the
                <strong> ORBIT Agent</strong> with any question about ORBIT; it replies, usually within hours.
              </p>
              <p className="text-sm">
                Click on any member's name in the community page or activity feed to visit their profile,
                where you can start a conversation. Unread message counts appear in the navigation bar so you
                never miss a reply.
              </p>
            </Section>

            <Section id="notifications" icon={Bell} title="Notifications & Email">
              <p>
                ORBIT sends both <strong>in-app notifications</strong> (visible in the bell icon on your navigation bar)
                and <strong>email alerts</strong> via Zeptomail SMTP. Here are the events that trigger notifications:
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                {[
                  { icon: CheckSquare, text: 'New task published in your stream' },
                  { icon: Bell, text: 'Deadline approaching (48 hours before)' },
                  { icon: Upload, text: 'Submission confirmed (email receipt)' },
                  { icon: Star, text: 'Task scored — approved or rejected with feedback' },
                  { icon: Trophy, text: 'Level up or badge earned' },
                  { icon: Mail, text: 'Welcome email with getting-started instructions' },
                ].map(({ icon: NIcon, text }, i) => (
                  <div key={i} className="flex items-center gap-2 bg-white border border-slate-200 rounded-lg p-3">
                    <NIcon className="w-4 h-4 text-emerald-600 flex-shrink-0" />
                    <span>{text}</span>
                  </div>
                ))}
              </div>
              <p className="text-sm">
                Manage your notification preferences (which emails you receive) in <Link to="/settings" className="text-emerald-600 hover:underline font-medium">Settings</Link>.
                You can opt in or out of specific email categories while keeping in-app notifications.
              </p>
            </Section>

            <Section id="roles" icon={Shield} title="Roles & Permissions">
              {/*
                SCOPED TO THE READER.
                This listed every role's capability to everyone, so an intern's
                own manual walked them through bulk import, database restore and
                platform settings — none of which they can reach. That reads as
                either a broken account or an invitation to go looking. Staff
                keep the full table, because a supervisor needs to know what the
                people they support can and cannot do.
              */}
              <p>
                {isStaff
                  ? 'ORBIT has three user roles. Yours determines what you can see and do across the platform.'
                  : 'This is what your account can do on ORBIT.'}
              </p>
              <div className="space-y-4">
                {visibleRoles.map(({ role, perms }) => (
                  <div key={role} className="bg-white border border-slate-200 rounded-lg p-4">
                    <h4 className="font-semibold text-slate-800 mb-2">{role}</h4>
                    <ul className="space-y-1">
                      {perms.map((p, i) => (
                        <li key={i} className="flex items-start gap-2 text-sm">
                          <ArrowRight className="w-3.5 h-3.5 mt-0.5 text-emerald-600 flex-shrink-0" />
                          {p}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </Section>

            <Section id="portal-guide" icon={Layers} title="Portal Navigation Guide">
              <p>Here's what each section of the portal does — click any card to go there directly:</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                {[
                  { to: '/', name: 'Home', desc: 'Activity feed, featured tasks, upcoming deadlines, your current level and streak' },
                  { to: '/tasks', name: 'Tasks', desc: 'View, accept, and submit tasks. Filter by status, see deadlines and point values' },
                  { to: '/streams', name: 'Streams', desc: 'Browse all streams, see member counts, and navigate to your stream\'s detail page' },
                  { to: '/community', name: 'Community', desc: 'Browse all members, filter by role or stream, visit profiles' },
                  { to: '/leaderboard', name: 'Leaderboard', desc: 'Overall (all-time), monthly, and weekly point rankings with podium display' },
                  { to: '/badges', name: 'Badges', desc: 'View all available badges and which ones you have earned' },
                  { to: '/messages', name: 'Messages', desc: 'Direct messaging with any member. Unread count shown in nav bar' },
                  { to: '/notifications', name: 'Notifications', desc: 'All in-app alerts — task updates, reviews, badges, and more' },
                  { to: '/profile', name: 'My ORBIT', desc: 'Your stats, level progress, recent achievements, and activity summary' },
                  { to: '/settings', name: 'Settings', desc: 'Profile visibility, email notification preferences, and account settings' },
                  { to: '/orientation', name: 'Manual (this page)', desc: 'The full internship guide you are reading right now' },
                ].map(({ to, name, desc }) => (
                  <Link
                    key={to}
                    to={to}
                    className="flex items-start gap-3 bg-white border border-slate-200 rounded-lg p-3 hover:border-emerald-300 transition-colors"
                  >
                    <ArrowRight className="w-4 h-4 text-emerald-600 mt-0.5 flex-shrink-0" />
                    <div>
                      <div className="font-medium text-slate-800">{name}</div>
                      <div className="text-xs text-slate-500">{desc}</div>
                    </div>
                  </Link>
                ))}
              </div>
            </Section>

            <Section id="faq" icon={HelpCircle} title="Frequently Asked Questions">
              <div className="space-y-4">
                {[
                  { q: 'How do I update my profile?', a: 'Go to Settings > Edit Profile. You can change your name, profile photo, and bio. Your email address cannot be changed — contact an admin if you need to update it.' },
                  { q: 'How do I switch streams?', a: 'Only admins can reassign stream membership. Contact your admin or stream lead if you need to switch.' },
                  { q: 'Can I submit after the deadline?', a: 'Late submissions may still be accepted at the reviewer\'s discretion, but are not guaranteed to be reviewed. You can edit your submission as many times as you want before the deadline.' },
                  { q: 'How are points calculated?', a: 'Each task has a point value set by the admin or stream lead. When your submission is approved, you receive the task\'s full point value. Points are recorded in the points ledger and your total updates immediately.' },
                  { q: 'What happens when I level up?', a: 'A celebration animation plays on screen and you receive an in-app notification. Your new level is displayed on your profile, My ORBIT page, and the leaderboard. There are 4 levels: Orbit Entry (0 pts), Active Orbit (100 pts), Event Orbit (300 pts), and Orbit Stars (600 pts).' },
                  { q: 'How do I earn badges?', a: 'Badges are awarded automatically based on criteria: login streaks, number of tasks completed, point milestones, quality of submissions, and consistency. Check the Badges page to see available badges and your progress.' },
                  { q: 'Who can see my profile?', a: 'By default, your profile is visible to all members. You can adjust your profile visibility (public, members-only, or private), and toggle whether to show your email and activity on the feed, in Settings > Profile.' },
                  { q: 'How do I contact support?', a: 'Message any admin through the Messages page, or ask your stream lead for help directly.' },
                  { q: 'Is there a mobile app?', a: 'ORBIT is a Progressive Web App (PWA). On mobile, open the site in your browser and tap "Add to Home Screen" to install it. It works just like a native app with offline support.' },
                  { q: 'Can I use ORBIT with screen readers?', a: 'Yes, the platform is built with semantic HTML and accessible components. If you experience any accessibility issues, please let an admin know.' },
                ].map(({ q, a }, i) => (
                  <details key={i} className="bg-white border border-slate-200 rounded-lg group">
                    <summary className="px-4 py-3 cursor-pointer font-medium text-slate-800 hover:text-emerald-600 transition-colors">
                      {q}
                    </summary>
                    <div className="px-4 pb-3 text-sm text-slate-600 border-t border-slate-100 pt-3">
                      {a}
                    </div>
                  </details>
                ))}
              </div>
            </Section>

            {readState === 'unread' || readState === 'saving' ? (
              <div className="mb-6 rounded-xl border border-slate-200 bg-white p-6 text-center">
                <p className="text-slate-700 mb-4">
                  That is the whole manual. Confirm you have read it and this comes off
                  your first-steps list.
                </p>
                <button
                  type="button"
                  onClick={confirmRead}
                  disabled={readState === 'saving'}
                  className="inline-flex items-center gap-2 bg-slate-800 hover:bg-slate-900 disabled:opacity-60 text-white font-medium px-6 py-2.5 rounded-lg transition-colors"
                >
                  <CheckSquare className="w-4 h-4" />
                  {readState === 'saving' ? 'Saving…' : "I've read the manual"}
                </button>
              </div>
            ) : null}

            <div className="bg-emerald-50 rounded-xl p-6 text-center">
              <Flame className="w-10 h-10 text-emerald-600 mx-auto mb-3" />
              <h3 className="text-lg font-bold text-slate-800 mb-2">Ready to Get Started?</h3>
              <p className="text-slate-600 mb-4">
                Head to your tasks and start earning points. Good luck with your ORBIT journey!
              </p>
              <Link
                to="/tasks"
                className="inline-flex items-center gap-2 bg-iih-green hover:bg-iih-green-dark text-white font-medium px-6 py-2.5 rounded-lg transition-colors"
              >
                <CheckSquare className="w-4 h-4" />
                View My Tasks
              </Link>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
