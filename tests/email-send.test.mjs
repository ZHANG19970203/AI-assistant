import test from 'node:test';
import assert from 'node:assert/strict';
import {createService} from '../lib/service.mjs';

const taskInput={title:'发送验证',phase:'pre',description:'测试课程任务，不包含私人对话。',emailConversation:false};
test('no deadline required; manual send works without scheduled email switch and does not resend',async t=>{
  const s=createService();t.after(()=>s.close());
  const task=s.addTask('teacher',taskInput).task;
  assert.equal(task.dueAt,'');assert.equal(task.emailEnabled,false);
  s.emailDelivery.setProfile('teacher',{email:'test@example.com',consent:true});
  const preview=s.emailDelivery.preview('teacher',task.id);
  assert.ok(!preview.text.includes('截止'));assert.ok(!preview.html.includes('截止'));
  let count=0;const send=async mail=>{count++;return {accepted:[mail.to],messageId:'mock'};};
  assert.equal((await s.emailDelivery.sendTask('teacher',task.id,send,true)).status,'sent');
  await s.emailDelivery.sendTask('teacher',task.id,send,true);assert.equal(count,1);
});
test('SMTP rejection is persisted as failure; retry is explicit and teacher-only',async t=>{
  const s=createService();t.after(()=>s.close());
  const task=s.addTask('teacher',taskInput).task;
  s.emailDelivery.setProfile('teacher',{email:'test@example.com',consent:true});
  await assert.rejects(s.emailDelivery.sendTask('student',task.id,async()=>{},true),/仅供/);
  await assert.rejects(s.emailDelivery.sendTask('teacher',task.id,async()=>({accepted:[]}),true),/发送失败/);
  assert.equal(s.bootstrap('teacher').emailDeliveries[0].status,'failed');
  let count=0;await s.emailDelivery.runDue('teacher',async()=>{count++;},true);assert.equal(count,0);
});
test('immediate bulk processing is limited to the selected task and future jobs stay queued',async t=>{
  const s=createService();t.after(()=>s.close());
  s.db.prepare('INSERT INTO mail_contacts(email,name,source,created_at) VALUES (?,?,?,?)').run('one@example.com','test','fixture',new Date().toISOString());
  const a=s.addTask('teacher',taskInput).task,b=s.addTask('teacher',{...taskInput,title:'另一个任务'}).task;
  const base={emails:['one@example.com'],confirm:true};
  s.emailDelivery.bulk.queue('teacher',{...base,taskId:a.id});
  s.emailDelivery.bulk.queue('teacher',{...base,taskId:b.id,scheduledAt:'2099-01-01T00:00:00Z'});
  let count=0;const send=async mail=>{count++;return {accepted:[mail.to],messageId:'mock'};};
  await Promise.all([s.emailDelivery.bulk.run(send,true,a.id),s.emailDelivery.bulk.run(send,true,a.id)]);
  assert.equal(count,1);const rows=s.emailDelivery.bulk.state('teacher').bulkDeliveries;
  assert.equal(rows.find(r=>r.task_id===a.id).status,'sent');assert.equal(rows.find(r=>r.task_id===b.id).status,'queued');
});
