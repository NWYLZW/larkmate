import { FeishuError } from './errors.js';

const BASE = 'https://meetings.feishu.cn/minutes/api/';

export function minuteToken(value) {
  let token = value;
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
    let url;
    try { url = new URL(value); } catch { /* handled below */ }
    const parts = url?.pathname.split('/').filter(Boolean) || [];
    token = parts[0] === 'minutes' ? parts[1] : '';
  }
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{10,128}$/.test(token)) {
    throw new FeishuError('INVALID_ARGUMENT', 'Use a recording minutes token or URL.');
  }
  return token;
}

function clock(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  const seconds = Math.floor(n / 1000);
  const h = Math.floor(seconds / 3600), m = Math.floor(seconds / 60) % 60, s = seconds % 60;
  return (h ? `${String(h).padStart(2, '0')}:` : '') + `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export class Minutes {
  constructor(gateway) { this.gateway = gateway; }

  async get(path, params = {}) {
    const url = new URL(path, BASE);
    for (const [key, value] of Object.entries(params)) if (value != null) url.searchParams.set(key, String(value));
    let response;
    try {
      response = await this.gateway.fetchImpl(url, { headers: this.gateway.baseHeaders(), redirect: 'manual', signal: AbortSignal.timeout(this.gateway.timeoutMs) });
    } catch { throw new FeishuError('REQUEST_FAILED', 'Could not reach Feishu minutes.'); }
    if (response.status >= 300 && response.status < 400 || response.status === 401) throw new FeishuError('AUTH_FAILED', 'The Cookie is invalid or expired for Feishu minutes.');
    if (response.status === 403) throw new FeishuError('MINUTES_ACCESS_DENIED', 'The current user cannot access this recording.');
    if (!response.ok) throw new FeishuError('MINUTES_REQUEST_FAILED', 'Feishu rejected the minutes request.', { httpStatus: response.status });
    let payload;
    try { payload = await response.json(); } catch { throw new FeishuError('AUTH_FAILED', 'Feishu minutes returned an invalid response; check the Cookie.'); }
    if (payload?.code !== 0) throw new FeishuError('MINUTES_REQUEST_FAILED', 'Feishu could not return the recording data.', { upstreamCode: payload?.code });
    return payload.data;
  }

  async list({ limit = 20, cursor } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new FeishuError('INVALID_ARGUMENT', 'Limit must be between 1 and 100.');
    if (cursor != null && !/^\d{1,20}$/.test(cursor)) throw new FeishuError('INVALID_ARGUMENT', 'Invalid minutes cursor.');
    const page = await this.get('space/list', { size: limit, space_name: '', timestamp: cursor });
    if (!Array.isArray(page?.list)) throw new FeishuError('MINUTES_RESPONSE_INVALID', 'The minutes list response was incomplete.');
    const nextCursor = page.has_more ? String(page.list.at(-1)?.share_time ?? '') : null;
    if (page.has_more && (!/^\d{1,20}$/.test(nextCursor) || nextCursor === cursor)) throw new FeishuError('MINUTES_RESPONSE_INVALID', 'The minutes list did not provide a usable next cursor.');
    return { items: page.list, hasMore: !!page.has_more, nextCursor };
  }

  async accessInfo(value) {
    const result = await this.get('permission/apply/info', { object_token: minuteToken(value), language: 'zh_cn' });
    if (typeof result?.allow_apply !== 'boolean') throw new FeishuError('MINUTES_RESPONSE_INVALID', 'The permission information was incomplete.');
    return { ownerId: result.owner_user_id || null, ownerName: result.owner_name || null, allowApply: result.allow_apply, notAllowedTips: result.not_allowed_tips || null };
  }

  async transcript(value) {
    const token = minuteToken(value), query = { object_token: token, language: 'zh_cn' };
    const ids = await this.get('subtitles/paragraph-ids', { page_size: 10000, page_num: 0, ...query });
    if (!Array.isArray(ids?.list) || !Number.isInteger(Number(ids.total)) || Number(ids.total) < 0) throw new FeishuError('MINUTES_RESPONSE_INVALID', 'The transcript index response was incomplete.');
    const total = Number(ids.total);
    if (!total) throw new FeishuError('TRANSCRIPT_UNAVAILABLE', 'This recording has no available transcript.');
    if (ids.has_more || ids.list.length < total || total > 10000 || !ids.list[0]?.pid) throw new FeishuError('TRANSCRIPT_INCOMPLETE', 'The transcript index is incomplete; no export was written.');
    const [subtitles, speakers] = await Promise.all([
      this.get('subtitles_v2', { paragraph_id: ids.list[0].pid, size: total, translate_lang: 'default', is_fluent: false, filter_speaker: true, ...query }),
      this.get('speakers', { size: 10000, translate_lang: 'default', ...query }),
    ]);
    if (!Array.isArray(subtitles?.paragraphs) || subtitles.has_more || subtitles.paragraphs.length !== total) throw new FeishuError('TRANSCRIPT_INCOMPLETE', 'Feishu returned an incomplete transcript; no export was written.');
    if (!speakers?.paragraph_to_speaker || !speakers?.speaker_info_map) throw new FeishuError('MINUTES_RESPONSE_INVALID', 'Speaker information was incomplete; no export was written.');
    const entries = subtitles.paragraphs.map((p, index) => {
      if (!Array.isArray(p.sentences)) throw new FeishuError('TRANSCRIPT_INCOMPLETE', 'A transcript paragraph was incomplete; no export was written.');
      if (p.pid !== ids.list[index]?.pid || p.sentences.some(s => !Array.isArray(s.contents))) throw new FeishuError('TRANSCRIPT_INCOMPLETE', 'A transcript paragraph was missing or out of order; no export was written.');
      const first = p.sentences[0];
      const speakerId = speakers.paragraph_to_speaker[first?.sid];
      return { speaker: speakers.speaker_info_map[speakerId]?.user_name || null, timestamp: clock(first?.start_time ?? p.start_time), text: p.sentences.map(s => (s.contents || []).map(c => c.content || '').join('')).join('').trim() };
    });
    return { token, entries, total };
  }
}

export function formatTranscript(entries, { speakers = true, timestamps = true, format = 'txt' } = {}) {
  if (!['txt', 'markdown'].includes(format)) throw new FeishuError('INVALID_ARGUMENT', 'Format must be txt or markdown.');
  return entries.filter(e => e.text).map(e => {
    const header = [timestamps && e.timestamp ? `[${e.timestamp}]` : '', speakers ? (e.speaker || '未知发言人') : ''].filter(Boolean).join(' ');
    return header ? `${format === 'markdown' ? `**${header}**` : header}\n${e.text}` : e.text;
  }).join('\n\n') + '\n';
}
