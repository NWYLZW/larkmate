import test from 'node:test';
import assert from 'node:assert/strict';
import { Tasks } from '../src/tasks.js';
import { FeedGroups } from '../src/feed-groups.js';
import { SidebarFilters } from '../src/sidebar-filters.js';
import { authorize, parsePolicy } from '../src/agent-broker.js';

const packet = value => ({ packet: { payload: { length: 1, value } } });
test('task list pages preserve order and reject changed snapshots', async () => {
  let ids = ['a', 'b', 'c'];
  const g = { async call(cmd, type, body) {
    if (cmd === 1050400) return packet({ containers: [{ guid: 'container', key: '__container_owned_tasks' }], views: [], sections: [] });
    if (cmd === 1051103) return packet({ groupDataList: [{ groupId: Math.random(), groupInfos: [], taskSortedInfos: ids.map(guid => ({ guid })) }] });
    if (cmd === 1051104) return packet({ tasks: [...body.taskGuids].reverse().map(guid => ({ task: { guid } })) });
    throw Error('unexpected');
  }, decode: (_type, value) => value.value };
  const tasks = new Tasks(g), first = await tasks.list({ limit: 2 });
  assert.deepEqual(first.items.map(x => x.task.guid), ['a', 'b']);
  const next = await tasks.list({ limit: 2, cursor: first.nextCursor });
  assert.deepEqual(next.items.map(x => x.task.guid), ['c']); assert.equal(next.nextCursor, null);
  ids = ['x', ...ids]; await assert.rejects(tasks.list({ limit: 2, cursor: first.nextCursor }), { code: 'CURSOR_EXPIRED' });
});

test('feed group filters across pages and reports continuation', async () => {
  let calls = 0; const g = { async call() { calls++; return packet({ cards: [{ type: 1, id: String(calls) }], chats: { [calls]: { type: calls === 1 ? 1 : 2, name: 'match', newMessageCount: 1 } }, docFeeds: {}, threads: {}, nextCursor: calls === 1 ? '42' : '0' }); }, decode: (_type, value) => value.value };
  const first = await new FeedGroups(g).query({ group: 'group', pages: 1 }); assert.equal(first.items.length, 0); assert.equal(first.nextCursor, '42');
  const second = await new FeedGroups(g).query({ group: 'group', cursor: first.nextCursor, pages: 1 }); assert.equal(second.items.length, 1); assert.equal(second.nextCursor, null);
});

test('sidebar editing preserves other groups and verifies the result', async () => {
  let usedFilters = [{ systemFilter: 1 }, { systemFilter: 2 }]; let written;
  const g = { async call(cmd, type, body) { if (cmd === 7022) return packet({ setting: { usedFilters, filterDisplayFeedRule: {}, version: '1' }, allFilters: [{ systemFilter: 1 }, { systemFilter: 2 }, { systemFilter: 12 }] }); written = body; usedFilters = body.usedFilters; return packet({}); }, decode: (_type, value) => value.value };
  const result = await new SidebarFilters(g).set({ filter: 'muted', visibility: 'show', position: 2 });
  assert.equal(result.status, 'updated'); assert.deepEqual(written.usedFilters.map(x => x.systemFilter), [1, 12, 2]); assert.deepEqual(written.updateFields, [2]);
});

test('task authorization does not allow completion grant to reopen', () => {
  const p = parsePolicy({ version: 1, allow: ['task-complete'], allowGlobal: true });
  const req = completed => ({ command: 'task-complete', service: 'tasks', method: 'complete', args: [{ taskId: 'a', completed }] });
  assert.doesNotThrow(() => authorize(p, req(true))); assert.throws(() => authorize(p, req(false)), { code: 'POLICY_DENIED' });
});
