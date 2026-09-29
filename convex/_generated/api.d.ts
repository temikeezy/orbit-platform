/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as acceptanceLetters from "../acceptanceLetters.js";
import type * as admin from "../admin.js";
import type * as adminSettings from "../adminSettings.js";
import type * as agentAdmissions from "../agentAdmissions.js";
import type * as agentCohorts from "../agentCohorts.js";
import type * as agentOps from "../agentOps.js";
import type * as agentSupervision from "../agentSupervision.js";
import type * as agentSupport from "../agentSupport.js";
import type * as agentTasks from "../agentTasks.js";
import type * as applications from "../applications.js";
import type * as auditLogs from "../auditLogs.js";
import type * as auth from "../auth.js";
import type * as badges from "../badges.js";
import type * as calendar from "../calendar.js";
import type * as crons from "../crons.js";
import type * as email from "../email.js";
import type * as emailDispatch from "../emailDispatch.js";
import type * as emailQueue from "../emailQueue.js";
import type * as errorReports from "../errorReports.js";
import type * as files from "../files.js";
import type * as friendships from "../friendships.js";
import type * as http from "../http.js";
import type * as leaderboard from "../leaderboard.js";
import type * as letterAttachment from "../letterAttachment.js";
import type * as levels from "../levels.js";
import type * as lib_acceptanceLetter from "../lib/acceptanceLetter.js";
import type * as lib_admissionRules from "../lib/admissionRules.js";
import type * as lib_agent from "../lib/agent.js";
import type * as lib_agentFallback from "../lib/agentFallback.js";
import type * as lib_appUrl from "../lib/appUrl.js";
import type * as lib_applicationStatus from "../lib/applicationStatus.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_cadence from "../lib/cadence.js";
import type * as lib_cohortRollover from "../lib/cohortRollover.js";
import type * as lib_conversion from "../lib/conversion.js";
import type * as lib_datetime from "../lib/datetime.js";
import type * as lib_emailQa from "../lib/emailQa.js";
import type * as lib_emailShell from "../lib/emailShell.js";
import type * as lib_html from "../lib/html.js";
import type * as lib_input from "../lib/input.js";
import type * as lib_intake from "../lib/intake.js";
import type * as lib_internProfile from "../lib/internProfile.js";
import type * as lib_letterPdf from "../lib/letterPdf.js";
import type * as lib_letterhead from "../lib/letterhead.js";
import type * as lib_levelAnnounce from "../lib/levelAnnounce.js";
import type * as lib_markAnomaly from "../lib/markAnomaly.js";
import type * as lib_membership from "../lib/membership.js";
import type * as lib_org from "../lib/org.js";
import type * as lib_patch from "../lib/patch.js";
import type * as lib_placement from "../lib/placement.js";
import type * as lib_points from "../lib/points.js";
import type * as lib_programme from "../lib/programme.js";
import type * as lib_rateLimit from "../lib/rateLimit.js";
import type * as lib_sentinels from "../lib/sentinels.js";
import type * as lib_settingSecrets from "../lib/settingSecrets.js";
import type * as lib_sheets from "../lib/sheets.js";
import type * as lib_signature from "../lib/signature.js";
import type * as lib_submissionOrder from "../lib/submissionOrder.js";
import type * as lib_taskApproval from "../lib/taskApproval.js";
import type * as lib_taskComplexity from "../lib/taskComplexity.js";
import type * as lib_taskProgramme from "../lib/taskProgramme.js";
import type * as lib_taskSeed from "../lib/taskSeed.js";
import type * as lib_tracks from "../lib/tracks.js";
import type * as logbook from "../logbook.js";
import type * as mcp from "../mcp.js";
import type * as messages from "../messages.js";
import type * as notificationPreferences from "../notificationPreferences.js";
import type * as notifications from "../notifications.js";
import type * as notificationsInternal from "../notificationsInternal.js";
import type * as onboarding from "../onboarding.js";
import type * as posts from "../posts.js";
import type * as reactions from "../reactions.js";
import type * as scheduled from "../scheduled.js";
import type * as setup from "../setup.js";
import type * as siwes from "../siwes.js";
import type * as streamChat from "../streamChat.js";
import type * as streams from "../streams.js";
import type * as tasks from "../tasks.js";
import type * as tracks from "../tracks.js";
import type * as users from "../users.js";
import type * as zoho from "../zoho.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  acceptanceLetters: typeof acceptanceLetters;
  admin: typeof admin;
  adminSettings: typeof adminSettings;
  agentAdmissions: typeof agentAdmissions;
  agentCohorts: typeof agentCohorts;
  agentOps: typeof agentOps;
  agentSupervision: typeof agentSupervision;
  agentSupport: typeof agentSupport;
  agentTasks: typeof agentTasks;
  applications: typeof applications;
  auditLogs: typeof auditLogs;
  auth: typeof auth;
  badges: typeof badges;
  calendar: typeof calendar;
  crons: typeof crons;
  email: typeof email;
  emailDispatch: typeof emailDispatch;
  emailQueue: typeof emailQueue;
  errorReports: typeof errorReports;
  files: typeof files;
  friendships: typeof friendships;
  http: typeof http;
  leaderboard: typeof leaderboard;
  letterAttachment: typeof letterAttachment;
  levels: typeof levels;
  "lib/acceptanceLetter": typeof lib_acceptanceLetter;
  "lib/admissionRules": typeof lib_admissionRules;
  "lib/agent": typeof lib_agent;
  "lib/agentFallback": typeof lib_agentFallback;
  "lib/appUrl": typeof lib_appUrl;
  "lib/applicationStatus": typeof lib_applicationStatus;
  "lib/auth": typeof lib_auth;
  "lib/cadence": typeof lib_cadence;
  "lib/cohortRollover": typeof lib_cohortRollover;
  "lib/conversion": typeof lib_conversion;
  "lib/datetime": typeof lib_datetime;
  "lib/emailQa": typeof lib_emailQa;
  "lib/emailShell": typeof lib_emailShell;
  "lib/html": typeof lib_html;
  "lib/input": typeof lib_input;
  "lib/intake": typeof lib_intake;
  "lib/internProfile": typeof lib_internProfile;
  "lib/letterPdf": typeof lib_letterPdf;
  "lib/letterhead": typeof lib_letterhead;
  "lib/levelAnnounce": typeof lib_levelAnnounce;
  "lib/markAnomaly": typeof lib_markAnomaly;
  "lib/membership": typeof lib_membership;
  "lib/org": typeof lib_org;
  "lib/patch": typeof lib_patch;
  "lib/placement": typeof lib_placement;
  "lib/points": typeof lib_points;
  "lib/programme": typeof lib_programme;
  "lib/rateLimit": typeof lib_rateLimit;
  "lib/sentinels": typeof lib_sentinels;
  "lib/settingSecrets": typeof lib_settingSecrets;
  "lib/sheets": typeof lib_sheets;
  "lib/signature": typeof lib_signature;
  "lib/submissionOrder": typeof lib_submissionOrder;
  "lib/taskApproval": typeof lib_taskApproval;
  "lib/taskComplexity": typeof lib_taskComplexity;
  "lib/taskProgramme": typeof lib_taskProgramme;
  "lib/taskSeed": typeof lib_taskSeed;
  "lib/tracks": typeof lib_tracks;
  logbook: typeof logbook;
  mcp: typeof mcp;
  messages: typeof messages;
  notificationPreferences: typeof notificationPreferences;
  notifications: typeof notifications;
  notificationsInternal: typeof notificationsInternal;
  onboarding: typeof onboarding;
  posts: typeof posts;
  reactions: typeof reactions;
  scheduled: typeof scheduled;
  setup: typeof setup;
  siwes: typeof siwes;
  streamChat: typeof streamChat;
  streams: typeof streams;
  tasks: typeof tasks;
  tracks: typeof tracks;
  users: typeof users;
  zoho: typeof zoho;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
