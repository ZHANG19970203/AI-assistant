import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const seed = JSON.parse(readFileSync(new URL('../data/practice-seed.json', import.meta.url), 'utf8'));
const id = prefix => `${prefix}-${randomUUID()}`;
const practiceById = new Map(seed.practices.map(p => [p.id, p]));
const dimensionById = new Map(seed.dimensions.map(d => [d.id, d]));
const asAttempt = row => ({ id: row.id, practiceId: row.practice_id, choice: row.choice, reasoning: row.reasoning, correct: !!row.correct, createdAt: row.created_at });
const asNote = row => ({ id: row.id, title: row.title, content: row.content, sourceRef: row.source_ref, createdAt: row.created_at });
const asFeedback = row => ({ id: row.id, dimensionId: row.dimension_id, score: row.score, comment: row.comment, evidenceId: row.evidence_id, evidenceType: row.evidence_type, createdAt: row.created_at });
const asCheckin = row => ({ id: row.id, difficulty: row.difficulty, message: row.message, advice: row.advice, createdAt: row.created_at });

export function createCompanion({ db, studentId, now, event, AppError }) {
  const stamp = () => now().toISOString();
  const fail = (message, status = 400, code = 'INVALID_INPUT') => { throw new AppError(status, code, message); };
  const text = (value, label, max, min = 1) => {
    if (typeof value !== 'string' || value.trim().length < min || value.length > max) fail(`${label}须为 ${min}–${max} 字的文字。`);
    return value.trim();
  };
  const getPractice = practiceId => {
    const practice = practiceById.get(practiceId);
    if (!practice) fail('找不到这项演示练习。', 404, 'NOT_FOUND');
    return practice;
  };
  db.exec(`
    CREATE TABLE IF NOT EXISTS practice_attempts (id TEXT PRIMARY KEY, student_id TEXT NOT NULL, practice_id TEXT NOT NULL, choice TEXT NOT NULL, reasoning TEXT NOT NULL, correct INTEGER NOT NULL CHECK(correct IN (0,1)), created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS practice_hints (id TEXT PRIMARY KEY, student_id TEXT NOT NULL, practice_id TEXT NOT NULL, level INTEGER NOT NULL CHECK(level BETWEEN 1 AND 3), created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS learning_notes (id TEXT PRIMARY KEY, student_id TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, source_ref TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS learning_feedback (id TEXT PRIMARY KEY, student_id TEXT NOT NULL, dimension_id TEXT NOT NULL, score INTEGER NOT NULL CHECK(score BETWEEN 0 AND 4), comment TEXT NOT NULL, evidence_id TEXT NOT NULL, evidence_type TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS learning_checkins (id TEXT PRIMARY KEY, student_id TEXT NOT NULL, difficulty TEXT NOT NULL, message TEXT NOT NULL, advice TEXT NOT NULL, created_at TEXT NOT NULL);
  `);
  const attempts = () => db.prepare('SELECT * FROM practice_attempts WHERE student_id=? ORDER BY rowid DESC').all(studentId);
  const notes = () => db.prepare('SELECT * FROM learning_notes WHERE student_id=? ORDER BY rowid DESC').all(studentId).map(asNote);
  const feedback = () => db.prepare('SELECT * FROM learning_feedback WHERE student_id=? ORDER BY rowid DESC').all(studentId).map(asFeedback);
  const evidenceDetail = current => {
    if (!current) return null;
    if (current.evidenceType === 'practiceAttempt') {
      const row = db.prepare('SELECT * FROM practice_attempts WHERE id=? AND student_id=?').get(current.evidenceId, studentId);
      if (!row) return null;
      return { type: 'practiceAttempt', title: practiceById.get(row.practice_id)?.title || '演示练习作答', content: `所选选项：${row.choice}\n作答思路：${row.reasoning || '（未填写）'}`, createdAt: row.created_at };
    }
    if (current.evidenceType === 'taskReflection') {
      const row = db.prepare("SELECT * FROM tasks WHERE id=? AND student_id=? AND status='completed'").get(current.evidenceId, studentId);
      if (!row) return null;
      return { type: 'taskReflection', title: row.title, content: row.reflection, createdAt: row.completed_at };
    }
    if (current.evidenceType === 'note') {
      const row = db.prepare('SELECT * FROM learning_notes WHERE id=? AND student_id=?').get(current.evidenceId, studentId);
      if (!row) return null;
      return { type: 'note', title: row.title, content: row.content, createdAt: row.created_at };
    }
    return null;
  };
  const dimensions = () => {
    const history = feedback();
    return seed.dimensions.map(d => {
      const ratings = history.filter(r => r.dimensionId === d.id);
      const current = ratings[0];
      return { id: d.id, label: d.label, score: current?.score ?? null, evidenceCount: new Set(ratings.map(r => r.evidenceId)).size, source: 'teacher', comment: current?.comment ?? null, evidenceId: current?.evidenceId ?? null, evidenceDetail: evidenceDetail(current), updatedAt: current?.createdAt ?? null, rubric: d.rubric, rubricVersion: seed.version };
    });
  };
  return {
    bootstrap(role) {
      const history = attempts();
      const allNotes = notes();
      const dims = dimensions();
      const practices = seed.practices.map(p => {
        const ownAttempts = history.filter(a => a.practice_id === p.id);
        return { id: p.id, title: p.title, dimensionId: p.dimensionId, stem: p.stem, options: p.options, sourceLabel: seed.sourceLabel, attemptCount: ownAttempts.length, correctCount: ownAttempts.filter(a => a.correct).length, lastAttempt: ownAttempts[0] ? asAttempt(ownAttempts[0]) : null };
      });
      const incorrect = history.filter(a => !a.correct);
      const untried = practices.filter(p => p.attemptCount === 0);
      const nextActions = [];
      const lastWrong = incorrect.find(a => practices.find(p => p.id === a.practice_id)?.lastAttempt?.id === a.id);
      if (lastWrong) nextActions.push({ type: 'practice', label: '回看一个尚未解决的练习', description: '先使用一级提示，核对自己的判断依据，再决定是否重试。', practiceId: lastWrong.practice_id });
      if (untried[0]) nextActions.push({ type: 'practice', label: '选择一道尚未尝试的练习', description: '先写下自己的思路，再对照反馈；练习表现不等于能力诊断。', practiceId: untried[0].id });
      if (!allNotes.length) nextActions.push({ type: 'note', label: '记下一个自己的解释', description: '可以记录观察、依据与一个待验证问题。笔记字数不参与评分。' });
      if (dims.some(d => d.score === null)) nextActions.push({ type: 'feedback', label: '准备一份可讨论的学习证据', description: '需要时请教师结合练习、笔记或反思给出人工反馈。没有证据的维度保持待评价。' });
      return {
        practices,
        notes: allNotes,
        companion: {
          dimensions: dims,
          summary: { practiceAttempts: history.length, uniquePractices: new Set(history.map(a => a.practice_id)).size, correctAttempts: history.filter(a => a.correct).length, incorrectAttempts: incorrect.length, notes: allNotes.length, reflections: db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE student_id=? AND status='completed' AND reflection IS NOT NULL AND length(trim(reflection))>0").get(studentId).n, reviewedDimensions: dims.filter(d => d.score !== null).length, note: '练习正确性、提交次数和自评分别记录；六维图仅采用教师结合证据的人工评分。缺少评价保持空值，不能视为零分或能力诊断。' },
          nextActions: nextActions.slice(0, 3),
          checkins: db.prepare('SELECT * FROM learning_checkins WHERE student_id=? ORDER BY rowid DESC LIMIT 20').all(studentId).map(asCheckin),
          feedbackHistory: role === 'teacher' ? feedback() : [],
          practiceAttempts: role === 'teacher' ? history.map(asAttempt) : [],
          sourceLabel: seed.sourceLabel
        }
      };
    },
    submitPractice(practiceId, body) {
      const practice = getPractice(practiceId);
      const choice = text(body.choice, '所选选项', 10);
      if (!practice.options.some(option => option.id === choice)) fail('所选选项不属于这道练习。');
      const reasoning = body.reasoning === undefined ? '' : text(body.reasoning, '作答思路', 2000, 0);
      const correct = choice === practice.answerKey;
      const attemptId = id('attempt');
      db.prepare('INSERT INTO practice_attempts VALUES (?,?,?,?,?,?,?)').run(attemptId, studentId, practiceId, choice, reasoning, correct ? 1 : 0, stamp());
      event('practice_attempt', `完成演示练习：${practice.title}；选项${correct ? '符合' : '暂不符合'}演示规则。未自动评价思路质量。`);
      return { attempt: asAttempt(db.prepare('SELECT * FROM practice_attempts WHERE id=?').get(attemptId)), feedback: correct ? '这个选项符合本题的演示规则。请对照下面的解释，检查自己的依据；系统没有评价你作答思路的质量。' : '这个选项暂不符合本题的演示规则。先看一个提示，检查自己的依据，再决定是否重试。系统没有评价你作答思路的质量。', explanation: correct ? practice.explanation : null, evidence: correct ? [practice.evidence] : [], hint: { level: 1, text: practice.hints[0] }, sourceLabel: seed.sourceLabel };
    },
    practiceHint(practiceId, body) {
      const practice = getPractice(practiceId);
      if (![1, 2, 3].includes(body.level)) fail('提示级别须为整数 1、2 或 3。');
      const attempted = db.prepare('SELECT 1 FROM practice_attempts WHERE student_id=? AND practice_id=? LIMIT 1').get(studentId, practiceId);
      if (body.level === 3 && !attempted) fail('请先提交一次自己的尝试，再选择查看证据与解释。', 409, 'ATTEMPT_REQUIRED');
      db.prepare('INSERT INTO practice_hints VALUES (?,?,?,?,?)').run(id('hint'), studentId, practiceId, body.level, stamp());
      return { practiceId, level: body.level, hint: body.level < 3 ? practice.hints[body.level - 1] : '你已选择查看演示证据与解释。读完后，可以回到自己的判断说明修正原因。', explanation: body.level === 3 ? practice.explanation : null, evidence: body.level === 3 ? [practice.evidence] : [], sourceLabel: seed.sourceLabel };
    },
    addNote(body) {
      const title = text(body.title, '笔记标题', 160);
      const content = text(body.content, '笔记正文', 5000);
      const sourceRef = body.sourceRef === undefined ? '' : text(body.sourceRef, '资料出处', 500, 0);
      const noteId = id('note');
      db.prepare('INSERT INTO learning_notes VALUES (?,?,?,?,?,?)').run(noteId, studentId, title, content, sourceRef, stamp());
      event('note_created', `保存学习笔记：${title}。笔记内容未被自动评分。`);
      return { note: asNote(db.prepare('SELECT * FROM learning_notes WHERE id=?').get(noteId)) };
    },
    checkin(body) {
      const adviceByDifficulty = {
        concept: '挑选一个不确定的概念，先写自己的定义，再做一道概念辨析练习；需要时查看一级提示。',
        observation: '选一个简单动作，记录身体节段、起始姿势和主要方向，先把观察与推断分开。',
        application: '换一个日常动作，沿用观察、判断、核证三个步骤，并保留一个无法解释的现象。',
        planning: '只选一个可在下一次学习中完成的小目标，写出具体步骤；完成后自行核对是否解决了原来的问题。'
      };
      if (!Object.hasOwn(adviceByDifficulty, body.difficulty)) fail('困难类型须为 concept、observation、application 或 planning。');
      const message = text(body.message, '当前困难描述', 1000, 0);
      const checkinId = id('checkin');
      const advice = adviceByDifficulty[body.difficulty];
      db.prepare('INSERT INTO learning_checkins VALUES (?,?,?,?,?,?)').run(checkinId, studentId, body.difficulty, message, advice, stamp());
      event('learning_checkin', '学生记录了自述学习困难；仅提供可行动的学习建议，不推断情绪或能力。');
      return { checkin: asCheckin(db.prepare('SELECT * FROM learning_checkins WHERE id=?').get(checkinId)), advice };
    },
    addFeedback(role, body) {
      if (role !== 'teacher') fail('六维评价须由演示教师角色结合证据提交。', 403, 'TEACHER_ONLY');
      if (!dimensionById.has(body.dimensionId)) fail('评价维度无效。');
      if (!Number.isInteger(body.score) || body.score < 0 || body.score > 4) fail('人工评分须为 0–4 的整数。');
      const comment = text(body.comment, '评价依据与建议', 2000, 2);
      const evidenceId = text(body.evidenceId, '学习证据编号', 100);
      let evidenceType = null;
      if (db.prepare('SELECT 1 FROM practice_attempts WHERE id=? AND student_id=?').get(evidenceId, studentId)) evidenceType = 'practiceAttempt';
      else if (db.prepare("SELECT 1 FROM tasks WHERE id=? AND student_id=? AND status='completed' AND reflection IS NOT NULL AND length(trim(reflection))>0").get(evidenceId, studentId)) evidenceType = 'taskReflection';
      else if (db.prepare('SELECT 1 FROM learning_notes WHERE id=? AND student_id=?').get(evidenceId, studentId)) evidenceType = 'note';
      if (!evidenceType) fail('证据须为该演示学生已有的练习作答、已完成任务反思或笔记。', 400, 'INVALID_EVIDENCE');
      const feedbackId = id('feedback');
      db.prepare('INSERT INTO learning_feedback VALUES (?,?,?,?,?,?,?,?)').run(feedbackId, studentId, body.dimensionId, body.score, comment, evidenceId, evidenceType, stamp());
      event('teacher_feedback', `教师结合已有${evidenceType === 'note' ? '笔记' : evidenceType === 'taskReflection' ? '反思' : '练习作答'}，对“${dimensionById.get(body.dimensionId).label}”给出人工评价；没有自动推断能力。`);
      return { feedback: asFeedback(db.prepare('SELECT * FROM learning_feedback WHERE id=?').get(feedbackId)), dimension: dimensions().find(d => d.id === body.dimensionId) };
    }
  };
}
