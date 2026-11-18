import assert from 'node:assert/strict';
import test from 'node:test';
import { Fleet, type MachineInfo } from '../../../../packages/fleet/src/index.ts';
import { danilAvailable, danilMachines, listedOf, noteListing, readDanil, setDanilFleet } from '../../src/features/machines/danil-source.ts';

const org: MachineInfo = { id: 'cmp_org', name: 'Servidor Acme', wakes: false, kind: 'organization', organizationId: 'org_A' };
const personal: MachineInfo = { id: 'cmp_vm', name: 'Danil VM', wakes: false, kind: 'personal' };

function fleetWith(answers: Record<string, unknown>) {
  const reads: string[] = [];
  const fleet = new Fleet({ connect: () => ({}) as never });
  (fleet as unknown as { add(info: MachineInfo): void }).add = function (this: Fleet, info: MachineInfo) {
    (this as unknown as { members: Map<string, unknown> }).members.set(info.id, { info, link: { state: () => 'online' }, live: true });
  };
  fleet.read = (async (envelope: { machine: string; command: string }) => {
    reads.push(`${envelope.machine} ${envelope.command}`);
    return { machine: envelope.machine, status: 'ok', has: true, value: answers[envelope.machine], at: 0 };
  }) as Fleet['read'];
  fleet.setMachines([personal, org]);
  return { fleet, reads };
}

test('list_workspaces answers are read tolerantly', () => {
  assert.deepEqual(listedOf({ workspaces: [{ id: 'a', name: 'Acme' }, { id: 'b' }, { name: 'x' }, 3], active: 'a' }), [{ id: 'a', name: 'Acme' }, { id: 'b', name: 'b' }]);
  assert.equal(listedOf(null), null);
  assert.equal(listedOf({ bloqueo: {} }), null);
});

test('only the organization machine of the active organization is read, and only its answer counts', async () => {
  const { fleet, reads } = fleetWith({ cmp_org: { workspaces: [{ id: 'ws_acme', name: 'Acme' }] }, cmp_vm: { workspaces: [{ id: 'mine', name: 'Mía' }] } });
  setDanilFleet(fleet);
  assert.equal(danilAvailable('org_A'), null, 'unsettled before its machine answers');
  assert.deepEqual(danilMachines('org_A'), ['cmp_org']);
  await readDanil('org_A');
  assert.deepEqual(reads, ['cmp_org list_workspaces'], 'a personal machine is never asked');
  assert.deepEqual(danilAvailable('org_A'), [{ id: 'ws_acme', name: 'Acme' }]);
  assert.equal(danilAvailable('org_B'), null);
  assert.equal(danilAvailable(null), null);
  noteListing('cmp_vm', { workspaces: [{ id: 'ws_acme' }] });
  assert.deepEqual(danilAvailable('org_A'), [{ id: 'ws_acme', name: 'Acme' }], 'what a personal machine lists never becomes Danil');
  setDanilFleet(null);
  assert.equal(danilAvailable('org_A'), null, 'without a session nothing is Danil');
});
