import { FeishuError } from './errors.js';

export const SIDEBAR_FILTERS = Object.freeze({ at_me: 1, unread: 2, delayed: 3, docs: 4, p2p: 5, group: 6, bot: 7,
  help_desk: 8, topic_group: 9, done: 10, crypto_chat: 11, muted: 12, labels: 13, team: 14, marked: 15,
  threads: 16, unread_over_days: 17, calendar_meetings: 18, instant_meetings: 19, messages: 25, expired_fold: 26 });
const byId = Object.fromEntries(Object.entries(SIDEBAR_FILTERS).map(([name, id]) => [id, name]));
const rules = { always: 1, new: 2, never: 3 };
const msgTypes = { all: 1, at_me: 2, at_all: 3, star_contacts: 4 };
const invalid = () => { throw new FeishuError('INVALID_ARGUMENT', 'Invalid sidebar filter or settings.'); };
const idFor = input => typeof input === 'string' && Object.hasOwn(SIDEBAR_FILTERS, input) ? SIDEBAR_FILTERS[input] : /^\d+$/.test(String(input)) && Number(input) > 0 && Number(input) <= 2147483647 ? Number(input) : invalid();

export class SidebarFilters {
  constructor(gateway) { this.gateway = gateway; }
  async raw() {
    const res = await this.gateway.call(7022, 'PullSidebarFilterSettingRequest', { needAllFilters: true }, { operation: 'sidebar-list' });
    if (!res.packet.payload?.length) throw new FeishuError('INVALID_RESPONSE', 'No sidebar settings were returned.');
    let p; try { p = this.gateway.decode('PullSidebarFilterSettingResponse', res.packet.payload); } catch { throw new FeishuError('INVALID_RESPONSE', 'Sidebar settings were unreadable.'); }
    if (!p.setting || !Array.isArray(p.setting.usedFilters)) throw new FeishuError('INVALID_RESPONSE', 'Sidebar filter settings were absent.');
    return p;
  }
  view(p) {
    const used = p.setting.usedFilters.map(x => x.systemFilter);
    const available = [...new Set([...used, ...p.allFilters.map(x => x.systemFilter)])].filter(x => Number.isInteger(x) && x > 0);
    const display = p.setting.filterDisplayFeedRule || {};
    return { items: available.map(id => ({ id, name: byId[id] || `unknown_${id}`, shown: used.includes(id),
      position: used.includes(id) ? used.indexOf(id) + 1 : null,
      displayRule: display[id] ? { mainRule: display[id].mainRule ?? null, msgTypes: display[id].msgTypes || [] } : null })),
      showFilter: p.setting.showFilter ?? null, showMuteFilter: p.setting.showMuteFilter ?? null,
      showAtAllInAtFilter: p.setting.showAtAllInAtFilter ?? null, flagSortingRule: p.setting.flagSortingRule ?? null, commonlyUsedFilters: p.setting.commonlyUsedFilters?.map(x => x.systemFilter) || [], version: p.setting.version?.toString() ?? null };
  }
  async list() { return this.view(await this.raw()); }
  async set({ filter, visibility, position, display, messageTypes, atAll, showFilter, showMuteFilter, flagSortingRule, commonlyUsedFilters }) {
    const id = idFor(filter);
    if (visibility != null && !['show', 'hide'].includes(visibility)) invalid();
    if (position != null && (!Number.isInteger(position) || position < 1)) invalid();
    if (display != null && !Object.hasOwn(rules, display)) invalid();
    if (messageTypes != null && (!Array.isArray(messageTypes) || messageTypes.some(x => !Object.hasOwn(msgTypes, x)) || new Set(messageTypes).size !== messageTypes.length)) invalid();
    if (messageTypes != null && display == null) invalid();
    if (atAll != null && typeof atAll !== 'boolean') invalid();
    if (atAll != null && id !== SIDEBAR_FILTERS.at_me) invalid();
    if ([showFilter, showMuteFilter].some(x => x != null && typeof x !== 'boolean')) invalid();
    if (flagSortingRule != null && (!Number.isInteger(flagSortingRule) || flagSortingRule < 0 || flagSortingRule > 2147483647)) invalid();
    if (commonlyUsedFilters != null && (!Array.isArray(commonlyUsedFilters) || new Set(commonlyUsedFilters.map(idFor)).size !== commonlyUsedFilters.length)) invalid();
    if (visibility == null && position == null && display == null && atAll == null && showFilter == null && showMuteFilter == null && flagSortingRule == null && commonlyUsedFilters == null) invalid();
    const before = await this.raw(), available = new Set([...before.allFilters, ...before.setting.usedFilters].map(x => x.systemFilter));
    if (!available.has(id)) invalid();
    let ids = before.setting.usedFilters.map(x => x.systemFilter);
    if (new Set(ids).size !== ids.length) throw new FeishuError('INVALID_RESPONSE', 'Sidebar order contains duplicates.');
    const fields = [], request = { clientSupportVersion: before.setting.version?.toString() || '0' };
    if (visibility != null || position != null) {
      if (visibility === 'hide') ids = ids.filter(x => x !== id);
      if (visibility === 'show' && !ids.includes(id)) ids.push(id);
      if (position != null) {
        if (!ids.includes(id) || position > ids.length) invalid();
        ids = ids.filter(x => x !== id); ids.splice(position - 1, 0, id);
      }
      request.usedFilters = ids.map(systemFilter => ({ systemFilter })); fields.push(2);
    }
    let selectedMessageTypes;
    if (display != null) {
      selectedMessageTypes = messageTypes ? messageTypes.map(x => msgTypes[x]) : [...(before.setting.filterDisplayFeedRule?.[id]?.msgTypes || [])];
      request.filterDisplayFeedRule = { ...before.setting.filterDisplayFeedRule,
        [id]: { mainRule: rules[display], msgTypes: selectedMessageTypes } }; fields.push(8);
    }
    if (atAll != null) { request.showAtAllInAtFilter = atAll; fields.push(5); }
    if (showFilter != null) { request.showFilter = showFilter; fields.push(1); }
    if (showMuteFilter != null) { request.showMuteFilter = showMuteFilter; fields.push(3); }
    if (flagSortingRule != null) { request.flagSortingRule = flagSortingRule; fields.push(7); }
    if (commonlyUsedFilters != null) { const common = commonlyUsedFilters.map(idFor); if (common.some(x => !available.has(x))) invalid(); request.commonlyUsedFilters = common.map(systemFilter => ({ systemFilter })); fields.push(6); }
    request.updateFields = fields;
    await this.gateway.call(7023, 'PutSidebarFilterSettingRequest', request, { mutating: true, operation: 'sidebar-set' });
    let after; try { after = await this.raw(); } catch { return { status: 'submitted_unconfirmed', filter: id }; }
    const view = this.view(after), item = view.items.find(x => x.id === id);
    const orderOk = !fields.includes(2) || JSON.stringify(after.setting.usedFilters.map(x => x.systemFilter)) === JSON.stringify(ids);
    const displayOk = display == null || (item?.displayRule?.mainRule === rules[display] && JSON.stringify(item.displayRule.msgTypes) === JSON.stringify(selectedMessageTypes));
    const atAllOk = atAll == null || view.showAtAllInAtFilter === atAll;
    const extraOk = (showFilter == null || view.showFilter === showFilter) && (showMuteFilter == null || view.showMuteFilter === showMuteFilter) && (flagSortingRule == null || view.flagSortingRule === flagSortingRule) && (commonlyUsedFilters == null || JSON.stringify(view.commonlyUsedFilters) === JSON.stringify(commonlyUsedFilters.map(idFor)));
    return { status: orderOk && displayOk && atAllOk && extraOk ? 'updated' : 'submitted_unconfirmed', filter: item };
  }
}
