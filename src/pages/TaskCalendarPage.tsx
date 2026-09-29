import toast from 'react-hot-toast';
import { useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { ChevronLeft, ChevronRight, Calendar as CalendarIcon, Clock, Award, CheckCircle, Link2, Download } from 'lucide-react';
import { tasksApi } from '../lib/api/tasks';
import { convexHttp as convex, convexSiteUrl } from '../lib/convex';
import { api } from '../../convex/_generated/api';
import { authService } from '../lib/auth';
import { logError } from '../lib/monitoring';

interface Task {
  id: string;
  title: string;
  description: string;
  deadline: string;
  points: number;
  stream_name?: string;
  stream_emoji?: string;
  submission_status?: string | null;
  is_accepted?: boolean;
}

interface CalendarDay {
  date: Date;
  isCurrentMonth: boolean;
  tasks: Task[];
}

export function TaskCalendarPage() {
  const navigate = useNavigate();
  const [currentDate, setCurrentDate] = useState(new Date());
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDay, setSelectedDay] = useState<CalendarDay | null>(null);
  const [showSubscriptionModal, setShowSubscriptionModal] = useState(false);

  /**
   * The feed URL, built from a DEDICATED rotatable token.
   *
   * It used to be `?user_id=${user.id}`. That worked when ids were Supabase
   * uuids, because `/calendar.ics` still accepts one as a legacy fallback — but
   * `user.id` is a Convex id now, which matches neither the fallback nor
   * `calendarFeedToken`, so every URL this page handed out after cutover 404'd.
   * Existing subscriptions with old uuids keep working; new ones were dead on
   * copy.
   *
   * `calendar.myFeedToken` was written for exactly this and had no caller. A
   * calendar URL is polled forever by third-party servers, so it must not carry
   * a session token that expires — and must stay revocable on its own.
   */
  const [feedToken, setFeedToken] = useState<string | null>(null);
  const [feedError, setFeedError] = useState(false);
  const calendarUrl = feedToken ? `${convexSiteUrl}/calendar.ics?token=${feedToken}` : '';

  useEffect(() => {
    loadTasks();
  }, []);

  // Minted on demand, when the subscribe dialog is actually opened — issuing a
  // feed credential to every visitor of the calendar page would be handing out
  // a long-lived URL nobody asked for.
  useEffect(() => {
    if (!showSubscriptionModal || feedToken) return;

    const token = authService.getToken();
    if (!token) return;

    setFeedError(false);
    void convex
      .mutation(api.calendar.myFeedToken, { token })
      .then((r) => setFeedToken(r.feedToken))
      .catch(() => {
        setFeedToken(null);
        setFeedError(true);
      });
  }, [showSubscriptionModal, feedToken]);

  const loadTasks = async () => {
    try {
      setLoading(true);
      const data = await tasksApi.getUserTasksWithStatus();
      setTasks(data);
    } catch (error) {
      logError(error, { context: 'TaskCalendarPage.loadTasks' });
    } finally {
      setLoading(false);
    }
  };

  const getDaysInMonth = (date: Date): CalendarDay[] => {
    const year = date.getFullYear();
    const month = date.getMonth();

    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const daysInMonth = lastDay.getDate();

    const startingDayOfWeek = firstDay.getDay();
    const days: CalendarDay[] = [];

    for (let i = 0; i < startingDayOfWeek; i++) {
      const prevMonthDay = new Date(year, month, -startingDayOfWeek + i + 1);
      days.push({
        date: prevMonthDay,
        isCurrentMonth: false,
        tasks: getTasksForDate(prevMonthDay),
      });
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const currentDay = new Date(year, month, day);
      days.push({
        date: currentDay,
        isCurrentMonth: true,
        tasks: getTasksForDate(currentDay),
      });
    }

    const remainingDays = 42 - days.length;
    for (let i = 1; i <= remainingDays; i++) {
      const nextMonthDay = new Date(year, month + 1, i);
      days.push({
        date: nextMonthDay,
        isCurrentMonth: false,
        tasks: getTasksForDate(nextMonthDay),
      });
    }

    return days;
  };

  const getTasksForDate = (date: Date): Task[] => {
    return tasks.filter((task) => {
      const taskDate = new Date(task.deadline);
      return (
        taskDate.getFullYear() === date.getFullYear() &&
        taskDate.getMonth() === date.getMonth() &&
        taskDate.getDate() === date.getDate()
      );
    });
  };

  const previousMonth = () => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1));
  };

  const nextMonth = () => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1));
  };

  const goToToday = () => {
    setCurrentDate(new Date());
  };

  const isToday = (date: Date): boolean => {
    const today = new Date();
    return (
      date.getDate() === today.getDate() &&
      date.getMonth() === today.getMonth() &&
      date.getFullYear() === today.getFullYear()
    );
  };

  const isPast = (date: Date): boolean => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const compareDate = new Date(date);
    compareDate.setHours(0, 0, 0, 0);
    return compareDate < today;
  };

  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const calendarDays = getDaysInMonth(currentDate);

  const getTaskStatusColor = (task: Task): string => {
    if (task.submission_status === 'approved') return 'bg-green-500';
    if (task.submission_status === 'submitted') return 'bg-blue-500';
    if (task.submission_status === 'changes_requested') return 'bg-orange-500';
    if (task.submission_status === 'rejected') return 'bg-red-500';
    if (task.is_accepted) return 'bg-yellow-500';
    if (isPast(new Date(task.deadline)) && !task.is_accepted && !task.submission_status) return 'bg-red-500';
    return 'bg-slate-400';
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-orbit-canvas flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-green-600 mx-auto"></div>
          <p className="mt-4 text-slate-600">Loading calendar...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-orbit-canvas">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-3xl font-bold text-slate-800 flex items-center gap-3">
                <CalendarIcon className="w-8 h-8 text-iih-green" />
                Task Calendar
              </h1>
              <p className="text-slate-600 mt-1">View all your task deadlines at a glance</p>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setShowSubscriptionModal(true)}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium flex items-center gap-2"
              >
                <Link2 className="w-4 h-4" />
                Subscribe
              </button>
              <button
                onClick={goToToday}
                className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-medium"
              >
                Today
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between bg-white rounded-lg p-4 shadow-sm">
            <button
              onClick={previousMonth}
              aria-label="Previous month"
              className="p-2 hover:bg-slate-100 rounded-lg transition-colors"
            >
              <ChevronLeft className="w-6 h-6 text-slate-600" />
            </button>

            <h2 className="text-2xl font-bold text-slate-800">
              {monthNames[currentDate.getMonth()]} {currentDate.getFullYear()}
            </h2>

            <button
              onClick={nextMonth}
              aria-label="Next month"
              className="p-2 hover:bg-slate-100 rounded-lg transition-colors"
            >
              <ChevronRight className="w-6 h-6 text-slate-600" />
            </button>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm overflow-hidden">
          <div className="grid grid-cols-7 gap-px bg-slate-200">
            {dayNames.map((day) => (
              <div
                key={day}
                className="bg-slate-50 py-3 text-center text-sm font-semibold text-slate-700"
              >
                {day}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-px bg-slate-200">
            {calendarDays.map((day, index) => {
              const hasDeadlines = day.tasks.length > 0;
              const isCurrentDay = isToday(day.date);
              const isPastDay = isPast(day.date);

              return (
                <div
                  key={index}
                  onClick={() => hasDeadlines && setSelectedDay(day)}
                  /**
                   * Reachable without a mouse.
                   *
                   * A bare `onClick` on a `div` gives keyboard and screen-reader
                   * users no route to the day's deadline list at all — and that
                   * modal is the only place those deadlines are listed. The
                   * role/tabIndex/key handler go on only when the day actually
                   * opens something, so empty days stay out of the tab order
                   * instead of adding 35 dead stops to every month.
                   */
                  role={hasDeadlines ? 'button' : undefined}
                  tabIndex={hasDeadlines ? 0 : undefined}
                  aria-label={
                    hasDeadlines
                      ? `${day.date.toDateString()} — ${day.tasks.length} deadline${day.tasks.length === 1 ? '' : 's'}`
                      : undefined
                  }
                  onKeyDown={
                    hasDeadlines
                      ? (e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setSelectedDay(day);
                          }
                        }
                      : undefined
                  }
                  className={`min-h-32 bg-white p-2 ${
                    !day.isCurrentMonth ? 'opacity-40' : ''
                  } ${hasDeadlines ? 'cursor-pointer hover:bg-slate-50' : ''} ${
                    isCurrentDay ? 'ring-2 ring-green-500 ring-inset' : ''
                  } transition-colors`}
                >
                  <div className="flex items-start justify-between mb-2">
                    <span
                      className={`text-sm font-medium ${
                        isCurrentDay
                          ? 'bg-green-600 text-white w-7 h-7 rounded-full flex items-center justify-center'
                          : isPastDay && day.isCurrentMonth
                          ? 'text-slate-400'
                          : 'text-slate-700'
                      }`}
                    >
                      {day.date.getDate()}
                    </span>
                    {hasDeadlines && (
                      <span className="text-xs font-bold text-slate-600 bg-slate-100 px-2 py-0.5 rounded-full">
                        {day.tasks.length}
                      </span>
                    )}
                  </div>

                  <div className="space-y-1">
                    {day.tasks.slice(0, 3).map((task) => (
                      <div
                        key={task.id}
                        className={`text-xs p-1.5 rounded truncate ${getTaskStatusColor(
                          task
                        )} text-white`}
                        title={task.title}
                      >
                        <div className="flex items-center gap-1">
                          {task.stream_emoji && <span>{task.stream_emoji}</span>}
                          <span className="truncate">{task.title}</span>
                        </div>
                      </div>
                    ))}
                    {day.tasks.length > 3 && (
                      <div className="text-xs text-slate-500 font-medium pl-1">
                        +{day.tasks.length - 3} more
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="mt-6 bg-white rounded-xl shadow-sm p-6">
          <h3 className="text-lg font-bold text-slate-800 mb-4">Your Task Status Legend</h3>
          <p className="text-sm text-slate-600 mb-4">Colors show your personal progress on each task</p>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 bg-green-500 rounded"></div>
              <span className="text-sm text-slate-600">Completed</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 bg-blue-500 rounded"></div>
              <span className="text-sm text-slate-600">Awaiting Review</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 bg-yellow-500 rounded"></div>
              <span className="text-sm text-slate-600">In Progress</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 bg-orange-500 rounded"></div>
              <span className="text-sm text-slate-600">Needs Changes</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 bg-slate-400 rounded"></div>
              <span className="text-sm text-slate-600">Not Started</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 bg-red-500 rounded"></div>
              <span className="text-sm text-slate-600">Missed/Rejected</span>
            </div>
          </div>
        </div>
      </div>

      {selectedDay && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
          onClick={() => setSelectedDay(null)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="task-day-modal-title"
        >
          <div
            className="bg-white rounded-xl shadow-xl max-w-2xl w-full max-h-[80vh] overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6 border-b border-slate-200">
              <div className="flex items-center justify-between">
                <div>
                  <h3 id="task-day-modal-title" className="text-2xl font-bold text-slate-800">
                    {selectedDay.date.toLocaleDateString('en-US', {
                      weekday: 'long',
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric',
                    })}
                  </h3>
                  <p className="text-sm text-slate-600 mt-1">
                    {selectedDay.tasks.length} task{selectedDay.tasks.length !== 1 ? 's' : ''} due
                  </p>
                </div>
                <button
                  onClick={() => setSelectedDay(null)}
                  className="text-slate-400 hover:text-slate-600 text-2xl"
                >
                  ×
                </button>
              </div>
            </div>

            <div className="p-6 overflow-y-auto max-h-96">
              <div className="space-y-4">
                {selectedDay.tasks.map((task) => (
                  <div
                    key={task.id}
                    onClick={() => {
                      if (navigate) {
                        navigate(`/tasks/${task.id}`);
                        setSelectedDay(null);
                      }
                    }}
                    className="p-4 border border-slate-200 rounded-lg hover:border-green-500 hover:shadow-md transition-all cursor-pointer"
                  >
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex items-center gap-2">
                        {task.stream_emoji && (
                          <span className="text-xl">{task.stream_emoji}</span>
                        )}
                        <h4 className="font-bold text-slate-800">{task.title}</h4>
                      </div>
                      {task.submission_status === 'approved' && (
                        <CheckCircle className="w-5 h-5 text-green-500" />
                      )}
                    </div>

                    {task.stream_name && (
                      <p className="text-sm text-slate-600 mb-2">{task.stream_name}</p>
                    )}

                    <div className="flex items-center gap-4 text-sm text-slate-600">
                      <div className="flex items-center gap-1">
                        <Award className="w-4 h-4" />
                        <span>{task.points} pts</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <Clock className="w-4 h-4" />
                        <span>
                          {new Date(task.deadline).toLocaleTimeString('en-US', {
                            hour: 'numeric',
                            minute: '2-digit',
                          })}
                        </span>
                      </div>
                    </div>

                    {task.submission_status && (
                      <div className="mt-3">
                        <span
                          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                            task.submission_status === 'approved'
                              ? 'bg-green-100 text-green-800'
                              : task.submission_status === 'submitted'
                              ? 'bg-blue-100 text-blue-800'
                              : 'bg-yellow-100 text-yellow-800'
                          }`}
                        >
                          {task.submission_status === 'approved'
                            ? 'Approved'
                            : task.submission_status === 'submitted'
                            ? 'Submitted'
                            : task.submission_status === 'changes_requested'
                            ? 'Changes Requested'
                            : 'In Progress'}
                        </span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="p-4 border-t border-slate-200 bg-slate-50">
              <button
                onClick={() => setSelectedDay(null)}
                className="w-full px-4 py-2 bg-slate-200 text-slate-700 rounded-lg hover:bg-slate-300 transition-colors font-medium"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {showSubscriptionModal && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
          onClick={() => setShowSubscriptionModal(false)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="calendar-subscription-modal-title"
        >
          <div
            className="bg-white rounded-xl shadow-xl max-w-2xl w-full"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6 border-b border-slate-200">
              <div className="flex items-center justify-between">
                <div>
                  <h3 id="calendar-subscription-modal-title" className="text-2xl font-bold text-slate-800">Calendar Subscription</h3>
                  <p className="text-sm text-slate-600 mt-1">
                    Subscribe to your task deadlines in your favorite calendar app
                  </p>
                </div>
                <button
                  onClick={() => setShowSubscriptionModal(false)}
                  className="text-slate-400 hover:text-slate-600 text-2xl"
                >
                  ×
                </button>
              </div>
            </div>

            <div className="p-6">
              <div className="space-y-6">
                <div>
                  <h4 className="font-bold text-slate-800 mb-3">Your Personal Calendar Link</h4>
                  <p className="text-sm text-slate-600 mb-4">
                    This link is unique to you and includes only tasks from streams you're a member of.
                  </p>
                  {/* Both controls stay DISABLED until the token exists.
                      Rendered eagerly, Copy would report "Link copied" after
                      writing an empty string, and an <a href=""> resolves to
                      the current page — so a slow or failed mint handed the
                      user a confident success and a link to nowhere. */}
                  <div className="bg-slate-50 p-4 rounded-lg border border-slate-200">
                    <code className="text-sm text-slate-800 break-all">
                      {calendarUrl || (feedError ? 'Could not create your link.' : 'Creating your link…')}
                    </code>
                  </div>
                  <div className="mt-3 flex gap-2">
                    <button
                      disabled={!calendarUrl}
                      onClick={() => {
                        navigator.clipboard.writeText(calendarUrl);
                        toast.success('Link copied to clipboard');
                      }}
                      className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg font-medium transition-colors"
                    >
                      <Link2 className="w-4 h-4" />
                      Copy Link
                    </button>
                    {calendarUrl ? (
                      <a
                        href={calendarUrl}
                        download="orbit-tasks.ics"
                        className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg font-medium transition-colors"
                      >
                        <Download className="w-4 h-4" />
                        Download ICS
                      </a>
                    ) : (
                      <span className="flex items-center gap-2 px-4 py-2 bg-green-600 opacity-50 cursor-not-allowed text-white rounded-lg font-medium">
                        <Download className="w-4 h-4" />
                        Download ICS
                      </span>
                    )}
                  </div>
                  {feedError && (
                    <button
                      onClick={() => setFeedError(false)}
                      className="mt-2 text-sm text-iih-green hover:underline"
                    >
                      Try again
                    </button>
                  )}
                </div>

                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                  <h4 className="font-bold text-blue-900 mb-2 flex items-center gap-2">
                    <CalendarIcon className="w-5 h-5" />
                    How to Subscribe
                  </h4>
                  <ul className="space-y-2 text-sm text-blue-800">
                    <li>
                      <strong>Google Calendar:</strong> Settings → Add calendar → From URL → Paste the link
                    </li>
                    <li>
                      <strong>Apple Calendar:</strong> File → New Calendar Subscription → Paste the link
                    </li>
                    <li>
                      <strong>Outlook:</strong> Add calendar → Subscribe from web → Paste the link
                    </li>
                    <li>
                      <strong>Other Apps:</strong> Download the ICS file and import it manually
                    </li>
                  </ul>
                </div>

                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                  <h4 className="font-bold text-yellow-900 mb-2">Important Notes</h4>
                  <ul className="space-y-1 text-sm text-yellow-800 list-disc list-inside">
                    <li>The calendar updates automatically with new tasks</li>
                    <li>Only upcoming tasks with deadlines are included</li>
                    <li>This link is public - anyone with it can view your task deadlines</li>
                    <li>Keep this link secure and don't share it publicly</li>
                  </ul>
                </div>
              </div>
            </div>

            <div className="p-4 border-t border-slate-200 bg-slate-50">
              <button
                onClick={() => setShowSubscriptionModal(false)}
                className="w-full px-4 py-2 bg-slate-200 text-slate-700 rounded-lg hover:bg-slate-300 transition-colors font-medium"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
