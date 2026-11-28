#!/usr/bin/env node
import { Command, CommanderError } from 'commander';
import { loadCookie } from '../src/credentials.js';
import { Gateway } from '../src/gateway.js';
import { LarkMateClient } from '../src/client.js';
import { SessionControls } from '../src/session-controls.js';
import { Minutes, formatTranscript } from '../src/minutes.js';
import { writeFile } from 'node:fs/promises';
import { FeishuError } from '../src/errors.js';
import { exportMessages } from '../src/export-messages.js';
import { brokerCall, brokerCommands, brokerProxy, createBrokerToken, loadBrokerToken, loadPolicy, startBroker } from '../src/agent-broker.js';
import { callOsDelegate, osDelegateProxy } from '../src/os-delegate-client.js';

const program = new Command();
program.name('larkmate').description('Operate Feishu as the logged-in user.').version('0.1.10');
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
      return { client: new LarkMateClient(gateway), controls: new SessionControls(gateway), minutes: new Minutes(gateway) };
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

program.command('pinned').description('List pinned conversations.').action(async () => output(await (await controls()).pinned()));
program.command('marked').description('List conversations marked with a flag.').action(async () => output(await (await controls()).marked()));
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
