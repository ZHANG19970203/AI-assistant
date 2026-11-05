import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createService} from '../lib/service.mjs';
import {createApp} from '../server.mjs';
import {flatChapters} from '../web/chapter-tree.js';

test('existing course sections gain parents once without changing material or task identity',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'chapter-tree-')),dbPath=join(folder,'db.sqlite');let s=createService({dbPath,seed:false});
 try{
  const c=s.addChapter('teacher',{title:'2.1 第一节课线上（了解学科，初识概念）',summary:'目录依据教师提供的课程截图；课程资料待上传。',publishNow:true}).chapter;
  s.db.prepare('INSERT INTO meta VALUES (?,?)').run('course-outline-v1','teacher-screenshot');
  const r=await s.addResource('teacher',{title:'讲义',chapterId:c.id},'chapter.txt','text/plain',Buffer.from('人体运动学课程学习资料，用于验证原有引用保持。'));s.approveResource('teacher',r.resource.id);
  const p=s.lessonFlow.save('teacher',{title:'原有学习',chapterId:c.id,stages:{pre:{resourceIds:[r.resource.id]}}}).id;
  const token=s.lessonFlow.assign('teacher',{planId:p,preview:true}).links[0].url.split('token=')[1];s.close();s=createService({dbPath});
  let all=s.bootstrap('teacher').chapters;const child=all.find(x=>x.id===c.id),parent=all.find(x=>x.id===child.parentId);assert.equal(parent.title,'人体运动学概述');assert.equal(s.lessonFlow.view(token).stages[0].resources[0].id,r.resource.id);
  assert.equal(flatChapters(all).find(x=>x.id===c.id).depth,1);const size=all.length;s.close();s=createService({dbPath});assert.equal(s.bootstrap('teacher').chapters.length,size);
  assert.throws(()=>s.updateChapter('teacher',parent.id,{parentId:c.id}),/自己/);assert.throws(()=>s.addChapter('teacher',{title:'无效父节点',parentId:'missing'}),/不存在/);
  const sibling=s.addChapter('teacher',{title:'新增课节',parentId:parent.id,publishNow:true}).chapter;assert.equal(sibling.parentId,parent.id);
  s.updateChapter('teacher',parent.id,{status:'draft'});assert.equal(s.bootstrap('student').resources.some(x=>x.id===r.resource.id),false);
  s.updateChapter('teacher',parent.id,{status:'published'});assert.equal(s.bootstrap('student').resources.some(x=>x.id===r.resource.id),true);
 }finally{s.close();assert.equal(dirname(folder),tmpdir());rmSync(folder,{recursive:true,force:true});}
});

test('renaming a chapter preserves resources and learning plans after restart',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'chapter-edit-')),dbPath=join(folder,'db.sqlite');let s=createService({dbPath});
 try{
  const c=s.addChapter('teacher',{title:'原章节',publishNow:true}).chapter;
  const r=await s.addResource('teacher',{title:'课程讲义',chapterId:c.id},'notes.txt','text/plain',Buffer.from('课程讲义：观察动作并确定参照节段。'));
  s.approveResource('teacher',r.resource.id);const p=s.lessonFlow.save('teacher',{title:'观察任务',chapterId:c.id,stages:{pre:{resourceIds:[r.resource.id]}}}).id;
  assert.throws(()=>s.updateChapter('student',c.id,{title:'越权改名'}),/教师/);
  assert.throws(()=>s.updateChapter('teacher',c.id,{title:'   '}),/章节名称/);
  assert.equal(s.updateChapter('teacher',c.id,{title:'修改后的章节'}).chapter.id,c.id);
  s.close();s=createService({dbPath});
  const state=s.bootstrap('teacher');assert.equal(state.chapters.find(x=>x.id===c.id).title,'修改后的章节');assert.equal(state.resources.find(x=>x.id===r.resource.id).chapterId,c.id);
  assert.equal(s.lessonFlow.report('teacher').plans.find(x=>x.id===p).chapter_id,c.id);assert.equal(s.previewResource('teacher',r.resource.id).content,'课程讲义：观察动作并确定参照节段。');
 }finally{s.close();assert.equal(dirname(folder),tmpdir());rmSync(folder,{recursive:true,force:true});}
});

test('chapter editing and pending/private material previews require teacher access',async()=>{
 const s=createService(),c=s.addChapter('teacher',{title:'资料测试',publishNow:true}).chapter;
 const r=await s.addResource('teacher',{title:'教师资料',chapterId:c.id,sourceType:'teacher_exam',audience:'teacher'},'private.txt','text/plain',Buffer.from('仅供教师核对的待审核资料，不应向学生开放。'));
 const app=createApp({service:s});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;
 try{
  const url=base+'/api/resources/'+r.resource.id+'/preview';assert.equal((await fetch(url)).status,403);
  const preview=await fetch(url,{headers:{'x-demo-role':'teacher'}});assert.equal(preview.status,200);assert.match((await preview.json()).content,/仅供教师/);
  const request=role=>fetch(base+'/api/chapters/'+c.id+'/update',{method:'POST',headers:{'Content-Type':'application/json','x-demo-role':role},body:JSON.stringify({title:'新名称'})});
  assert.equal((await request('student')).status,403);assert.equal((await request('teacher')).status,200);
  assert.equal((await fetch(base+'/api/resources/missing/preview',{headers:{'x-demo-role':'teacher'}})).status,404);
 }finally{await app.close();}
});
