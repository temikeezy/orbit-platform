import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ZodRawShapeCompat, ShapeOutput } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { describeError } from '../client.js';

/**
 * Tool registration helpers.
 *
 * Two things every tool needs and none should repeat: a uniform error path, and
 * a uniform way to render a result. The Supabase version hand-wrote
 * `if (error) return { content: [{ type: "text", text: \`Error: ...\` }] }` after
 * every single call — twenty-five times, with three variants of the shape and
 * several places where a failure fell through and reported success anyway.
 */

export type ToolResult = CallToolResult;

export function text(body: string): ToolResult {
  return { content: [{ type: 'text', text: body }] };
}

export function json(value: unknown): ToolResult {
  return text(JSON.stringify(value, null, 2));
}

/**
 * Marks the result as an error so the client can distinguish a failure from a
 * tool that simply had nothing to say. The old server returned every failure as
 * ordinary text beginning with "Error:", which reads as success to anything not
 * parsing the string.
 */
export function failure(body: string): ToolResult {
  return { content: [{ type: 'text', text: body }], isError: true };
}

/**
 * Registers a tool with a single error boundary.
 *
 * Convex mutations in this codebase report expected failures as
 * `{ success: false, error }` and unexpected ones by throwing; both end up here
 * as one shape the agent can act on.
 */
export function register<Shape extends ZodRawShapeCompat>(
  server: McpServer,
  name: string,
  description: string,
  schema: Shape,
  handler: (args: ShapeOutput<Shape>) => Promise<ToolResult>,
): void {
  const callback = async (args: ShapeOutput<Shape>): Promise<ToolResult> => {
    try {
      return await handler(args);
    } catch (error) {
      return failure(`Error: ${describeError(error)}`);
    }
  };

  // `server.tool`'s callback parameter is BaseToolCallback<..., Shape>, a
  // conditional type. TS cannot evaluate it while Shape is still an unresolved
  // generic — even though the constraint guarantees which branch it takes — so
  // a generic wrapper around `tool` can never satisfy it without this cast.
  // Nothing is lost at the call sites: `handler` above is typed
  // `(args: ShapeOutput<Shape>) => ...`, and Shape is inferred there from the
  // literal schema, so each tool's arguments are fully checked.
  (server.tool as (...a: unknown[]) => unknown)(name, description, schema, callback);
}

/** Unwraps the `{ success, error }` convention the Convex mutations return. */
export function expectOk<T extends { success: boolean }>(
  result: T,
): Extract<T, { success: true }> {
  if (!result.success) {
    throw new Error((result as unknown as { error: string }).error);
  }
  return result as Extract<T, { success: true }>;
}
