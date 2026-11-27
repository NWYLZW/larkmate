import test from 'node:test';
import assert from 'node:assert/strict';
import { Minutes, minuteToken, formatTranscript } from '../src/minutes.js';

const token = 'obcn12345678901234567890';
function fixture(override = {}) {
  const calls = [];
  const responses = {
    'space/list': { list: [{ topic: 'Meeting', share_time: 12345 }], has_more: true, timestamp: '99999' },
    'subtitles/paragraph-ids': { total: 2, list: [{ pid: 'p1' }, { pid: 'p2' }], has_more: false },
    subtitles_v2: { paragraphs: [
      { pid: 'p1', sentences: [{ sid: 's1', start_time: '13000', contents: [{ content: 'Hello' }] }] },
      { pid: 'p2', sentences: [{ sid: 's2', start_time: '61000', contents: [{ content: 'World' }] }] },
    ], has_more: false },
    speakers: { paragraph_to_speaker: { s1: 'u1', s2: 'u2' }, speaker_info_map: { u1: { user_name: 'A' }, u2: { user_name: 'B' } } },
    'permission/apply/info': { owner_user_id: '123', owner_name: 'Owner', allow_apply: true, not_allowed_tips: '' },
    ...override,
  };
  const gateway = { timeoutMs: 1000, baseHeaders: () => ({ cookie: 'secret' }), fetchImpl: async (url, options) => {
    calls.push({ url, options }); const path = url.pathname.replace('/minutes/api/', '');
    return new Response(JSON.stringify({ code: 0, data: responses[path] }), { status: 200 });
  } };
  return { minutes: new Minutes(gateway), calls };
}

test('transcript is complete and export options independently omit metadata', async () => {
  const f = fixture(); const result = await f.minutes.transcript(`https://example.feishu.cn/minutes/${token}`);
  assert.equal(result.total, 2);
  assert.equal(formatTranscript(result.entries), '[00:13] A\nHello\n\n[01:01] B\nWorld\n');
  assert.equal(formatTranscript(result.entries, { speakers: false, timestamps: false }), 'Hello\n\nWorld\n');
  assert.equal(formatTranscript(result.entries, { speakers: false }), '[00:13]\nHello\n\n[01:01]\nWorld\n');
  assert.equal(formatTranscript(result.entries, { timestamps: false }), 'A\nHello\n\nB\nWorld\n');
  assert.ok(f.calls.every(c => c.url.hostname === 'meetings.feishu.cn' && c.options.redirect === 'manual'));
});

test('refuses to export incomplete transcripts', async () => {
  const f = fixture({ subtitles_v2: { paragraphs: [], has_more: true } });
  await assert.rejects(f.minutes.transcript(token), { code: 'TRANSCRIPT_INCOMPLETE' });
});

test('list cursor, input validation and access failures', async () => {
  const f = fixture(); const page = await f.minutes.list({ limit: 2, cursor: '42' });
  assert.equal(page.nextCursor, '12345'); assert.equal(f.calls[0].url.searchParams.get('timestamp'), '42');
  const info = await f.minutes.accessInfo(token); assert.equal(info.allowApply, true); assert.equal(info.ownerName, 'Owner');
  assert.ok(f.calls.every(c => !c.options.method || c.options.method === 'GET'));
  assert.throws(() => minuteToken('https://evil.example/bad'), { code: 'INVALID_ARGUMENT' });
  f.minutes.gateway.fetchImpl = async () => new Response('', { status: 403 });
  await assert.rejects(f.minutes.transcript(token), { code: 'MINUTES_ACCESS_DENIED' });
});
