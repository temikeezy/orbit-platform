import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { OrbitClient } from '../client.js';
import { registerTaskTools } from './tasks.js';

type CreateResult = {
  success: true;
  id: string;
  notified: number;
  approvalStatus: 'pending' | 'approved';
  deadline: number;
};

type AuditDetail = {
  recordId?: string;
  values?: Record<string, unknown>;
};

type RegisteredTool = {
  description: string;
  schema: z.ZodRawShape;
  callback: (args: Record<string, unknown>) => Promise<CallToolResult>;
};

function createHarness(result: CreateResult) {
  const tools = new Map<string, RegisteredTool>();
  const mutations: Array<Record<string, unknown>> = [];
  const audits: AuditDetail[] = [];

  const server = {
    tool(
      name: string,
      description: string,
      schema: z.ZodRawShape,
      callback: (args: Record<string, unknown>) => Promise<CallToolResult>,
    ) {
      tools.set(name, { description, schema, callback });
    },
  } as unknown as McpServer;

  const client = {
    async mutateAudited(
      _ref: unknown,
      args: Record<string, unknown>,
      audit: { onSuccess?: (value: CreateResult) => AuditDetail },
    ) {
      mutations.push(args);
      const detail = audit.onSuccess?.(result);
      if (detail) audits.push(detail);
      return result;
    },
  } as unknown as OrbitClient;

  registerTaskTools(server, client);
  const tool = tools.get('create_task');
  assert.ok(tool, 'create_task should be registered');

  return {
    tool,
    mutations,
    audits,
    async invoke(input: Record<string, unknown>) {
      const args = z.object(tool.schema).parse(input);
      return tool.callback(args);
    },
  };
}

const REQUIRED = {
  title: 'Week 3 field research',
  stream_id: 'stream_123',
};

function responseText(result: CallToolResult): string {
  const first = result.content[0];
  assert.equal(first?.type, 'text');
  return first.text;
}

describe('create_task', () => {
  test('accepts an omitted deadline and reports the cadence deadline returned by Convex', async () => {
    const resolved = Date.parse('2026-08-20T22:00:00.000Z');
    const harness = createHarness({
      success: true,
      id: 'task_123',
      notified: 0,
      approvalStatus: 'pending',
      deadline: resolved,
    });

    assert.match(harness.tool.description, /silent pending proposal/i);
    assert.match(harness.tool.description, /omit.*current or next programme week/i);
    assert.match(
      z.toJSONSchema(harness.tool.schema.notify_members).description ?? '',
      /no effect.*proposal/i,
    );
    const result = await harness.invoke(REQUIRED);

    assert.equal(harness.mutations.length, 1);
    assert.equal(Object.hasOwn(harness.mutations[0], 'deadline'), false);
    assert.match(responseText(result), /AWAITING SUPERVISOR APPROVAL/);
    assert.match(responseText(result), /supervisors may have been alerted/i);
    assert.match(responseText(result), /if automatic publication is configured/i);
    assert.doesNotMatch(responseText(result), /nobody has been notified/i);
    assert.match(responseText(result), /2026-08-20T22:00:00\.000Z/);
  });

  test('audits the cadence deadline resolved by Convex when none was supplied', async () => {
    const resolved = Date.parse('2026-08-20T22:00:00.000Z');
    const harness = createHarness({
      success: true,
      id: 'task_123',
      notified: 0,
      approvalStatus: 'pending',
      deadline: resolved,
    });

    await harness.invoke(REQUIRED);

    assert.equal(harness.audits[0]?.values?.deadline, resolved);
  });

  test('sends an explicitly supplied ISO deadline as epoch milliseconds', async () => {
    const explicit = '2026-08-19T16:30:00.000Z';
    const resolved = Date.parse(explicit);
    const harness = createHarness({
      success: true,
      id: 'task_456',
      notified: 4,
      approvalStatus: 'approved',
      deadline: resolved,
    });

    const result = await harness.invoke({ ...REQUIRED, deadline: explicit });

    assert.equal(harness.mutations[0]?.deadline, resolved);
    assert.equal(harness.audits[0]?.values?.deadline, resolved);
    assert.match(responseText(result), /2026-08-19T16:30:00\.000Z/);
  });

  for (const explicit of [
    '2026-08-19T22:00:00+01:00',
    '2026-08-19T17:30:00-04:30',
    '2028-02-29T17:00:00Z',
  ]) {
    test(`accepts the valid timezone-qualified ISO deadline ${explicit}`, async () => {
      const resolved = Date.parse(explicit);
      const harness = createHarness({
        success: true,
        id: 'task_valid_boundary',
        notified: 0,
        approvalStatus: 'pending',
        deadline: resolved,
      });

      await harness.invoke({ ...REQUIRED, deadline: explicit });

      assert.equal(harness.mutations[0]?.deadline, resolved);
    });
  }

  test('rejects an invalid explicit deadline before calling Convex', async () => {
    const harness = createHarness({
      success: true,
      id: 'task_789',
      notified: 0,
      approvalStatus: 'pending',
      deadline: 0,
    });

    const result = await harness.invoke({ ...REQUIRED, deadline: 'Thursday sometime' });

    assert.equal(result.isError, true);
    assert.match(responseText(result), /Could not parse.*ISO 8601/);
    assert.equal(harness.mutations.length, 0);
  });

  test('rejects a parseable non-ISO date before calling Convex', async () => {
    const harness = createHarness({
      success: true,
      id: 'task_non_iso',
      notified: 0,
      approvalStatus: 'pending',
      deadline: 0,
    });

    const result = await harness.invoke({ ...REQUIRED, deadline: '08/19/2026' });

    assert.equal(result.isError, true);
    assert.match(responseText(result), /Could not parse.*ISO 8601/);
    assert.equal(harness.mutations.length, 0);
  });

  test('rejects an impossible ISO calendar date before calling Convex', async () => {
    const harness = createHarness({
      success: true,
      id: 'task_impossible_date',
      notified: 0,
      approvalStatus: 'pending',
      deadline: 0,
    });

    const result = await harness.invoke({ ...REQUIRED, deadline: '2026-02-30T17:00:00Z' });

    assert.equal(result.isError, true);
    assert.match(responseText(result), /Could not parse.*ISO 8601/);
    assert.equal(harness.mutations.length, 0);
  });

  for (const invalid of [
    '2027-02-29T17:00:00Z',
    '2026-08-19T24:00:00Z',
    '2026-08-19T17:00:00+24:00',
    '2026-08-19T17:00:00+01:60',
  ]) {
    test(`rejects the out-of-range ISO deadline ${invalid}`, async () => {
      const harness = createHarness({
        success: true,
        id: 'task_invalid_boundary',
        notified: 0,
        approvalStatus: 'pending',
        deadline: 0,
      });

      const result = await harness.invoke({ ...REQUIRED, deadline: invalid });

      assert.equal(result.isError, true);
      assert.equal(harness.mutations.length, 0);
    });
  }
});
