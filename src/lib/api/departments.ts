import { callSiwesRpc } from './siwesRpc';
import { OrbitDepartment } from '../../types/database';

export interface SaveDepartmentData {
  id?: string;
  name?: string;
  description?: string;
  lead_user_id?: string | null;
  is_active?: boolean;
}

export const departmentsApi = {
  /** Active departments for all users; admins also receive inactive ones. */
  async getDepartments(): Promise<OrbitDepartment[]> {
    return callSiwesRpc<OrbitDepartment[]>('orbit_siwes_list_departments');
  },

  /** Create (no id) or update (with id) a department. Admin only. */
  async saveDepartment(department: SaveDepartmentData): Promise<OrbitDepartment> {
    return callSiwesRpc<OrbitDepartment>('orbit_siwes_save_department', {
      p_department: department,
    });
  },
};
