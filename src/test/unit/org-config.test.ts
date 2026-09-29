import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  agentEmail,
  emailFromDomain,
  icsUidDomain,
  orgAddress,
  orgName,
  orgShortName,
} from '../../../convex/lib/org';

const VARS = [
  'ORBIT_ORG_NAME',
  'ORBIT_ORG_SHORT_NAME',
  'ORBIT_ORG_ADDRESS',
  'ORBIT_AGENT_EMAIL',
  'ORBIT_ICS_UID_DOMAIN',
  'EMAIL_FROM',
];

afterEach(() => vi.unstubAllEnvs());

describe('convex/lib/org', () => {
  it('defaults reproduce the original operator exactly', () => {
    for (const v of VARS) vi.stubEnv(v, '');
    expect(orgName()).toBe('Ilorin Innovation Hub');
    expect(orgShortName()).toBe('IIH');
    expect(orgAddress()).toBe('Ahmadu Bello Way, GRA, Ilorin, Kwara State');
    expect(agentEmail()).toBe('orbit.agent@iih.ng');
    expect(icsUidDomain()).toBe('orbit.iih.ng');
    expect(emailFromDomain()).toBe('orbit2.iih.ng');
  });

  it('honours env overrides', () => {
    vi.stubEnv('ORBIT_ORG_NAME', 'Example Lab');
    vi.stubEnv('ORBIT_ORG_SHORT_NAME', 'EL');
    vi.stubEnv('ORBIT_ORG_ADDRESS', '1 Main St');
    vi.stubEnv('ORBIT_AGENT_EMAIL', 'agent@example.org');
    vi.stubEnv('ORBIT_ICS_UID_DOMAIN', 'orbit.example.org');
    vi.stubEnv('EMAIL_FROM', 'noreply@mail.example.org');
    expect(orgName()).toBe('Example Lab');
    expect(orgShortName()).toBe('EL');
    expect(orgAddress()).toBe('1 Main St');
    expect(agentEmail()).toBe('agent@example.org');
    expect(icsUidDomain()).toBe('orbit.example.org');
    expect(emailFromDomain()).toBe('mail.example.org');
  });
});
