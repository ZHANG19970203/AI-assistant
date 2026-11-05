import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createService } from '../lib/service.mjs';
import { createApp } from '../server.mjs';

test('student practice bootstrap hides keys, explanations and hints; six dimensions start missing', t => {
  const s = createService(); t.after(() => s.close());
  const boot = s.bootstrap();
  assert.equal(boot.practices.length, 8);
  assert.ok(boot.practices.every(p => p.options.length === 3 && p.lastAttempt === null));
  assert.ok(!JSON.stringify(boot.practices).includes('answerKey'));
  assert.ok(!JSON.stringify(boot.practices).includes('explanation'));
  assert.ok(!JSON.stringify(boot.practices).includes('hints'));
  assert.equal(boot.companion.dimensions.length, 6);
  assert.ok(boot.companion.dimensions.every(d => d.score === null && d.evidenceCount === 0));
  assert.ok(boot.companion.dimensions.every(d => d.evidenceDetail === null && d.rubricVersion === 'demo-practice-0.1'));
  assert.equal(boot.companion.summary.reviewedDimensions, 0);
});

test('graded hints withhold evidence explanation until a learner has attempted', t => {
  const s = createService(); t.after(() => s.close());
  const basic = s.practiceHint('concept-planes', { level: 1 });
  assert.ok(basic.hint);
  assert.equal(basic.explanation, null);
  assert.deepEqual(basic.evidence, []);
  assert.equal(s.practiceHint('concept-planes', { level: 2 }).explanation, null);
  assert.throws(() => s.practiceHint('concept-planes', { level: 3 }), error => error.status === 409 && error.code === 'ATTEMPT_REQUIRED');
  const wrong = s.submitPractice('concept-planes', { choice: 'A', reasoning: '这是我自己的暂定解释。' });
  assert.equal(wrong.attempt.correct, false);
  assert.equal(wrong.explanation, null);
  assert.deepEqual(wrong.evidence, []);
  assert.ok(!Object.hasOwn(wrong, 'answerKey'));
  assert.ok(!wrong.feedback.includes('矢状面'));
  const revealed = s.practiceHint('concept-planes', { level: 3 });
  assert.ok(revealed.explanation.includes('矢状面'));
  assert.equal(revealed.evidence.length, 1);
  const retry = s.submitPractice('concept-planes', { choice: 'B', reasoning: '' });
  assert.equal(retry.attempt.correct, true);
  assert.ok(retry.explanation);
  assert.equal(retry.evidence.length, 1);
  assert.ok(retry.evidence[0].title && retry.evidence[0].section && retry.evidence[0].version && retry.evidence[0].excerpt);
  assert.ok(s.bootstrap().companion.dimensions.every(d => d.score === null));
});

test('first correct attempt gives explanation; reasoning length never changes correctness or scores', t => {
  const s = createService(); t.after(() => s.close());
  const one = s.submitPractice('concept-complex', { choice: 'C', reasoning: '短' });
  const two = s.submitPractice('concept-complex', { choice: 'C', reasoning: '长'.repeat(1800) });
  assert.equal(one.attempt.correct, true);
  assert.equal(two.attempt.correct, true);
  assert.equal(one.feedback, two.feedback);
  assert.ok(one.explanation);
  assert.ok(one.evidence.some(e => e.title && e.section && e.version && e.excerpt));
  assert.equal(s.bootstrap().companion.summary.correctAttempts, 2);
  assert.equal(s.bootstrap().companion.summary.uniquePractices, 1);
  assert.ok(s.bootstrap().companion.dimensions.every(d => d.score === null));
  assert.throws(() => s.submitPractice('concept-complex', { choice: 'Z' }), /不属于/);
  assert.throws(() => s.practiceHint('concept-complex', { level: '3' }), /整数/);
});

test('teacher rubric ratings need a real own evidence record and never fill missing dimensions', t => {
  const s = createService(); t.after(() => s.close());
  const attempt = s.submitPractice('concept-planes', { choice: 'B', reasoning: '我比较了三个定义。' }).attempt;
  const rating = { dimensionId: 'concept', score: 3, comment: '结合这次作答讨论了概念，其他维度还需补充证据。', evidenceId: attempt.id };
  assert.throws(() => s.addFeedback('student', rating), error => error.status === 403);
  assert.throws(() => s.addFeedback('teacher', { ...rating, evidenceId: 'missing' }), /已有/);
  assert.throws(() => s.addFeedback('teacher', { ...rating, score: 4.5 }), /整数/);
  const result = s.addFeedback('teacher', rating);
  assert.equal(result.dimension.score, 3);
  assert.equal(result.dimension.evidenceCount, 1);
  assert.equal(result.feedback.evidenceType, 'practiceAttempt');
  assert.equal(result.dimension.evidenceDetail.type, 'practiceAttempt');
  assert.ok(result.dimension.evidenceDetail.content.includes('我比较了三个定义。'));
  assert.ok(result.dimension.evidenceDetail.title && result.dimension.evidenceDetail.createdAt);
  assert.equal(result.dimension.rubricVersion, 'demo-practice-0.1');
  assert.ok(!JSON.stringify(result.dimension.evidenceDetail).includes('answerKey'));
  const dims = s.bootstrap().companion.dimensions;
  assert.equal(dims.filter(d => d.score !== null).length, 1);
  assert.equal(s.bootstrap().companion.feedbackHistory.length, 0);
  assert.equal(s.bootstrap('teacher').companion.feedbackHistory.length, 1);
  // A manual zero is a real score; it is different from an unevaluated null.
  assert.equal(s.addFeedback('teacher', { ...rating, score: 0, comment: '人工复核后调整，保留历史和证据。' }).dimension.score, 0);
});

test('notes and task reflections can support manual ratings; other student evidence stays inaccessible', t => {
  const s = createService(); t.after(() => s.close());
  const note = s.addNote({ title: '自己的解释', content: '我先记录观察，再核对证据，并保留疑问。', sourceRef: '演示学习卡' }).note;
  const noteFeedback = s.addFeedback('teacher', { dimensionId: 'reflection', score: 2, comment: '根据笔记讨论修正过程。', evidenceId: note.id });
  assert.equal(noteFeedback.feedback.evidenceType, 'note');
  assert.equal(noteFeedback.dimension.evidenceDetail.content, note.content);
  assert.throws(() => s.addFeedback('teacher', { dimensionId: 'planning', score: 2, comment: '尚未提交任务反思。', evidenceId: 'demo-in' }), /已有/);
  s.completeTask('demo-in', { reflection: '下次先记录节段，再核对方向。', confidence: 3 });
  const reflectionFeedback = s.addFeedback('teacher', { dimensionId: 'planning', score: 2, comment: '结合反思中的下一步计划讨论。', evidenceId: 'demo-in' });
  assert.equal(reflectionFeedback.feedback.evidenceType, 'taskReflection');
  assert.equal(reflectionFeedback.dimension.evidenceDetail.content, '下次先记录节段，再核对方向。');
  s.db.prepare('INSERT INTO learning_notes VALUES (?,?,?,?,?,?)').run('other-note', 'other-student', '其他学生', '这份笔记应隔离。', '', new Date().toISOString());
  assert.ok(!s.bootstrap().notes.some(n => n.id === 'other-note'));
  assert.throws(() => s.addFeedback('teacher', { dimensionId: 'planning', score: 2, comment: '不可使用别人的证据。', evidenceId: 'other-note' }), /已有/);
  assert.throws(() => s.addNote({ title: '过长笔记', content: 'a'.repeat(5001) }), /5000/);
});

test('notes, checkins, practice attempts and teacher feedback persist without replacing old task data', t => {
  const directory = mkdtempSync(join(tmpdir(), 'kin-companion-extra-'));
  const dbPath = join(directory, 'test.sqlite');
  const a = createService({ dbPath });
  a.completeTask('demo-pre', { reflection: '旧任务的反思需要保留。', confidence: 4 });
  const note = a.addNote({ title: '迁移笔记', content: '在新动作中重新确定观察节段。', sourceRef: '' }).note;
  a.submitPractice('transfer-new-action', { choice: 'A', reasoning: '迁移步骤，不复制结论。' });
  a.addFeedback('teacher', { dimensionId: 'transfer', score: 2, comment: '根据笔记讨论迁移步骤。', evidenceId: note.id });
  const check = a.checkin({ difficulty: 'planning', message: '我想先明确一个小目标。' });
  assert.ok(check.advice.includes('小目标'));
  a.close();
  const b = createService({ dbPath });
  t.after(() => { b.close(); rmSync(directory, { recursive: true, force: true }); });
  const boot = b.bootstrap();
  assert.equal(boot.notes[0].id, note.id);
  assert.equal(boot.companion.summary.practiceAttempts, 1);
  assert.equal(boot.companion.dimensions.find(d => d.id === 'transfer').score, 2);
  assert.equal(boot.companion.checkins.length, 1);
  assert.equal(boot.tasks.find(t => t.id === 'demo-pre').reflection, '旧任务的反思需要保留。');
  assert.equal(boot.tasks.length, 3);
});

test('new HTTP routes respect feedback permission and hint prerequisites', async t => {
  const app = createApp({ service: createService() });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (path, payload, role = 'student') => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-demo-role': role }, body: JSON.stringify(payload) });
  assert.equal((await post('/api/practice/concept-planes/hint', { level: 3 })).status, 409);
  const noteResponse = await post('/api/notes', { title: 'HTTP笔记', content: '记录观察和证据。' });
  assert.equal(noteResponse.status, 201);
  const note = (await noteResponse.json()).note;
  const rating = { dimensionId: 'reflection', score: 2, comment: '教师人工查看这份笔记。', evidenceId: note.id };
  assert.equal((await post('/api/feedback', rating)).status, 403);
  assert.equal((await post('/api/feedback', rating, 'teacher')).status, 201);
  assert.equal((await post('/api/checkin', { difficulty: 'concept', message: '定义不确定。' })).status, 201);
  const submitted = await post('/api/practice/concept-planes/submit', { choice: 'A', reasoning: '' });
  assert.equal(submitted.status, 200);
  assert.equal((await submitted.json()).explanation, null);
});
