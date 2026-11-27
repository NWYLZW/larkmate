import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { FeishuError } from './errors.js';

export async function loadCookie({ file, env = process.env, home = homedir() } = {}) {
  let cookie = !file && env.LARKMATE_COOKIE;
  if (!cookie) {
    const path = file || join(env.LARKMATE_HOME || join(home, '.larkmate'), 'credentials.json');
    let contents;
    try { contents = await readFile(path, 'utf8'); }
    catch { throw new FeishuError('CREDENTIALS_UNAVAILABLE', 'Cannot read LarkMate credentials.'); }
    try { cookie = JSON.parse(contents).cookie; }
    catch { throw new FeishuError('CREDENTIALS_INVALID', 'Credentials must be JSON with a cookie field.'); }
  }
  if (typeof cookie !== 'string' || !cookie.trim() || cookie === 'SETUP_NEEDED') {
    throw new FeishuError('CREDENTIALS_UNAVAILABLE', 'No usable user Cookie is configured.');
  }
  if (/[^\x00-\xff]/.test(cookie) || /[\r\n]/.test(cookie)) {
    throw new FeishuError('CREDENTIALS_INVALID', 'The Cookie contains invalid header characters.');
  }
  return cookie.trim();
}
