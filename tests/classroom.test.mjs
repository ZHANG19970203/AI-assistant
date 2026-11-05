import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createService} from '../lib/service.mjs';
import {createApp} from '../server.mjs';
import {pythonExecutable,parsePptx} from '../lib/pptx-parser.mjs';

function setup(t){const folder=mkdtempSync(join(tmpdir(),'kin-classroom-'));const s=createService({dbPath:join(folder,'classroom.sqlite')});t.after(()=>{s.close();assert.equal(dirname(folder),tmpdir());rmSync(folder,{recursive:true,force:true});});return {s,c:s.classroom,folder};}
function fixture(folder,mode='normal'){const p=join(folder,mode+'.pptx');const r=spawnSync(pythonExecutable(),[fileURLToPath(new URL('make-pptx-fixture.py',import.meta.url)),p,mode],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return p;}
const lecture=(c,consent=false)=>c.create('teacher',{title:'课堂测试：观察与依据',recordingConsentConfirmed:consent}).session.id;

test('PPTX extraction honors presentation order and notes, then creates source-backed drafts',async t=>{
 const {c,folder,s}=setup(t),sid=lecture(c),p=fixture(folder);
 const d=await c.upload('teacher',sid,{name:'课堂课件.pptx',mime:'application/vnd.openxmlformats-officedocument.presentationml.presentation',buffer:readFileSync(p)});
 assert.equal(d.assets[0].detail.slideCount,2);assert.equal(d.segments[0].title,'观察动作');
 assert.ok(d.segments.some(x=>x.kind==='slide_notes'&&x.text.includes('区分观察')));
 assert.equal(s.bootstrap('student').classroom.sessions.length,0);
 const result=c.end('teacher',sid,{expectedChunks:0});assert.equal(result.session.state,'draft_ready');
 assert.ok(result.artifact.mindmap.branches.length>=2);assert.ok(result.artifact.questions.length>0);
 assert.ok(result.artifact.questions.every(q=>q.answerKey===null&&result.artifact.sources.some(x=>x.id===q.sourceId)));
 assert.equal(result.artifact.coverage.audioTranscribedAutomatically,false);
 assert.throws(()=>c.view('student',sid),/还没有教师/);
 c.publish('teacher',sid,{confirmCoverage:true,artifactRevision:c.view('teacher',sid).artifact?.revision});assert.equal(c.view('student',sid).artifact.status,'published');
 assert.equal(s.bootstrap('student').classroom.sessions.length,1);
});

test('PPTX invalid/encrypted-like content and DTD fail without creating approved materials',async t=>{
 const {c,folder}=setup(t),sid=lecture(c);
 await assert.rejects(()=>c.upload('teacher',sid,{name:'legacy.ppt',buffer:Buffer.from('old')}),/另存为PPTX/);
 await assert.rejects(()=>c.upload('teacher',sid,{name:'bad.pptx',buffer:Buffer.from('invalid zip')}),/zip|Zip|File|文件/i);
 await assert.rejects(()=>parsePptx(fixture(folder,'dtd')),/DTD/);
 assert.equal(c.view('teacher',sid).assets.length,0);
});

test('recording requires consent, deduplicates chunks, rejects holes/conflicts, and does not invent transcripts',t=>{
 const {c}=setup(t),sid=lecture(c),chunk={sequence:0,startMs:0,endMs:10000,mime:'audio/webm;codecs=opus',buffer:Buffer.from('synthetic recording chunk')};
 assert.throws(()=>c.chunk('teacher',sid,chunk),/告知/);c.consent('teacher',sid,{confirmed:true});
 assert.equal(c.chunk('teacher',sid,chunk).duplicate,false);assert.equal(c.chunk('teacher',sid,chunk).duplicate,true);
 assert.throws(()=>c.chunk('teacher',sid,{...chunk,buffer:Buffer.from('different')}),/不一致/);
 assert.throws(()=>c.end('teacher',sid,{expectedChunks:2}),/尚未全部保存/);
 const d=c.end('teacher',sid,{expectedChunks:1});assert.equal(d.session.state,'awaiting_transcript');assert.equal(d.artifact,null);assert.equal(d.recording.asr,'not-connected');assert.equal(d.recording.durationMs,10000);
 assert.throws(()=>c.chunk('teacher',sid,{...chunk,sequence:1}),/已结束/);
 assert.throws(()=>c.publish('teacher',sid,{confirmCoverage:true,artifactRevision:c.view('teacher',sid).artifact?.revision}),/没有可发布/);
});

test('subtitle timestamps, teacher review, source changes and video waiting states remain explicit',async t=>{
 const {c}=setup(t),sid=lecture(c);
 await c.upload('teacher',sid,{name:'课录.mp4',buffer:Buffer.from('video container placeholder test only')});
 let d=await c.upload('teacher',sid,{name:'课录.srt',buffer:Buffer.from('1\n00:00:01,000 --> 00:00:05,500\n先记录身体节段和方向，再说明依据。\n\n2\n00:00:06,000 --> 00:00:09,000\n不能把观察与解释混为一谈。\n')});
 assert.equal(d.assets[0].status,'awaiting_transcription');assert.equal(d.segments[0].startMs,1000);assert.equal(d.segments[0].endMs,5500);
 d=c.end('teacher',sid,{expectedChunks:0});assert.equal(d.artifact.coverage.awaitingAudioAssets,1);assert.equal(d.artifact.coverage.hasTranscript,true);
 assert.throws(()=>c.publish('student',sid,{confirmCoverage:true}),/教师/);assert.throws(()=>c.publish('teacher',sid,{confirmCoverage:false}),/核对/);
 c.publish('teacher',sid,{confirmCoverage:true,artifactRevision:c.view('teacher',sid).artifact?.revision});
 const oldRevision=c.view('teacher',sid).artifact.revision;
 c.transcript('teacher',sid,{title:'教师补充',text:'教师补充了本节课观察条件的说明。'});
 assert.throws(()=>c.view('student',sid),/还没有教师/);
 assert.throws(()=>c.publish('teacher',sid,{confirmCoverage:true,artifactRevision:oldRevision}),/版本已变化/);
 d=c.draft('teacher',sid);assert.equal(d.artifact.status,'pending');
 assert.ok(d.artifact.sources.some(x=>x.title==='教师补充'));
});

test('classroom HTTP gates binary uploads and unpublished sources; artifacts persist across restarts',async t=>{
 const {s,c,folder}=setup(t),sid=lecture(c),app=createApp({service:s});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>app.server.close(r)));
 const base='http://127.0.0.1:'+app.server.address().port;
 assert.equal((await fetch(base+'/api/classroom/sessions/'+sid)).status,404);
 assert.equal((await fetch(base+'/api/classroom/sessions/'+sid+'/assets',{method:'POST',headers:{'Content-Type':'application/octet-stream','x-file-name':'test.txt'},body:'abc'})).status,403);
 assert.equal((await fetch(base+'/api/classroom/sessions/'+sid+'/assets',{method:'POST',headers:{'Content-Type':'application/octet-stream','x-file-name':'test.txt','x-demo-role':'teacher'},body:'这是一段用于课堂材料流程测试的文字。'})).status,201);
 c.end('teacher',sid,{expectedChunks:0});c.publish('teacher',sid,{confirmCoverage:true,artifactRevision:c.view('teacher',sid).artifact?.revision});
 const other=createService({dbPath:join(folder,'classroom.sqlite')});try{assert.equal(other.classroom.view('student',sid).artifact.status,'published');}finally{other.close();}
});
