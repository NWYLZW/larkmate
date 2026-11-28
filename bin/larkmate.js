#!/usr/bin/env node
import { Command, CommanderError } from 'commander';
import { loadCookie } from '../src/credentials.js';
import { Gateway } from '../src/gateway.js';
import { LarkMateClient } from '../src/client.js';
import { SessionControls } from '../src/session-controls.js';
import { Minutes, formatTranscript } from '../src/minutes.js';
import { writeFile, readFile } from 'node:fs/promises';
import { FeishuError } from '../src/errors.js';
import { exportMessages } from '../src/export-messages.js';
import { brokerCall, brokerCommands, brokerProxy, createBrokerToken, loadBrokerToken, loadPolicy, startBroker } from '../src/agent-broker.js';
import { callOsDelegate, osDelegateProxy } from '../src/os-delegate-client.js';
import { SidebarFilters } from '../src/sidebar-filters.js';
import { FeedGroups } from '../src/feed-groups.js';
import { Tasks } from '../src/tasks.js';
import { Calendar } from '../src/calendar.js';
import { GroupManagement, groupSettingsSchema } from '../src/group-management.js';

const defaultTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const program = new Command();
program.name('larkmate').description('Operate Feishu as the logged-in user.').version('0.1.14');
program.option('--credentials-file <path>', 'read LarkMate credentials.json');
program.option('--broker <path>', 'use a restricted local broker socket (or LARKMATE_BROKER)');
program.option('--broker-token-file <path>', 'read the agent token (or LARKMATE_BROKER_TOKEN_FILE)');
program.option('--delegate-owner <user>', 'execute through a protected OS-user delegate (or LARKMATE_DELEGATE_OWNER)');
program.option('--delegate-launcher <path>', 'protected delegate launcher (or LARKMATE_DELEGATE_LAUNCHER)');
program.exitOverride();
let activeCommand;
program.hook('preAction', (_program, command) => { activeCommand = command.name(); });

const collect = (value, previous) => [...previous, value];
const output = value => process.stdout.write(`${JSON.stringify({ ok: true, ...value }, null, 2)}\n`);

function configuredBroker() { return program.opts().broker || process.env.LARKMATE_BROKER || null; }
function configuredBrokerToken() { return program.opts().brokerTokenFile || process.env.LARKMATE_BROKER_TOKEN_FILE || null; }
function configuredDelegate() {
  const owner = program.opts().delegateOwner || process.env.LARKMATE_DELEGATE_OWNER;
  const launcher = program.opts().delegateLauncher || process.env.LARKMATE_DELEGATE_LAUNCHER;
  if (!!owner !== !!launcher) throw new FeishuError('DELEGATE_CONFIG_INVALID', 'Both delegate owner and launcher are required.');
  if (owner && (configuredBroker() || configuredBrokerToken() || program.opts().credentialsFile)) throw new FeishuError('DELEGATE_CONFIG_INVALID', 'Do not combine OS delegation with broker or credentials options.');
  return owner ? { owner, launcher } : null;
}
function proxy(service) {
  const delegate = configuredDelegate();
  if (delegate) return osDelegateProxy(delegate.owner, delegate.launcher, service, () => activeCommand);
  const path = configuredBroker();
  if (!path && configuredBrokerToken()) throw new FeishuError('BROKER_CONFIGURATION_INVALID', 'A broker token file was configured without a broker socket.');
  if (path && program.opts().credentialsFile) throw new FeishuError('INVALID_ARGUMENT', 'A broker client cannot select a credentials file.');
  return path ? brokerProxy(path, service, () => activeCommand, configuredBrokerToken()) : null;
}

async function controls() {
  const remote = proxy('controls');
  if (remote) return remote;
  return new SessionControls(new Gateway({ cookie: await loadCookie({ file: program.opts().credentialsFile }) }));
}

async function client() {
  const remote = proxy('client');
  if (remote) return remote;
  const cookie = await loadCookie({ file: program.opts().credentialsFile });
  return new LarkMateClient(new Gateway({ cookie }));
}

async function minutes() {
  const remote = proxy('minutes');
  if (remote) return remote;
  return new Minutes(new Gateway({ cookie: await loadCookie({ file: program.opts().credentialsFile }) }));
}

async function sidebar() {
  const remote = proxy('sidebar');
  if (remote) return remote;
  return new SidebarFilters(new Gateway({ cookie: await loadCookie({ file: program.opts().credentialsFile }) }));
}

async function groups() { const remote = proxy('groups'); return remote || new GroupManagement(new Gateway({ cookie: await loadCookie({ file: program.opts().credentialsFile }) })); }
async function calendar() { const remote = proxy('calendar'); return remote || new Calendar(new Gateway({ cookie: await loadCookie({ file: program.opts().credentialsFile }) })); }
async function feeds() { const remote = proxy('feeds'); return remote || new FeedGroups(new Gateway({ cookie: await loadCookie({ file: program.opts().credentialsFile }) })); }
async function tasks() { const remote = proxy('tasks'); return remote || new Tasks(new Gateway({ cookie: await loadCookie({ file: program.opts().credentialsFile }) })); }
async function readJson(path, fallback) {
  if (!path) return fallback;
  let data; try { data = path === '-' ? await new Promise((resolve, reject) => { let text = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', x => { text += x; if (text.length > 1048576) reject(new Error()); }); process.stdin.on('end', () => resolve(text)); process.stdin.on('error', reject); }) : await readFile(path, 'utf8');
    if (Buffer.byteLength(data) > 1048576) throw new Error(); return JSON.parse(data);
  } catch { throw new FeishuError('INVALID_ARGUMENT', 'Cannot read JSON input (maximum 1 MiB).'); }
}

program.command('broker-commands').description('List operations supported by the agent broker and their scopes.')
  .action(() => output({ items: brokerCommands() }));

program.command('delegate-commands').description('List operations supported by OS-user delegation and their scopes.')
  .action(() => output({ items: brokerCommands() }));

program.command('delegate-info').description('Show the current OS-user delegation permissions.')
  .action(async () => {
    const delegate = configuredDelegate();
    if (!delegate) throw new FeishuError('DELEGATE_CONFIG_INVALID', 'Configure the delegate owner and launcher.');
    output(await callOsDelegate({ ...delegate, request: { command: 'delegate-info' } }));
  });

program.command('broker-token-create').description('Create a private token for one agent broker.')
  .requiredOption('--output <path>', 'absolute path for a new token file')
  .action(async o => { await createBrokerToken(o.output); output({ status: 'created', output: o.output }); });

program.command('broker-serve').description('Start a restricted local agent broker with an owner-controlled policy.')
  .requiredOption('--socket <path>', 'absolute Unix socket path')
  .requiredOption('--policy <path>', 'absolute JSON policy path')
  .requiredOption('--token-file <path>', 'absolute owner-controlled agent token file')
  .action(async o => {
    if (configuredBroker() || configuredDelegate()) throw new FeishuError('INVALID_ARGUMENT', 'Start the broker directly, without a broker or OS delegate.');
    const policy = await loadPolicy(o.policy);
    const token = await loadBrokerToken(o.tokenFile, { owner: true });
    let promise;
    const getServices = () => promise ||= (async () => {
      const gateway = new Gateway({ cookie: await loadCookie({ file: program.opts().credentialsFile }) });
      return { client: new LarkMateClient(gateway), controls: new SessionControls(gateway), minutes: new Minutes(gateway), sidebar: new SidebarFilters(gateway), feeds: new FeedGroups(gateway), tasks: new Tasks(gateway), calendar: new Calendar(gateway), groups: new GroupManagement(gateway) };
    })().catch(error => { promise = undefined; throw error; });
    const broker = await startBroker({ socketPath: o.socket, policy, token, getServices });
    output({ status: 'listening', socket: broker.socketPath });
    let closing = false;
    const stop = async () => { if (closing) return; closing = true; try { await broker.close(); } finally { process.exit(0); } };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });

program.command('broker-info').description('Show the permissions assigned to this broker connection.')
  .action(async () => {
    const path = configuredBroker();
    if (!path) throw new FeishuError('INVALID_ARGUMENT', 'Specify --broker or LARKMATE_BROKER.');
    if (program.opts().credentialsFile) throw new FeishuError('INVALID_ARGUMENT', 'A broker client cannot select a credentials file.');
    output(await brokerCall(path, { command: 'broker-info' }, configuredBrokerToken()));
  });

program.command('status').description('Check the current user login.')
  .action(async () => output(await (await client()).status()));

program.command('search').description('Search users, bots and groups.')
  .requiredOption('--query <text>', 'search text')
  .action(async options => output(await (await client()).search(options.query)));
program.command('search-messages').description('Search accessible messages across conversations.')
  .requiredOption('--query <text>', 'search text')
  .option('--limit <number>', 'results per page, 1 to 100', '20')
  .option('--cursor <cursor>', 'continue the same query from the previous page')
  .action(async o => output(await (await client()).searchMessages({ query: o.query, limit: Number(o.limit), cursor: o.cursor })));

program.command('chats').description('List a page of inbox chats without opening them.')
  .option('--limit <number>', 'inbox cards per page, 1 to 100', '50')
  .option('--cursor <number>', 'continue with the returned cursor')
  .option('--parent <id>', 'list a box returned by a previous page')
  .option('--type <type>', 'filter this page: p2p, group or topic_group')
  .option('--scope <scope>', 'inbox or done', 'inbox')
  .option('--state <state>', 'filter this page: read or unread')
  .action(async options => {
    if (options.type && !['p2p', 'group', 'topic_group'].includes(options.type)) throw new FeishuError('INVALID_ARGUMENT', 'Invalid chat type.');
    if (options.state && !['read', 'unread'].includes(options.state)) throw new FeishuError('INVALID_ARGUMENT', 'Invalid read state.');
    const page = await (await client()).chats({ limit: Number(options.limit), cursor: options.cursor, parent: options.parent, scope: options.scope });
    if (options.type) page.items = page.items.filter(item => item.type === options.type);
    if (options.state) { page.unknownReadState = page.items.filter(item => item.unread == null).length; page.items = page.items.filter(item => item.unread === (options.state === 'unread')); }
    output(page);
  });

program.command('group-query').description('Find feed items by sidebar group across pages.')
  .requiredOption('--group <name>', 'messages, unread, muted, at_me, p2p, group, topic_group, docs, threads or done')
  .option('--query <text>', 'filter names') .option('--limit <number>', 'feed page size', '100').option('--pages <number>', 'maximum pages to scan', '20')
  .option('--cursor <cursor>', 'continue from the previous result').option('--parent <id>', 'search inside a box')
  .action(async o => output(await (await feeds()).query({ group: o.group, query: o.query, limit: Number(o.limit), pages: Number(o.pages), cursor: o.cursor, parent: o.parent })));

program.command('calendars').description('List managed and subscribed calendars.')
  .option('--pages <number>', 'maximum pages', '20').action(async o => output(await (await calendar()).calendars({maxPages:Number(o.pages)})));
program.command('calendar-search').description('Search people, shared calendars and meeting rooms.').requiredOption('--query <text>').option('--offset <number>','search offset','0').option('--limit <number>','result count','20')
  .action(async o => output(await (await calendar()).searchCalendars({query:o.query,offset:Number(o.offset),count:Number(o.limit)})));
program.command('calendar-events').description('Query calendar events overlapping a time range.')
  .requiredOption('--start <time>','ISO date-time with timezone or Unix seconds').requiredOption('--end <time>','exclusive end')
  .option('--calendar <id>','repeatable calendar ID',collect,[]).option('--user <id>','repeatable user ID',collect,[]).option('--all-calendars','include all listed calendars').option('--pages <number>','maximum pages per calendar','20')
  .action(async o => output(await (await calendar()).events({start:o.start,end:o.end,calendarIds:o.calendar,userIds:o.user,allCalendars:!!o.allCalendars,maxPages:Number(o.pages)})));
program.command('calendar-busy').description('Check whether people are busy in a time range.')
  .requiredOption('--start <time>').requiredOption('--end <time>').option('--user <id>','repeatable user ID',collect,[]).option('--no-self','exclude your own calendar')
  .action(async o=>output(await (await calendar()).busy({start:o.start,end:o.end,users:o.user,includeSelf:o.self})));
program.command('calendar-suggest').description('Find mutually available meeting times using free/busy data.')
  .requiredOption('--start <time>').requiredOption('--end <time>').option('--user <id>','repeatable user ID',collect,[]).option('--no-self','exclude your own calendar')
  .option('--duration <minutes>','meeting duration','30').option('--step <minutes>','start-time interval','30').option('--work-start <HH:mm>','working day start','09:00').option('--work-end <HH:mm>','working day end','18:00')
  .option('--timezone <zone>','IANA timezone',defaultTimezone).option('--weekends','include Saturdays and Sundays').option('--limit <number>','maximum suggestions','10').option('--max-requests <number>','maximum free/busy queries','200')
  .action(async o=>output(await (await calendar()).suggest({start:o.start,end:o.end,users:o.user,includeSelf:o.self,duration:Number(o.duration),step:Number(o.step),workStart:o.workStart,workEnd:o.workEnd,timezone:o.timezone,weekends:!!o.weekends,limit:Number(o.limit),maxRequests:Number(o.maxRequests)})));
program.command('calendar-rooms').description('Search available meeting rooms.')
  .requiredOption('--start <time>').requiredOption('--end <time>').option('--query <text>','room name','').option('--limit <number>','page size','50').option('--cursor <number>','next page','0').option('--timezone <zone>','IANA timezone',defaultTimezone).option('--repeat <rrule>')
  .action(async o => output(await (await calendar()).rooms({start:o.start,end:o.end,query:o.query,count:Number(o.limit),cursor:Number(o.cursor),timezone:o.timezone,rrule:o.repeat})));
program.command('event-get').description('Read event details and attendees.').requiredOption('--id <id>').action(async o => output(await (await calendar()).event({eventId:o.id})));
program.command('event-create').description('Create a calendar event; participants may be notified.')
  .option('--title <text>').option('--start <time>').option('--end <time>').option('--calendar <id>').option('--timezone <zone>','IANA timezone',defaultTimezone)
  .option('--description <text>').option('--location <text>').option('--all-day').option('--repeat <rrule>')
  .option('--user <id>','repeatable attendee user ID',collect,[]).option('--group <id>','repeatable group ID',collect,[]).option('--room <id>','repeatable room calendar ID',collect,[])
  .option('--reminder <minutes>','repeatable reminder before start',collect,[]).option('--no-notify','suppress event notifications').option('--json <path>','WebCalendarEvent JSON or - for stdin')
  .action(async o => {let input=await readJson(o.json,{});if(o.location)input.locations=[{name:o.location}];if(o.reminder.length)input.reminders=o.reminder.map(x=>{let minutes=Number(x);if(!Number.isInteger(minutes)||minutes<0)throw new FeishuError('INVALID_ARGUMENT','Invalid reminder.');return {minutes,method:3}});
    output(await (await calendar()).createEvent({input,title:o.title,start:o.start,end:o.end,calendarId:o.calendar,timezone:o.timezone,description:o.description,allDay:o.allDay,repeat:o.repeat,users:o.user,groups:o.group,rooms:o.room,notify:o.notify}));});
program.command('event-update').description('Update an event; participants may be notified.').requiredOption('--id <id>')
  .option('--title <text>').option('--start <time>').option('--end <time>').option('--description <text>').option('--repeat <rrule>').option('--location <text>')
  .option('--add-user <id>','repeatable user ID',collect,[]).option('--remove-user <id>','repeatable user ID',collect,[])
  .option('--add-group <id>','repeatable group ID',collect,[]).option('--remove-group <id>','repeatable group ID',collect,[])
  .option('--add-room <id>','repeatable room calendar ID',collect,[]).option('--remove-room <id>','repeatable room calendar ID',collect,[])
  .option('--span <number>','0 normal, 1 occurrence, 2 future or 3 entire series','0').option('--instance-start <time>','occurrence start')
  .option('--no-notify','suppress event notifications').option('--json <path>','event field patch JSON or - for stdin')
  .action(async o => {let patch=await readJson(o.json,{});for(const [opt,key] of [['title','summary'],['start','startTime'],['end','endTime'],['description','description'],['repeat','rrule']])if(o[opt]!=null)patch[key]=o[opt];if(o.location!=null)patch.locations=[{name:o.location}];
    output(await (await calendar()).updateEvent({eventId:o.id,patch,span:Number(o.span),instanceStart:o.instanceStart,notify:o.notify,addUsers:o.addUser,removeUsers:o.removeUser,addGroups:o.addGroup,removeGroups:o.removeGroup,addRooms:o.addRoom,removeRooms:o.removeRoom}));});
program.command('event-delete').description('Delete an event; participants may be notified.').requiredOption('--id <id>').option('--span <number>','0 normal, 1 occurrence, 2 future or 3 entire series','0').option('--instance-start <time>').option('--no-notify')
  .action(async o => output(await (await calendar()).deleteEvent({eventId:o.id,span:Number(o.span),instanceStart:o.instanceStart,notify:o.notify})));
program.command('event-share').description('Share an event to one or more chats.').requiredOption('--id <id>').requiredOption('--chat <id>','repeatable numeric chat ID',collect,[])
  .action(async o => output(await (await calendar()).share({eventId:o.id,chatIds:o.chat})));
program.command('event-reply').description('Respond to a calendar invitation.').requiredOption('--id <id>').requiredOption('--response <status>','accept, decline or tentative').option('--comment <text>').option('--quit-meeting')
  .action(async o => output(await (await calendar()).reply({eventId:o.id,response:o.response,comment:o.comment,quitMeeting:!!o.quitMeeting})));
program.command('calendar-create').description('Create a calendar.').option('--name <text>').option('--description <text>').option('--timezone <zone>','IANA timezone',defaultTimezone).option('--json <path>','WebCalendar JSON or - for stdin')
  .action(async o => output(await (await calendar()).createCalendar({input:await readJson(o.json,{}),name:o.name,description:o.description,timezone:o.timezone})));
program.command('calendar-update').description('Update calendar settings and members.').requiredOption('--id <id>').option('--name <text>').option('--description <text>').option('--json <path>','calendar field patch JSON or - for stdin')
  .action(async o => {let patch=await readJson(o.json,{});if(o.name!=null)patch.summary=o.name;if(o.description!=null)patch.description=o.description;output(await (await calendar()).updateCalendar({calendarId:o.id,patch}));});
program.command('calendar-delete').description('Delete a non-primary calendar.').requiredOption('--id <id>').action(async o => output(await (await calendar()).deleteCalendar({calendarId:o.id})));
for(const [name,subscribe] of [['calendar-subscribe',true],['calendar-unsubscribe',false]])program.command(name).description('Change a calendar subscription.').requiredOption('--id <id>').action(async o=>output(await (await calendar()).subscription({calendarId:o.id,subscribe})));

program.command('task-center').description('List task containers, views and sections.').action(async () => output(await (await tasks()).center()));
program.command('tasks-list').description('List tasks from a task center view.')
  .option('--scope <name>', 'mine, followed, all, created, assigned or completed', 'mine').option('--container <id>', 'task center container ID')
  .option('--limit <number>', 'tasks per page', '50').option('--cursor <cursor>', 'continue from previous page')
  .action(async o => output(await (await tasks()).list({ scope: o.scope, container: o.container, limit: Number(o.limit), cursor: o.cursor })));
program.command('task-search').description('Search accessible tasks.').requiredOption('--query <text>').option('--limit <number>', 'page size', '20').option('--cursor <cursor>')
  .action(async o => output(await (await tasks()).search({ query: o.query, limit: Number(o.limit), cursor: o.cursor })));
program.command('task-get').description('Read a task.').requiredOption('--id <id>').action(async o => output(await (await tasks()).get({ taskId: o.id })));
program.command('task-create').description('Create a task.').option('--title <text>').option('--description <text>').option('--start <time>', 'milliseconds or ISO date')
  .option('--due <time>', 'milliseconds or ISO date').option('--all-day', 'all-day task').option('--assignee <id>', 'repeatable user ID', collect, [])
  .option('--follower <id>', 'repeatable user ID', collect, []).option('--list <id>', 'repeatable task list ID', collect, [])
  .option('--repeat <rrule>', 'recurrence rule').option('--points <value>').option('--json <path>', 'full InputTask JSON, or - for stdin')
  .action(async o => output(await (await tasks()).create({ input: await readJson(o.json, {}), title: o.title, description: o.description, start: o.start, due: o.due, allDay: o.allDay, assignees: o.assignee, followers: o.follower, lists: o.list, repeat: o.repeat, points: o.points })));
program.command('task-update').description('Update task fields and members.').requiredOption('--id <id>').option('--title <text>').option('--description <text>')
  .option('--start <time>', 'milliseconds or ISO date; 0 clears').option('--due <time>', 'milliseconds or ISO date; 0 clears')
  .option('--all-day <bool>', 'true or false').option('--repeat <rrule>').option('--points <value>').option('--milestone <bool>', 'true or false')
  .option('--add-assignee <id>', 'repeatable user ID', collect, []).option('--remove-assignee <id>', 'repeatable user ID', collect, [])
  .option('--add-follower <id>', 'repeatable user ID', collect, []).option('--remove-follower <id>', 'repeatable user ID', collect, [])
  .option('--commits-json <path>', 'advanced commit array JSON, or - for stdin')
  .action(async o => { const patch = {}; for (const key of ['title','description','start','due','repeat','points']) if (o[key] != null) patch[key] = o[key];
    for (const key of ['allDay','milestone']) if (o[key] != null) { if (!['true','false'].includes(o[key])) throw new FeishuError('INVALID_ARGUMENT', key + ' must be true or false.'); patch[key] = o[key] === 'true'; }
    for (const key of ['addAssignee','removeAssignee','addFollower','removeFollower']) if (o[key].length) patch[key + 's'] = o[key];
    output(await (await tasks()).update({ taskId: o.id, patch, commits: await readJson(o.commitsJson, []) })); });
for (const [command, completed] of [['task-complete', true], ['task-reopen', false]]) program.command(command).description('Change task completion status.').requiredOption('--id <id>')
  .option('--assignee <id>', 'repeatable assignee ID', collect, []).action(async o => output(await (await tasks()).complete({ taskId: o.id, completed, assignees: o.assignee })));
program.command('task-delete').description('Delete a task.').requiredOption('--id <id>').action(async o => output(await (await tasks()).delete({ taskId: o.id })));

program.command('pinned').description('List pinned conversations.').action(async () => output(await (await controls()).pinned()));
program.command('marked').description('List conversations marked with a flag.').action(async () => output(await (await controls()).marked()));
program.command('sidebar-list').description('List sidebar groups and display settings.').action(async () => output(await (await sidebar()).list()));
program.command('sidebar-set').description('Change sidebar group visibility, order or display settings.')
  .requiredOption('--filter <name-or-id>', 'filter name from sidebar-list or numeric ID')
  .option('--visibility <mode>', 'show or hide')
  .option('--position <number>', 'one-based position among visible groups')
  .option('--display <mode>', 'always, new or never in the message group')
  .option('--message-type <type>', 'all, at_me, at_all or star_contacts; repeatable', collect, [])
  .option('--at-all <mode>', 'include @all in the @me group: true or false')
  .option('--show-filter <bool>', 'show the group sidebar: true or false')
  .option('--show-mute-filter <bool>', 'show muted filter: true or false')
  .option('--flag-sorting-rule <number>', 'native numeric flag sorting rule')
  .option('--commonly-used <filter>', 'repeatable common filter name or ID', collect, [])
  .action(async o => {
    if (o.atAll != null && !['true', 'false'].includes(o.atAll)) throw new FeishuError('INVALID_ARGUMENT', 'at-all must be true or false.');
    for (const k of ['showFilter', 'showMuteFilter']) if (o[k] != null && !['true', 'false'].includes(o[k])) throw new FeishuError('INVALID_ARGUMENT', k + ' must be true or false.');
    output(await (await sidebar()).set({ filter: o.filter, visibility: o.visibility, ...(o.position != null ? { position: Number(o.position) } : {}),
      display: o.display, ...(o.messageType.length ? { messageTypes: o.messageType } : {}), ...(o.atAll != null ? { atAll: o.atAll === 'true' } : {}), ...(o.showFilter != null ? { showFilter: o.showFilter === 'true' } : {}), ...(o.showMuteFilter != null ? { showMuteFilter: o.showMuteFilter === 'true' } : {}), ...(o.flagSortingRule != null ? { flagSortingRule: Number(o.flagSortingRule) } : {}), ...(o.commonlyUsed.length ? { commonlyUsedFilters: o.commonlyUsed } : {}) }));
  });
program.command('labels').description('List personal conversation labels.').action(async () => output(await (await controls()).labels()));
program.command('label-chats').description('List conversations in a label.')
  .requiredOption('--label <id>', 'numeric label ID').action(async o => output(await (await controls()).labelChats(o.label)));
program.command('label-create').description('Create a personal conversation label.')
  .requiredOption('--name <name>', 'label name').action(async o => output(await (await controls()).createLabel(o.name)));
program.command('label-rename').description('Rename a conversation label.')
  .requiredOption('--label <id>', 'numeric label ID').requiredOption('--name <name>', 'new name')
  .action(async o => output(await (await controls()).renameLabel(o.label, o.name)));
program.command('label-delete').description('Delete a personal conversation label.')
  .requiredOption('--label <id>', 'numeric label ID').action(async o => output(await (await controls()).deleteLabel(o.label)));
for (const [command, enabled] of [['label-add', true], ['label-remove', false]]) {
  program.command(command).description(enabled ? 'Add a chat to a manual label.' : 'Remove a chat from a manual label.')
    .requiredOption('--label <id>', 'numeric label ID').requiredOption('--chat <id>', 'numeric chat ID')
    .action(async o => output(await (await controls()).labelChat(o.label, o.chat, enabled)));
}
program.command('chat-state').description('Read pin, flag, notification and read state for a conversation.')
  .requiredOption('--chat <id>', 'numeric chat ID').action(async o => output(await (await controls()).state(o.chat)));
for (const [command, method, enabled, description] of [
  ['pin', 'pin', true, 'Pin a conversation.'], ['unpin', 'pin', false, 'Unpin a conversation.'],
  ['mark', 'mark', true, 'Flag a conversation.'], ['unmark', 'mark', false, 'Remove a conversation flag.'],
  ['mute', 'setMute', true, 'Mute a conversation.'], ['unmute', 'setMute', false, 'Unmute a conversation.'],
  ['done', 'setDone', true, 'Move a conversation to done.'], ['inbox', 'setDone', false, 'Return a conversation to inbox.'],
  ['box', 'setBox', true, 'Move a conversation into the box.'], ['unbox', 'setBox', false, 'Remove a conversation from the box.'],
]) {
  program.command(command).description(description).requiredOption('--chat <id>', 'numeric chat ID')
    .action(async o => output(await (await controls())[method](o.chat, enabled)));
}
program.command('unread').description('Mark a conversation manually unread.')
  .requiredOption('--chat <id>', 'numeric chat ID').action(async o => output(await (await controls()).setUnread(o.chat)));
program.command('read').description('Mark a conversation read through its latest visible position.')
  .requiredOption('--chat <id>', 'numeric chat ID').action(async o => output(await (await controls()).setRead(o.chat)));

program.command('minutes-list').description('List accessible recording minutes with the LarkMate Cookie.')
  .option('--limit <number>', 'items per page, 1 to 100', '20')
  .option('--cursor <cursor>', 'continue from the previous page')
  .action(async o => output(await (await minutes()).list({ limit: Number(o.limit), cursor: o.cursor })));

program.command('minutes-access-info').description('Check who owns a recording and whether an access request is allowed.')
  .requiredOption('--minute <token-or-url>', 'recording minutes token or URL')
  .action(async o => output(await (await minutes()).accessInfo(o.minute)));

program.command('minutes-request-access').description('Request access from the recording owner.')
  .requiredOption('--minute <token-or-url>', 'recording minutes token or URL')
  .option('--reason <text>', 'optional request message', '')
  .action(async o => output(await (await minutes()).requestAccess(o.minute, { reason: o.reason })));

program.command('minutes-export').description('Export a complete recording transcript.')
  .requiredOption('--minute <token-or-url>', 'recording minutes token or URL')
  .option('--format <format>', 'txt or markdown', 'txt')
  .option('--no-speakers', 'omit speaker names')
  .option('--no-timestamps', 'omit timestamps')
  .option('--output <path>', 'write a new local file; otherwise return text as JSON')
  .action(async o => {
    if (!['txt', 'markdown'].includes(o.format)) throw new FeishuError('INVALID_ARGUMENT', 'Format must be txt or markdown.');
    const result = await (await minutes()).transcript(o.minute);
    const content = formatTranscript(result.entries, o);
    if (o.output) {
      try { await writeFile(o.output, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); }
      catch (error) { throw new FeishuError('EXPORT_WRITE_FAILED', error.code === 'EEXIST' ? 'Output file already exists; choose a new path.' : 'Could not write the output file.'); }
      output({ output: o.output, total: result.total, format: o.format });
    } else output({ total: result.total, format: o.format, content });
  });

program.command('chat-open').description('Open or find a private chat by numeric user or bot ID.')
  .requiredOption('--id <id>', 'numeric ID from search')
  .action(async options => output(await (await client()).openChat(options.id)));

program.command('chat-info').description('Read basic information about a chat.')
  .requiredOption('--chat <id>', 'numeric chat ID')
  .action(async options => output(await (await client()).chatInfo(options.chat)));

program.command('history').description('Read a bounded page of chat messages as the user.')
  .requiredOption('--chat <id>', 'numeric chat ID')
  .option('--limit <number>', 'number of positions, 1 to 100', '20')
  .option('--start <number>', 'first position; defaults to the most recent page')
  .option('--pages <number>', 'scan up to this many pages backwards, 1 to 100', '1')
  .option('--query <text>', 'filter text within the scanned positions')
  .option('--sender <id>', 'filter sender ID within the scanned positions')
  .option('--after <seconds>', 'filter from Unix time in seconds, inclusive')
  .option('--before <seconds>', 'filter until Unix time in seconds, inclusive')
  .action(async options => output(await (await client()).historyPages({
    chatId: options.chat, limit: Number(options.limit), pages: Number(options.pages), query: options.query, sender: options.sender,
    ...(options.after != null ? { after: Number(options.after) } : {}),
    ...(options.before != null ? { before: Number(options.before) } : {}),
    ...(options.start != null ? { start: Number(options.start) } : {}),
  })));

program.command('messages-export').description('Export a conversation to a local file, paging through history.')
  .requiredOption('--chat <id>', 'numeric chat ID')
  .requiredOption('--output <path>', 'new local output file')
  .option('--format <format>', 'markdown or jsonl', 'markdown')
  .option('--sender <id>', 'only messages from this numeric sender ID')
  .option('--query <text>', 'only messages containing this text')
  .option('--after <seconds>', 'inclusive Unix time in seconds')
  .option('--before <seconds>', 'inclusive Unix time in seconds')
  .option('--start <number>', 'first position of the initial page')
  .option('--limit <number>', 'positions per page, 1 to 100', '100')
  .option('--max-pages <number>', 'stop after this many pages; default scans to the beginning')
  .action(async o => output(await exportMessages(await client(), {
    chatId: o.chat, output: o.output, format: o.format, sender: o.sender, query: o.query, limit: Number(o.limit),
    ...(o.after != null ? { after: Number(o.after) } : {}),
    ...(o.before != null ? { before: Number(o.before) } : {}),
    ...(o.start != null ? { start: Number(o.start) } : {}),
    ...(o.maxPages != null ? { maxPages: Number(o.maxPages) } : {}),
  })));

program.command('send').description('Send text once as the user; delivery remains unconfirmed.')
  .requiredOption('--chat <id>', 'numeric chat ID')
  .requiredOption('--text <text>', 'message text')
  .option('--mention <id:name>', 'mention a numeric user or bot ID; repeatable', collect, [])
  .option('--reply-to <id>', 'reply to a numeric message ID')
  .option('--reply-root <id>', 'root ID when replying to an existing reply')
  .action(async options => {
    const mentions = options.mention.map(value => {
      const colon = value.indexOf(':');
      if (colon < 1) throw new FeishuError('INVALID_ARGUMENT', 'A mention must use id:name.');
      return { id: value.slice(0, colon), name: value.slice(colon + 1) };
    });
    output(await (await client()).send({ chatId: options.chat, text: options.text, mentions, replyTo: options.replyTo, replyRoot: options.replyRoot }));
  });

program.command('send-file').description('Upload and send a local file as the user.')
  .requiredOption('--chat <id>', 'numeric chat ID')
  .requiredOption('--file <path>', 'local file path')
  .action(async options => output(await (await client()).sendFile({ chatId: options.chat, path: options.file })));
program.command('send-image').description('Upload and send a local image as the user.')
  .requiredOption('--chat <id>', 'numeric chat ID')
  .requiredOption('--file <path>', 'local PNG, JPEG, GIF or WebP file')
  .action(async o => output(await (await client()).sendImage({ chatId: o.chat, path: o.file })));

for (const [name, remove] of [['reaction-add', false], ['reaction-remove', true]]) {
  program.command(name).description(remove ? 'Remove a reaction from a message.' : 'Add a reaction to a message.')
    .requiredOption('--message <id>', 'numeric message ID')
    .option('--emoji <name>', 'Feishu reaction name', 'DarkThumbsup')
    .action(async o => output(await (await client()).reaction({ messageId: o.message, emoji: o.emoji, remove })));
}
program.command('download-file').description('Download a message file or image to a new local file.')
  .requiredOption('--chat <id>', 'numeric chat ID')
  .requiredOption('--message <id>', 'numeric message ID')
  .requiredOption('--key <key>', 'file or image key from history')
  .option('--position <number>', 'message position from history (required by a broker or OS delegate)')
  .requiredOption('--output <path>', 'new local output file')
  .action(async o => output(await (await client()).downloadFile({ chatId: o.chat, messageId: o.message, key: o.key, output: o.output, ...(o.position != null ? { position: Number(o.position) } : {}) })));
program.command('message-link').description('Get the native link to a message.')
  .requiredOption('--chat <id>', 'numeric chat ID')
  .requiredOption('--message <id>', 'numeric message ID')
  .action(async o => output(await (await client()).messageLink({ chatId: o.chat, messageId: o.message })));
program.command('message-edit').description('Replace the text of your own message.')
  .requiredOption('--message <id>', 'numeric message ID')
  .requiredOption('--text <text>', 'replacement text')
  .action(async o => output(await (await client()).editMessage({ messageId: o.message, text: o.text })));
program.command('message-forward').description('Forward one message to a chat.')
  .requiredOption('--chat <id>', 'source numeric chat ID')
  .requiredOption('--message <id>', 'numeric message ID')
  .requiredOption('--to <id>', 'target numeric chat ID')
  .action(async o => output(await (await client()).forwardMessage({ chatId: o.chat, messageId: o.message, targetChatId: o.to })));
program.command('message-recall').description('Recall a message.')
  .requiredOption('--message <id>', 'numeric message ID')
  .action(async o => output(await (await client()).recallMessage(o.message)));
program.command('favorite-add').description('Add a message to your favorites.')
  .requiredOption('--chat <id>', 'numeric chat ID')
  .requiredOption('--message <id>', 'numeric message ID')
  .action(async o => output(await (await client()).favoriteMessage({ chatId: o.chat, messageId: o.message })));
program.command('favorite-remove').description('Remove an item from your favorites.')
  .requiredOption('--favorite <id>', 'favorite ID returned by favorite-add')
  .action(async o => output(await (await client()).removeFavorite(o.favorite)));
program.command('favorites').description('Read the first page of your favorite messages.')
  .option('--limit <number>', 'maximum items, 1 to 100', '50')
  .action(async o => output(await (await client()).favorites({ limit: Number(o.limit) })));

program.command('group-link').description('Create a group invitation link.').requiredOption('--chat <id>').option('--days <number>','validity days','7').option('--unlimited','no expiration')
  .action(async o=>output(await (await groups()).link({chatId:o.chat,days:Number(o.days),unlimited:!!o.unlimited})));
program.command('group-requests').description('List pending or processed join applications.').requiredOption('--chat <id>').option('--cursor <cursor>','page cursor','0')
  .action(async o=>output(await (await groups()).requests({chatId:o.chat,cursor:o.cursor})));
for(const [command,approve] of [['group-request-approve',true],['group-request-reject',false]])program.command(command).description('Review a group join application.').requiredOption('--chat <id>').requiredOption('--user <id>')
  .action(async o=>output(await (await groups()).reviewRequest({chatId:o.chat,userId:o.user,approve})));
program.command('group-post-users').description('List the group posting whitelist.').requiredOption('--chat <id>').action(async o=>output(await (await groups()).postUsers({chatId:o.chat})));
program.command('group-settings-schema').description('Show supported group settings and values.').action(()=>output(groupSettingsSchema()));
program.command('group-settings').description('Read group permissions, owner and announcement.').requiredOption('--chat <id>')
  .action(async o=>output(await (await groups()).info({chatId:o.chat})));
program.command('group-settings-set').description('Update group permissions and other settings.').requiredOption('--chat <id>').requiredOption('--json <path>','settings JSON or - for stdin')
  .action(async o=>output(await (await groups()).setSettings({chatId:o.chat,settings:await readJson(o.json,{})})));
program.command('group-admins').description('List group administrators.').requiredOption('--chat <id>').action(async o=>output(await (await groups()).admins({chatId:o.chat})));
for(const [command,enabled] of [['group-admin-add',true],['group-admin-remove',false]])program.command(command).description('Change group administrators.').requiredOption('--chat <id>')
  .requiredOption('--user <id>','repeatable user ID',collect,[]).action(async o=>output(await (await groups()).setAdmins({chatId:o.chat,userIds:o.user,enabled})));
program.command('group-remove').description('Remove members from a group.').requiredOption('--chat <id>').requiredOption('--member <id>','repeatable member ID',collect,[])
  .action(async o=>output(await (await groups()).remove({chatId:o.chat,userIds:o.member})));
program.command('group-leave').description('Leave a group as the current user.').requiredOption('--chat <id>').option('--new-owner <id>','transfer ownership if required')
  .action(async o=>output(await (await groups()).leave({chatId:o.chat,newOwnerId:o.newOwner})));
program.command('group-owner').description('Transfer ownership of a group.').requiredOption('--chat <id>').requiredOption('--user <id>','new owner user ID')
  .action(async o=>output(await (await groups()).setOwner({chatId:o.chat,userId:o.user})));
program.command('group-post-set').description('Set who can send messages in a group.').requiredOption('--chat <id>').requiredOption('--mode <mode>','anyone, admin or whitelist')
  .option('--add-user <id>','repeatable user ID',collect,[]).option('--remove-user <id>','repeatable user ID',collect,[])
  .action(async o=>output(await (await groups()).setPost({chatId:o.chat,mode:o.mode,addUsers:o.addUser,removeUsers:o.removeUser})));
program.command('group-join-history').description('Read group join and leave history.').requiredOption('--chat <id>').option('--cursor <cursor>').option('--limit <number>','page size','20')
  .action(async o=>output(await (await groups()).history({chatId:o.chat,cursor:o.cursor,count:Number(o.limit)})));

program.command('group-create').description('Create a group as the user.')
  .requiredOption('--name <name>', 'group name')
  .option('--description <text>', 'group description')
  .option('--member <id>', 'numeric user or bot ID; repeatable', collect, [])
  .option('--allow-member-removal', 'allow ordinary members to remove invited bots')
  .action(async options => output(await (await client()).createGroup({
    name: options.name, description: options.description, memberIds: options.member,
    protectBots: !options.allowMemberRemoval,
  })));

program.command('group-update').description('Change a group name or description.')
  .requiredOption('--chat <id>', 'numeric group ID')
  .option('--name <name>', 'new group name')
  .option('--description <text>', 'new group description; use an empty string to clear it')
  .action(async options => output(await (await client()).updateGroup({
    chatId: options.chat, name: options.name, description: options.description,
  })));

program.command('group-dissolve').description('Dissolve a group as its owner.')
  .requiredOption('--chat <id>', 'numeric group ID')
  .action(async options => output(await (await client()).dissolveGroup(options.chat)));

program.command('group-invite').description('Invite users or bots once; verify membership separately.')
  .requiredOption('--chat <id>', 'numeric group ID')
  .requiredOption('--member <id>', 'numeric user or bot ID; repeatable', collect, [])
  .option('--allow-member-removal', 'allow ordinary members to remove invited bots')
  .action(async options => output(await (await client()).invite({
    chatId: options.chat, memberIds: options.member, protectBots: !options.allowMemberRemoval,
  })));

program.command('group-bot-info').description('Read a bot’s removal protection in a group.')
  .requiredOption('--chat <id>', 'numeric group ID')
  .requiredOption('--bot <id>', 'numeric bot ID')
  .action(async options => output(await (await client()).botProtection({ chatId: options.chat, botId: options.bot })));

program.command('group-bot-protection').description('Change a bot’s removal protection in a group.')
  .requiredOption('--chat <id>', 'numeric group ID')
  .requiredOption('--bot <id>', 'numeric bot ID')
  .option('--allow-member-removal', 'allow ordinary members to remove this bot')
  .action(async options => output(await (await client()).setBotProtection({
    chatId: options.chat, botId: options.bot, enabled: !options.allowMemberRemoval,
  })));

program.command('group-members').description('Read one page of group members.')
  .requiredOption('--chat <id>', 'numeric group ID')
  .option('--cursor <number>', 'page cursor')
  .option('--offset <value>', 'page offset')
  .option('--limit <number>', 'page size, 1 to 200', '100')
  .action(async options => output(await (await client()).members({
    chatId: options.chat, cursor: options.cursor, offset: options.offset, limit: Number(options.limit),
  })));

try {
  await program.parseAsync(process.argv);
  if (!process.argv.slice(2).length) program.help();
} catch (error) {
  if (error instanceof CommanderError && error.exitCode === 0) process.exit(0);
  const safe = error instanceof FeishuError
    ? { code: error.code, message: error.message, ...error.details }
    : { code: 'CLI_ERROR', message: 'The command could not be completed.' };
  process.stderr.write(`${JSON.stringify({ ok: false, error: safe })}\n`);
  process.exitCode = 1;
}
