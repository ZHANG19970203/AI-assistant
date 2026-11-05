import {createLessonFlow} from './lesson-flow.mjs';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { retrieve } from './retrieval.mjs';
import { createCompanion } from './companion.mjs';
import { createClassroom } from './classroom.mjs';
import { createCourseLibrary } from './course-library.mjs';
import { createEmailDelivery } from './email-delivery.mjs';

export class AppError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (message, code = 'INVALID_INPUT') => { throw new AppError(400, code, message); };
const text = (value, label, max = 1000, min = 1) => {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) fail(`${label}须为 ${min}–${max} 字的文字。`);
  return value.trim();
};
const teacherOnly = role => { if (role !== 'teacher') throw new AppError(403, 'TEACHER_ONLY', '此操作仅供演示教师角色使用。'); };
const own = 'demo-student';
const id = prefix => `${prefix}-${randomUUID()}`;
const asDocument = row => ({ id: row.id, title: row.title, section: row.section, version: row.version, content: row.content, status: row.status, sourceType: row.source_type, audience: row.audience, provenance: row.provenance, createdAt: row.created_at });
const asTask = row => ({ id: row.id, title: row.title, phase: row.phase, description: row.description, dueAt: row.due_at, releaseAt: row.release_at || null, chapterId: row.chapter_id || null, emailEnabled: !!row.email_enabled, emailConversation: row.email_conversation !== 0, status: row.status, reflection: row.reflection, confidence: row.confidence, completedAt: row.completed_at, studentId: row.student_id });

export function createService({ dbPath = ':memory:', now = () => new Date(), seed = true } = {}) {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS settings (student_id TEXT PRIMARY KEY, reminders INTEGER NOT NULL DEFAULT 0, quiet_start TEXT NOT NULL DEFAULT '22:00', quiet_end TEXT NOT NULL DEFAULT '08:00');
    CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, title TEXT NOT NULL, section TEXT NOT NULL, version TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','approved')), source_type TEXT NOT NULL, audience TEXT NOT NULL, provenance TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, student_id TEXT NOT NULL, title TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('pre','in','post')), description TEXT NOT NULL, due_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', reflection TEXT, confidence INTEGER, completed_at TEXT);
    CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, student_id TEXT, type TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS questions (id TEXT PRIMARY KEY, student_id TEXT NOT NULL, question TEXT NOT NULL, attempt TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, student_id TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id), title TEXT NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(student_id,task_id));
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  const stamp = () => now().toISOString();
  const event = (type, detail, studentId = own) => db.prepare('INSERT INTO events VALUES (?,?,?,?,?)').run(id('event'), studentId, type, detail, stamp());
  const initial = JSON.parse(readFileSync(new URL('../data/seed.json', import.meta.url), 'utf8'));
  if (seed && !db.prepare("SELECT 1 FROM meta WHERE key='seeded'").get()) {
    db.exec('BEGIN');
    try {
      db.prepare('INSERT OR IGNORE INTO settings(student_id) VALUES (?)').run(own);
      for (const doc of initial.documents) db.prepare('INSERT INTO documents VALUES (?,?,?,?,?,?,?,?,?,?)').run(doc.id, doc.title, doc.section, doc.version, doc.content, doc.status, doc.sourceType, doc.audience, doc.provenance, stamp());
      for (const task of initial.tasks) db.prepare('INSERT INTO tasks(id,student_id,title,phase,description,due_at) VALUES (?,?,?,?,?,?)').run(task.id, own, task.title, task.phase, task.description, task.dueAt);
      db.prepare('INSERT INTO meta VALUES (?,?)').run('seeded', 'demo-0.1');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  db.prepare('INSERT OR IGNORE INTO settings(student_id) VALUES (?)').run(own);
  const docs = () => db.prepare('SELECT * FROM documents ORDER BY created_at,id').all().map(asDocument);
  const tasks = () => db.prepare('SELECT * FROM tasks WHERE student_id=?').all(own).map(asTask).sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt) || a.id.localeCompare(b.id));
  const settings = () => {
    const row = db.prepare('SELECT * FROM settings WHERE student_id=?').get(own);
    return { reminders: !!row.reminders, quietStart: row.quiet_start, quietEnd: row.quiet_end, timezone: 'Asia/Shanghai' };
  };
  const companion = createCompanion({ db, studentId: own, now, event, AppError });
  const classroom = createClassroom({db,AppError,now,storageDir:dbPath===':memory:'?undefined:resolve(dirname(dbPath),'runtime/classroom')});
  const library = createCourseLibrary({ db, dbPath, now, AppError, text, teacherOnly });
  if(seed&&!db.prepare("SELECT 1 FROM meta WHERE key='course-outline-v1'").get()){
    const outline=JSON.parse(readFileSync(new URL('../data/course-outline.json',import.meta.url),'utf8'));
    for(const [index,title] of outline.entries())if(!db.prepare('SELECT 1 FROM chapters WHERE title=?').get(title))library.addChapter('teacher',{title,position:index+1,publishNow:true,summary:'目录依据教师提供的课程截图；课程资料待上传。'});
    db.prepare('INSERT INTO meta VALUES (?,?)').run('course-outline-v1','teacher-screenshot');
  }
  if(seed&&!db.prepare("SELECT 1 FROM meta WHERE key='course-tree-v1'").get()){
    db.exec('BEGIN');try{
      for(const [number,title] of [[1,'人体运动学虚拟实验室'],[2,'人体运动学概述']]){
        const children=db.prepare("SELECT * FROM chapters WHERE parent_id IS NULL AND title LIKE ? AND summary LIKE '%目录依据教师提供的课程截图%' ORDER BY position,id").all(number+'.%');
        if(!children.length)continue;
        let parent=db.prepare('SELECT id FROM chapters WHERE title=? AND parent_id IS NULL').get(title);
        parent||=library.addChapter('teacher',{title,position:number,publishNow:true}).chapter;
        for(const [i,c] of children.entries())db.prepare('UPDATE chapters SET parent_id=?,position=? WHERE id=?').run(parent.id,i+1,c.id);
      }
      db.prepare('INSERT INTO meta VALUES (?,?)').run('course-tree-v1','teacher-reference');db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
  }
  const emailDelivery = createEmailDelivery({ db, now, AppError, text, teacherOnly });
  const lessonFlow=createLessonFlow({db,dbPath,now,teacherOnly,AppError,library});
  return {
    lessonFlow,
    db,
    classroom,
    close: () => db.close(),
    bootstrap(role = 'student') {
      const ownTasks = tasks();
      const completed = ownTasks.filter(t => t.status === 'completed').length;
      const visibleDocs = role === 'teacher' ? docs() : library.visibleDocuments(docs().filter(d => d.status === 'approved' && d.sourceType === 'course' && d.audience === 'student'));
      return {
        course: initial.course,
        documents: visibleDocs,
        tasks: library.tasksForRole(role, ownTasks),
        progress: { completed, total: ownTasks.length, completionRate: ownTasks.length ? Math.round(completed / ownTasks.length * 100) : 0, note: '完成率是任务行为记录，不代表知识掌握度。' },
        settings: settings(),
        events: db.prepare('SELECT * FROM events WHERE student_id=? ORDER BY created_at DESC LIMIT 50').all(own).map(r => ({ id: r.id, type: r.type, detail: r.detail, createdAt: r.created_at })),
        outbox: role === 'teacher' ? db.prepare('SELECT * FROM outbox WHERE student_id=? ORDER BY created_at DESC LIMIT 100').all(own).map(r => ({ id: r.id, taskId: r.task_id, title: r.title, status: r.status, reason: r.reason, createdAt: r.created_at })) : [],
        questions: role === 'teacher' ? db.prepare('SELECT * FROM questions WHERE student_id=? ORDER BY created_at DESC LIMIT 100').all(own).map(r => ({ id: r.id, studentId: r.student_id, question: r.question, attempt: r.attempt, status: r.status, createdAt: r.created_at })) : [],
        ...companion.bootstrap(role),
        classroom: classroom.bootstrap(role),
        ...library.bootstrap(role),
        ...emailDelivery.bootstrap(role),
        status: { mode: 'local-demo', retrieval: 'lexical-extractive', llm: 'not-connected', email: 'not-configured', identity: 'demo-role-only', scheduler: 'email-scheduler-60s', timezone: 'Asia/Shanghai', realStudentData: false }
      };
    },
    submitPractice: (practiceId, body) => companion.submitPractice(practiceId, body),
    practiceHint: (practiceId, body) => companion.practiceHint(practiceId, body),
    addNote: body => companion.addNote(body),
    checkin: body => companion.checkin(body),
    addFeedback: (role, body) => companion.addFeedback(role, body),
    chat(body) {
      const question = text(body.question, '问题', 500, 2);
      const attempt = body.attempt === undefined ? '' : text(body.attempt, '你的思考', 1000, 0);
      const citations = retrieve(question, library.visibleDocuments(docs()));
      event('question_asked', `演示学生提出问题；检索到 ${citations.length} 条摘录。`);
      if (!citations.length) {
        const questionId = id('question');
        db.prepare('INSERT INTO questions VALUES (?,?,?,?,?,?)').run(questionId, own, question, attempt, 'open', stamp());
        const answer = '当前已审核的学生课程资料没有足够证据支持这个问题。我不会补写结论，已将问题加入本地教师待答队列。';
        const interactionId = library.addInteraction({question,attempt,answer,citations,provider:'local'});
        return { answer, citations: [], followUp: '请先写下你的判断和已查过的资料，或在教师补充资料后再试。此队列没有向教师发送外部通知。', needsTeacher: true, questionId, interactionId, mode: 'lexical-extractive' };
      }
      const answer = `以下为已审核资料的检索摘录（关键词匹配，不是大模型生成答案）：\n\n${citations.map((c, i) => `[${i + 1}] ${c.excerpt}`).join('\n\n')}`;
      const interactionId = library.addInteraction({question,attempt,answer,citations,provider:'local'});
      return { answer, citations, interactionId, followUp: attempt ? '请将你的判断与以上证据逐项对照，说明你会保留或修改哪一点，以及原因。' : '先试着用自己的话作答，再指出哪一条摘录支持你的判断；若仍有疑问，可交给教师核实。', needsTeacher: false, mode: 'lexical-extractive' };
    },
    completeTask(taskId, body) {
      const reflection = text(body.reflection, '学习反思', 1000, 2);
      if (!Number.isInteger(body.confidence) || body.confidence < 1 || body.confidence > 5) fail('信心自评须为 1–5 的整数。');
      const task = db.prepare('SELECT * FROM tasks WHERE id=? AND student_id=?').get(taskId, own);
      if (!task) throw new AppError(404, 'NOT_FOUND', '找不到这个学习任务。');
      if (task.status === 'completed') return { task: asTask(task), alreadyCompleted: true };
      db.prepare("UPDATE tasks SET status='completed',reflection=?,confidence=?,completed_at=? WHERE id=? AND student_id=?").run(reflection, body.confidence, stamp(), taskId, own);
      event('task_completed', `完成任务：${task.title}；信心自评 ${body.confidence}/5。`);
      return { task: asTask(db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId)), alreadyCompleted: false };
    },
    updateSettings(body) {
      if (typeof body.reminders !== 'boolean') fail('reminders 必须为 true 或 false。');
      db.prepare('UPDATE settings SET reminders=? WHERE student_id=?').run(body.reminders ? 1 : 0, own);
      if (!body.reminders) db.prepare("UPDATE outbox SET status='suppressed',reason='学生撤回提醒授权；未发送' WHERE student_id=? AND status='queued'").run(own);
      event('reminder_consent', body.reminders ? '已开启本地提醒模拟；没有获得微信订阅消息授权。' : '已关闭本地提醒模拟；后续模拟发送已停止。');
      return settings();
    },
    addDocument(role, body) {
      teacherOnly(role);
      const title = text(body.title, '资料标题', 160);
      const section = text(body.section, '章节或页码', 160);
      const version = text(body.version, '资料版本', 80);
      const content = text(body.content, '资料正文', 40000, 10);
      if (!['course', 'teacher_exam', 'research'].includes(body.sourceType)) fail('资料类型须为 course、teacher_exam 或 research。');
      if (!['student', 'teacher'].includes(body.audience)) fail('资料可见范围须为 student 或 teacher。');
      if (body.sourceType !== 'course' && body.audience !== 'teacher') fail('考试卷和研究材料仅允许教师可见。', 'PRIVATE_SOURCE');
      const docId = id('doc');
      db.prepare('INSERT INTO documents VALUES (?,?,?,?,?,?,?,?,?,?)').run(docId, title, section, version, content, 'pending', body.sourceType, body.audience, '本地教师手动录入；需核实版权、脱敏与准确性；未自动认定为正式教材。', stamp());
      event('document_added', `新增待审核资料：${title}`, null);
      return { document: asDocument(db.prepare('SELECT * FROM documents WHERE id=?').get(docId)) };
    },
    addChapter: (role, body) => library.addChapter(role, body),
    updateChapter: (role, chapterId, body) => library.updateChapter(role, chapterId, body),
    previewResource: (role, resourceId) => library.previewResource(role, resourceId),
    publishChapter: (role, chapterId, body) => library.publishChapter(role, chapterId, body),
    addResource: (role, meta, filename, mimeType, buffer) => library.addResource(role, meta, filename, mimeType, buffer),
    approveResource: (role, resourceId) => library.approveResource(role, resourceId),
    getResourceFile: (role, resourceId) => library.getFile(role, resourceId),
    updateInteractionAnswer: (interactionId, answer, provider) => library.updateInteractionAnswer(interactionId, answer, provider),
    chatFeedback: (role, interactionId, body) => library.feedback(role, interactionId, body),
    reviewInteraction: (role, interactionId, body) => library.review(role, interactionId, body),
    emailDelivery,
    importCandidates(role, candidates) {
      teacherOnly(role);
      if (!Array.isArray(candidates) || candidates.length > 100) fail('候选资料须为最多 100 项的数组。');
      // Validate the whole batch before writing so a bad entry cannot leave a partial import.
      const validated = candidates.map(candidate => {
        const title = text(candidate.title, '候选资料标题', 160);
        const section = text(candidate.section, '候选章节', 160);
        const version = text(candidate.version, '候选版本', 80);
        const content = text(candidate.content, '候选正文', 40000, 10);
        if (candidate.sourceType !== 'course' || candidate.audience !== 'student') fail('候选导入仅接受已筛选的 course/student 课程材料。');
        if (!candidate.provenance || typeof candidate.provenance !== 'object' || typeof candidate.provenance.path !== 'string' || !/^[a-f0-9]{64}$/i.test(candidate.provenance.sha256 || '')) fail('候选资料必须提供出处 path 和 sha256；脚本不能代替教学审核。');
        const stableId = `candidate-${createHash('sha256').update(candidate.provenance.path + '\n' + content).digest('hex').slice(0, 24)}`;
        return { id: stableId, title, section, version, content, provenance: JSON.stringify(candidate.provenance) };
      });
      let imported = 0;
      db.exec('BEGIN');
      try {
        for (const item of validated) {
          const result = db.prepare('INSERT OR IGNORE INTO documents VALUES (?,?,?,?,?,?,?,?,?,?)').run(item.id, item.title, item.section, item.version, item.content, 'pending', 'course', 'student', item.provenance, stamp());
          if (result.changes) imported++;
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return { imported, skipped: validated.length - imported, status: 'pending', note: '仅作为待审核候选入库；学生检索仍不可见。' };
    },
    approveDocument(role, docId) {
      teacherOnly(role);
      const doc = db.prepare('SELECT * FROM documents WHERE id=?').get(docId);
      if (!doc) throw new AppError(404, 'NOT_FOUND', '找不到这份资料。');
      db.prepare("UPDATE documents SET status='approved' WHERE id=?").run(docId);
      event('document_approved', `已审核资料：${doc.title}；${doc.source_type === 'course' && doc.audience === 'student' ? '可用于学生检索' : '仍仅教师可见'}`, null);
      return { document: asDocument(db.prepare('SELECT * FROM documents WHERE id=?').get(docId)) };
    },
    addTask(role, body) {
      teacherOnly(role);
      const title = text(body.title, '任务标题', 160);
      const description = text(body.description, '任务说明', 2000, 2);
      if (!['pre', 'in', 'post'].includes(body.phase)) fail('任务阶段须为 pre、in 或 post。');
      if (body.dueAt) {
      if (typeof body.dueAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(body.dueAt) || !Number.isFinite(Date.parse(body.dueAt))) fail('任务时间须使用含时区的 ISO 时间，如 2026-10-29T08:00:00+08:00。');
      const [year, month, day] = body.dueAt.slice(0, 10).split('-').map(Number);
      if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) fail('任务日期无效，请检查月份和日期。');
      }
      if (body.releaseAt && (!Number.isFinite(Date.parse(body.releaseAt)) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(body.releaseAt))) fail('任务显示时间须使用含时区的 ISO 时间。');
      if (body.chapterId && !db.prepare('SELECT 1 FROM chapters WHERE id=?').get(body.chapterId)) fail('所选章节不存在。');
      if (body.emailEnabled !== undefined && typeof body.emailEnabled !== 'boolean') fail('邮件发送开关须为 true 或 false。');
      if (body.emailConversation !== undefined && typeof body.emailConversation !== 'boolean') fail('邮件对话回顾开关须为 true 或 false。');
      const taskId = id('task');
      db.prepare('INSERT INTO tasks(id,student_id,title,phase,description,due_at,release_at,chapter_id,email_enabled,email_conversation) VALUES (?,?,?,?,?,?,?,?,?,?)').run(taskId, own, title, body.phase, description, body.dueAt || '', body.releaseAt || null, body.chapterId || null, body.emailEnabled ? 1 : 0, body.emailConversation === false ? 0 : 1);
      event('task_assigned', `教师创建任务：${title}`);
      return { task: asTask(db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId)) };
    },
    runScheduler(role = 'teacher') {
      teacherOnly(role);
      return { simulated:0, skipped:0, deferred:0, reason:'本地提醒模拟已停用；任务通知由QQ邮件发件箱处理。', externalSent:0 };
    }
  };
}
