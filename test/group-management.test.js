import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSettings, GroupManagement } from '../src/group-management.js';
import { authorize, parsePolicy } from '../src/agent-broker.js';

test('group settings validate fields and send only selected update masks', () => {
  assert.deepEqual(buildSettings({entity:{atAllPermissionSetting:'ONLY_OWNER',topNoticePermissionSetting:'ONLY_MANAGER'},general:{restrictedModePermissionSetting:{status:true,copyPermissionSetting:'NO_MEMBER'}}}),{
    entitySetting:{atAllPermissionSetting:2,topNoticePermissionSetting:2},updateEntitySettingFields:[2,14],
    generalSetting:{restrictedModePermissionSetting:{status:true,copyPermissionSetting:2}},updateGeneralSettingFields:[1,3],updateFields:[15,41]});
  assert.throws(()=>buildSettings({entity:{atAllPermissionSetting:'unrecognized'}}),{code:'INVALID_ARGUMENT'});
  assert.throws(()=>buildSettings({ownerId:'123'}),{code:'INVALID_ARGUMENT'});
  assert.throws(()=>buildSettings({general:{restrictedModePermissionSetting:{status:'true'}}}),{code:'INVALID_ARGUMENT'});
});
test('removing yourself cannot bypass the separate leave permission', async () => {
  let called=false;const g={async authenticate(){return {id:'123'}},async call(){called=true;throw Error('unexpected')}};
  await assert.rejects(new GroupManagement(g).remove({chatId:'44',userIds:['123']}),{code:'INVALID_ARGUMENT'});assert.equal(called,false);
});
test('admin and application decisions remain distinct under the broker policy', () => {
  const p=parsePolicy({version:1,allow:['group-admin-add','group-request-approve'],chatIds:['44']});
  const a=enabled=>({command:'group-admin-add',service:'groups',method:'setAdmins',args:[{chatId:'44',userIds:['123'],enabled}]});
  const b=approve=>({command:'group-request-approve',service:'groups',method:'reviewRequest',args:[{chatId:'44',userId:'123',approve}]});
  assert.doesNotThrow(()=>authorize(p,a(true)));assert.throws(()=>authorize(p,a(false)),{code:'POLICY_DENIED'});
  assert.doesNotThrow(()=>authorize(p,b(true)));assert.throws(()=>authorize(p,b(false)),{code:'POLICY_DENIED'});
  assert.throws(()=>authorize(p,{...a(true),args:[{chatId:'45',userIds:['123'],enabled:true}]}),{code:'POLICY_DENIED'});
});
test('join request listing does not expose invitation tokens', async () => {
  let group=new GroupManagement({});group.call=async()=>({data:{applies:[{reason:'please',status:3,time:'123',inviteeId:'456',joinToken:'secret'}],nextCursor:'0'}});
  const r=await group.requests({chatId:'44'});assert.equal(r.items[0].inviteeId,'456');assert.ok(!Object.hasOwn(r.items[0],'joinToken'));assert.equal(r.nextCursor,null);
});
