import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FeishuError } from './errors.js';

const exec = promisify(execFile);

export class Meetings {
  constructor({ run = exec } = {}) { this.run = run; }

  async invoke(args) {
    let result;
    try {
      result = await this.run('lark-cli', args, { timeout: 30000, maxBuffer: 12 * 1024 * 1024,
        env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } });
    } catch (error) {
      if (error.code === 'ENOENT') throw new FeishuError('MEETING_PROVIDER_UNAVAILABLE', 'Meeting queries require the optional lark-cli executable.');
      let parsed; try { parsed = JSON.parse(String(error.stderr || error.stdout || '')); } catch { /* do not expose raw subprocess output */ }
      const upstream = parsed?.error;
      throw new FeishuError('MEETING_PROVIDER_ERROR', upstream?.message || 'The meeting provider request failed.', {
        ...(upstream?.code != null ? { providerCode: upstream.code } : {}),
        ...(Array.isArray(upstream?.missing_scopes) ? { missingScopes: upstream.missing_scopes } : {}),
      });
    }
    let parsed; try { parsed = JSON.parse(result.stdout); }
    catch { throw new FeishuError('MEETING_PROVIDER_ERROR', 'The meeting provider returned invalid JSON.'); }
    if (parsed.ok !== true && args[0] !== 'whoami') {
      throw new FeishuError('MEETING_PROVIDER_ERROR', parsed.error?.message || 'The meeting provider request failed.');
    }
    return parsed;
  }

  async identity() {
    const p = await this.invoke(['whoami', '--as', 'user']);
    if (p.available !== true || p.identity !== 'user') throw new FeishuError('MEETING_IDENTITY_UNAVAILABLE', 'The official meeting provider has no available user identity.');
    return { provider: 'lark-cli', identity: 'user', name: p.onBehalfOf?.userName || null, openId: p.onBehalfOf?.openId || null };
  }

  async search({ query, start, end, mine = false, participantIds, organizerIds, pageSize, pageToken } = {}) {
    const account = await this.identity();
    if (mine && participantIds) throw new FeishuError('INVALID_ARGUMENT', 'Use --mine or --participant-ids, not both.');
    const participants = mine ? account.openId : participantIds;
    if (mine && !participants) throw new FeishuError('MEETING_IDENTITY_UNAVAILABLE', 'The meeting provider did not return the current user ID.');
    if (![query, start, end, participants, organizerIds].some(Boolean)) throw new FeishuError('INVALID_ARGUMENT', 'Provide a meeting search filter.');
    const args = ['vc', '+search', '--as', 'user', '--format', 'json'];
    for (const [flag, value] of [['--query', query], ['--start', start], ['--end', end], ['--participant-ids', participants],
      ['--organizer-ids', organizerIds], ['--page-size', pageSize], ['--page-token', pageToken]]) {
      if (value != null && value !== '') args.push(flag, String(value));
    }
    const response = await this.invoke(args);
    return { source: account, data: response.data, ...(response.meta ? { meta: response.meta } : {}) };
  }

  async meeting(meetingId) {
    if (!/^\d{10,20}$/.test(meetingId || '')) throw new FeishuError('INVALID_ARGUMENT', 'Use the long meeting ID from meeting-search, not the 9-digit meeting number.');
    const p = await this.invoke(['vc', '+detail', '--meeting-ids', meetingId, '--as', 'user', '--format', 'json']);
    const meeting = p.data?.meetings?.find(x => x.meeting_id === meetingId);
    if (!meeting) throw new FeishuError('NOT_FOUND', 'The requested meeting was not returned.');
    return meeting;
  }

  async detail(meetingId) { const account = await this.identity(); return { source: account, meeting: await this.meeting(meetingId) }; }

  async note(meetingId) {
    const account = await this.identity(), meeting = await this.meeting(meetingId);
    if (!meeting.note_id) throw new FeishuError('MEETING_NOTE_UNAVAILABLE', 'This meeting has no available AI note.', { meetingId });
    const note = await this.invoke(['note', '+detail', '--note-id', meeting.note_id, '--as', 'user', '--format', 'json']);
    const doc = note.data?.note?.note_doc_token;
    if (!doc) throw new FeishuError('MEETING_NOTE_UNAVAILABLE', 'The meeting note has no readable document.', { meetingId });
    const document = await this.invoke(['docs', '+fetch', '--doc', doc, '--doc-format', 'markdown', '--as', 'user']);
    return { source: account, meeting, note: note.data.note, document: document.data?.document };
  }

  async minutes(meetingId) {
    const account = await this.identity(), meeting = await this.meeting(meetingId);
    if (!meeting.minute_token) throw new FeishuError('MEETING_MINUTES_UNAVAILABLE', 'This meeting has no linked recording minutes.', { meetingId });
    const p = await this.invoke(['minutes', '+detail', '--minute-tokens', meeting.minute_token, '--summary', '--todo', '--chapter', '--as', 'user', '--format', 'json']);
    return { source: account, meeting, data: p.data };
  }
}
