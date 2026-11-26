import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { FeishuError } from './errors.js';

function cookieFromDocument(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return trimmed;
  let document;
  try {
    document = JSON.parse(trimmed);
  } catch {
    throw new FeishuError('CREDENTIALS_INVALID', 'The credentials file is not valid JSON.');
  }
  if (document?.profiles && document?.active) {
    return document.profiles[document.active]?.LARK_COOKIE;
  }
  return document?.LARK_COOKIE;
}

async function readCookieFile(path, required) {
  try {
    return cookieFromDocument(await readFile(path, 'utf8'));
  } catch (error) {
    if (error instanceof FeishuError) throw error;
    if (error.code === 'ENOENT' && !required) return undefined;
    throw new FeishuError('CREDENTIALS_UNAVAILABLE', 'Cannot read the credentials file.');
  }
}

export async function loadCookie({ file, env = process.env, home = homedir() } = {}) {
  let cookie;
  if (file) {
    cookie = await readCookieFile(file, true);
  } else if (env.FEISHU_USER_COOKIE || env.LARK_COOKIE) {
    cookie = env.FEISHU_USER_COOKIE || env.LARK_COOKIE;
  } else {
    const dir = env.FEISHU_USER_PLUGIN_CREDENTIALS_DIR || join(home, '.feishu-user-plugin');
    cookie = await readCookieFile(join(dir, 'credentials.json'), false);
  }
  if (typeof cookie !== 'string' || !cookie.trim() || cookie === 'SETUP_NEEDED') {
    throw new FeishuError('CREDENTIALS_UNAVAILABLE', 'No usable user Cookie is configured.');
  }
  if (/[^\x00-\xff]/.test(cookie) || /[\r\n]/.test(cookie)) {
    throw new FeishuError('CREDENTIALS_INVALID', 'The Cookie contains invalid header characters.');
  }
  return cookie.trim();
}
