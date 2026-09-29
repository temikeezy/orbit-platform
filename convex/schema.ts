import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * ORBIT schema on Convex.
 *
 * Translated from the 39 `orbit_*` tables in the shared Supabase project
 * (jnlkzcmeiksqljnbtfhb). Three deliberate departures from the Postgres shape:
 *
 * 1. THE `orbit_` PREFIX IS GONE. It existed only because that database is
 *    multi-tenant — it also hosts iih_*, prdforge_*, the job board and a tax app.
 *    This deployment is ORBIT alone, so the prefix is noise.
 *
 * 2. SESSIONS AND MAGIC LINKS ARE THEIR OWN TABLES. Postgres kept jwt_token /
 *    jwt_expires_at / magic_link_token as columns ON orbit_users, which capped
 *    every account at exactly one active session — signing in on a phone silently
 *    signed you out on a laptop. Separate tables also stop secrets from riding
 *    along in every user read, which is what made the anon-key exposure so broad.
 *
 * 3. TIMESTAMPS ARE EXPLICIT `createdAt` NUMBERS, not Convex's `_creationTime`.
 *    `_creationTime` is stamped at insert and cannot be backdated, so relying on
 *    it would silently reset every historical record to its import time.
 *
 * Every table carries `legacyId` (the Postgres uuid) for the duration of the
 * migration: the importer resolves foreign keys through it, and it makes a
 * row-by-row diff against the old database possible. It is dropped once cutover
 * is verified.
 *
 * Type mapping: timestamptz -> number (epoch ms), date -> string (YYYY-MM-DD, as
 * these are calendar dates with no timezone and must not shift), jsonb -> any,
 * inet -> string, uuid FK -> v.id(<table>), text[] -> array of string.
 */
export default defineSchema({
  // ---------------------------------------------------------------- identity

  users: defineTable({
    legacyId: v.optional(v.string()),
    email: v.string(),
    fullName: v.string(),
    profileSlug: v.string(),
    passwordHash: v.optional(v.string()),
    // Carried over so admin-issued temporary passwords keep working; cleared on
    // first successful change, same as today.
    tempPassword: v.optional(v.string()),
    zohoId: v.optional(v.string()),
    profilePhotoUrl: v.optional(v.string()),
    coverPhotoUrl: v.optional(v.string()),
    // The storage id BESIDE the url. The url is what every read returns, so it
    // stays denormalised — resolving an id per user would put a storage lookup
    // in the directory's hot path. The id exists so replacing a photo can delete
    // the object it replaced: Convex never reclaims storage, so without it every
    // avatar change would leak a file that is billed forever.
    profilePhotoId: v.optional(v.id('_storage')),
    coverPhotoId: v.optional(v.id('_storage')),
    bio: v.optional(v.string()),
    location: v.optional(v.string()),
    socialLinks: v.optional(v.any()),
    roles: v.array(v.string()),
    /**
     * Which programme this member is on: 'siwes' | 'internship' | 'nysc' |
     * 'volunteer'. Copied from their application at conversion.
     *
     * It lived only on `applications` until now, which meant the platform
     * forgot it the moment someone became an intern — and every logbook
     * reminder, missing-log count and status card then treated all four
     * programmes as SIWES because nothing downstream could tell them apart.
     * Optional because accounts created before this existed have none; see
     * `carriesLogbook` in lib/programme.ts for how absence is read.
     */
    programmeType: v.optional(v.string()),
    currentStreamId: v.optional(v.id('streams')),
    totalPoints: v.number(),
    currentLevel: v.number(),
    loginStreakCount: v.number(),
    loginStreakLastDate: v.optional(v.string()),
    isActive: v.boolean(),
    mcpEnabled: v.boolean(),
    profileVisibility: v.string(),
    showEmail: v.boolean(),
    showActivityOnFeed: v.boolean(),
    showOnLeaderboard: v.boolean(),
    lastLoginAt: v.optional(v.number()),
    /**
     * When this member finished reading the orientation manual.
     *
     * Onboarding is checked, not submitted. Signing in and setting a password
     * are both already observable (`lastLoginAt`, `passwordHash`); reading the
     * manual was the only step with no trace, so it gets one. Nothing else in
     * the platform needs it, and it is deliberately not a `tasks` row — see
     * convex/onboarding.ts.
     */
    orientationReadAt: v.optional(v.number()),
    // Opaque, rotatable credential for the ICS calendar feed. A calendar URL is
    // polled forever by third-party servers, so it cannot carry a session token
    // that expires — but it must be revocable independently of one.
    calendarFeedToken: v.optional(v.string()),
    isDummy: v.boolean(),
    dummySource: v.optional(v.string()),
    dummyMarkedAt: v.optional(v.number()),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.id('users')),
    createdAt: v.number(),
    updatedAt: v.number(),

    /**
     * SIWES enrolment, formerly the `internProfiles` table.
     *
     * A person had two identities — a userId and an internProfileId — and every
     * logbook, attendance and review path had to translate between them. The
     * profile was 1:1 with the account and, since accounts started creating one
     * automatically, never absent. A second table for a record that always
     * exists and always belongs to exactly one user is a join with no question
     * to answer.
     *
     * All optional: staff hold accounts too, and an account exists before
     * anyone assigns a cohort.
     */
    cohortId: v.optional(v.id('cohorts')),
    participationMode: v.optional(v.string()),
    institutionName: v.optional(v.string()),
    faculty: v.optional(v.string()),
    courseOfStudy: v.optional(v.string()),
    matricNumber: v.optional(v.string()),
    siwesStartDate: v.optional(v.string()),
    siwesEndDate: v.optional(v.string()),
    institutionSupervisorName: v.optional(v.string()),
    institutionSupervisorEmail: v.optional(v.string()),
    institutionSupervisorPhone: v.optional(v.string()),
    iihSupervisorId: v.optional(v.id('users')),
    departmentId: v.optional(v.id('departments')),
    physicalDay: v.optional(v.number()),
    emergencyContactName: v.optional(v.string()),
    emergencyContactPhone: v.optional(v.string()),
    /** Enrolment status: active | completed | withdrawn. */
    internStatus: v.optional(v.string()),
  })
    .index('by_email', ['email'])
    .index('by_cohort', ['cohortId'])
    .index('by_supervisor', ['iihSupervisorId'])
    .index('by_deleter', ['deletedBy'])
    .index('by_slug', ['profileSlug'])
    .index('by_zohoId', ['zohoId'])
    .index('by_stream', ['currentStreamId'])
    .index('by_calendarToken', ['calendarFeedToken'])
    .index('by_legacyId', ['legacyId']),

  // Replaces orbit_users.jwt_token/jwt_expires_at. One row per active session.
  sessions: defineTable({
    userId: v.id('users'),
    token: v.string(),
    expiresAt: v.number(),
    createdAt: v.number(),
    userAgent: v.optional(v.string()),
    ipAddress: v.optional(v.string()),
    // Marks a session minted by mcp.authenticate rather than by a human sign-in.
    // Needed so revoking MCP access can drop exactly those sessions without
    // signing the person out of their browser — the two are otherwise identical
    // rows, and `mcpEnabled: false` would be advisory until natural expiry.
    isMcp: v.optional(v.boolean()),
    // WHICH credential minted this session, when several resolve to one actor.
    //
    // Recording it only on the authentication row was not enough: every later
    // MCP action audits as the shared actor, so two orchestrators sharing the
    // ORBIT Agent account produced action rows that could not be told apart —
    // the attribution stopped at the door.
    mcpCredential: v.optional(v.string()),
  })
    .index('by_token', ['token'])
    .index('by_user', ['userId'])
    .index('by_expiry', ['expiresAt']),

  // Replaces orbit_users.magic_link_*. Single-use: deleted on redemption.
  magicLinks: defineTable({
    userId: v.id('users'),
    /**
     * LEGACY, and no longer written. The raw token used to live here, which
     * meant redeeming one required passing the secret as a mutation argument —
     * and Convex records function arguments in its logs and any log drain, so a
     * log reader could sign in as anyone within the hour. Replaced by the
     * selector/verifier pair below. Optional so links issued before the change
     * still redeem while they last.
     */
    token: v.optional(v.string()),
    /** Public half: identifies the row, is not a credential, safe to index. */
    selector: v.optional(v.string()),
    /** Secret half, bcrypt-hashed. Never leaves the database in readable form. */
    verifierHash: v.optional(v.string()),
    expiresAt: v.number(),
    sentAt: v.number(),
  })
    .index('by_selector', ['selector'])
    .index('by_token', ['token'])
    .index('by_user', ['userId']),

  oauthStateTokens: defineTable({
    stateToken: v.string(),
    expiresAt: v.number(),
    createdAt: v.number(),
  }).index('by_token', ['stateToken']),

  oauthExchangeCodes: defineTable({
    code: v.string(),
    userId: v.id('users'),
    token: v.string(),
    isNewUser: v.boolean(),
    expiresAt: v.number(),
    usedAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index('by_code', ['code'])
    .index('by_user', ['userId']),

  // ------------------------------------------------------------ streams/tasks

  streams: defineTable({
    legacyId: v.optional(v.string()),
    name: v.string(),
    description: v.optional(v.string()),
    emoji: v.optional(v.string()),
    coverImageUrl: v.optional(v.string()),
    displayPhotoUrl: v.optional(v.string()),
    coverImageId: v.optional(v.id('_storage')),
    displayPhotoId: v.optional(v.id('_storage')),
    memberCount: v.number(),
    privacy: v.optional(v.string()),
    joinType: v.optional(v.string()),
    isActive: v.boolean(),
    createdBy: v.id('users'),
    isDummy: v.boolean(),
    dummySource: v.optional(v.string()),
    dummyMarkedAt: v.optional(v.number()),
    /**
     * The track that owns this stream. Optional: this deployment already holds
     * streams that predate tracks, and a required field would block the deploy.
     * Set through `tracks.attachStream`, never through `streams.update` — that
     * one is moderator-callable, and ownership is an admin decision.
     */
    trackId: v.optional(v.id('tracks')),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_active', ['isActive'])
    .index('by_track', ['trackId'])
    .index('by_legacyId', ['legacyId'])
    .index('by_name', ['name'])
    .index('by_active_and_updated', ['isActive', 'updatedAt']),

  streamMemberships: defineTable({
    legacyId: v.optional(v.string()),
    userId: v.id('users'),
    streamId: v.id('streams'),
    assignedBy: v.id('users'),
    isActive: v.boolean(),
    startedAt: v.optional(v.number()),
    endedAt: v.optional(v.number()),
    isDummy: v.boolean(),
    dummySource: v.optional(v.string()),
    dummyMarkedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_stream', ['streamId'])
    .index('by_stream_and_user', ['streamId', 'userId'])
    .index('by_assigner', ['assignedBy'])
    .index('by_legacyId', ['legacyId']),

  streamModerators: defineTable({
    legacyId: v.optional(v.string()),
    streamId: v.id('streams'),
    userId: v.id('users'),
    /**
     * `track_lead` when this row was materialised by a track-lead grant.
     *
     * ABSENT MEANS A DIRECT GRANT, which reassigning a track lead must never
     * revoke — someone gave that authority deliberately. Every row predating
     * this field reads as manual, which is the safe default.
     */
    source: v.optional(v.string()),
    assignedBy: v.id('users'),
    assignedAt: v.number(),
  })
    .index('by_stream', ['streamId'])
    .index('by_user', ['userId'])
    // isStreamModerator runs on every stream update and announcement send.
    .index('by_stream_and_user', ['streamId', 'userId']),

  tasks: defineTable({
    legacyId: v.optional(v.string()),
    streamId: v.id('streams'),
    title: v.string(),
    /**
     * Which prepared task this came from, when it came from the bank.
     *
     * `title` is what a supervisor sees and is freely editable; this is
     * provenance and is never edited. The bank is matched by title, so without
     * it a supervisor who retitled a proposal and then declined it freed the
     * ORIGINAL seed title — and the very next "request another" offered the
     * same content back under its old name. Absent on hand-written tasks, which
     * have no seed to point at.
     */
    seedTitle: v.optional(v.string()),
    description: v.string(),
    submissionType: v.string(),
    points: v.number(),
    deadline: v.number(),
    createdBy: v.id('users'),
    /**
     * `pending` while a task proposed by the ORBIT agent awaits a supervisor.
     *
     * OPTIONAL, and absent means approved. Every task that existed before the
     * agent did was created by a human who had already decided to publish it,
     * so backfilling them all with a status would be writing down a decision
     * nobody made. `isPublished()` in tasks.ts is the one place that reads it.
     */
    approvalStatus: v.optional(v.string()),
    approvedBy: v.optional(v.id('users')),
    approvedAt: v.optional(v.number()),
    isActive: v.boolean(),
    isFeatured: v.boolean(),
    isDummy: v.boolean(),
    dummySource: v.optional(v.string()),
    dummyMarkedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_stream', ['streamId'])
    .index('by_deadline', ['deadline'])
    .index('by_active', ['isActive'])
    // The approval queue. Without it, finding pending proposals means scanning
    // every task ever created, on a screen supervisors open daily.
    .index('by_approval', ['approvalStatus'])
    .index('by_creator', ['createdBy'])
    .index('by_legacyId', ['legacyId']),

  submissions: defineTable({
    legacyId: v.optional(v.string()),
    taskId: v.id('tasks'),
    userId: v.id('users'),
    submissionText: v.optional(v.string()),
    // Convex file storage id; the Postgres column held a public bucket URL.
    submissionFileId: v.optional(v.id('_storage')),
    submissionFileUrl: v.optional(v.string()),
    status: v.string(),
    score: v.optional(v.number()),
    feedback: v.optional(v.string()),
    reviewedBy: v.optional(v.id('users')),
    reviewedAt: v.optional(v.number()),
    /**
     * When the agent last asked this intern to reshare unreadable evidence.
     *
     * EXISTS TO STOP A DAILY CRON BECOMING HARASSMENT. The reshare chaser runs
     * unattended; without a mark of its own it would message the same person
     * every morning until they fixed a link, which is not a nudge but a
     * punishment for being slow. Recorded on the submission rather than the
     * user because one intern can have several unreadable submissions and each
     * deserves its own ask.
     */
    resharePromptedAt: v.optional(v.number()),
    /**
     * Why the agent last set this submission aside instead of marking it.
     *
     * The marking runner lives on a machine outside this deployment and asks
     * `pendingForAgent` for work each cycle. Without a record of what it already
     * tried, a submission its readers disagreed on would be re-read — and
     * re-billed — every cycle for ever. `at` is compared against `updatedAt`, so
     * a resubmission is picked up again automatically, while an unchanged
     * contested row waits for the five-day settlement instead. A RESHARED link
     * changes nothing on the row, so `unreadable` rows are re-fetched daily a few
     * times instead (see `pendingForAgent`).
     */
    agentAssessment: v.optional(
      v.object({
        outcome: v.string(),
        at: v.number(),
        attempts: v.number(),
        detail: v.optional(v.string()),
        // When THIS version of the work was first set aside — the settlement
        // window runs from here, not from `at`, which moves on every retry.
        firstAt: v.optional(v.number()),
      }),
    ),
    startedAt: v.optional(v.number()),
    acceptedAt: v.optional(v.number()),
    submittedAt: v.optional(v.number()),
    isDummy: v.boolean(),
    dummySource: v.optional(v.string()),
    dummyMarkedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_task', ['taskId'])
    .index('by_user', ['userId'])
    .index('by_task_and_user', ['taskId', 'userId'])
    .index('by_status', ['status'])
    /**
     * The reviewer's queue, ordered by when work was SUBMITTED.
     *
     * `by_status` orders by `_creationTime`, and a resubmission patches the
     * existing row rather than inserting a new one — so work sent back for
     * changes and then redone keeps the creation time of its first attempt.
     * Once the pending backlog is larger than the queue's page, a resubmission
     * is reliably outside the window: the intern does the work again, and the
     * reviewer who asked for it never sees it arrive.
     *
     * `submittedAt` is the field that actually moves when work is resubmitted,
     * so it is the one the queue has to be ordered by.
     */
    .index('by_status_and_submitted', ['status', 'submittedAt'])
    .index('by_status_and_reshare_prompted', ['status', 'resharePromptedAt'])
    // Authorship lookups for the permanent-delete blocker check. These four
    // tables are the only ones in AUTHORSHIP_REFERENCES that grow without bound;
    // the rest (streams, tasks, cohorts, departments, adminSettings) stay in the
    // tens or hundreds and are cheap to scan.
    .index('by_reviewer', ['reviewedBy'])
    .index('by_legacyId', ['legacyId']),

  // ------------------------------------------------------------- gamification

  levels: defineTable({
    legacyId: v.optional(v.string()),
    levelNumber: v.number(),
    name: v.string(),
    description: v.string(),
    pointsRequired: v.number(),
    iconEmoji: v.optional(v.string()),
    colorHex: v.optional(v.string()),
    createdAt: v.number(),
  }).index('by_levelNumber', ['levelNumber']),

  badges: defineTable({
    legacyId: v.optional(v.string()),
    name: v.string(),
    description: v.string(),
    iconUrl: v.optional(v.string()),
    criteriaType: v.string(),
    criteriaValue: v.number(),
    pointsBonus: v.number(),
    isActive: v.boolean(),
    createdAt: v.number(),
  }).index('by_legacyId', ['legacyId']),

  userBadges: defineTable({
    legacyId: v.optional(v.string()),
    userId: v.id('users'),
    badgeId: v.id('badges'),
    earnedAt: v.number(),
    isDummy: v.boolean(),
    dummySource: v.optional(v.string()),
    dummyMarkedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_user_and_badge', ['userId', 'badgeId'])
    // `badges.holders` answers "who has THIS badge", and without this it read
    // every row in the table and filtered in memory — growth is users x badges,
    // so it climbs toward the per-transaction read limit on a screen that looks
    // trivial.
    .index('by_badge', ['badgeId']),

  pointsLedger: defineTable({
    legacyId: v.optional(v.string()),
    userId: v.id('users'),
    points: v.number(),
    reason: v.string(),
    referenceId: v.optional(v.string()),
    referenceType: v.optional(v.string()),
    createdBy: v.id('users'),
    isDummy: v.boolean(),
    dummySource: v.optional(v.string()),
    dummyMarkedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_user_and_reference', ['userId', 'referenceType', 'referenceId'])
    .index('by_user_and_time', ['userId', 'createdAt'])
    .index('by_creator', ['createdBy']),

  weeklyLeaderboard: defineTable({
    legacyId: v.optional(v.string()),
    userId: v.id('users'),
    weekStart: v.string(),
    weekEnd: v.string(),
    /**
     * The deadline in force when this summary was created.
     *
     * Stored rather than derived, for the reason `tasks.deadline` is stored: a
     * deadline is a fact about the record. Cadence is editable cohort config,
     * and a logbook a university receives should state the deadline that
     * applied at the time, not whatever the setting says when it is read.
     * Absent on rows predating it, which fall back to a live computation.
     */
    dueAt: v.optional(v.number()),
    pointsEarned: v.number(),
    rank: v.optional(v.number()),
    rankChange: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index('by_week', ['weekStart'])
    .index('by_user', ['userId']),

  // ------------------------------------------------------------------- social

  posts: defineTable({
    legacyId: v.optional(v.string()),
    userId: v.id('users'),
    streamId: v.optional(v.id('streams')),
    content: v.string(),
    postType: v.string(),
    metadata: v.optional(v.any()),
    // Attached to the POST, not handed out as a standalone public url. See
    // posts.create — an image that belongs to nothing is a free image host, and
    // one that is never reaped is billed forever.
    imageId: v.optional(v.id('_storage')),
    isDummy: v.boolean(),
    dummySource: v.optional(v.string()),
    dummyMarkedAt: v.optional(v.number()),
    /**
     * When the author last rewrote this, if they did.
     *
     * Shown in the feed. Quietly editing a post after people have replied
     * changes what the thread appears to be about, so the fact of an edit is
     * part of the record even though its history is not kept.
     */
    editedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    // createdAt is part of the stream index so the feed can page a single
    // stream with a cursor rather than fetching everything and slicing.
    .index('by_stream', ['streamId', 'createdAt'])
    .index('by_time', ['createdAt'])
    .index('by_legacyId', ['legacyId']),

  postLikes: defineTable({
    legacyId: v.optional(v.string()),
    postId: v.id('posts'),
    userId: v.id('users'),
    createdAt: v.number(),
  })
    .index('by_post', ['postId'])
    .index('by_post_and_user', ['postId', 'userId'])
    .index('by_user', ['userId']),

  postReplies: defineTable({
    legacyId: v.optional(v.string()),
    postId: v.id('posts'),
    userId: v.id('users'),
    content: v.string(),
    isDummy: v.boolean(),
    dummySource: v.optional(v.string()),
    dummyMarkedAt: v.optional(v.number()),
    /**
     * When the author last rewrote this, if they did.
     *
     * Shown in the feed. Quietly editing a post after people have replied
     * changes what the thread appears to be about, so the fact of an edit is
     * part of the record even though its history is not kept.
     */
    editedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index('by_post', ['postId'])
    // Badge 'consistency' counts a user's replies, which ran as a full table
    // scan inside every review approval without this.
    .index('by_user', ['userId'])
    // The mention sweep needs a time window. Without it, posts.mentionsOfMe
    // collected the entire table on every call and then discarded almost all of
    // it — fine at today's size, a hard read-limit failure as replies accumulate.
    .index('by_time', ['createdAt']),

  comments: defineTable({
    legacyId: v.optional(v.string()),
    // targetType/targetId, NOT v.id('posts'). The only live consumer comments on
    // SUBMISSIONS (TaskDetailPage.tsx:317 inserts post_id = submissionId), so a
    // posts-typed id would reject every real comment at the validator and strand
    // the legacy rows on import.
    targetType: v.string(),
    targetId: v.string(),
    userId: v.id('users'),
    content: v.string(),
    parentCommentId: v.optional(v.id('comments')),
    isActive: v.boolean(),
    isDummy: v.boolean(),
    dummySource: v.optional(v.string()),
    dummyMarkedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_target', ['targetType', 'targetId'])
    .index('by_user', ['userId']),

  reactions: defineTable({
    legacyId: v.optional(v.string()),
    userId: v.id('users'),
    targetType: v.string(),
    targetId: v.string(),
    emoji: v.string(),
    createdAt: v.number(),
  })
    .index('by_target', ['targetType', 'targetId'])
    // toggleReaction previously collected every reaction on a target to find the
    // caller's own.
    .index('by_target_and_user', ['targetType', 'targetId', 'userId'])
    .index('by_user', ['userId']),

  friendships: defineTable({
    legacyId: v.optional(v.string()),
    userId: v.id('users'),
    friendId: v.id('users'),
    status: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_pair', ['userId', 'friendId'])
    // listMine's incoming direction was a full table scan without this.
    .index('by_friend', ['friendId']),

  activityFeed: defineTable({
    legacyId: v.optional(v.string()),
    userId: v.id('users'),
    contentType: v.string(),
    contentText: v.optional(v.string()),
    contentUrl: v.optional(v.string()),
    streamId: v.optional(v.id('streams')),
    isStreamOnly: v.boolean(),
    pollOptions: v.optional(v.any()),
    isActive: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_stream', ['streamId'])
    .index('by_time', ['createdAt'])
    .index('by_user', ['userId']),

  streamChat: defineTable({
    legacyId: v.optional(v.string()),
    streamId: v.id('streams'),
    userId: v.id('users'),
    content: v.string(),
    attachmentUrl: v.optional(v.string()),
    isAnnouncement: v.boolean(),
    isDummy: v.boolean(),
    dummySource: v.optional(v.string()),
    dummyMarkedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index('by_stream_and_time', ['streamId', 'createdAt'])
    .index('by_user', ['userId']),

  messages: defineTable({
    legacyId: v.optional(v.string()),
    senderId: v.id('users'),
    recipientId: v.id('users'),
    content: v.string(),
    attachmentUrl: v.optional(v.string()),
    parentMessageId: v.optional(v.id('messages')),
    isRead: v.boolean(),
    readAt: v.optional(v.number()),
    isDummy: v.boolean(),
    dummySource: v.optional(v.string()),
    dummyMarkedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index('by_recipient', ['recipientId'])
    .index('by_sender', ['senderId'])
    .index('by_pair', ['senderId', 'recipientId'])
    .index('by_pair_and_time', ['senderId', 'recipientId', 'createdAt'])
    .index('by_recipient_unread', ['recipientId', 'isRead'])
    // Ordering an inbox "newest first" on by_recipient sorts by _creationTime
    // after the index fields — and every imported row shares roughly the same
    // _creationTime, in importer batch order. Post-cutover that returns the most
    // recently IMPORTED messages, not the newest, and `.take(n)` means the real
    // newest may not appear at all. These indexes carry the real timestamp.
    .index('by_recipient_time', ['recipientId', 'createdAt'])
    .index('by_recipient_unread_time', ['recipientId', 'isRead', 'createdAt'])
    // The sender-side counterpart, added when `conversations` was bounded. The
    // reasoning directly above applies identically to sent mail, and without
    // this a bounded "newest sent" read would take the most recently IMPORTED
    // rows rather than the newest — silently omitting live conversations from
    // the list while looking like it worked.
    .index('by_sender_time', ['senderId', 'createdAt'])
    // Replies to a thread root. The page found these with an `.or()` filter
    // string that interpolated the root id and matched across the whole table.
    .index('by_parent', ['parentMessageId']),

  notifications: defineTable({
    legacyId: v.optional(v.string()),
    userId: v.id('users'),
    type: v.string(),
    title: v.string(),
    content: v.string(),
    referenceType: v.optional(v.string()),
    referenceId: v.optional(v.string()),
    actionUrl: v.optional(v.string()),
    relatedMessageId: v.optional(v.id('messages')),
    relatedTaskId: v.optional(v.id('tasks')),
    relatedStreamId: v.optional(v.id('streams')),
    /**
     * The post this notification is about.
     *
     * Optional and added late, so every existing row is unaffected. It exists so
     * a second fan-out over the same post can RECOGNISE what it already sent —
     * without it, "have I told this person about this post" is unanswerable and
     * a retry, a re-run or an overlapping schedule silently mails everyone
     * twice.
     */
    relatedPostId: v.optional(v.id('posts')),
    relatedUserId: v.optional(v.id('users')),
    isRead: v.boolean(),
    readAt: v.optional(v.number()),
    isDummy: v.boolean(),
    dummySource: v.optional(v.string()),
    dummyMarkedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_user_unread', ['userId', 'isRead'])
    // Answers "was this person already told about this post" in one lookup.
    .index('by_user_and_post', ['userId', 'relatedPostId'])
    // The reminder cron asks "has this user had one of these TODAY". Without a
    // time component that question reads a user's entire notification history,
    // once per intern per run — and notifications only ever accumulate, so the
    // cron would eventually exceed the per-transaction read limit and, being one
    // mutation, send nothing at all rather than degrade.
    .index('by_user_and_time', ['userId', 'createdAt'])
    // Notification history is product state, not an audit trail. The retention
    // cron keeps read rows for 30 days and unread rows for 180 days, and needs
    // each class ordered by age so neither backlog can hide the other.
    .index('by_read_and_time', ['isRead', 'createdAt'])
    /**
     * Notifications ABOUT a user, for permanent deletion.
     *
     * That path scanned the whole table to find them, which on a deployment
     * with real history read 14.6MB against a 16MB limit — so deleting an
     * account began to fail as notifications accumulated, with no warning that
     * it was approaching a wall.
     */
    .index('by_relatedUser', ['relatedUserId']),

  notificationPreferences: defineTable({
    // The Postgres table is keyed on user_id with no id column, so this carries
    // the user uuid. Without it the importer's dedupe had nothing to match on
    // and a second run inserted all 13 rows again — which is exactly what
    // happened.
    legacyId: v.optional(v.string()),
    userId: v.id('users'),
    newTaskEnabled: v.boolean(),
    deadlineReminderEnabled: v.boolean(),
    newMessageEnabled: v.boolean(),
    taskSubmittedEnabled: v.boolean(),
    taskApprovedEnabled: v.boolean(),
    taskRejectedEnabled: v.boolean(),
    streamUpdateEnabled: v.boolean(),
    levelUpEnabled: v.boolean(),
    badgeEarnedEnabled: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('by_user', ['userId']),

  // --------------------------------------------------------- SIWES / logbook

  cohorts: defineTable({
    legacyId: v.optional(v.string()),
    name: v.string(),
    description: v.optional(v.string()),
    startDate: v.string(),
    endDate: v.string(),
    status: v.string(),
    defaultParticipationMode: v.string(),
    defaultPhysicalDay: v.optional(v.number()),
    dailyLogsRequired: v.boolean(),
    weeklySummaryRequired: v.boolean(),
    signoffRequired: v.boolean(),

    /**
     * WHEN, not just whether.
     *
     * The three booleans above say a cohort keeps daily logs and weekly
     * summaries; nothing said when they were due, so nothing could be late and
     * no reminder could exist. All optional, and the defaults in lib/cadence.ts
     * reproduce the previous behaviour exactly — so adding these changes
     * nothing until a cohort is edited to use them.
     *
     * Days are Sunday=0, matching `defaultPhysicalDay` and `users.physicalDay`.
     */
    weeklySummaryDueDay: v.optional(v.number()),
    weeklySummaryDueHourWat: v.optional(v.number()),
    signoffDueDay: v.optional(v.number()),
    signoffDueHourWat: v.optional(v.number()),
    /** Which days a daily log is expected. Cohort 1 is Tue–Thu, i.e. [2,3,4]. */
    dailyLogDays: v.optional(v.array(v.number())),
    /** When true, a missed on-site day becomes an absence rather than a nudge. */
    physicalAttendanceRequired: v.optional(v.boolean()),
    createdBy: v.optional(v.id('users')),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('by_status', ['status']),

  departments: defineTable({
    legacyId: v.optional(v.string()),
    name: v.string(),
    description: v.optional(v.string()),
    leadUserId: v.optional(v.id('users')),
    isActive: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('by_active', ['isActive']),

  /**
   * A programme track: an IIH department owns it, and it groups streams.
   *
   * Keyed on `slug`, which is a NATURAL KEY and never edited — the same strings
   * are on every application's `trackInterests` and in the Google Sheet's
   * "Tracks" column, so renaming one orphans history. Display names live here
   * and are editable; the seed and the intake validator live in lib/tracks.ts.
   *
   * `departmentId` is optional because the concept note leaves one track's
   * ownership undecided, and a track that exists but is unowned is a truer
   * record than one pointed at the wrong department.
   */
  tracks: defineTable({
    slug: v.string(),
    name: v.string(),
    shortName: v.optional(v.string()),
    description: v.optional(v.string()),
    /** The owning department. Its `leadUserId` IS the track lead. */
    departmentId: v.optional(v.id('departments')),
    displayOrder: v.number(),
    isActive: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_slug', ['slug'])
    .index('by_active', ['isActive'])
    .index('by_department', ['departmentId']),

  dailyLogs: defineTable({
    legacyId: v.optional(v.string()),
    /** The intern. The enrolment lives on the account — see lib/internProfile.ts. */
    userId: v.id('users'),
    logDate: v.string(),
    participationMode: v.string(),
    streamId: v.optional(v.id('streams')),
    departmentId: v.optional(v.id('departments')),
    submissionId: v.optional(v.id('submissions')),
    title: v.string(),
    workDone: v.string(),
    learned: v.optional(v.string()),
    toolsUsed: v.optional(v.string()),
    challenges: v.optional(v.string()),
    nextSteps: v.optional(v.string()),
    hoursSpent: v.optional(v.number()),
    evidenceLinks: v.any(),
    attachmentUrl: v.optional(v.string()),
    status: v.string(),
    submittedAt: v.optional(v.number()),
    reviewedBy: v.optional(v.id('users')),
    reviewedAt: v.optional(v.number()),
    supervisorComment: v.optional(v.string()),
    /**
     * The agent's review attempt, when it did not settle the log. Same shape
     * and the same `updatedAt` rule as `submissions.agentAssessment`.
     */
    agentReview: v.optional(
      v.object({ outcome: v.string(), at: v.number(), firstAt: v.optional(v.number()) }),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_user_and_date', ['userId', 'logDate'])
    .index('by_status', ['status'])
    .index('by_reviewer', ['reviewedBy']),

  weeklySummaries: defineTable({
    legacyId: v.optional(v.string()),
    /** The intern. The enrolment lives on the account — see lib/internProfile.ts. */
    userId: v.id('users'),
    weekStart: v.string(),
    weekEnd: v.string(),
    /**
     * The deadline in force when this summary was created.
     *
     * Stored rather than derived, for the reason `tasks.deadline` is stored: a
     * deadline is a fact about the record. Cadence is editable cohort config,
     * and a logbook a university receives should state the deadline that
     * applied at the time, not whatever the setting says when it is read.
     * Absent on rows predating it, which fall back to a live computation.
     */
    dueAt: v.optional(v.number()),
    goals: v.optional(v.string()),
    summary: v.optional(v.string()),
    keyLearnings: v.optional(v.string()),
    dailyLogIds: v.array(v.string()),
    supervisorComment: v.optional(v.string()),
    status: v.string(),
    submittedAt: v.optional(v.number()),
    signedOffBy: v.optional(v.id('users')),
    signedOffAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_user_and_week', ['userId', 'weekStart'])
    // The sign-off sweep's queue. It had no status index because only a
    // supervisor ever looked, one intern at a time.
    .index('by_status', ['status'])
    .index('by_signatory', ['signedOffBy']),

  attendanceRecords: defineTable({
    legacyId: v.optional(v.string()),
    /** The intern. The enrolment lives on the account — see lib/internProfile.ts. */
    userId: v.id('users'),
    attendanceDate: v.string(),
    expectedMode: v.string(),
    checkInTime: v.optional(v.number()),
    checkOutTime: v.optional(v.number()),
    departmentId: v.optional(v.id('departments')),
    activitySummary: v.optional(v.string()),
    verifiedBy: v.optional(v.id('users')),
    status: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_user_and_date', ['userId', 'attendanceDate'])
    .index('by_verifier', ['verifiedBy']),

  supervisorNotes: defineTable({
    legacyId: v.optional(v.string()),
    /** The intern. The enrolment lives on the account — see lib/internProfile.ts. */
    userId: v.id('users'),
    authorId: v.id('users'),
    note: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('by_user', ['userId']),

  logbookExports: defineTable({
    legacyId: v.optional(v.string()),
    /** The intern. The enrolment lives on the account — see lib/internProfile.ts. */
    userId: v.id('users'),
    exportedBy: v.optional(v.id('users')),
    exportType: v.string(),
    dateFrom: v.optional(v.string()),
    dateTo: v.optional(v.string()),
    createdAt: v.number(),
  }).index('by_user', ['userId']),

  // -------------------------------------------------------------- admissions

  /**
   * One row per application, tracking whether it reached the Google Sheet.
   *
   * This single table is the log, the retry queue and the duplicate guard.
   * Separate from `applications` so a delivery failure never touches applicant
   * data, and so the mirror can be re-driven without rewriting it.
   */
  applicationMirror: defineTable({
    applicationId: v.id('applications'),
    // Denormalised: the duplicate check and the log stay meaningful without a
    // second read, and remain readable if the application is ever removed.
    referenceCode: v.string(),
    /** pending | sent | duplicate | failed | abandoned */
    status: v.string(),
    attempts: v.number(),
    lastError: v.optional(v.string()),
    lastAttemptAt: v.optional(v.number()),
    sentAt: v.optional(v.number()),
    /** Backoff gate. The sweeper ignores rows until this passes. */
    nextAttemptAt: v.optional(v.number()),
    /**
     * Which flush run holds this row, and since when.
     *
     * Every submission schedules a flush and retries pile on top, so two runs
     * could select the same rows and both push them. The Apps Script now locks
     * around read-deduplicate-append so the sheet cannot gain duplicate rows,
     * but without a claim the two runs could still write conflicting outcomes
     * back — one recording `sent`, the other regressing it to `failed`.
     */
    claimId: v.optional(v.string()),
    claimedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index('by_application', ['applicationId'])
    .index('by_status_and_next', ['status', 'nextAttemptAt']),

  applications: defineTable({
    legacyId: v.optional(v.string()),
    referenceCode: v.string(),
    programmeType: v.string(),
    status: v.string(),
    fullName: v.string(),
    email: v.string(),
    // The address with any `+tag` stripped, for duplicate detection only. The
    // `email` field keeps what the applicant typed and is what gets mailed.
    // Without this the "mail this inbox once a day" guard compared raw strings,
    // so victim+1@, victim+2@ … were distinct addresses to it and identical to
    // the mail server.
    canonicalEmail: v.optional(v.string()),
    phone: v.string(),
    // 'male' | 'female', or absent. Normalised by `genderField` in lib/intake.ts
    // and read only by the acceptance letter, to pick a pronoun. Absent is a
    // first-class value: the form allows declining, and every applicant taken
    // before this field existed has none.
    gender: v.optional(v.string()),
    location: v.optional(v.string()),
    institutionName: v.optional(v.string()),
    faculty: v.optional(v.string()),
    courseOfStudy: v.optional(v.string()),
    matricNumber: v.optional(v.string()),
    levelOrYear: v.optional(v.string()),
    siwesStartDate: v.optional(v.string()),
    siwesEndDate: v.optional(v.string()),
    institutionSupervisorName: v.optional(v.string()),
    institutionSupervisorEmail: v.optional(v.string()),
    institutionSupervisorPhone: v.optional(v.string()),
    preferredParticipationMode: v.string(),
    availablePhysicalDay: v.optional(v.number()),
    trackInterests: v.array(v.string()),
    skillsSummary: v.optional(v.string()),
    motivation: v.optional(v.string()),
    portfolioUrl: v.optional(v.string()),
    emergencyContactName: v.optional(v.string()),
    emergencyContactPhone: v.optional(v.string()),
    consentLogbook: v.boolean(),
    consentDataUse: v.boolean(),
    notes: v.optional(v.string()),
    passportPhotoId: v.optional(v.id('_storage')),
    siwesLetterId: v.optional(v.id('_storage')),
    passportPhotoUrl: v.optional(v.string()),
    siwesLetterUrl: v.optional(v.string()),
    siwesLetterFileName: v.optional(v.string()),
    reviewedBy: v.optional(v.id('users')),
    reviewedAt: v.optional(v.number()),
    /**
     * The ORBIT account created when this application was approved.
     *
     * Also the idempotency key for conversion: an application with this set is
     * never converted again, however many times the sweep runs.
     */
    convertedUserId: v.optional(v.id('users')),
    convertedAt: v.optional(v.number()),
    /** Why conversion could not finish, if it could not. */
    conversionNote: v.optional(v.string()),

    /**
     * WHAT REVIEW DECIDED, kept apart from what intake derived.
     *
     * `preferredParticipationMode` above is inferred from the applicant's
     * free-text location and is never edited — the recommendation and the human
     * decision are different facts, and overwriting the first destroys the
     * evidence that anyone made the second. Until these existed, an admin could
     * change only status and notes, so the approval email stated a mode nobody
     * had chosen and the team fixed it afterwards on the created account.
     */
    assignedParticipationMode: v.optional(v.string()),
    assignedPhysicalDay: v.optional(v.number()),
    assignedCohortId: v.optional(v.id('cohorts')),
    assignedStreamId: v.optional(v.id('streams')),
    assignedSupervisorId: v.optional(v.id('users')),
    assignedDepartmentId: v.optional(v.id('departments')),
    /** Required when the assigned mode differs from the derived one. */
    modeOverrideReason: v.optional(v.string()),
    assignedBy: v.optional(v.id('users')),
    assignedAt: v.optional(v.number()),

    /**
     * The agent's admissions screening, kept apart from the decision itself.
     *
     * Written by `agentAdmissions.recordScreening` without moving `updatedAt`,
     * so an application the applicant later edits is screened again while an
     * unchanged one is not re-read (and re-billed) every cycle. The DECISION is
     * still `status` + `reviewedBy` — this is only why the agent reached it, or
     * why it has not yet.
     */
    agentScreening: v.optional(
      v.object({
        outcome: v.string(),
        at: v.number(),
        detail: v.optional(v.string()),
      }),
    ),

    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_reference', ['referenceCode'])
    .index('by_status', ['status'])
    .index('by_email', ['email'])
    /**
     * The conversion sweep's index.
     *
     * It used to `collect()` the entire applications table on every 15-minute
     * run to find approved-and-unconverted rows — fine at ten applications,
     * and a transaction that stops converting anyone once public intake fills
     * the table. `status` leads so the scan is bounded to approved rows even
     * before the unconverted filter.
     */
    .index('by_status_and_converted', ['status', 'convertedUserId'])
    // Applications accumulate across yearly intakes and are never deleted, so
    // the unfiltered list and the dashboard counts needed a bound.
    .index('by_time', ['createdAt'])
    .index('by_status_and_time', ['status', 'createdAt'])
    .index('by_canonicalEmail', ['canonicalEmail'])
    .index('by_reviewer', ['reviewedBy']),

  // ------------------------------------------------------- ops / admin / logs

  adminSettings: defineTable({
    legacyId: v.optional(v.string()),
    settingKey: v.string(),
    settingValue: v.any(),
    category: v.string(),
    description: v.optional(v.string()),
    acceptableFileTypes: v.optional(v.any()),
    updatedBy: v.optional(v.id('users')),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('by_key', ['settingKey']),

  auditLogs: defineTable({
    legacyId: v.optional(v.string()),
    userId: v.optional(v.id('users')),
    userEmail: v.optional(v.string()),
    userRoles: v.optional(v.array(v.string())),
    action: v.string(),
    tableName: v.optional(v.string()),
    recordId: v.optional(v.string()),
    oldValues: v.optional(v.any()),
    newValues: v.optional(v.any()),
    ipAddress: v.optional(v.string()),
    userAgent: v.optional(v.string()),
    success: v.boolean(),
    errorMessage: v.optional(v.string()),
    metadata: v.optional(v.any()),
    createdAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_action', ['action'])
    .index('by_time', ['createdAt'])
    // Filtered audit reads order by createdAt, and by_action/by_user fall
    // through to _creationTime — which for imported rows is importer batch
    // order. Same trap already fixed in messages and emailQueue.
    .index('by_action_and_time', ['action', 'createdAt'])
    .index('by_user_and_time', ['userId', 'createdAt']),

  /**
   * One row per DELIVERY ATTEMPT, appended and never updated.
   *
   * `emailQueue` carries the CURRENT state of a message — its status, its retry
   * count, and the most recent error. That is enough to decide what to do next
   * and not enough to explain what happened: each failure overwrites the last
   * error, so three attempts that failed for three different reasons are
   * indistinguishable from three that failed for one. "It failed three times"
   * is not a log.
   *
   * Kept separate from `emailQueue` rather than as an array on it because the
   * queue row is written on every transition and attempts are append-only —
   * and because a message body plus an unbounded attempt array on one document
   * is how a row grows past Convex's limit on a bad week.
   *
   * BODIES ARE NEVER COPIED HERE. The attempt records what happened, not what
   * was sent; `emailQueue.bodyHtml` remains the single copy, so a magic-link
   * credential is not duplicated into a second table with a different
   * retention.
   */
  /**
   * Titles a supervisor has declined, per stream.
   *
   * Exists because declining a proposal DELETES its row, which freed its title
   * and made the very next "request another task" hand back the task just
   * rejected — the one flow that feature exists for.
   *
   * The first fix read declined titles out of `auditLogs`, which worked but was
   * bounded by a global cap: audit rows are indexed by action, not by stream,
   * so enough declines ANYWHERE would push a given stream's own decline out of
   * the window and the bug would quietly return. This table is indexed by the
   * thing actually being asked about, so the read is exact and needs no cap.
   *
   * Titles, not task ids: the row is gone, and the bank is matched on title.
   */
  declinedTaskTitles: defineTable({
    streamId: v.id('streams'),
    title: v.string(),
    declinedBy: v.id('users'),
    reason: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index('by_stream', ['streamId'])
    .index('by_stream_and_title', ['streamId', 'title']),

  /**
   * Something went wrong — caught by the app, or reported by a person.
   *
   * WHY THIS EXISTS. `logError` sent to Sentry when a DSN was configured and to
   * the console otherwise, and only when NOT in production. Production has no
   * DSN, so on the deployment that matters every caught error went nowhere at
   * all: no trace, no count, no way to answer "is this happening to anyone
   * else". The first anyone heard of a fault was a member saying the app was
   * broken, with nothing to look up.
   *
   * A reported bug and a caught exception are the same record with a different
   * trigger, so they share a table. `source` distinguishes them, because what
   * you do about them differs: a person who took the trouble to write something
   * down is owed an answer, while a thrown exception is owed a fix.
   *
   * NO TOKENS, EVER. `url` is stored with its query and fragment stripped —
   * magic-link credentials live in a fragment, and an error captured on the
   * sign-in path would otherwise write a live credential into a table admins
   * can read.
   */
  errorReports: defineTable({
    /** 'caught' from logError, 'reported' from the bug form. */
    source: v.string(),
    message: v.string(),
    /** Truncated at write time; a full trace is rarely the useful part. */
    stack: v.optional(v.string()),
    /** Path only — query and fragment are stripped before this is written. */
    path: v.optional(v.string()),
    /** Where in the code, when the caller named it. */
    context: v.optional(v.string()),
    userAgent: v.optional(v.string()),
    /** Absent for an error caught before anyone signed in. */
    userId: v.optional(v.id('users')),
    userEmail: v.optional(v.string()),
    /** What the person said, for a reported bug. */
    note: v.optional(v.string()),
    /** open -> acknowledged -> resolved. Set by an admin. */
    status: v.string(),
    resolvedBy: v.optional(v.id('users')),
    resolvedAt: v.optional(v.number()),
    /**
     * How many times this same message has arrived. One fault hit by forty
     * people is one problem, and a list that says so is readable where forty
     * identical rows are not.
     */
    occurrences: v.number(),
    lastSeenAt: v.number(),
    createdAt: v.number(),
  })
    .index('by_status_and_time', ['status', 'lastSeenAt'])
    .index('by_time', ['lastSeenAt'])
    .index('by_fingerprint', ['message', 'context']),

  emailAttempts: defineTable({
    emailId: v.id('emailQueue'),
    /** 1-based, matching what the admin screen shows. */
    attempt: v.number(),
    outcome: v.string(), // 'sent' | 'failed'
    /** Provider message id on success — the handle support asks for. */
    providerMessageId: v.optional(v.string()),
    /** Full provider error on failure. Truncated at write time, not read time. */
    error: v.optional(v.string()),
    /** How long the send call took, for spotting a degrading provider. */
    durationMs: v.optional(v.number()),
    /** Which drain run made the attempt; ties an attempt to its claim. */
    claimId: v.optional(v.string()),
    /** Set when a human caused this attempt rather than the cron. */
    triggeredByUserId: v.optional(v.id('users')),
    createdAt: v.number(),
  })
    .index('by_email', ['emailId'])
    .index('by_email_and_attempt', ['emailId', 'attempt'])
    .index('by_time', ['createdAt'])
    .index('by_outcome_and_time', ['outcome', 'createdAt']),

  emailQueue: defineTable({
    legacyId: v.optional(v.string()),
    userId: v.optional(v.id('users')),
    emailType: v.string(),
    recipientEmail: v.string(),
    subject: v.string(),
    bodyHtml: v.string(),
    bodyText: v.string(),
    referenceType: v.optional(v.string()),
    referenceId: v.optional(v.string()),
    status: v.string(),
    sentAt: v.optional(v.number()),
    failedAt: v.optional(v.number()),
    /**
     * When an admin called this message off.
     *
     * Its own field rather than reusing `failedAt`, because a cancellation is
     * not a failure and the sweep needs a retention clock that starts when the
     * decision was made — not when the message was queued, which may be weeks
     * earlier. Mirrors sentAt/failedAt so all three terminal states are
     * symmetrical and each is sweepable.
     */
    cancelledAt: v.optional(v.number()),
    errorMessage: v.optional(v.string()),
    retryCount: v.number(),
    /**
     * Not before this instant. Set by `markFailed` with exponential backoff.
     *
     * Without it, a failure went straight back to `pending` and the two-minute
     * cron retried immediately — three attempts inside four minutes, then
     * permanent failure. Any provider blip longer than that lost the mail.
     */
    nextAttemptAt: v.optional(v.number()),
    /**
     * Who requeued this by hand, if anyone.
     *
     * Set by `adminRetry` and consumed by the next delivery attempt, which
     * copies it onto the `emailAttempts` row and clears it. Without this the
     * attempt log could only ever say "the cron did it": the requeue and the
     * send that follows are different transactions minutes apart, and the drain
     * has no idea a human caused it. Cleared on consumption so a LATER
     * cron-driven retry of the same message is not also attributed to them.
     */
    requeuedByUserId: v.optional(v.id('users')),
    /**
     * Claimed by a drain run at this instant, so a second run does not send it
     * again. `status: 'processing'` takes the row out of the pending index for
     * the length of the lease.
     */
    claimedAt: v.optional(v.number()),
    /**
     * Which drain run holds the claim.
     *
     * A lease alone stops two runs picking the same row up, but it cannot stop
     * a run that lost its lease from later reporting on a row someone else now
     * owns — overwriting a `sent` with `failed`, or resurrecting a message that
     * has already gone out. Every transition is conditioned on this.
     */
    claimId: v.optional(v.string()),
    isDummy: v.boolean(),
    dummySource: v.optional(v.string()),
    dummyMarkedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index('by_status', ['status'])
    .index('by_recipient', ['recipientEmail'])
    // Deadline reminders dedupe on a composite referenceId, once per member per
    // due task per hour.
    .index('by_reference', ['referenceId'])
    // The admin email log is "newest first". Without a time index that meant
    // .take() on an unordered scan, which returns the OLDEST rows — so the log
    // showed the first N emails ever queued and never the one you just sent.
    .index('by_time', ['createdAt'])
    .index('by_status_and_time', ['status', 'createdAt'])
    // Terminal retention starts when delivery actually ends, not when the row
    // was queued. A delayed message can be old at the moment it is sent or
    // fails; creation-time cleanup would erase that fresh result before an
    // admin had the promised investigation window.
    .index('by_status_and_sent_at', ['status', 'sentAt'])
    .index('by_status_and_failed_at', ['status', 'failedAt'])
    .index('by_status_and_cancelled_at', ['status', 'cancelledAt'])
    .index('by_user', ['userId']),

  /**
   * Who uploaded which storage object.
   *
   * Convex storage has no ownership model: `ctx.storage.delete(id)` succeeds for
   * anyone holding an id, and ids are visible in every `profilePhotoUrl` the
   * directory returns. Without this table the attach mutations' delete-on-reject
   * was a "delete any file on the platform" primitive for every session, and
   * nothing stopped one member attaching another's object to their own record.
   *
   * A row is claimed on first attach. Later attaches by a different user are
   * refused, and an object is only ever deleted on a claim the same call created.
   */
  uploads: defineTable({
    storageId: v.id('_storage'),
    userId: v.id('users'),
    attached: v.boolean(),
    createdAt: v.number(),
  })
    .index('by_storage', ['storageId'])
    .index('by_user', ['userId'])
    // The reaper sweeps claims that were never attached.
    .index('by_attached_and_time', ['attached', 'createdAt']),

  rateLimits: defineTable({
    ipAddress: v.string(),
    userId: v.optional(v.id('users')),
    endpoint: v.string(),
    requestCount: v.number(),
    windowStart: v.number(),
    lastRequest: v.number(),
  })
    .index('by_ip_and_endpoint', ['ipAddress', 'endpoint'])
    /**
     * Rate-limit rows belonging to a user, for permanent deletion.
     *
     * This table grows faster than any other — every sign-in, upload and
     * application submission touches it — and the delete path scanned all of it
     * to find one user's rows. Measured climbing past 15.7MB of a 16MB
     * transaction limit on a deployment with a few hundred accounts, at which
     * point deleting anyone stops working entirely.
     */
    .index('by_user', ['userId'])
    /**
     * The sweep, which needs to find rows by IDLENESS and cannot use creation
     * time to do it.
     *
     * `checkRateLimit` PATCHES a bucket when its window elapses rather than
     * re-inserting — deliberately, so a long-lived address keeps one row per
     * endpoint instead of accumulating them. The side effect is that an
     * active bucket keeps its original `_creationTime` forever, so a sweep
     * paging from the oldest end reads the same few hundred permanently-busy
     * buckets on every run and never reaches the stale rows behind them. It
     * would have deleted nothing, for good, on the table that was measured at
     * 15.7MB of a 16MB limit.
     */
    .index('by_last_request', ['lastRequest']),

  blockedIps: defineTable({
    ipAddress: v.string(),
    reason: v.string(),
    blockedBy: v.optional(v.id('users')),
    blockedAt: v.number(),
    expiresAt: v.optional(v.number()),
    isPermanent: v.boolean(),
    metadata: v.optional(v.any()),
  }).index('by_ip', ['ipAddress']).index('by_blockedBy', ['blockedBy']),
});
