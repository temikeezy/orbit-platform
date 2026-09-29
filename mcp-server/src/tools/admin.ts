import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fn } from '../functions.js';
import type { OrbitClient } from '../client.js';
import { resolveId } from '../ids.js';
import { register, json, text, expectOk } from './shared.js';

const ID = z.string().min(1).describe('Convex id, or the pre-migration uuid');

export function registerAdminTools(server: McpServer, client: OrbitClient): void {
  register(
    server,
    'send_notification',
    'Send an in-app notification to a user. In-app only — use queue_email_alert to email as well.',
    {
      user_id: ID,
      title: z.string().min(1).max(200),
      content: z.string().min(1).max(2000),
      type: z.string().default('general'),
      action_url: z.string().optional().describe('App-relative path, e.g. /tasks/<id>'),
    },
    async ({ user_id, title, content, type, action_url }) => {
      const userId = await resolveId(client, 'users', user_id);

      const result = await client.mutateAudited(
        fn.sendNotification,
        { userId, title, content, type, actionUrl: action_url },
        {
          action: 'SEND_NOTIFICATION',
          tableName: 'notifications',
          onSuccess: (r) => ({ recordId: r.success ? r.id : undefined, values: { userId, type } }),
        },
      );

      return text(`Notification ${expectOk(result).id} sent to ${userId}`);
    },
  );

  register(
    server,
    'queue_email_alert',
    'Queue a PLAIN TEXT email to a member through the ORBIT email queue. The address is taken ' +
      'from the user record, never supplied by the caller, and the HTML body is generated with ' +
      'the text escaped. The queue drains every 2 minutes.',
    {
      user_id: ID,
      subject: z.string().min(1).max(180),
      body_text: z.string().min(1).max(8000),
      // `body_html` is deliberately NOT exposed.
      //
      // `emailQueue.adminEnqueue` still accepts it, for the app's own templates,
      // which developers author. This caller is different in kind: the agent
      // reads member-written text through list_agent_messages and check_mentions,
      // and an LLM cannot reliably separate "content I was asked to look at"
      // from "instructions". Handing it a verbatim-HTML email primitive means
      // any member can compose mail from ORBIT's domain and ZeptoMail
      // reputation by asking the agent to "send this to everyone" — and the
      // audit row would faithfully attribute it to the admin actor.
      //
      // Plain text, escaped server-side, removes the primitive rather than
      // trying to filter it.
      email_type: z
        .enum([
          'general',
          'onboarding',
          'task_created',
          'deadline_reminder',
          'submission_confirmed',
          'task_scored',
          'welcome',
          'logbook_reminder',
          'logbook_review',
          'logbook_signoff',
          'physical_day_reminder',
          'attendance_alert',
        ])
        .default('general'),
      reference_type: z.string().optional(),
      reference_id: z.string().optional(),
    },
    async (args) => {
      const userId = await resolveId(client, 'users', args.user_id);

      const result = await client.mutateAudited(
        fn.queueEmail,
        {
          userId,
          subject: args.subject,
          bodyText: args.body_text,
          emailType: args.email_type,
          referenceType: args.reference_type,
          referenceId: args.reference_id,
        },
        {
          action: 'QUEUE_EMAIL_ALERT',
          tableName: 'emailQueue',
          onSuccess: (r) => ({
            recordId: r.success ? r.id : undefined,
            values: { userId, emailType: args.email_type },
          }),
        },
      );

      const ok = expectOk(result);
      return text(`Queued email ${ok.id} for ${ok.recipientEmail}`);
    },
  );

  register(
    server,
    'get_admin_settings',
    'Get all admin settings',
    {},
    async () => json(await client.query(fn.listSettings, {})),
  );

  register(
    server,
    'update_setting',
    'Update an existing admin setting. Unknown keys are rejected rather than silently ignored.',
    { setting_key: z.string().min(1), setting_value: z.unknown() },
    async ({ setting_key, setting_value }) => {
      const result = await client.mutateAudited(
        fn.setSetting,
        { key: setting_key, value: setting_value },
        {
          action: 'UPDATE_SETTING',
          tableName: 'adminSettings',
          // The KEY only, never the values. adminSettings.set writes its own
          // audit row with before/after, so duplicating them here is redundant —
          // and if a setting ever holds a credential, this would copy it into a
          // second permanent record.
          onSuccess: () => ({ recordId: setting_key }),
        },
      );

      const ok = expectOk(result);
      return text(
        `Setting "${setting_key}" updated (was ${JSON.stringify(ok.previous)}, now ${JSON.stringify(setting_value)})`,
      );
    },
  );
}
