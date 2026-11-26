#!/usr/bin/env node
import { Command, CommanderError } from 'commander';
import { loadCookie } from '../src/credentials.js';
import { Gateway } from '../src/gateway.js';
import { FeishuUserClient } from '../src/client.js';
import { FeishuError } from '../src/errors.js';

const program = new Command();
program.name('feishu-user').description('Operate Feishu as the logged-in user.').version('0.1.0');
program.option('--credentials-file <path>', 'read a Cookie file or compatible credentials.json');
program.exitOverride();

const collect = (value, previous) => [...previous, value];
const output = value => process.stdout.write(`${JSON.stringify({ ok: true, ...value }, null, 2)}\n`);

async function client() {
  const cookie = await loadCookie({ file: program.opts().credentialsFile });
  return new FeishuUserClient(new Gateway({ cookie }));
}

program.command('status').description('Check the current user login.')
  .action(async () => output(await (await client()).status()));

program.command('search').description('Search users, bots and groups.')
  .requiredOption('--query <text>', 'search text')
  .action(async options => output(await (await client()).search(options.query)));

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
  .action(async options => output(await (await client()).history({
    chatId: options.chat, limit: Number(options.limit),
    ...(options.start != null ? { start: Number(options.start) } : {}),
  })));

program.command('send').description('Send text once as the user; delivery remains unconfirmed.')
  .requiredOption('--chat <id>', 'numeric chat ID')
  .requiredOption('--text <text>', 'message text')
  .option('--mention <id:name>', 'mention a numeric user or bot ID; repeatable', collect, [])
  .action(async options => {
    const mentions = options.mention.map(value => {
      const colon = value.indexOf(':');
      if (colon < 1) throw new FeishuError('INVALID_ARGUMENT', 'A mention must use id:name.');
      return { id: value.slice(0, colon), name: value.slice(colon + 1) };
    });
    output(await (await client()).send({ chatId: options.chat, text: options.text, mentions }));
  });

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
