import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {createService} from '../lib/service.mjs';import {createApp} from '../server.mjs';
function setup(t){let clock=new Date('2026-11-04T00:00:00Z');const s=createService({now:()=>clock});t.after(()=>s.close());const chapter=s.bootstrap('teacher').chapters[0];const make=stages=>{const plan=s.lessonFlow.save('teacher',{title:'学习计划',chapterId:chapter.id,stages}).id;const raw=s.lessonFlow.assign('teacher',{planId:plan,preview:true}).links[0].url.split('token=')[1];return {raw,new:{value:raw,mode:'new'},review:{value:raw,mode:'review'},makeup:{value:raw,mode:'makeup'}};};return {s,make,advance:days=>clock=new Date(+clock+days*86400000),chapter};}
test('six dimensions count assigned tasks once; review and makeup never increase timely rates',t=>{const {s,make,advance}=setup(t);const token=make({pre:{thinking:'讨论',movement:'体感'},in:{thinking:'课中讨论'},post:{thinking:'课后讨论',mindmap:true}});
  const view=()=>s.lessonFlow.view(token.new).feedback.dimensions;
  assert.equal(view().find(d=>d.id==='pre_discussion').total,1);assert.equal(view().find(d=>d.id==='pre_video').percent,null);
  s.lessonFlow.media.submit(token.review,{phase:'pre',kind:'reflection',content:'复习讨论'});assert.equal(view()[0].done,0);
  for(let i=0;i<3;i++)s.lessonFlow.media.submit(token.new,{phase:'pre',kind:'reflection',content:'及时完成讨论'});assert.equal(view()[0].done,1);assert.equal(view()[0].percent,100);
  s.lessonFlow.media.submit(token.new,{phase:'pre',kind:'movement',content:'体验完成'});assert.equal(view().find(d=>d.id==='pre_movement').done,1);
  advance(8);s.lessonFlow.makeup(token.makeup,{phase:'post'});const request=s.lessonFlow.report('teacher').requests[0];s.lessonFlow.policy.decide('teacher',{id:request.id,action:'approve'});s.lessonFlow.media.submit(token.makeup,{phase:'post',kind:'mindmap',content:'补学导图'});assert.equal(view().find(d=>d.id==='post_mindmap').done,0);
});
test('seven-day expiry, no double-counted pending request, three applications, fourth locks course and teacher can reset',async t=>{const {s,make,advance}=setup(t);const token=make({pre:{thinking:'讨论'},post:{requirements:'任务'}});advance(7);
  assert.throws(()=>s.lessonFlow.media.submit(token.review,{phase:'pre',kind:'reflection',content:'过期复习'}),/7天/);assert.equal(s.lessonFlow.view(token.review).stages[0].open,false);
  for(let i=1;i<=3;i++){const r=s.lessonFlow.makeup(token.makeup,{phase:'pre'});assert.equal(r.attempts,i);assert.equal(s.lessonFlow.makeup(token.makeup,{phase:'pre'}).duplicate,true);const req=s.lessonFlow.report('teacher').requests.find(r=>r.status==='pending');s.lessonFlow.policy.decide('teacher',{id:req.id,action:'approve'});assert.equal(s.lessonFlow.view(token.makeup).stages[0].open,true);advance(7);}
  assert.equal(s.lessonFlow.makeup(token.makeup,{phase:'pre'}).status,'locked');assert.ok(s.lessonFlow.view(token.new).stages.every(x=>!x.open));await assert.rejects(s.lessonFlow.chat(token.new,{phase:'post',question:'还能学吗'}),/课程已锁定/);
  const learner=s.lessonFlow.report('teacher').limits[0].learner;assert.throws(()=>s.lessonFlow.policy.reset('student',{learner,confirm:true}),/教师/);s.lessonFlow.policy.reset('teacher',{learner,confirm:true});assert.equal(s.lessonFlow.makeup(token.makeup,{phase:'pre'}).attempts,1);
});
test('video coverage is deduplicated; skipped segments and repeated intervals do not complete video',async t=>{const {s,make,chapter}=setup(t);const r=await s.addResource('teacher',{title:'测试视频',chapterId:chapter.id,audience:'student',sourceType:'course'},'video.mp4','video/mp4',Buffer.from('synthetic'));s.approveResource('teacher',r.resource.id);const token=make({pre:{resourceIds:[r.resource.id]}});const send=(ranges,mode=token.new)=>s.lessonFlow.event(mode,{id:randomUUID(),phase:'pre',kind:'video_progress',resourceId:r.resource.id,seconds:10,duration:100,position:100,ranges});
  for(let i=0;i<20;i++)send([[0,2]]);assert.equal(s.lessonFlow.view(token.new).feedback.dimensions.find(d=>d.id==='pre_video').done,0);send([[0,100]]);assert.equal(s.lessonFlow.view(token.new).feedback.dimensions.find(d=>d.id==='pre_video').done,0);
  for(let n=0;n<90;n+=2)send([[n,n+2]],token.review);assert.equal(s.lessonFlow.view(token.new).feedback.dimensions.find(d=>d.id==='pre_video').done,0);for(let n=0;n<90;n+=2)send([[n,n+2]]);assert.equal(s.lessonFlow.view(token.new).feedback.dimensions.find(d=>d.id==='pre_video').percent,100);
});
test('address book selection, delete and add persist without deleting learning records',t=>{const {s}=setup(t);const p=s.lessonFlow.policy;p.contact('teacher',{email:'A@example.com',name:'甲'});p.contact('teacher',{email:'b@example.com',name:'乙'});p.contact('teacher',{action:'selectAll',selected:false});assert.ok(s.bootstrap('teacher').mailContacts.every(c=>c.selected===0));p.contact('teacher',{action:'select',email:'a@example.com',selected:true});assert.equal(s.bootstrap('teacher').mailContacts.find(c=>c.email==='a@example.com').selected,1);p.contact('teacher',{action:'deleteMany',emails:['b@example.com']});assert.equal(s.bootstrap('teacher').mailContacts.length,1);});

test('course lock follows one recipient across assignments; other learners are isolated',t=>{
  const {s,advance,chapter}=setup(t),old=process.env.PUBLIC_BASE_URL;process.env.PUBLIC_BASE_URL='https://course.example.com';t.after(()=>{if(old===undefined)delete process.env.PUBLIC_BASE_URL;else process.env.PUBLIC_BASE_URL=old;});
  const assign=()=>{const id=s.lessonFlow.save('teacher',{title:'课程任务',chapterId:chapter.id,stages:{pre:{thinking:'观察与讨论'}}}).id;s.lessonFlow.assign('teacher',{planId:id,emails:['a@example.com','b@example.com'],confirm:true});return s.db.prepare('SELECT * FROM lesson_access WHERE plan_id=? ORDER BY recipient').all(id);};
  const first=assign();advance(8);const second=assign();
  assert.equal(s.lessonFlow.view(first[0].token).history.length,2);assert.ok(s.lessonFlow.view(first[0].token).history.every(h=>h.reviewURL.includes(first[0].token)||h.reviewURL.includes(second[0].token)));
  for(let i=0;i<3;i++){s.lessonFlow.makeup(first[0].token,{phase:'pre'});s.lessonFlow.policy.decide('teacher',{id:s.lessonFlow.report('teacher').requests.find(r=>r.status==='pending').id,action:'reject'});}
  assert.equal(s.lessonFlow.makeup(first[0].token,{phase:'pre'}).status,'locked');assert.equal(s.lessonFlow.view(second[0].token).stages[0].locked,true);assert.equal(s.lessonFlow.view(second[1].token).stages[0].open,true);
  const a=s.lessonFlow.report('teacher').students.find(x=>x.id===second[0].id);assert.equal(a.taskStats.dimensions[0].total,2);s.lessonFlow.policy.reset('teacher',{learner:'a@example.com',confirm:true});assert.equal(s.lessonFlow.view(second[0].token).stages[0].open,true);
});

test('HTTP enforces expired materials and records; makeup grants do not unlock normal study',async()=>{
  let clock=new Date('2026-11-04T00:00:00Z');const s=createService({now:()=>clock}),chapter=s.bootstrap('teacher').chapters[0];
  const resource=await s.addResource('teacher',{title:'讲义',chapterId:chapter.id,audience:'student',sourceType:'course'},'lesson.txt','text/plain',Buffer.from('测试课程资料'));s.approveResource('teacher',resource.resource.id);
  const id=s.lessonFlow.save('teacher',{title:'权限测试',chapterId:chapter.id,stages:{pre:{resourceIds:[resource.resource.id],oral:'口述理解'}}}).id,raw=s.lessonFlow.assign('teacher',{planId:id,preview:true}).links[0].url.split('token=')[1];
  const recording=s.lessonFlow.media.start(raw,{phase:'pre',kind:'oral',consent:true});
  await assert.rejects(s.lessonFlow.media.finish({value:raw,mode:'review'},{id:recording.id,phase:'pre',expected:1}),/所属学习模式/);
  const app=createApp({service:s});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;
  const get=(path,mode='new')=>fetch(base+path,{headers:{'x-study-token':raw,'x-study-mode':mode}});
  try{
    clock=new Date(+clock+7*86400000);
    for(const type of ['materials','files'])assert.equal((await get(`/api/study/${type}/${resource.resource.id}?phase=pre`,'review')).status,403);
    const view=await (await get('/api/study')).json();assert.equal(view.stages[0].resources,undefined);assert.equal(view.recordings.length,0);
    s.lessonFlow.makeup(raw,{phase:'pre'});s.lessonFlow.policy.decide('teacher',{id:s.lessonFlow.report('teacher').requests[0].id,action:'approve'});
    assert.equal((await get(`/api/study/files/${resource.resource.id}?phase=pre`)).status,403);assert.equal((await get(`/api/study/files/${resource.resource.id}?phase=pre`,'makeup')).status,200);
    assert.equal((await fetch(base+'/api/resources/'+resource.resource.id+'/file')).status,403);
  }finally{await app.close();}
});
