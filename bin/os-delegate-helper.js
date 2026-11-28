// This helper is launched once by a protected, environment-clearing sudo wrapper.
// The policy location is fixed relative to this protected installation, never to caller input.
import { fileURLToPath } from 'node:url';
import { loadDelegateConfig, serveOne } from '../src/os-delegate.js';
import { loadCookie } from '../src/credentials.js';
import { Gateway } from '../src/gateway.js';
import { LarkMateClient } from '../src/client.js';
import { SessionControls } from '../src/session-controls.js';
import { Minutes } from '../src/minutes.js';
import { FeishuError } from '../src/errors.js';
import { SidebarFilters } from '../src/sidebar-filters.js';
import { FeedGroups } from '../src/feed-groups.js';
import { Tasks } from '../src/tasks.js';
import { Calendar } from '../src/calendar.js';
import { GroupManagement, groupSettingsSchema } from '../src/group-management.js';

try {
  const caller = process.env.SUDO_UID, owner = process.getuid?.();
  if (!Number.isInteger(owner) || typeof caller !== 'string' || !/^[1-9]\d*$/.test(caller) || !Number.isSafeInteger(Number(caller)) || Number(caller) === owner) throw new FeishuError('POLICY_DENIED', 'The operating-system caller identity is unavailable.');
  const config = await loadDelegateConfig(fileURLToPath(new URL('../delegate-policy.json', import.meta.url)), owner);
  const profile = config.users[caller];
  if (!profile) throw new FeishuError('POLICY_DENIED', 'This operating-system user has no delegation profile.');
  let services;
  const getServices = () => services ||= (async () => {
    const gateway = new Gateway({ cookie: await loadCookie({ file: config.credentialsFile }) });
    return { client: new LarkMateClient(gateway), controls: new SessionControls(gateway), minutes: new Minutes(gateway), sidebar: new SidebarFilters(gateway), feeds: new FeedGroups(gateway), tasks: new Tasks(gateway), calendar: new Calendar(gateway), groups: new GroupManagement(gateway) };
  })();
  await serveOne({ input: process.stdin, output: process.stdout, uid: caller, profile, getServices });
} catch (error) {
  const detail = error instanceof FeishuError ? { code: error.code, message: error.message } : { code: 'DELEGATE_ERROR', message: 'Cannot start the delegated operation.' };
  process.stdout.write(JSON.stringify({ ok: false, error: detail }) + '\n');
  process.exitCode = 1;
}
