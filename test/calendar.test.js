import test from 'node:test';
import assert from 'node:assert/strict';
import { Calendar, epoch, expandEvents } from '../src/calendar.js';
import { authorize, parsePolicy } from '../src/agent-broker.js';
const timestamp = value => Date.parse(value)/1000;
function event(start,end,zone,rule) {return {id:'event',key:'key',calendarId:'calendar',startTime:String(timestamp(start)),endTime:String(timestamp(end)),startTimezone:zone,rrule:rule};}
test('recurring meetings use the event timezone and respect DST', () => {
  const e=event('2026-03-01T09:00:00-05:00','2026-03-01T10:00:00-05:00','America/New_York','FREQ=WEEKLY;COUNT=3');
  const r=expandEvents([e],timestamp('2026-03-01T00:00:00Z'),timestamp('2026-03-20T00:00:00Z'));
  assert.deepEqual(r.items.map(x=>new Date(Number(x.startTime)*1000).toISOString()),['2026-03-01T14:00:00.000Z','2026-03-08T13:00:00.000Z','2026-03-15T13:00:00.000Z']);assert.deepEqual(r.warnings,[]);
});
test('exceptions replace and cancel an occurrence', () => {
  const e=event('2026-11-24T17:00:00+08:00','2026-11-24T17:30:00+08:00','Asia/Shanghai','FREQ=WEEKLY;BYDAY=TU,TH');
  let cancelled={...e,id:'exception',rrule:'',originalTime:String(timestamp('2026-11-26T17:00:00+08:00')),status:3};
  let r=expandEvents([e,cancelled],timestamp('2026-11-22T00:00:00+08:00'),timestamp('2026-11-29T00:00:00+08:00'));
  assert.deepEqual(r.items.map(x=>new Date(Number(x.startTime)*1000).toISOString()),['2026-11-24T09:00:00.000Z']);
});
test('timezone and invalid recurrence do not silently invent results', () => {
  assert.throws(()=>epoch('2026-11-28'),{code:'INVALID_ARGUMENT'});
  let e=event('2026-11-24T17:00:00+08:00','2026-11-24T17:30:00+08:00','Not/AZone','FREQ=WEEKLY');
  let r=expandEvents([e],timestamp('2026-11-22T00:00:00+08:00'),timestamp('2026-11-29T00:00:00+08:00'));
  assert.equal(r.items.length,0);assert.equal(r.warnings[0].code,'RECURRENCE_UNEXPANDED');
});
test('events follow page tokens and report incompleteness', async () => {
  let calls=0;const g={async call(cmd,type,body){if(cmd===1001001)return {packet:{payload:{kind:'calendars'}}};if(cmd===1001008)return {packet:{payload:{kind:'metadata'}}};calls++;return {packet:{payload:{kind:'events',page:calls}}}},decode(type,body){if(body.kind==='calendars')return {calendars:[{id:'c',isPrimary:true}],hasMore:false};if(body.kind==='metadata')return {calendars:{c:{selfAccessRole:4}}};return {results:{c:{calendarEvents:[{id:String(body.page),calendarId:'c',key:String(body.page),startTime:'100',endTime:'200',attendees:[]}],nextPageToken:body.page===1?'next':''}}}}};
  const c=new Calendar(g),partial=await c.events({start:'50',end:'300',maxPages:1});assert.equal(partial.items.length,1);assert.equal(partial.complete,false);
  calls=0;const complete=await c.events({start:'50',end:'300',maxPages:2});assert.equal(complete.items.length,2);assert.equal(complete.complete,true);
});
test('calendar subscription grant cannot be used to unsubscribe', () => {
  const p=parsePolicy({version:1,allow:['calendar-subscribe'],allowGlobal:true});let req=subscribe=>({command:'calendar-subscribe',service:'calendar',method:'subscription',args:[{calendarId:'1',subscribe}]});
  assert.doesNotThrow(()=>authorize(p,req(true)));assert.throws(()=>authorize(p,req(false)),{code:'POLICY_DENIED'});
});
test('event update cannot secretly cancel an event or reply to an invitation', async () => {
  const gateway={calendarProto:{lookupType(){return {toObject(){return {startTime:'100',endTime:'200'}}}}}};
  const c=new Calendar(gateway);c.event=async()=>({event:{}});
  await assert.rejects(c.updateEvent({eventId:'1',patch:{status:3}}),{code:'INVALID_ARGUMENT'});
  await assert.rejects(c.updateEvent({eventId:'1',patch:{selfAttendeeStatus:4}}),{code:'INVALID_ARGUMENT'});
});
test('availability refuses users whose free-busy permission is missing', async () => {
  const c=new Calendar({async authenticate(){return {id:'1'}}});let resolved=false;
  c.call=async()=>({freeBusyAccessibleUserMap:{'1':true,'2':false}});c.attendees=async()=>{resolved=true;return {items:[]}};
  await assert.rejects(c.resolveAvailability(['2']),{code:'FREEBUSY_UNAVAILABLE'});assert.equal(resolved,false);
});
test('meeting suggestions return only windows verified free for everyone', async () => {
  const c=new Calendar({});c.resolveAvailability=async()=>[{userId:'1',calendarId:'a'},{userId:'2',calendarId:'b'}];
  const busyStart=timestamp('2026-11-30T12:00:00+08:00'),busyEnd=timestamp('2026-11-30T13:00:00+08:00');
  c.checkBusy=async(people,start,end)=>people.map((p,i)=>({...p,busy:i===1&&start<busyEnd&&end>busyStart}));
  const o={users:['2'],start:'2026-11-30T09:00:00+08:00',end:'2026-11-30T18:00:00+08:00',duration:30,step:30,timezone:'Asia/Shanghai',limit:30};
  const r=await c.suggest(o);assert.equal(r.complete,true);assert.equal(r.slots.length,16);
  for(const slot of r.slots)assert.ok(Number(slot.end)<=busyStart||Number(slot.start)>=busyEnd);
  const cut=await c.suggest({...o,maxRequests:1});assert.equal(cut.complete,false);assert.equal(cut.slots.length,0);
});
