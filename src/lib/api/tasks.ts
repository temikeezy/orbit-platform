import { convexHttp as convex, convexSiteUrl } from '../convex';
import { api } from '../../../convex/_generated/api';
import { authService } from '../auth';
import {
  OrbitTask,
  OrbitSubmission,
  OrbitUser,
  SubmissionType,
  SubmissionStatus,
} from '../../types/database';
import {
  toTask,
  toSubmission,
  ConvexTask,
  ConvexSubmission,
} from '../convexAdapters';
import { storageUtils } from '../utils/storage';

/**
 * Tasks and submissions, on Convex.
 *
 * THIS IS THE MODULE THE MIGRATION WAS MOST WORRIED ABOUT. `reviewSubmission`
 * used to award points from the BROWSER, in three separate non-transactional
 * calls made with the anon key: update the submission, insert a points-ledger
 * row, then `rpc('increment_user_points')`. Any of the three could fail on its
 * own, leaving a submission approved with no points or a ledger entry whose
 * total was never applied — and the caller checked none of the results. It also
 * read `if (reviewData.status === 'approved' && reviewData.score)`, so a
 * deliberate score of ZERO was falsy and skipped the ledger entirely.
 *
 * All of that is one mutation now. There is no client-callable path that writes
 * the ledger, which is the property that matters: points cannot be granted from
 * a browser at all.
 */

export interface TaskUserSubmission extends Omit<OrbitSubmission, 'status'> {
  status: SubmissionStatus | null;
}

export interface TaskWithStatus extends OrbitTask {
  created_by_name: string;
  stream_name: string;
  stream_emoji: string;
  is_accepted: boolean;
  accepted_at?: string | null;
  submission_status?: string | null;
  user_submission?: TaskUserSubmission | null;
  is_member_of_stream: boolean;
}

export interface SubmissionWithDetails extends OrbitSubmission {
  task?: Partial<OrbitTask> & { stream?: { id: string; name: string; emoji: string } };
  user?: Partial<OrbitUser>;
  reviewer?: Partial<OrbitUser>;
}

/** A task the ORBIT agent drafted, not yet visible to the stream. */
export interface ProposedTask {
  id: string;
  stream_id: string;
  stream_name: string | null;
  stream_emoji: string | null;
  title: string;
  description: string;
  submission_type: string;
  points: number;
  deadline: string;
  proposed_by: string | null;
  created_at: string;
}

export interface CreateTaskData {
  stream_id: string;
  title: string;
  description: string;
  submission_type: SubmissionType;
  points: number;
  deadline?: string;
  is_featured?: boolean;
}

export interface TaskProgrammeState {
  allowed: boolean;
  cohortName: string | null;
  startDate: string | null;
  defaultDeadline: number | null;
  error?: string;
}

const WAT_OFFSET_MS = 60 * 60 * 1000;

/**
 * `datetime-local` has no timezone marker. Rendering through local Date methods
 * would move ORBIT's WAT deadline on a lead's device in another timezone, so
 * the fixed programme timezone is applied before taking the browser value.
 */
export function taskDeadlineToWatInput(deadline: number): string {
  return new Date(deadline + WAT_OFFSET_MS).toISOString().slice(0, 16);
}

/**
 * Parse against the same fixed programme timezone so an overseas lead cannot
 * unknowingly move a deadline simply by editing and resaving it.
 */
export function taskDeadlineFromWatInput(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    throw new Error('Please set a valid deadline');
  }

  const [, year, month, day, hour, minute] = match;
  const parts = [year, month, day, hour, minute].map(Number);
  const [y, m, d, h, min] = parts;
  if (m < 1 || m > 12 || d < 1 || h > 23 || min > 59) {
    throw new Error('Please set a valid deadline');
  }

  const parsed = Date.parse(`${value}:00.000+01:00`);
  const wat = new Date(parsed + WAT_OFFSET_MS);
  if (
    !Number.isFinite(parsed) ||
    wat.getUTCFullYear() !== y ||
    wat.getUTCMonth() + 1 !== m ||
    wat.getUTCDate() !== d ||
    wat.getUTCHours() !== h ||
    wat.getUTCMinutes() !== min
  ) {
    throw new Error('Please set a valid deadline');
  }
  return parsed;
}

export interface UpdateTaskData {
  title?: string;
  description?: string;
  submission_type?: SubmissionType;
  points?: number;
  deadline?: string;
  is_active?: boolean;
  is_featured?: boolean;
}

export interface CreateSubmissionData {
  task_id: string;
  submission_text?: string;
  submission_url?: string;
}

export interface UpdateSubmissionData {
  submission_text?: string;
  submission_url?: string;
  status?: SubmissionStatus;
}

export interface ReviewSubmissionData {
  status: SubmissionStatus;
  score?: number;
  feedback?: string;
}

interface ConvexTaskWithStatus extends ConvexTask {
  streamName: string | null;
  streamEmoji: string | null;
  createdByName: string | null;
  isMemberOfStream: boolean;
  mySubmission: ConvexSubmission | null;
}

/** Whether an id refers to the signed-in user. */
function isSelf(userId: string): boolean {
  return authService.getCurrentUser()?.id === userId;
}

/**
 * The task attached to a submission on the review screen.
 *
 * The FULL shape now that `listSubmissions` returns one. It used to project
 * five fields from a five-field server projection, and the review page reads
 * `description`, `deadline` and `submission_type` — the last of which GATES
 * whether the submission's text, link or file is rendered at all. Undefined, it
 * rendered none of them, so a reviewer approved work they could not see.
 */
function partialTask(t: ConvexTask) {
  return toTask(t);
}

function requireToken(): string {
  const token = authService.getToken();
  if (!token) throw new Error('Not authenticated');
  return token;
}

function toTaskWithStatus(t: ConvexTaskWithStatus): TaskWithStatus {
  const submission = t.mySubmission ? toSubmission(t.mySubmission) : null;

  return {
    ...toTask(t),
    created_by_name: t.createdByName ?? '',
    stream_name: t.streamName ?? '',
    stream_emoji: t.streamEmoji ?? '',
    // "Accepted" means a submission row exists at all — accepting a task is what
    // creates one, in `in_progress`.
    is_accepted: Boolean(submission),
    accepted_at: submission?.started_at ?? null,
    submission_status: submission?.status ?? null,
    user_submission: submission
      ? { ...submission, status: submission.status as SubmissionStatus }
      : null,
    is_member_of_stream: t.isMemberOfStream,
  };
}

export const tasksApi = {
  async getTaskProgrammeState(now = Date.now()): Promise<TaskProgrammeState> {
    return await convex.query(api.tasks.programmeState, {
      token: requireToken(),
      now,
    }) as TaskProgrammeState;
  },

  async getUserTasksWithStatus(): Promise<TaskWithStatus[]> {
    const tasks = (await convex.query(api.tasks.listForUser, {
      token: requireToken(),
    })) as ConvexTaskWithStatus[];
    return tasks.map(toTaskWithStatus);
  },

  async getAllTasks(): Promise<TaskWithStatus[]> {
    const tasks = (await convex.query(api.tasks.listForUser, {
      token: requireToken(),
      includeInactive: true,
    })) as ConvexTaskWithStatus[];
    return tasks.map(toTaskWithStatus);
  },

  async getTasksByStream(streamId: string): Promise<TaskWithStatus[]> {
    const tasks = await this.getAllTasks();
    return tasks.filter((t) => t.stream_id === streamId);
  },

  async getTaskById(id: string): Promise<TaskWithStatus | null> {
    const task = (await convex.query(api.tasks.getById, {
      token: requireToken(),
      taskId: id as never,
    })) as ConvexTaskWithStatus | null;
    return task ? toTaskWithStatus(task) : null;
  },

  async acceptTask(taskId: string): Promise<void> {
    await convex.mutation(api.tasks.acceptTask, {
      token: requireToken(),
      taskId: taskId as never,
    });
  },

  /**
   * NAMED, not positional.
   *
   * This was `(taskId, submissionUrl?, submissionText?)` — url first, text
   * second — and the only UI caller passed a text task's prose as the second
   * argument, filing it as a file URL. Two optional strings of the same type in
   * an order nobody would guess is a trap, and it caught the one caller there
   * was. An object makes the mistake unrepresentable.
   */
  async submitTask(taskId: string, submission: { text?: string; url?: string }): Promise<void> {
    const result = await convex.mutation(api.tasks.submitWork, {
      token: requireToken(),
      taskId: taskId as never,
      submissionText: submission.text,
      submissionFileUrl: submission.url,
    });

    if (!result.success) throw new Error(result.error);
  },

  /**
   * Uploads a file and submits it.
   *
   * The old implementation uploaded to a `task-submissions` bucket that DOES NOT
   * EXIST in the Supabase project, so this has been failing in production — and
   * had the bucket existed as configured it would have been public, making every
   * member's coursework readable by anyone who guessed a path. The file goes to
   * Convex storage and is served only through an authenticated route.
   */
  async submitTaskWithFile(taskId: string, file: File): Promise<void> {
    const validation = storageUtils.validateImage(file);
    // Submissions are not only images, so a failed image check is not fatal
    // here — the server's own allow-list is the one that decides.
    void validation;

    const result = await convex.mutation(api.files.generateUploadUrl, {
      token: requireToken(),
    });
    if (!result.success) throw new Error(result.error);

    const uploaded = await fetch(result.uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': file.type },
      body: file,
    });
    if (!uploaded.ok) throw new Error('Upload failed. Please try again.');

    const { storageId } = (await uploaded.json()) as { storageId: string };

    const attached = await convex.mutation(api.files.attachSubmissionFile, {
      token: requireToken(),
      taskId: taskId as never,
      storageId: storageId as never,
    });

    if (!attached.success) throw new Error(attached.error);
  },

  async createTask(taskData: CreateTaskData, _createdBy?: string): Promise<OrbitTask> {
    const result = await convex.mutation(api.tasks.create, {
      token: requireToken(),
      streamId: taskData.stream_id as never,
      title: taskData.title,
      description: taskData.description,
      submissionType: taskData.submission_type,
      points: taskData.points,
      ...(taskData.deadline
        ? { deadline: taskDeadlineFromWatInput(taskData.deadline) }
        : {}),
      isFeatured: taskData.is_featured,
    });

    const created = await this.getTaskById(result.id as string);
    if (!created) throw new Error('Task not found after creation');
    return created;
  },

  /**
   * Proposals from the ORBIT agent, awaiting a supervisor.
   *
   * A separate call rather than a flag on `getTasks`: these are not tasks the
   * stream has, they are a decision queue, and mixing them into the same list
   * is how one gets published by accident.
   */
  async getPendingProposals(): Promise<ProposedTask[]> {
    const rows = await convex.query(api.tasks.pendingProposals, { token: requireToken() });

    return (rows as Array<Record<string, unknown>>).map((t) => ({
      id: t.id as string,
      stream_id: t.streamId as string,
      stream_name: (t.streamName ?? null) as string | null,
      stream_emoji: (t.streamEmoji ?? null) as string | null,
      title: t.title as string,
      description: t.description as string,
      submission_type: t.submissionType as string,
      points: t.points as number,
      deadline: new Date(t.deadline as number).toISOString(),
      proposed_by: (t.createdByName ?? null) as string | null,
      created_at: new Date(t.createdAt as number).toISOString(),
    }));
  },

  /** Hours a proposal waits before publishing itself; 0 means never. */
  async getApprovalWindow(): Promise<number> {
    const result = await convex.query(api.tasks.approvalWindow, { token: requireToken() });
    return result.hours;
  },

  async approveProposal(taskId: string): Promise<{ notified: number }> {
    const result = await convex.mutation(api.tasks.approveProposal, {
      token: requireToken(),
      taskId: taskId as never,
    });

    if (!result.success) throw new Error(result.error ?? 'Could not approve this task');
    return { notified: result.notified ?? 0 };
  },

  async declineProposal(taskId: string, reason?: string): Promise<void> {
    const result = await convex.mutation(api.tasks.declineProposal, {
      token: requireToken(),
      taskId: taskId as never,
      reason: reason?.trim() ? reason.trim() : undefined,
    });

    if (!result.success) throw new Error(result.error ?? 'Could not decline this task');
  },

  /**
   * Ask for another proposal for a stream.
   *
   * RETURNS the failure rather than throwing it, unlike its neighbours
   * `approveProposal` and `declineProposal`. The difference is deliberate and
   * matches what the server does: `requestNewTask` throws only on
   * authorisation, and returns `{ success: false, error }` for the three
   * ordinary outcomes — the programme has not commenced, the stream is not
   * running, or the stream's bank of prepared tasks is used up.
   *
   * The last of those is not a fault and becomes the COMMON case once a stream
   * has worked through its five, so a caller that threw would be turning
   * routine information into an error banner. The structural split — returned
   * result versus thrown exception — is the discriminant; nothing needs to
   * match on message text.
   */
  async requestNewTask(
    streamId: string,
  ): Promise<{ success: true; taskId: string; title: string } | { success: false; error: string }> {
    return (await convex.mutation(api.tasks.requestNewTask, {
      token: requireToken(),
      streamId: streamId as never,
    })) as { success: true; taskId: string; title: string } | { success: false; error: string };
  },

  async updateTask(id: string, taskData: UpdateTaskData): Promise<OrbitTask> {
    const result = await convex.mutation(api.tasks.update, {
      token: requireToken(),
      taskId: id as never,
      title: taskData.title,
      description: taskData.description,
      submissionType: taskData.submission_type,
      points: taskData.points,
      deadline: taskData.deadline ? taskDeadlineFromWatInput(taskData.deadline) : undefined,
      isActive: taskData.is_active,
      isFeatured: taskData.is_featured,
    });
    if (!result.success) throw new Error(result.error ?? 'Could not update this task');

    const updated = await this.getTaskById(id);
    if (!updated) throw new Error('Task not found after update');
    return updated;
  },

  /**
   * Deactivates. Named `deleteTask` so call sites do not move.
   *
   * The old one hard-deleted the row, orphaning every submission against it —
   * people's work disappeared along with the task, and their points kept
   * referencing a task that no longer existed.
   */
  async deleteTask(id: string): Promise<void> {
    await convex.mutation(api.tasks.deactivate, {
      token: requireToken(),
      taskId: id as never,
    });
  },

  /**
   * A user's submissions.
   *
   * Reading your OWN goes through `mySubmissions`; reading somebody else's
   * through the moderator-gated `listSubmissions`. Sending everything through
   * the latter meant a member could not see the work they had just submitted —
   * the task detail screen does exactly this on every render.
   */
  async getUserSubmissions(userId: string): Promise<OrbitSubmission[]> {
    const rows = isSelf(userId)
      ? ((await convex.query(api.tasks.mySubmissions, {
          token: requireToken(),
        })) as ConvexSubmission[])
      : ((await convex.query(api.tasks.listSubmissions, {
          token: requireToken(),
          userId: userId as never,
        })) as ConvexSubmission[]);

    return rows.map(toSubmission);
  },

  async getSubmissionByTaskAndUser(taskId: string, userId: string): Promise<OrbitSubmission | null> {
    const rows = isSelf(userId)
      ? ((await convex.query(api.tasks.mySubmissions, {
          token: requireToken(),
          taskId: taskId as never,
        })) as ConvexSubmission[])
      : ((await convex.query(api.tasks.listSubmissions, {
          token: requireToken(),
          taskId: taskId as never,
          userId: userId as never,
        })) as ConvexSubmission[]);

    return rows.length ? toSubmission(rows[0]) : null;
  },

  async createSubmission(
    submissionData: CreateSubmissionData,
    _userId?: string,
  ): Promise<OrbitSubmission> {
    await this.submitTask(submissionData.task_id, {
      url: submissionData.submission_url,
      text: submissionData.submission_text,
    });

    const created = await this.getSubmissionByTaskAndUser(
      submissionData.task_id,
      authService.getCurrentUser()?.id ?? '',
    );
    if (!created) throw new Error('Submission not found after creation');
    return created;
  },

  async updateSubmission(
    id: string,
    submissionData: UpdateSubmissionData,
  ): Promise<OrbitSubmission> {
    const existing = await this.getSubmissionById(id);
    if (!existing) throw new Error('Submission not found');

    await this.submitTask(existing.task_id, {
      url: submissionData.submission_url,
      text: submissionData.submission_text,
    });

    const updated = await this.getSubmissionById(id);
    if (!updated) throw new Error('Submission not found after update');
    return updated;
  },

  /**
   * Reviews a submission. ONE call.
   *
   * The points, the level, the badge re-check and the notification all move
   * together or not at all — see the header. `score: 0` is now a real score
   * rather than a falsy value that silently skipped the ledger, and re-scoring
   * pays the difference instead of leaving the row and the ledger disagreeing.
   */
  async reviewSubmission(
    id: string,
    reviewData: ReviewSubmissionData,
    _reviewedBy?: string,
  ): Promise<OrbitSubmission> {
    const result = await convex.mutation(api.tasks.reviewSubmission, {
      token: requireToken(),
      submissionId: id as never,
      status: reviewData.status as 'approved' | 'rejected' | 'changes_requested',
      score: reviewData.score,
      feedback: reviewData.feedback,
    });

    if (!result.success) throw new Error(result.error);

    const reviewed = await this.getSubmissionById(id);
    if (!reviewed) throw new Error('Submission not found after review');
    return reviewed;
  },

  /**
   * One submission by id.
   *
   * Tries the caller's own first — that is the common case and the only one a
   * member is allowed — and falls back to the moderator queue for staff. A
   * member hitting the fallback gets null rather than an exception, because
   * "not yours" and "does not exist" should look the same from here.
   */
  async getSubmissionById(id: string): Promise<OrbitSubmission | null> {
    const mine = (await convex.query(api.tasks.mySubmissions, {
      token: requireToken(),
    })) as ConvexSubmission[];

    const own = mine.find((r) => r.id === id);
    if (own) return toSubmission(own);

    try {
      const rows = (await convex.query(api.tasks.listSubmissions, {
        token: requireToken(),
        limit: 200,
      })) as ConvexSubmission[];
      const match = rows.find((r) => r.id === id);
      return match ? toSubmission(match) : null;
    } catch {
      return null;
    }
  },

  async getAllPendingSubmissions(): Promise<SubmissionWithDetails[]> {
    const rows = await convex.query(api.tasks.reviewQueue, { token: requireToken() });
    return (rows as Record<string, unknown>[]).map((r) => ({
      ...toSubmission(r as unknown as ConvexSubmission),
      // submission_type is REQUIRED here: SubmissionReviewPage gates every
      // content renderer on it, so dropping it meant no submission's text, link
      // or file was ever displayed — reviewers approved and paid points for work
      // they could not see.
      task: r.task ? partialTask(r.task as ConvexTask) : undefined,
      user: r.author
        ? {
            id: (r.author as { id: string }).id,
            full_name: (r.author as { fullName: string }).fullName,
          }
        : undefined,
    }));
  },

  async getSubmissionsByStatus(
    status: string,
    streamId?: string,
  ): Promise<SubmissionWithDetails[]> {
    const rows = (await convex.query(api.tasks.listSubmissions, {
      token: requireToken(),
      status,
      limit: 200,
    })) as Array<ConvexSubmission & { task: ConvexTask | null; author: { id: string; fullName: string } | null }>;

    const mapped = rows.map((r) => ({
      ...toSubmission(r),
      task: r.task ? partialTask(r.task) : undefined,
      user: r.author ? { id: r.author.id, full_name: r.author.fullName } : undefined,
    }));

    if (!streamId) return mapped;

    const streamTasks = new Set((await this.getTasksByStream(streamId)).map((t) => t.id));
    return mapped.filter((s) => streamTasks.has(s.task_id));
  },

  async getSubmissionDetails(
    submissionId: string,
    taskId?: string,
  ): Promise<SubmissionWithDetails | null> {
    /**
     * By TASK when the caller knows it — one indexed query, keyed on a field
     * that never changes, instead of four status-filtered scans keyed on one
     * that does.
     *
     * The status scan below has a race a reviewer actually hits: opening a
     * submission at the moment its author resubmits. The row leaves
     * 'changes_requested' after that list is read and enters 'submitted' before
     * that one is re-read, so every scan misses it and the id fallback wins —
     * which returns the row WITHOUT its task. The review pane rendered from
     * that shape is unusable in the worst way: the submission's content is
     * invisible, "Points to Award (Max: )" is blank, and every score typed is
     * clamped against a missing maximum to 0, so approval is refused with
     * "Please provide a score" no matter what the reviewer does.
     */
    if (taskId) {
      const rows = (await convex.query(api.tasks.listSubmissions, {
        token: requireToken(),
        taskId: taskId as never,
        limit: 200,
      })) as Array<ConvexSubmission & { task: ConvexTask | null; author: { id: string; fullName: string } | null }>;

      const r = rows.find((row) => row.id === submissionId);
      if (r) {
        return {
          ...toSubmission(r),
          task: r.task ? partialTask(r.task) : undefined,
          user: r.author ? { id: r.author.id, full_name: r.author.fullName } : undefined,
        };
      }
    }

    // Searches every reviewable status, not just 'submitted'. Restricted to
    // pending, opening an already-approved submission fell through to the
    // own-submissions path and found nothing.
    for (const status of ['submitted', 'approved', 'rejected', 'changes_requested']) {
      const found = (await this.getSubmissionsByStatus(status)).find((s) => s.id === submissionId);
      if (found) return found;
    }
    return this.getSubmissionById(submissionId);
  },

  async getUpcomingDeadlines(streamId: string, limit = 5): Promise<OrbitTask[]> {
    const tasks = await this.getTasksByStream(streamId);
    const now = Date.now();

    return tasks
      .filter((t) => t.is_active && new Date(t.deadline).getTime() > now)
      .sort((a, b) => new Date(a.deadline).getTime() - new Date(b.deadline).getTime())
      .slice(0, limit);
  },
};

/**
 * Opens a submission's attached file.
 *
 * Convex-stored submissions have NO public url — deliberately. The old code
 * uploaded to a `task-submissions` bucket that does not exist, and had it
 * existed as configured it would have been public, making every member's
 * coursework readable by anyone who guessed a path. The file is served by
 * `/submissions/file`, which checks the session and allows only the author or a
 * reviewer.
 *
 * That route needs an Authorization header, so a plain `<a href>` cannot reach
 * it: the bytes are fetched and handed to the browser as an object URL. The URL
 * is revoked once the tab has taken it, so it does not outlive the click.
 */
export async function openSubmissionFile(submissionId: string): Promise<void> {
  const token = authService.getToken();
  if (!token) throw new Error('Not authenticated');

  const response = await fetch(`${convexSiteUrl}/submissions/file?submissionId=${submissionId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? 'That file is no longer available, or you do not have access to it.'
        : 'Could not open the file. Please try again.',
    );
  }

  const url = window.URL.createObjectURL(await response.blob());
  window.open(url, '_blank', 'noopener');
  setTimeout(() => window.URL.revokeObjectURL(url), 60_000);
}
