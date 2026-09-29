import { callSiwesRpc } from './siwesRpc';
import { convexHttp as convex } from '../convex';
import { api } from '../../../convex/_generated/api';
import { authService } from '../auth';
import { OrbitApplication, OrbitApplicationStatus } from '../../types/database';

/** Same shape as the other api modules: the session or a clear refusal. */
function requireToken(): string {
  const token = authService.getToken();
  if (!token) throw new Error('Not authenticated');
  return token;
}

export const applicationsApi = {
  /**
   * Every application, as the columns the Google Sheet used to carry.
   *
   * The sheet is disconnected in both directions — its readback was an
   * unattributable approval path, and its writeback kept a standing copy of the
   * whole intake's personal details in a document shared by link. This is the
   * replacement: the same columns, generated for a signed-in admin, leaving no
   * second copy behind.
   */
  exportRows() {
    return convex.query(api.applications.exportRows, { token: requireToken() }) as Promise<{
      headers: string[];
      rows: string[][];
      generatedAt: number;
      truncated: boolean;
    }>;
  },

  /**
   * How many applications sit in each status, independent of what is on screen.
   *
   * The tab badges used to be derived from the fetched rows — which the server
   * had already filtered to ONE status — so only the active tab ever showed a
   * number, and searching turned that number into a match count. These come
   * from their own scan so "how many are waiting" stays the answer to the
   * question the screen exists for.
   */
  counts(programmeType?: string) {
    return callSiwesRpc<{ total: number; byStatus: Record<string, number>; capped: boolean }>(
      'orbit_siwes_application_counts',
      { p_programme_type: programmeType || null },
    );
  },

  /**
   * The admissions queue.
   *
   * `search` goes to the SERVER, not to a filter over what is already loaded.
   * The list arrives capped, and production holds more applications than one
   * page — a client-side filter would search the slice you happen to be
   * looking at and quietly report nothing for an applicant who is certainly
   * there. The server matches name, email and reference code across a window of
   * the newest rows — exhaustive at any intake ORBIT has run, and it says so in
   * the logs if that ever stops being true.
   */
  list(status?: OrbitApplicationStatus | '', search?: string, programmeType?: string) {
    return callSiwesRpc<OrbitApplication[]>('orbit_siwes_list_applications', {
      p_status: status || null,
      p_search: search?.trim() || null,
      p_programme_type: programmeType || null,
      // Raised from the default 100: an intake of 200+ is normal here, and a
      // queue that silently stops at 100 hides the oldest applications.
      p_limit: 500,
    });
  },

  updateStatus(id: string, status: OrbitApplicationStatus, notes?: string) {
    return callSiwesRpc<OrbitApplication>('orbit_siwes_update_application_status', {
      p_application_id: id,
      p_status: status,
      p_notes: notes || null,
    });
  },

  /**
   * Records the placement decision: mode, on-site day, stream, supervisor.
   *
   * Direct through `convex.mutation` rather than the `orbit_siwes_*` shim —
   * there is no legacy Postgres name for this, and inventing one would add to a
   * compatibility layer whose whole purpose is eventual deletion.
   */
  async assignPlacement(
    id: string,
    placement: {
      participationMode?: string;
      physicalDay?: number;
      streamId?: string;
      supervisorId?: string;
      departmentId?: string;
      modeOverrideReason?: string;
    },
  ): Promise<void> {
    const result = await convex.mutation(api.applications.assignPlacement, {
      token: requireToken(),
      applicationId: id as never,
      participationMode: placement.participationMode,
      physicalDay: placement.physicalDay,
      streamId: (placement.streamId || undefined) as never,
      supervisorId: (placement.supervisorId || undefined) as never,
      departmentId: (placement.departmentId || undefined) as never,
      modeOverrideReason: placement.modeOverrideReason?.trim() || undefined,
    });

    if (!result.success) throw new Error(result.error ?? 'Could not save this placement');
  },

  /**
   * Approves several applications in one call.
   *
   * Reports which were skipped rather than failing the batch: a selection will
   * often contain something already approved, and refusing the whole thing
   * because of one row would make this useless exactly when it is most wanted.
   */
  async approveMany(ids: string[]): Promise<{
    updated: number;
    skipped: { referenceCode: string; reason: string }[];
  }> {
    const result = await convex.mutation(api.applications.updateStatusBulk, {
      token: requireToken(),
      applicationIds: ids as never,
      status: 'approved',
    });
    if (!result.success) throw new Error(result.error ?? 'Bulk approval failed');
    return { updated: result.updated, skipped: result.skipped };
  },
};
