import test from 'node:test';
import assert from 'node:assert/strict';
import { Meetings } from '../src/meetings.js';

function fixture() {
  const calls = [], meetingId = '7000000000000000001';
  const run = async (binary, args, options) => {
    calls.push({ binary, args, options });
    if (args[0] === 'whoami') return { stdout: JSON.stringify({ available: true, identity: 'user', onBehalfOf: { userName: 'User', openId: 'ou_abc' } }) };
    if (args[0] === 'vc' && args[1] === '+search') return { stdout: JSON.stringify({ ok: true, data: { items: [{ id: meetingId }], has_more: false } }) };
    if (args[0] === 'vc' && args[1] === '+detail') return { stdout: JSON.stringify({ ok: true, data: { meetings: [{ meeting_id: meetingId, note_id: 'note-1', minute_token: 'minute-1' }] } }) };
    if (args[0] === 'note') return { stdout: JSON.stringify({ ok: true, data: { note: { note_doc_token: 'doc-1' } } }) };
    if (args[0] === 'docs') return { stdout: JSON.stringify({ ok: true, data: { document: { content: '# Summary' } } }) };
    if (args[0] === 'minutes') throw { stderr: JSON.stringify({ ok: false, error: { message: 'scope missing', missing_scopes: ['minutes:minutes.basic:read'] } }) };
    throw Error('unexpected operation');
  };
  return { meetings: new Meetings({ run }), calls, meetingId };
}

test('meeting search uses explicit user identity and participant filter for the provider account', async () => {
  const f = fixture(); const result = await f.meetings.search({ mine: true, start: '2026-11-27' });
  assert.equal(result.source.provider, 'lark-cli');
  const search = f.calls.find(c => c.args[1] === '+search');
  assert.equal(search.binary, 'lark-cli');
  assert.deepEqual(search.args.slice(search.args.indexOf('--participant-ids'), search.args.indexOf('--participant-ids') + 2), ['--participant-ids', 'ou_abc']);
  assert.deepEqual(search.args.slice(search.args.indexOf('--as'), search.args.indexOf('--as') + 2), ['--as', 'user']);
  await assert.rejects(f.meetings.search({ mine: true, participantIds: 'ou_other' }), { code: 'INVALID_ARGUMENT' });
});

test('meeting note follows meeting ID to note ID to the documented source document', async () => {
  const f = fixture(); const result = await f.meetings.note(f.meetingId);
  assert.equal(result.document.content, '# Summary');
  assert.ok(f.calls.some(c => c.args[0] === 'note' && c.args.includes('note-1')));
  assert.ok(f.calls.some(c => c.args[0] === 'docs' && c.args.includes('doc-1')));
  assert.ok(f.calls.every(c => !c.args.includes('bot')));
  await assert.rejects(f.meetings.note('123456789'), { code: 'INVALID_ARGUMENT' });
});

test('missing minutes authorization is reported without switching identity or logging raw output', async () => {
  const f = fixture();
  await assert.rejects(f.meetings.minutes(f.meetingId), e => {
    assert.equal(e.code, 'MEETING_PROVIDER_ERROR');
    assert.deepEqual(e.details.missingScopes, ['minutes:minutes.basic:read']);
    return true;
  });
  assert.equal(f.calls.filter(c => c.args[0] === 'minutes').length, 1);
  assert.ok(f.calls.every(c => !c.args.includes('bot')));
});

test('provider absence is reported explicitly', async () => {
  const m = new Meetings({ run: async () => { const e = new Error('missing'); e.code = 'ENOENT'; throw e; } });
  await assert.rejects(m.identity(), { code: 'MEETING_PROVIDER_UNAVAILABLE' });
});
