import type { AccountNode } from '@oxy.so/core';
/** UI hints only; every mutation is authorized afresh by the API. */
export function editableOrganizations(nodes: AccountNode[]) {
  return nodes.filter(
    (n) =>
      n.kind === 'organization' &&
      n.callerMembership?.status === 'active' &&
      ['owner', 'admin', 'editor'].includes(n.callerMembership.role),
  );
}
export function utcInput(instant: string) {
  return instant.slice(0, 16).replace('T', ' ');
}
export function parseUtcInput(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value)) throw new Error('Invalid date');
  const date = new Date(`${value.replace(' ', 'T')}:00.000Z`);
  if (!Number.isFinite(date.getTime()) || utcInput(date.toISOString()) !== value)
    throw new Error('Invalid date');
  return date.toISOString();
}
