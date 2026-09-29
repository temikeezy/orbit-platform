import { OrbitUser, OrbitTask, OrbitStream, OrbitSubmission, OrbitAdminSetting } from '../types/database';

export const mockInternUser: OrbitUser = {
  id: 'user-intern-1',
  email: 'intern@test.com',
  full_name: 'Test Intern',
  roles: ['intern'],
  total_points: 50,
  current_level: 1,
  is_active: true,
  jwt_token: 'test-token-intern',
  jwt_expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  created_at: '2024-01-01T00:00:00.000Z',
  updated_at: '2024-01-01T00:00:00.000Z',
};

export const mockAdminUser: OrbitUser = {
  id: 'user-admin-1',
  email: 'admin@test.com',
  full_name: 'Test Admin',
  roles: ['admin'],
  total_points: 500,
  current_level: 5,
  is_active: true,
  jwt_token: 'test-token-admin',
  jwt_expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  created_at: '2024-01-01T00:00:00.000Z',
  updated_at: '2024-01-01T00:00:00.000Z',
};

export const mockModeratorUser: OrbitUser = {
  id: 'user-mod-1',
  email: 'mod@test.com',
  full_name: 'Test Moderator',
  roles: ['moderator'],
  total_points: 200,
  current_level: 3,
  is_active: true,
  jwt_token: 'test-token-mod',
  jwt_expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  created_at: '2024-01-01T00:00:00.000Z',
  updated_at: '2024-01-01T00:00:00.000Z',
};

export const mockStream: OrbitStream = {
  id: 'stream-1',
  name: 'Web Development',
  description: 'Web dev stream',
  is_active: true,
  created_by: 'user-admin-1',
  created_at: '2024-01-01T00:00:00.000Z',
  updated_at: '2024-01-01T00:00:00.000Z',
};

export const mockTask: OrbitTask = {
  id: 'task-1',
  title: 'Build a landing page',
  description: 'Create a responsive landing page',
  stream_id: 'stream-1',
  created_by: 'user-admin-1',
  points: 10,
  submission_type: 'link',
  deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  is_active: true,
  created_at: '2024-01-01T00:00:00.000Z',
  updated_at: '2024-01-01T00:00:00.000Z',
};

export const mockSubmission: OrbitSubmission = {
  id: 'sub-1',
  task_id: 'task-1',
  user_id: 'user-intern-1',
  status: 'submitted',
  submission_url: 'https://example.com/my-project',
  submitted_at: '2024-01-05T00:00:00.000Z',
  created_at: '2024-01-03T00:00:00.000Z',
  updated_at: '2024-01-05T00:00:00.000Z',
};

export const mockSetting: OrbitAdminSetting = {
  id: 'setting-1',
  setting_key: 'site_name',
  setting_value: 'ORBIT' as unknown as Record<string, unknown>,
  category: 'general',
  description: 'Platform name',
  created_at: '2024-01-01T00:00:00.000Z',
  updated_at: '2024-01-01T00:00:00.000Z',
};

export function seedLocalStorage(user: OrbitUser, token = 'test-token'): void {
  // The _v2 keys. auth.ts versioned them when sessions moved to Convex, and
  // deletes the v1 pair on load — a Supabase token under the old key would make
  // isAuthenticated() true while every Convex call was rejected.
  localStorage.setItem('orbit_auth_token_v2', token);
  localStorage.setItem('orbit_user_v2', JSON.stringify(user));
}
