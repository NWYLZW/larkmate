import { randomUUID, createHash } from 'node:crypto';
import { FeishuError } from './errors.js';

const invalid = message => { throw new FeishuError('INVALID_ARGUMENT', message); };
const scopes = { mine: '__container_owned_tasks', followed: '__container_followed_tasks', all: '__container_all_tasks', created: '__container_created_tasks', assigned: '__container_assigned_tasks', completed: '__container_completed_tasks' };
const id = value => { if (typeof value !== 'string' || !value || value.length > 256) invalid('A valid task ID is required.'); return value; };
const stamp = value => {
  if (value == null || value === '') return '0';
  if (typeof value !== 'string' && typeof value !== 'number') invalid('Invalid task time.');
  const text = String(value); const n = /^\d+$/.test(text) ? Number(text) : Date.parse(text);
  if (!Number.isSafeInteger(n) || n < 0) invalid('Task times must be milliseconds or an ISO date.');
  return String(n);
};
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
function validate(type, object, path = 'input') {
  if (!isObject(object)) invalid(`${path} must be an object.`);
  type.resolveAll();
  for (const [key, value] of Object.entries(object)) {
    const field = type.fields[key]; if (!field) invalid(`Unknown field ${path}.${key}.`);
    const check = item => {
      if (field.resolvedType?.fields) validate(field.resolvedType, item, `${path}.${key}`);
      else if (field.resolvedType?.values && !(typeof item === 'string' && Object.hasOwn(field.resolvedType.values, item)) && !(Number.isInteger(item) && Object.values(field.resolvedType.values).includes(item))) invalid(`Invalid enum ${path}.${key}.`);
    };
    if (field.map) { if (!isObject(value)) invalid(`${path}.${key} must be an object.`); Object.values(value).forEach(check); }
    else if (field.repeated) { if (!Array.isArray(value)) invalid(`${path}.${key} must be an array.`); value.forEach(check); }
    else check(value);
  }
  const message = type.fromObject(object); const error = type.verify(message); if (error) invalid(`${path}: ${error}`);
}
export class Tasks {
  constructor(gateway) { this.gateway = gateway; }
  async call(command, request, data, response, write = false, operation = 'task') {
    const result = await this.gateway.call(command, `todo.${request}`, data, { mutating: write, operation });
    return result.packet.payload?.length ? this.gateway.decode(`todo.${response}`, result.packet.payload) : null;
  }
  async center() { const r = await this.call(1050400, 'GetTaskCenterRequest', {}, 'GetTaskCenterResponse'); if (!r) throw new FeishuError('INVALID_RESPONSE', 'Task center was not returned.'); return { containers: r.containers, views: r.views, sections: r.sections, taskContainerSectionData: r.taskContainerSectionData }; }
  async get({ taskId }) { const task = (await this.call(1050007, 'MGetTodoByGuidRequest', { guids: [id(taskId)] }, 'MGetTodoByGuidResponse'))?.guidToTodo?.[taskId]; if (!task) throw new FeishuError('NOT_FOUND', 'Task was not found or is inaccessible.'); return { task }; }
  async list({ scope = 'mine', container, limit = 50, cursor } = {}) {
    if ((!container && !Object.hasOwn(scopes, scope)) || (container != null && (typeof container !== 'string' || !container)) || !Number.isInteger(limit) || limit < 1 || limit > 100) invalid('Invalid task list options.');
    const center = await this.center(); const selected = center.containers.find(x => container ? x.guid === container : x.key === scopes[scope]);
    if (!selected) throw new FeishuError('NOT_FOUND', 'Task container was not returned by task center.');
    const view = center.views.find(x => x.containerGuid === selected.guid || x.containerKey === selected.key);
    const response = await this.call(1051103, 'GetContainerGroupInfoRequest', { containerGuid: selected.guid,
      ...(view?.viewGroups ? { viewGroups: view.viewGroups } : {}), ...(view?.viewSorts ? { viewSorts: view.viewSorts } : {}),
      ...(view?.viewFilters ? { viewFilters: view.viewFilters } : {}), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', nextCount: 1 }, 'GetContainerGroupInfoResponse');
    if (!response) throw new FeishuError('INVALID_RESPONSE', 'Task list was not returned.');
    const entries = response.groupDataList.flatMap(group => group.taskSortedInfos.map(info => ({ guid: info.taskGuid || info.guid, groupId: String(group.groupId) }))).filter(x => x.guid);
    const digest = createHash('sha256').update(JSON.stringify(entries.map(x => x.guid))).digest('base64url'); let offset = 0;
    if (cursor) { let parsed; try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString()); } catch { invalid('Invalid task cursor.'); }
      if (parsed.container !== selected.guid || parsed.digest !== digest || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0 || parsed.offset > entries.length) throw new FeishuError('CURSOR_EXPIRED', 'Task list changed; restart pagination.'); offset = parsed.offset; }
    const page = entries.slice(offset, offset + limit); const fetched = page.length ? await this.call(1051104, 'MGetServerContainerTasksRequest', { containerGuid: selected.guid, taskGuids: page.map(x => x.guid) }, 'MGetServerContainerTasksResponse') : { tasks: [] };
    if (!fetched) throw new FeishuError('INVALID_RESPONSE', 'Task details were not returned.');
    const byId = new Map(fetched.tasks.map(x => [x.task?.guid, x.task]));
    return { container: selected, items: page.filter(x => byId.has(x.guid)).map(x => ({ task: byId.get(x.guid), groupId: x.groupId })), missing: page.filter(x => !byId.has(x.guid)).map(x => x.guid), total: entries.length,
      groups: response.groupDataList.map(g => ({ id: String(g.groupId), info: g.groupInfos })), serverReportedAllTasks: response.isAllTask,
      nextCursor: offset + page.length < entries.length ? Buffer.from(JSON.stringify({ container: selected.guid, digest, offset: offset + page.length })).toString('base64url') : null };
  }
  async search({ query, limit = 20, cursor } = {}) { if (typeof query !== 'string' || !query.trim() || !Number.isInteger(limit) || limit < 1 || limit > 100 || (cursor != null && typeof cursor !== 'string')) invalid('Invalid task search.');
    const r = await this.call(1050031, 'SearchTaskRequest', { query, count: limit, ...(cursor ? { token: cursor } : {}) }, 'SearchTaskResponse');
    if (!r || (r.hasMore && !r.token)) throw new FeishuError('INVALID_RESPONSE', 'Task search pagination was incomplete.'); return { items: r.todos, nextCursor: r.hasMore ? r.token : null }; }
  rich(text) { if (typeof text !== 'string') invalid('Task text must be a string.'); const element = randomUUID(); return { richText: { elementIds: [element], innerText: text, elements: { dictionary: { [element]: { tag: 1, property: this.gateway.encode('TextProperty', { content: text }) } } } } }; }
  async create({ input = {}, title, description, start, due, allDay, assignees, followers, repeat, lists, points } = {}) {
    if (!isObject(input)) invalid('Task input must be an object.'); await this.gateway.authenticate(); await this.gateway.ensureTodoProto();
    const task = { ...input, guid: input.guid || randomUUID() };
    if (title != null) task.richSummary = this.rich(title); if (description != null) task.richDescription = this.rich(description);
    if (!task.richSummary) invalid('A task title or richSummary is required.');
    if (start != null) task.startMilliTime = stamp(start); if (due != null) task.dueMilliTime = stamp(due); if (allDay != null) task.isAllDay = allDay;
    if (assignees?.length) task.assignees = assignees.map(memberId => ({ memberId: id(memberId), type: 1 }));
    if (followers?.length) task.followers = followers.map(memberId => ({ memberId: id(memberId), type: 1 }));
    if (repeat != null) task.rrule = repeat; if (lists?.length) task.taskListContainerRefs = lists.map(containerGuid => ({ containerGuid: id(containerGuid) })); if (points != null) task.points = points;
    validate(this.gateway.todoProto.lookupType('todo_entities.InputTask'), task);
    const result = await this.call(1050030, 'CreateTaskRequest', { tasks: [task] }, 'CreateTaskResponse', true, 'task-create');
    if (!result) return { status: 'submitted_unconfirmed', taskId: task.guid };
    return { status: result.success && result.tasks.some(x => x.guid === task.guid) ? 'created' : 'rejected_or_unconfirmed', taskId: task.guid, tasks: result.tasks, failReasons: result.failReasons, taskContainerRefReject: result.taskContainerRefReject };
  }
  async update({ taskId, patch = {}, commits = [] } = {}) {
    id(taskId); if (!isObject(patch) || !Array.isArray(commits)) invalid('Invalid task update.');
    const allowed = ['title','description','start','due','allDay','repeat','points','milestone','addAssignees','removeAssignees','addFollowers','removeFollowers'];
    if (Object.keys(patch).some(k => !allowed.includes(k))) invalid('Unknown task update field.');
    const current = (await this.get({ taskId })).task, user = await this.gateway.authenticate(), changes = [];
    const add = (key, dataType, added, deleted) => changes.push({ key, dataType, ...(added ? { added } : {}), ...(deleted ? { deleted } : {}) });
    for (const [name,key] of [['title',17],['description',18]]) if (patch[name] != null) add(key, 5, this.gateway.encode('todo_entities.RichContent', this.rich(patch[name])));
    if (['start','due','allDay'].some(k => patch[k] != null)) add(34, 9, this.gateway.encode('todo_entities.Commit.DataTypeStartAndDueTime', { startTime: patch.start != null ? stamp(patch.start) : String(current.startTime || 0), dueTime: patch.due != null ? stamp(patch.due) : String(current.dueTime || 0), isAllDay: patch.allDay ?? current.isAllDay }));
    for (const [name,key] of [['repeat',26],['points',37]]) if (patch[name] != null) { if (typeof patch[name] !== 'string') invalid('Task field must be a string.'); add(key, 3, this.gateway.encode('todo_entities.Commit.DataTypeString', { value: patch[name] })); }
    if (patch.milestone != null) { if (typeof patch.milestone !== 'boolean') invalid('Milestone must be a boolean.'); add(35, 4, this.gateway.encode('todo_entities.Commit.DataTypeBool', { value: patch.milestone })); }
    for (const [kind,key,type,prop] of [['Assignees',5,'TodoAssignee','assigneeId'],['Followers',20,'TodoFollower','followerId']]) {
      const plus = patch[`add${kind}`] || [], minus = patch[`remove${kind}`] || []; if (!Array.isArray(plus) || !Array.isArray(minus)) invalid('Task members must be arrays.');
      const values = plus.map(member => this.gateway.encode(`todo_entities.${type}`, kind === 'Assignees' ? { id: randomUUID(), assigneeId: id(member), type: 1, assignerId: user.id } : { followerId: id(member), type: 1, inviterId: user.id }));
      const existing = current[kind.toLowerCase()] || []; const deleted = minus.map(member => { id(member); const item = existing.find(x => x[prop] === member); if (!item) invalid(`Member ${member} is not on the task.`); return this.gateway.encode(`todo_entities.${type}`, item); });
      if (values.length || deleted.length) add(key, 6, values.length ? this.gateway.encode('todo_entities.Commit.DataTypeVec', { values }) : null, deleted.length ? this.gateway.encode('todo_entities.Commit.DataTypeVec', { values: deleted }) : null);
    }
    for (const change of commits) { if (!isObject(change) || Object.keys(change).some(k => !['key','dataType','added','deleted'].includes(k))) invalid('Advanced commits accept key, dataType, added and deleted.'); changes.push(change); }
    if (!changes.length) invalid('No task changes were supplied.');
    const enveloped = changes.map(change => ({ ...change, guid: randomUUID(), objType: 1, objGuid: taskId, clientMilliTime: String(Date.now()), platform: 6, ownerType: 1, ownerId: user.id, operationGuid: randomUUID() }));
    for (const commit of enveloped) validate(this.gateway.todoProto.lookupType('todo_entities.Commit'), commit, 'commit');
    let applied = 0, refused = 0, task = null;
    for (const commit of enveloped) {
      let result;
      try { result = await this.call(1050032, 'UpdateTaskByCommitsRequest', { taskGuid: taskId, commits: [commit] }, 'UpdateTaskByCommitsResponse', true, 'task-update'); }
      catch (error) { if (!applied) throw error; return { status: 'partially_applied_effect_unknown', taskId, applied, refused, error: { code: error.code || 'ERROR', message: error.message } }; }
      if (!result) return { status: 'submitted_unconfirmed', taskId, applied, refused };
      applied += result.appliedCommits.length; refused += result.refusedCommits.length; task = result.task || task;
      if (result.refusedCommits.length || !result.appliedCommits.length) break;
    }
    return { status: refused ? 'partially_rejected' : applied === changes.length ? 'updated' : 'submitted_unconfirmed', taskId, applied, refused, task };
  }
  async complete({ taskId, completed, assignees = [] }) { id(taskId); if (typeof completed !== 'boolean' || !Array.isArray(assignees)) invalid('Invalid completion options.');
    await this.call(1050103, 'UpdateTodoCompleteStatusRequest', { todoGuid: taskId, isCompleted: completed, assigneeIds: assignees.map(id) }, 'UpdateTodoCompleteStatusResponse', true, completed ? 'task-complete' : 'task-reopen');
    try { const { task } = await this.get({ taskId }); return { status: (BigInt(String(task.completedMilliTime || 0)) > 0n) === completed ? 'updated' : 'submitted_unconfirmed', task }; } catch { return { status: 'submitted_unconfirmed', taskId }; } }
  async delete({ taskId }) { id(taskId); await this.call(1050101, 'DeleteTodosRequest', { todoGuids: [taskId] }, 'DeleteTodosResponse', true, 'task-delete');
    try { const { task } = await this.get({ taskId }); return { status: BigInt(String(task.deletedMilliTime || 0)) > 0n ? 'deleted' : 'submitted_unconfirmed', taskId }; } catch (e) { return { status: e.code === 'NOT_FOUND' ? 'deleted' : 'submitted_unconfirmed', taskId }; } }
}
