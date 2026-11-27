import { open } from 'node:fs/promises';
import { FeishuError, requireInt64Id, requireText } from './errors.js';

// Uses the same message-scoped access check as the web client; never follows redirects with the Cookie.
export async function downloadFile(gateway, { chatId, messageId, key, output, maxBytes = Infinity }) {
  requireInt64Id(chatId, 'chat ID');
  requireInt64Id(messageId, 'message ID');
  requireText(output, 'output path');
  if (typeof key !== 'string' || !/^[\w.-]{1,200}$/.test(key)) throw new FeishuError('INVALID_ARGUMENT', 'Invalid file key.');
  await gateway.authenticate();
  const url = new URL('/uni_api/download/file', gateway.endpoints.file);
  url.searchParams.set('data', JSON.stringify({ file_key: key, src: {
    scene_type: 1, entity_id: messageId, auth_file_key: '', im_ext: { chat_id: chatId }, ext: {},
  }, ext: {} }));
  const response = await gateway.request(url, { method: 'GET', redirect: 'manual', headers: gateway.baseHeaders() }, { operation: 'download-file' });
  if (response.status !== 200) {
    try { await response.body?.cancel(); } catch { /* The unexpected status is the important error. */ }
    throw new FeishuError('DOWNLOAD_FAILED', 'Feishu did not return a complete file.', { httpStatus: response.status });
  }
  let handle;
  try { handle = await open(output, 'wx', 0o600); }
  catch (error) {
    try { await response.body?.cancel(); } catch { /* Preserve the output error. */ }
    throw new FeishuError('DOWNLOAD_WRITE_FAILED', error.code === 'EEXIST' ? 'Output file already exists; choose a new path.' : 'Could not create the output file.');
  }
  let bytes = 0;
  try {
    if (!response.body) throw new Error('empty response');
    for await (const chunk of response.body) {
      if (bytes + chunk.length > maxBytes) throw new FeishuError('FILE_TOO_LARGE', 'The download exceeds the configured file limit.');
      await handle.writeFile(chunk); bytes += chunk.length;
    }
    const length = response.headers.get('content-length');
    const encoding = response.headers.get('content-encoding');
    if (length && (!encoding || encoding === 'identity') && /^\d+$/.test(length) && BigInt(bytes) !== BigInt(length)) throw new Error('incomplete response');
    return { output, bytes, messageId };
  } catch (error) {
    if (error instanceof FeishuError && error.code === 'FILE_TOO_LARGE') throw error;
    throw new FeishuError('DOWNLOAD_INCOMPLETE', 'The download stopped; the output file is incomplete.', { output, bytes });
  } finally { await handle.close(); }
}
