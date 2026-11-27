import { open } from 'node:fs/promises';
import { FeishuError } from './errors.js';

// Stream newest pages first, so even very large conversations need only one page in memory.
export async function exportMessages(client, { chatId, output, format = 'markdown', sender, query, after, before, start, maxPages, limit = 100 } = {}) {
  if (typeof output !== 'string' || !output) throw new FeishuError('INVALID_ARGUMENT', 'An output path is required.');
  if (!['markdown', 'jsonl'].includes(format)) throw new FeishuError('INVALID_ARGUMENT', 'Format must be markdown or jsonl.');
  if (maxPages != null && (!Number.isSafeInteger(maxPages) || maxPages < 1)) throw new FeishuError('INVALID_ARGUMENT', 'max-pages must be a positive integer.');
  // Validate all scan parameters before creating an output file.
  if (!/^\d+$/.test(chatId || '') || (sender && !/^\d+$/.test(sender))) throw new FeishuError('INVALID_ARGUMENT', 'Chat and sender IDs must be numeric.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new FeishuError('INVALID_ARGUMENT', 'limit must be between 1 and 100.');
  if (start != null && (!Number.isInteger(start) || start < 1 || start + limit - 1 > 2147483647)) throw new FeishuError('INVALID_ARGUMENT', 'start and limit must fit the position range.');
  if ([after, before].some(value => value != null && (!Number.isSafeInteger(value) || value < 0)) || (after != null && before != null && after > before)) throw new FeishuError('INVALID_ARGUMENT', 'Invalid time range.');
  let handle;
  try { handle = await open(output, 'wx', 0o600); }
  catch (error) { throw new FeishuError('EXPORT_WRITE_FAILED', error.code === 'EEXIST' ? 'Output file already exists; choose a new path.' : 'Could not create the output file.'); }
  const metadata = { chatId, sender: sender || null, query: query || null, after: after ?? null, before: before ?? null, start: start ?? null, order: 'newest_first' };
  let next = start, pages = 0, count = 0, scannedPositions = 0, omittedPositions = 0, missingTimestamps = 0;
  try {
    await handle.writeFile(format === 'jsonl' ? `${JSON.stringify({ kind: 'metadata', ...metadata })}\n` : `# 消息导出\n\n筛选条件：\`${JSON.stringify(metadata)}\`\n\n`);
    do {
      const page = await client.historyPages({ chatId, limit, start: next, pages: 1, sender, query, after, before });
      pages++;
      scannedPositions += page.scannedPositions;
      omittedPositions += page.omittedPositions;
      missingTimestamps += page.missingTimestamps;
      const chunks = [];
      for (const item of page.items.reverse()) {
        count++;
        if (format === 'jsonl') chunks.push(`${JSON.stringify({ kind: 'message', ...item })}\n`);
        else {
          const timestamp = item.createTime != null && Number.isFinite(Number(item.createTime)) && Math.abs(Number(item.createTime)) < 8640000000000
            ? new Date(Number(item.createTime) * 1000).toISOString() : '时间未知';
          const body = item.text ?? (item.resource ? JSON.stringify(item.resource) : `[无法解析的消息类型 ${item.type}]`);
          chunks.push(`## ${timestamp} · 发送者 ${item.senderId || '未知'}\n\n消息 ID：${item.id || '未知'} · 位置：${item.position}\n\n${String(body).split('\n').map(line => `> ${line}`).join('\n')}\n\n`);
        }
      }
      if (chunks.length) await handle.writeFile(chunks.join(''));
      next = page.nextStart;
      limit = page.nextLimit;
    } while (next != null && (maxPages == null || pages < maxPages));
    const summary = { output, format, count, pages, scannedPositions, omittedPositions, missingTimestamps, reachedBeginning: next == null, nextStart: next ?? null, nextLimit: limit ?? null };
    await handle.writeFile(format === 'jsonl' ? `${JSON.stringify({ kind: 'summary', ...summary })}\n` : `---\n\n导出统计：\`${JSON.stringify(summary)}\`\n`);
    return summary;
  } catch (error) {
    // Keep the partial file so users do not lose a lengthy export; it has no completion footer.
    throw new FeishuError('EXPORT_INCOMPLETE', 'Export stopped; the output file is incomplete.', { output, pages, cause: error.code || 'WRITE_FAILED' });
  } finally { await handle.close(); }
}
