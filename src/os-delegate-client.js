import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { once } from 'node:events';
import { FeishuError } from './errors.js';
import { brokerCommands } from './agent-broker.js';

const MAX_FILE = 100 * 1024 * 1024, MAX_JSON = 32 * 1024 * 1024;
const fail = (code, message) => { throw new FeishuError(code, message); };

export async function callOsDelegate({ owner, launcher, request, inputPath, outputPath, spawnImpl = spawn }) {
  if (typeof owner !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(owner) || typeof launcher !== 'string' || !isAbsolute(launcher)) fail('DELEGATE_CONFIG_INVALID', 'A valid owner and absolute protected launcher are required.');
  let source;
  if (inputPath != null) {
    try { source = await open(inputPath, 'r'); } catch { fail('FILE_UNAVAILABLE', 'Cannot open the file.'); }
  }
  try {
    let meta = request;
    if (source) {
      const s = await source.stat();
      if (!s.isFile() || s.size < 1 || s.size > MAX_FILE) fail('FILE_INVALID', 'Use a regular, non-empty file up to 100 MiB.');
      meta = { ...request, fileName: basename(inputPath), size: s.size };
    }
    const child = spawnImpl('/usr/bin/sudo', ['-n', '-u', owner, '--', launcher], { stdio: ['pipe', 'pipe', 'ignore'] });
    const mutating = brokerCommands().find(x => x.command === request.command)?.mutating === true;
    const unavailable = () => new FeishuError(mutating ? 'EFFECT_UNKNOWN' : 'DELEGATE_UNAVAILABLE', mutating ? 'The delegated operation could not be confirmed; inspect before retrying.' : 'Cannot run the OS delegate.');
    let spawnError;
    child.on('error', error => { spawnError = error; });
    child.stdin.on('error', () => {});
    const writing = (async () => {
      try {
        child.stdin.write(JSON.stringify(meta) + '\n');
        if (source) {
          for await (const chunk of source.createReadStream({ autoClose: false })) if (!child.stdin.write(chunk)) await once(child.stdin, 'drain');
        }
        child.stdin.end();
      } catch { child.stdin.destroy(); }
    })();
    let header = Buffer.alloc(0), parsed, bytes = 0, output;
    try {
      for await (const chunk of child.stdout) {
        let data = chunk;
        if (!parsed) {
          header = Buffer.concat([header, data]);
          const end = header.indexOf(10);
          if (end < 0) { if (header.length > MAX_JSON) throw unavailable(); continue; }
          try { parsed = JSON.parse(header.subarray(0, end).toString('utf8')); } catch { throw unavailable(); }
          data = header.subarray(end + 1); header = null;
          if (!parsed.ok) { const error = parsed.error || {}; throw new FeishuError(error.code || 'DELEGATE_ERROR', error.message || 'Delegated operation failed.'); }
          if (outputPath != null) {
            if (!Number.isSafeInteger(parsed.size) || parsed.size < 0 || parsed.size > MAX_FILE) throw unavailable();
            try { output = await open(outputPath, 'wx', 0o600); }
            catch (error) { throw new FeishuError('DOWNLOAD_WRITE_FAILED', error.code === 'EEXIST' ? 'Output file already exists; choose a new path.' : 'Could not create the output file.'); }
          }
        }
        if (outputPath != null) {
          bytes += data.length;
          if (bytes > parsed.size) throw new Error('too large');
          if (data.length) await output.writeFile(data);
        } else if (data.length) throw unavailable();
      }
      await writing;
      if (spawnError || !parsed) throw unavailable();
      if (outputPath != null) {
        if (bytes !== parsed.size) fail('DOWNLOAD_INCOMPLETE', 'The downloaded file is incomplete.');
        return { output: outputPath, bytes, messageId: request.args[0].messageId };
      }
      return parsed.data;
    } catch (error) {
      child.kill('SIGTERM');
      if (output && !(error instanceof FeishuError)) throw new FeishuError('DOWNLOAD_INCOMPLETE', 'The downloaded file is incomplete.', { output: outputPath, bytes });
      throw error instanceof FeishuError ? error : unavailable();
    } finally { await output?.close(); }
  } finally { await source?.close(); }
}

export function osDelegateProxy(owner, launcher, service, getCommand) {
  return new Proxy({}, { get(_target, method) {
    if (method === 'then' || typeof method !== 'string') return undefined;
    return (...args) => {
      const command = getCommand();
      if (service === 'client' && ['sendFile', 'sendImage', 'setGroupAvatar'].includes(method)) {
        const { chatId, path } = args[0];
        return callOsDelegate({ owner, launcher, request: { command, service: 'files', method: 'upload', args: [{ chatId }] }, inputPath: path });
      }
      if (service === 'client' && method === 'downloadFile') {
        const { chatId, messageId, key, position, output } = args[0];
        if (!Number.isInteger(position) || position < 1) fail('INVALID_ARGUMENT', 'A message --position from history is required by the delegate.');
        return callOsDelegate({ owner, launcher, request: { command, service: 'files', method: 'download', args: [{ chatId, messageId, key, position }] }, outputPath: output });
      }
      return callOsDelegate({ owner, launcher, request: { command, service, method, args } });
    };
  } });
}
