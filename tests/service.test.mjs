import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../lib/service.mjs';
import { createApp } from '../server.mjs';

const material = (overrides = {}) => ({ title: '课程补充材料', section: '第 2 页', version: 'v1', content: '椭圆描绘是本测试的独立学习主题；观察轮廓后，请说明证据。', sourceType: 'course', audience: 'student', ...overrides });

test('approved course retrieval cites provenance and refuses missing evidence', t => {
  const s = createService(); t.after(() => s.close());
  const answer = s.chat({ question: '矢状面与额状面如何区分？' });
  assert.equal(answer.mode, 'lexical-extractive');
  assert.ok(answer.citations.some(c => c.documentId === 'demo-planes' && c.section && c.version));
  const unknown = s.chat({ question: '量子纠缠是否具有可传递性？', attempt: '我还不确定。' });
  assert.equal(unknown.needsTeacher, true);
  assert.equal(unknown.citations.length, 0);
  assert.equal(s.bootstrap('teacher').questions.length, 1);
  assert.equal(s.bootstrap('student').questions.length, 0);
});

test('pending approval and private exam/research sources never enter student retrieval', t => {
  const s = createService(); t.after(() => s.close());
  const doc = s.addDocument('teacher', material()).document;
  assert.equal(s.chat({ question: '椭圆描绘' }).needsTeacher, true);
  assert.ok(!s.bootstrap('student').documents.some(d => d.id === doc.id));
  s.approveDocument('teacher', doc.id);
  assert.equal(s.chat({ question: '椭圆描绘' }).needsTeacher, false);
  const exam = s.addDocument('teacher', material({ title: '保密考试', content: '紫色月轮是测试用的保密题目。禁止进入学生检索。', sourceType: 'teacher_exam', audience: 'teacher' })).document;
  s.approveDocument('teacher', exam.id);
  const research = s.addDocument('teacher', material({ title: '研究记录', content: '金色荒原是测试用的研究记录。禁止进入学生检索。', sourceType: 'research', audience: 'teacher' })).document;
  s.approveDocument('teacher', research.id);
  assert.equal(s.chat({ question: '紫色月轮' }).citations.length, 0);
  assert.equal(s.chat({ question: '金色荒原' }).citations.length, 0);
  assert.ok(s.bootstrap('student').documents.every(d => d.sourceType === 'course' && d.audience === 'student'));
  assert.throws(() => s.addDocument('teacher', material({ sourceType: 'teacher_exam' })), /仅允许教师/);
});

test('teacher-only operations and validation prevent invalid learning records', t => {
  const s = createService(); t.after(() => s.close());
  assert.throws(() => s.addDocument('student', material()), /仅供演示教师/);
  assert.throws(() => s.approveDocument('student', 'demo-review'), /仅供演示教师/);
  assert.throws(() => s.addTask('student', {}), /仅供演示教师/);
  assert.throws(() => s.runScheduler('student'), /仅供演示教师/);
  assert.throws(() => s.completeTask('demo-pre', { reflection: '完成', confidence: 9 }), /1–5/);
  assert.throws(() => s.completeTask('not-own-task', { reflection: '完成', confidence: 4 }), /找不到/);
  assert.throws(() => s.updateSettings({ reminders: 'yes' }), /true 或 false/);
  assert.throws(() => s.addTask('teacher', { title: '测试任务', phase: 'pre', description: '说明任务', dueAt: '2026-10-29T10:00' }), /含时区/);
  const done = s.completeTask('demo-pre', { reflection: '我能解释观察平面的选择。', confidence: 4 });
  assert.equal(done.task.status, 'completed');
  assert.equal(s.completeTask('demo-pre', { reflection: '重复提交不新增事件。', confidence: 4 }).alreadyCompleted, true);
  assert.equal(s.bootstrap().progress.completed, 1);
  assert.equal(s.bootstrap().events.filter(e => e.type === 'task_completed').length, 1);
});

test('retired demo scheduler never simulates or sends notifications', t => {
  const s=createService();t.after(()=>s.close());s.updateSettings({reminders:true});
  const r=s.runScheduler('teacher');assert.equal(r.simulated,0);assert.equal(r.externalSent,0);
  assert.equal(s.bootstrap('teacher').outbox.length,0);assert.match(r.reason,/停用/);
});

test('SQLite persists completions, consent, approved sources across restarts', t => {
  const directory = mkdtempSync(join(tmpdir(), 'kin-companion-'));
  const dbPath = join(directory, 'test.sqlite');
  const a = createService({ dbPath });
  a.completeTask('demo-in', { reflection: '我记录了观察节段和证据。', confidence: 4 });
  a.updateSettings({ reminders: true });
  const doc = a.addDocument('teacher', material()).document;
  a.approveDocument('teacher', doc.id);
  a.close();
  const b = createService({ dbPath });
  t.after(() => { b.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal(b.bootstrap().tasks.find(t => t.id === 'demo-in').status, 'completed');
  assert.equal(b.bootstrap().settings.reminders, true);
  assert.ok(b.bootstrap().documents.some(d => d.id === doc.id));
  assert.equal(b.bootstrap().tasks.length, 3);
});

test('HTTP rejects cross-origin, unprivileged mutations, invalid JSON, and private file access', async t => {
  const service = createService();
  const app = createApp({ service });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  assert.equal((await fetch(`${base}/api/bootstrap`, { headers: { Origin: 'http://evil.test' } })).status, 403);
  assert.equal((await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', Referer: 'https://evil.test/page' }, body: '{}' })).status, 403);
  assert.equal((await fetch(`${base}/api/documents`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(material()) })).status, 403);
  assert.equal((await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{ broken' })).status, 400);
  assert.equal((await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'a'.repeat(170000) }) })).status, 413);
  assert.equal((await fetch(`${base}/api/wechat/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
  assert.equal((await fetch(`${base}/data/companion.sqlite`)).status, 404);
  assert.equal((await fetch(`${base}/%2e%2e%5clib/service.mjs`)).status, 404);
  assert.equal((await fetch(`${base}/.env`)).status, 404);
});

test('candidate batch imports remain pending, preserve provenance, and are idempotent', t => {
  const s = createService(); t.after(() => s.close());
  const candidate = material({ provenance: { path: 'teaching-outline.txt', sha256: 'a'.repeat(64), note: '测试候选' } });
  assert.equal(s.importCandidates('teacher', [candidate]).imported, 1);
  assert.equal(s.importCandidates('teacher', [candidate]).skipped, 1);
  const found = s.bootstrap('teacher').documents.find(d => d.title === candidate.title);
  assert.equal(found.status, 'pending');
  assert.equal(JSON.parse(found.provenance).sha256, 'a'.repeat(64));
  assert.ok(!s.bootstrap('student').documents.some(d => d.id === found.id));
  assert.throws(() => s.importCandidates('teacher', [material()]), /出处/);
  assert.throws(() => s.importCandidates('student', [candidate]), /仅供演示教师/);
});
