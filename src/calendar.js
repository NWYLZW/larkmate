import { randomUUID } from 'node:crypto';
import rrule from 'rrule';
import { FeishuError } from './errors.js';
const { RRule } = rrule;
const defaultTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const fail = message => { throw new FeishuError('INVALID_ARGUMENT', message); };
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const requireId = v => { if (typeof v !== 'string' || !v || v.length > 512) fail('An identifier is required.'); return v; };
export function epoch(value) {
  if (typeof value !== 'string' && typeof value !== 'number') fail('A date or Unix timestamp is required.');
  const s = String(value); let n;
  if (/^\d+$/.test(s)) n = Number(s); else { if (!/(Z|[+-]\d\d:\d\d)$/i.test(s)) fail('Use an ISO date-time with an explicit timezone, or Unix seconds.'); n = Date.parse(s) / 1000; }
  if (!Number.isSafeInteger(n) || n < 0) fail('Invalid time.'); return n;
}
function validate(type, data, path = 'input') {
  if (!object(data)) fail(`${path} must be an object.`); type.resolveAll();
  for (const [key,value] of Object.entries(data)) {
    const f = type.fields[key]; if (!f) fail(`Unknown field ${path}.${key}.`);
    const check = v => { if (f.resolvedType?.fields) validate(f.resolvedType,v,`${path}.${key}`);
      else if (f.resolvedType?.values && !(typeof v === 'string' && Object.hasOwn(f.resolvedType.values,v)) && !(Number.isInteger(v) && Object.values(f.resolvedType.values).includes(v))) fail(`Invalid ${path}.${key}.`); };
    if (f.map) { if (!object(value)) fail(`${path}.${key} must be an object.`); Object.values(value).forEach(check); }
    else if (f.repeated) { if (!Array.isArray(value)) fail(`${path}.${key} must be an array.`); value.forEach(check); }
    else check(value);
  }
  const err = type.verify(type.fromObject(data)); if (err) fail(`${path}: ${err}`);
}
function localAsUtc(seconds, zone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23' }).formatToParts(new Date(seconds*1000));
  const d = Object.fromEntries(parts.map(x => [x.type,x.value])); return new Date(Date.UTC(+d.year,+d.month-1,+d.day,+d.hour,+d.minute,+d.second));
}
function wallToEpoch(wall, zone) {
  let guess=wall.getTime(); const target=wall.getTime();
  for(let i=0;i<4;i++){const delta=target-localAsUtc(guess/1000,zone).getTime();if(!delta)return Math.floor(guess/1000);guess+=delta;}
  if(localAsUtc(guess/1000,zone).getTime()!==target)throw Error('Nonexistent local time');return Math.floor(guess/1000);
}
export function expandEvents(events, from, to) {
  const out = [], warnings = [], exceptions = new Map();
  for (const e of events) if (Number(e.originalTime) > 0) exceptions.set(`${e.calendarId}\0${e.key}\0${e.originalTime}`,e);
  for (const e of events) {
    if (e.isDeleted || e.status === 3) continue;
    const start = Number(e.startTime), end = Number(e.endTime), duration = Math.max(0,end-start);
    if (!e.rrule) { if (start < to && end > from) out.push({ event:e, startTime:String(start), endTime:String(end), recurring:false }); continue; }
    try {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !e.startTimezone) throw Error();
      const options = RRule.parseString(e.rrule.replace(/^RRULE:/i,'')); options.dtstart = localAsUtc(start,e.startTimezone);
      const until = options.until ? Math.floor(options.until.getTime()/1000) : null; if (until != null) options.until=localAsUtc(until,e.startTimezone);
      const dates = new RRule(options).between(new Date((from-duration-172800)*1000),new Date((to+172800)*1000),true,(_date,index)=>index<10000);
      if (dates.length >= 10000) throw Error();
      for (const date of dates) { const t = wallToEpoch(date,e.startTimezone); if ((until != null && t>until) || t < start || t >= to || t+duration <= from || exceptions.has(`${e.calendarId}\0${e.key}\0${t}`)) continue;
        out.push({ event:e, startTime:String(t), endTime:String(t+duration), recurring:true, originalTime:String(t) }); }
    } catch { warnings.push({ code:'RECURRENCE_UNEXPANDED', eventId:e.id, calendarId:e.calendarId }); }
  }
  out.sort((a,b)=>Number(a.startTime)-Number(b.startTime)); return { items:out, warnings };
}
export class Calendar {
  constructor(gateway) { this.gateway=gateway; }
  async call(command,type,body,response,write=false,operation='calendar') {
    const r=await this.gateway.call(command,type,body,{mutating:write,operation});
    return this.gateway.decode(response,r.packet.payload || new Uint8Array());
  }
  async calendars({ maxPages=20 }={}) {
    if (!Number.isInteger(maxPages)||maxPages<1||maxPages>100) fail('Invalid calendar page count.');
    let token='',items=[],seen=new Set(),more=false;
    for(let i=0;i<maxPages;i++){let r=await this.call(1001001,'calendar_web.ListCalendarsRequest',{pageSize:200,...(token?{syncToken:token}:{})},'calendar_web.ListCalendarsResponse');
      if(!r)throw new FeishuError('INVALID_RESPONSE','Calendars were not returned.'); items.push(...r.calendars.filter(x=>!x.isDeleted)); more=r.hasMore;
      if(!more){token='';break}if(!r.nextSyncToken||seen.has(r.nextSyncToken))throw new FeishuError('PAGINATION_INCOMPLETE','Calendar pagination could not advance.');token=r.nextSyncToken;seen.add(token);}
    return {items,complete:!more,nextCursor:token||null};
  }
  async searchCalendars({query,offset=0,count=20}={}) { if(typeof query!=='string'||!query.trim()||!Number.isInteger(offset)||offset<0||!Number.isInteger(count)||count<1||count>100)fail('Invalid calendar search.');
    let r=await this.call(1000017,'calendars.MultiCalendarSearchRequest',{query,offset,count,needSearchMeetingRoom:true,needSearchSharedCalendar:true,needSearchPrimaryCalendar:true},'calendars.MultiCalendarSearchResponse'); if(!r)throw new FeishuError('INVALID_RESPONSE','Calendar search was not returned.'); return {items:r.contents,calendarBriefMap:r.calendarBriefMap,calendarChatterMap:r.calendarChatterMap,chatterMap:r.chatterMap}; }
  async rooms({start,end,query='',count=50,cursor=0,timezone=defaultTimezone,rrule}={}) {start=epoch(start);end=epoch(end);if(end<=start||typeof query!=='string'||!Number.isInteger(count)||count<1||count>100||!Number.isInteger(cursor)||cursor<0)fail('Invalid room search.');
    let r=await this.call(1000016,'calendar_events.SearchMeetingRoomsRequest',{startTime:String(start),endTime:String(end),keyword:query,count,cursor,startTimezone:timezone,...(rrule?{rrule}:{})},'calendar_events.SearchMeetingRoomsResponse');if(!r)throw new FeishuError('INVALID_RESPONSE','Meeting rooms were not returned.');return {items:r.buildings,hasMore:r.hasMore,nextCursor:r.hasMore?r.cursor:null}; }
  async events({start,end,calendarIds=[],userIds=[],allCalendars=false,maxPages=20}={}) {
    let from=epoch(start),to=epoch(end);if(to<=from||to-from>366*86400||!Array.isArray(calendarIds)||!Array.isArray(userIds)||userIds.length>20||!Number.isInteger(maxPages)||maxPages<1||maxPages>100)fail('Use a valid range of at most 366 days.');
    let cal=await this.calendars();if(!cal.complete)throw new FeishuError('PAGINATION_INCOMPLETE','Calendar list is incomplete.');
    let ids=calendarIds.map(requireId);if(userIds.length){let people=await this.attendees({users:userIds});ids.push(...people.items.map(x=>x.attendeeCalendarId).filter(x=>x&&x!=='0'));if(people.items.some(x=>!x.attendeeCalendarId||x.attendeeCalendarId==='0'))throw new FeishuError('NOT_FOUND','A user calendar could not be resolved.');}
    if(allCalendars||!ids.length)ids.push(...cal.items.filter(x=>allCalendars||x.isPrimary).map(x=>x.id));ids=[...new Set(ids)];if(!ids.length)throw new FeishuError('NOT_FOUND','No selected calendar was found.');
    const metadata=await this.call(1001008,'calendar_web.WebMGetCalendarsWithIDsRequest',{calendarIds:ids},'calendar_web.WebMGetCalendarsWithIDsResponse');
    const access=ids.map(calendarId=>{const calendar=metadata.calendars?.[calendarId];const role=calendar&&Object.hasOwn(calendar,'selfAccessRole')?calendar.selfAccessRole:null;return {calendarId,role,detailAccess:role!=null&&role>=2};});
    let events=[],pending=ids.map(calendarId=>({calendarId,timeMin:String(from),timeMax:String(to),pageSize:200,filters:{maxAttendeesCountPerEvent:100,needsReminders:true,needsDescription:true,maxResourcesCountPerEvent:100}})),seen=new Set();
    for(let i=0;i<maxPages&&pending.length;i++){let r=await this.call(1002001,'calendar_web.ListCalendarEventsRequest',{params:pending},'calendar_web.ListCalendarEventsResponse');if(!r)throw new FeishuError('INVALID_RESPONSE','Calendar events were not returned.');let next=[];
      for(const p of pending){let result=r.results[p.calendarId];if(!result)throw new FeishuError('INVALID_RESPONSE','A selected calendar was omitted.');events.push(...result.calendarEvents);if(result.nextPageToken){const k=p.calendarId+'\0'+result.nextPageToken;if(seen.has(k))throw new FeishuError('PAGINATION_INCOMPLETE','Event pagination repeated its cursor.');seen.add(k);next.push({...p,pageToken:result.nextPageToken})}}pending=next;}
    let expanded=expandEvents(events,from,to);return {...expanded,access,series:events.filter(e=>e.rrule),complete:pending.length===0,remainingCalendars:pending.map(x=>x.calendarId),range:{start:String(from),end:String(to)}};
  }
  async event({eventId}) { let r=await this.call(1002006,'calendar_web.MGetEventsWithIdsRequest',{ids:[requireId(eventId)]},'calendar_web.MGetEventsWithIdsResponse');let event=r?.events?.[eventId]||Object.values(r?.events||{}).find(x=>x.id===eventId);if(!event)throw new FeishuError('NOT_FOUND','Event not found or inaccessible.');return {event}; }
  async attendees({users=[],groups=[],calendars=[]}={}) { if(![users,groups,calendars].every(Array.isArray))fail('Invalid attendees.');let items=[];
    for(const [values,cmd,req,res,key,param] of [[users,1002008,'GetUserAttendeesByUserIdsRequest','GetUserAttendeesByUserIdsResponse','userAttendees','userIds'],[groups,1002007,'GetGroupAttendeesByGroupIdsRequest','GetGroupAttendeesByGroupIdsResponse','groupAttendees','groupIds'],[calendars,1002009,'GetAttendeesByCalendarIdsRequest','GetAttendeesByCalendarIdsResponse','attendees','calendarIds']])if(values.length){values.forEach(requireId);let r=await this.call(cmd,`calendar_web.${req}`,{[param]:values},`calendar_web.${res}`);if(!r)throw new FeishuError('INVALID_RESPONSE','Attendees could not be resolved.');for(const id of values){if(!r[key]?.[id])throw new FeishuError('NOT_FOUND','An attendee could not be resolved.');items.push(r[key][id]);}}
    return {items}; }
  async createEvent({input={},title,start,end,calendarId,timezone=defaultTimezone,description,allDay,repeat,users=[],groups=[],rooms=[],notify=true}={}) {
    if(!object(input))fail('Event input must be an object.'); await this.gateway.authenticate();await this.gateway.ensureCalendarProto();
    if(!calendarId){const c=await this.calendars();calendarId=c.items.find(x=>x.isPrimary)?.id}requireId(calendarId);
    let event={...input,id:'0',key:input.key||randomUUID(),calendarId,organizerCalendarId:input.organizerCalendarId||calendarId,creatorCalendarId:input.creatorCalendarId||calendarId,source:1,status:input.status||2,selfAttendeeStatus:2};
    if(title!=null)event.summary=title;if(description!=null)event.description=description;if(start!=null)event.startTime=String(epoch(start));if(end!=null)event.endTime=String(epoch(end));if(allDay!=null)event.isAllDay=allDay;if(repeat!=null)event.rrule=repeat;
    event.startTimezone=event.startTimezone||timezone;event.endTimezone=event.endTimezone||timezone;
    if(!event.summary||Number(event.endTime)<=Number(event.startTime)||!Number.isSafeInteger(Number(event.startTime))||!Number.isSafeInteger(Number(event.endTime)))fail('A title and valid start/end are required.');
    if(users.length||groups.length||rooms.length) event.attendees=[...(event.attendees||[]),...(await this.attendees({users,groups,calendars:rooms})).items];
    validate(this.gateway.calendarProto.lookupType('calendar_entities.WebCalendarEvent'),event);
    await this.call(1002003,'calendar_web.CreateEventRequest',{event,notificationType:notify?1:2},'calendar_web.CreateEventResponse',true,'event-create');
    return {status:'submitted_unconfirmed',calendarId,key:event.key,startTime:String(event.startTime),endTime:String(event.endTime)};
  }
  async updateEvent({eventId,patch={},span=0,instanceStart,notify=true,addUsers=[],removeUsers=[],addGroups=[],removeGroups=[],addRooms=[],removeRooms=[]}={}) {
    if(!object(patch)||!Number.isInteger(span)||span<0||span>3)fail('Invalid event update.');const current=(await this.event({eventId})).event;
    let type=this.gateway.calendarProto.lookupType('calendar_entities.WebCalendarEvent'),data=type.toObject(current,{longs:String,enums:Number,bytes:String});
    for(const k of ['id','key','calendarId','creatorCalendarId','organizerCalendarId','originalTime','source','status','isDeleted','selfAttendeeStatus'])if(Object.hasOwn(patch,k))fail(`Cannot change event identity field ${k}.`);
    const memberLists=[addUsers,removeUsers,addGroups,removeGroups,addRooms,removeRooms];if(!memberLists.every(Array.isArray))fail('Attendee changes must be arrays.');
    if(memberLists.some(x=>x.length)&&Object.hasOwn(patch,'attendees'))fail('Do not combine attendee replacement with add/remove options.');
    if(memberLists.some(x=>x.length)){
      let attendees=[...(data.attendees||[])];
      for(const [ids,match] of [[removeUsers,x=>x.user?.userId],[removeGroups,x=>x.group?.groupId],[removeRooms,x=>x.attendeeCalendarId]])for(const id of ids){requireId(id);let index=attendees.findIndex(x=>match(x)===id);if(index<0)fail('An attendee to remove was not found.');attendees.splice(index,1);}
      if(addUsers.length||addGroups.length||addRooms.length)attendees.push(...(await this.attendees({users:addUsers,groups:addGroups,calendars:addRooms})).items);
      patch={...patch,attendees};
    }
    let event={...data,...patch}; if (patch.startTime != null) event.startTime=String(epoch(patch.startTime)); if (patch.endTime != null) event.endTime=String(epoch(patch.endTime)); validate(type,event);if(Number(event.endTime)<=Number(event.startTime))fail('End must be after start.');
    await this.call(1002004,'calendar_web.UpdateEventRequest',{event,span, ...(instanceStart!=null?{instanceStartTime:String(epoch(instanceStart))}:{}),notificationType:notify?1:2},'calendar_web.UpdateEventResponse',true,'event-update');return {status:'submitted_unconfirmed',eventId};
  }
  async deleteEvent({eventId,span=0,instanceStart,notify=true}={}) {if(!Number.isInteger(span)||span<0||span>3)fail('Invalid event span.');let {event}=await this.event({eventId});
    await this.call(1002005,'calendar_web.DeleteEventRequest',{calendarId:event.calendarId,key:event.key,originalTime:String(event.originalTime||0),span,instanceStartTime:String(instanceStart!=null?epoch(instanceStart):event.startTime),notificationType:notify?1:2},'calendar_web.DeleteEventResponse',true,'event-delete');return {status:'submitted_unconfirmed',eventId}; }
  async resolveAvailability(users,includeSelf=true) {
    if(!Array.isArray(users)||typeof includeSelf!=='boolean'||users.length>20)fail('Provide at most 20 user IDs.');
    const self=await this.gateway.authenticate();const ids=[...new Set([...(includeSelf?[self.id]:[]),...users])];
    if(!ids.length||ids.some(id=>typeof id!=='string'||!/^[1-9]\d{0,18}$/.test(id)||BigInt(id)>9223372036854775807n))fail('At least one valid numeric user ID is required.');
    let access=await this.call(1000034,'calendars.GetFreeBusyAccessibleUserMapRequest',{userIds:ids},'calendars.GetFreeBusyAccessibleUserMapResponse');
    const unavailable=ids.filter(id=>!Object.hasOwn(access.freeBusyAccessibleUserMap,id)||access.freeBusyAccessibleUserMap[id]!==true);
    if(unavailable.length)throw new FeishuError('FREEBUSY_UNAVAILABLE','Busy/free access is not available for every requested user.',{userIds:unavailable});
    let attendees=(await this.attendees({users:ids})).items;
    const people=ids.map((userId,i)=>({userId,calendarId:attendees[i]?.attendeeCalendarId}));
    if(people.some(x=>!x.calendarId||x.calendarId==='0'))throw new FeishuError('FREEBUSY_UNAVAILABLE','A user calendar could not be resolved.');
    return people;
  }
  async checkBusy(people,start,end) {
    let r=await this.call(1010020,'calendar_events.GetBusyUserRequest',{calendarIds:[...new Set(people.map(x=>x.calendarId))],startTime:String(start),endTime:String(end)},'calendar_events.GetBusyUserResponse');
    if(!r||!r.calendarBusyMap)throw new FeishuError('INVALID_RESPONSE','Free/busy data was not returned.');
    return people.map(p=>({...p,busy:r.calendarBusyMap[p.calendarId]===true}));
  }
  async busy({users=[],includeSelf=true,start,end}={}) {const from=epoch(start),to=epoch(end);if(to<=from||to-from>366*86400)fail('Use a valid range of at most 366 days.');
    let people=await this.resolveAvailability(users,includeSelf);return {start:String(from),end:String(to),people:await this.checkBusy(people,from,to)}; }
  async suggest({users=[],includeSelf=true,start,end,duration=30,step=30,workStart='09:00',workEnd='18:00',timezone=defaultTimezone,weekends=false,limit=10,maxRequests=200}={}) {
    const from=epoch(start),to=epoch(end);if(to<=from||to-from>14*86400||!Number.isInteger(duration)||duration<5||duration>480||!Number.isInteger(step)||step<5||step>240||!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(maxRequests)||maxRequests<1||maxRequests>500||typeof weekends!=='boolean')fail('Invalid availability search options.');
    const parseClock=value=>{if(typeof value!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(value))fail('Working hours must be HH:mm.');let [h,m]=value.split(':').map(Number);return h*60+m};
    const first=parseClock(workStart),last=parseClock(workEnd);if(last<=first||duration>last-first)fail('Invalid working hours or duration.');
    let formatter;try{formatter=new Intl.DateTimeFormat('en-US',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});}catch{fail('Invalid timezone.');}
    const people=await this.resolveAvailability(users,includeSelf);let days=new Map();
    for(let t=Math.ceil(from/60)*60;t+duration*60<=to;t+=60){const parts=Object.fromEntries(formatter.formatToParts(new Date(t*1000)).map(x=>[x.type,x.value]));let minute=Number(parts.hour)*60+Number(parts.minute);
      if((!weekends&&['Sat','Sun'].includes(parts.weekday))||minute<first||minute+duration>last||(minute-first)%step!==0)continue;
      const endParts=Object.fromEntries(formatter.formatToParts(new Date((t+duration*60)*1000)).map(x=>[x.type,x.value]));const date=parts.year+'-'+parts.month+'-'+parts.day;
      if(date!==endParts.year+'-'+endParts.month+'-'+endParts.day||Number(endParts.hour)*60+Number(endParts.minute)>last)continue;
      let day=days.get(date)||[];day.push({start:t,end:t+duration*60});days.set(date,day);
    }
    let slots=[],requests=0,truncated=false;
    const scan=async candidates=>{if(!candidates.length||slots.length>=limit)return;if(requests>=maxRequests){truncated=true;return}requests++;
      const state=await this.checkBusy(people,candidates[0].start,candidates.at(-1).end);
      if(state.every(x=>!x.busy)){slots.push(...candidates.slice(0,limit-slots.length));return}
      if(candidates.length===1)return;let middle=Math.floor(candidates.length/2);await scan(candidates.slice(0,middle));await scan(candidates.slice(middle));};
    for(const day of days.values()){await scan(day);if(slots.length>=limit||truncated)break;}
    return {people,slots:slots.map(x=>({start:String(x.start),end:String(x.end)})),timezone,durationMinutes:duration,requests,complete:!truncated&&slots.length<limit,limitReached:slots.length>=limit};
  }
  async share({eventId,chatIds=[]}={}) { if(!Array.isArray(chatIds)||!chatIds.length||chatIds.some(id=>typeof id!=='string'||!/^\d{1,19}$/.test(id)))fail('At least one numeric chat ID is required.');let {event}=await this.event({eventId});
    let r=await this.call(1002012,'calendar_web.ShareCalendarEventRequest',{chatIds,calendarId:event.calendarId,key:event.key,originalTime:String(event.originalTime||0)},'calendar_web.ShareCalendarEventResponse',true,'event-share');return {status:r.sharedFailedChats?.length?'partially_rejected':'submitted_unconfirmed',eventId,failedChats:(r.sharedFailedChats||[]).map(String)}; }
  async reply({eventId,response,comment,quitMeeting=false}={}) {let replyType={accept:1,decline:2,tentative:3}[response];if(!replyType)fail('Invalid invitation response.');let {event}=await this.event({eventId});
    await this.call(1020002,'calendar_events.ReplyCalendarEventInvitationRequest',{calendarEventKey:{uniqueKey:event.key,calendarId:event.calendarId,originalTime:String(event.originalTime||0)},replyType,quitMeeting,...(comment?{rsvpCommentInfo:{comment}}:{})},'calendar_events.ReplyCalendarEventInvitationResponse',true,'event-reply');return {status:'submitted_unconfirmed',eventId,response}; }
  async createCalendar({input={},name,description,timezone=defaultTimezone}={}) {if(!object(input))fail('Calendar input must be an object.');let u=await this.gateway.authenticate();await this.gateway.ensureCalendarProto();let calendar={...input,creatorUserId:u.id,defaultTimezone:input.defaultTimezone||timezone,defaultAccessRole:input.defaultAccessRole??1,visibilityProperty:input.visibilityProperty??32};if(name!=null)calendar.summary=name;if(description!=null)calendar.description=description;if(!calendar.summary)fail('Calendar name is required.');validate(this.gateway.calendarProto.lookupType('calendar_entities.WebCalendar'),calendar);
    await this.call(1001004,'calendar_web.CreateCalendarRequest',{calendar},'calendar_web.CreateCalendarResponse',true,'calendar-create');return {status:'submitted_unconfirmed',name:calendar.summary}; }
  async updateCalendar({calendarId,patch={}}={}) {requireId(calendarId);if(!object(patch)||['id','creatorUserId','isPrimary','type'].some(k=>Object.hasOwn(patch,k)))fail('Invalid calendar patch.');let found=(await this.calendars()).items.find(x=>x.id===calendarId);if(!found)throw new FeishuError('NOT_FOUND','Calendar not found.');let type=this.gateway.calendarProto.lookupType('calendar_entities.WebCalendar'),calendar={...type.toObject(found,{longs:String,enums:Number,bytes:String}),...patch};validate(type,calendar);await this.call(1001006,'calendar_web.UpdateCalendarRequest',{calendar},'calendar_web.UpdateCalendarResponse',true,'calendar-update');return {status:'submitted_unconfirmed',calendarId}; }
  async deleteCalendar({calendarId}={}) {requireId(calendarId);let found=(await this.calendars()).items.find(x=>x.id===calendarId);if(!found||found.isPrimary)fail('Cannot delete the primary or an unknown calendar.');await this.call(1001005,'calendar_web.DeleteCalendarRequest',{calendarId},'calendar_web.DeleteCalendarResponse',true,'calendar-delete');return {status:'submitted_unconfirmed',calendarId}; }
  async subscription({calendarId,subscribe}={}) {requireId(calendarId);if(typeof subscribe!=='boolean')fail('Invalid subscription.');let r=await this.call(subscribe?1001002:1001003,`calendar_web.Batch${subscribe?'Subscribe':'Unsubscribe'}CalendarsRequest`,{calendarIds:[calendarId],...(subscribe?{visibilityMask:[32]}:{}),subscriptionMask:[1]},`calendar_web.Batch${subscribe?'Subscribe':'Unsubscribe'}CalendarsResponse`,true,subscribe?'calendar-subscribe':'calendar-unsubscribe');
    if(!r)return {status:'submitted_unconfirmed',calendarId};let rejected=subscribe?!!r.normalViewFailedCalendarIdErrCodeMap?.[calendarId]:r.failedCalendarIds.includes(calendarId);return {status:rejected?'rejected':'submitted',calendarId}; }
}
