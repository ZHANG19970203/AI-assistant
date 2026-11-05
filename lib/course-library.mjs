import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { extractResourceText } from './resource-parser.mjs';

const makeId = prefix => `${prefix}-${randomUUID()}`;
const released = (value, now) => !value || Date.parse(value) <= now.getTime();
const asChapter = r => ({ id:r.id, parentId:r.parent_id||null, title:r.title, summary:r.summary, position:r.position, status:r.status, releaseAt:r.release_at, createdAt:r.created_at });
const asResource = r => ({ id:r.id, documentId:r.document_id, chapterId:r.chapter_id, title:r.title, kind:r.kind, filename:r.filename, mimeType:r.mime_type, fileSize:r.file_size, extractionStatus:r.extraction_status, releaseAt:r.release_at, status:r.status, sourceType:r.source_type, audience:r.audience, section:r.section, version:r.version, createdAt:r.created_at, fileUrl:`/api/resources/${encodeURIComponent(r.id)}/file` });
const asInteraction = r => ({ id:r.id, question:r.question, attempt:r.attempt, answer:r.answer, citations:JSON.parse(r.citations||'[]'), provider:r.provider, feedback:r.feedback, feedbackNote:r.feedback_note, reviewed:!!r.reviewed, createdAt:r.created_at });

export function createCourseLibrary({ db, dbPath, now, AppError, text, teacherOnly }) {
  const stamp = () => now().toISOString();
  const storageDir = dbPath === ':memory:' ? resolve(process.cwd(), '.runtime/course-resources') : resolve(dirname(dbPath), 'runtime/course-resources');
  mkdirSync(storageDir, { recursive: true });
  db.exec(`CREATE TABLE IF NOT EXISTS chapters(id TEXT PRIMARY KEY,title TEXT NOT NULL,summary TEXT NOT NULL,position INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('draft','published')),release_at TEXT,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS course_resources(id TEXT PRIMARY KEY,document_id TEXT,chapter_id TEXT REFERENCES chapters(id),title TEXT NOT NULL,kind TEXT NOT NULL,filename TEXT NOT NULL,mime_type TEXT NOT NULL,file_path TEXT NOT NULL,file_size INTEGER NOT NULL,extraction_status TEXT NOT NULL,release_at TEXT,status TEXT NOT NULL CHECK(status IN ('pending','approved')),source_type TEXT NOT NULL,audience TEXT NOT NULL,section TEXT NOT NULL,version TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS chat_interactions(id TEXT PRIMARY KEY,student_id TEXT NOT NULL,question TEXT NOT NULL,attempt TEXT NOT NULL,answer TEXT NOT NULL,citations TEXT NOT NULL,provider TEXT NOT NULL,feedback TEXT,feedback_note TEXT,reviewed INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
  `);
  const columns = table => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name));
  if (!columns('chapters').has('parent_id')) db.exec('ALTER TABLE chapters ADD COLUMN parent_id TEXT REFERENCES chapters(id)');
  if (!columns('tasks').has('chapter_id')) db.exec('ALTER TABLE tasks ADD COLUMN chapter_id TEXT REFERENCES chapters(id)');
  if (!columns('tasks').has('release_at')) db.exec('ALTER TABLE tasks ADD COLUMN release_at TEXT');
  const chapterRows = () => db.prepare('SELECT * FROM chapters ORDER BY position,id').all();
  const resourceRows = () => db.prepare('SELECT * FROM course_resources ORDER BY created_at DESC,id').all();
  const studentChapter = (chapterId, time = now()) => {
    if (!chapterId) return true;
    const visited=new Set();let id=chapterId;
    while(id){if(visited.has(id))return false;visited.add(id);const c=db.prepare('SELECT * FROM chapters WHERE id=?').get(id);if(!c||c.status!=='published'||!released(c.release_at,time))return false;id=c.parent_id;}
    return true;
  };
  const canStudentSee = (r, time = now()) => r.status === 'approved' && r.source_type === 'course' && r.audience === 'student' && released(r.release_at, time) && studentChapter(r.chapter_id, time);
  const listResources = role => resourceRows().filter(r => role === 'teacher' || canStudentSee(r)).map(asResource);
  const listChapters = role => chapterRows().filter(r => role === 'teacher' || studentChapter(r.id)).map(asChapter);
  function parentValue(value,ownId=null){const parent=value||null;if(parent!==null&&typeof parent!=='string')throw new AppError(400,'INVALID_PARENT','上级目录无效。');const seen=new Set(ownId?[ownId]:[]);let id=parent;
    while(id){if(seen.has(id))throw new AppError(400,'CHAPTER_CYCLE','不能将目录放到自己或自己的子目录下。');seen.add(id);const c=db.prepare('SELECT parent_id FROM chapters WHERE id=?').get(id);if(!c)throw new AppError(400,'CHAPTER_NOT_FOUND','上级目录不存在。');id=c.parent_id;}return parent;}
  return {
    bootstrap(role) {
      return { chapters:listChapters(role), resources:listResources(role), improvementQueue:role === 'teacher' ? db.prepare(`SELECT * FROM chat_interactions WHERE reviewed=0 AND (feedback='needs_review' OR feedback='not_helpful' OR json_array_length(citations)=0) ORDER BY created_at DESC LIMIT 100`).all().map(asInteraction) : [] };
    },
    addChapter(role, body) {
      teacherOnly(role);
      const title = text(body.title, '章节名称', 160);
      const summary = body.summary ? text(body.summary, '章节简介', 1000, 0) : '';
      const parentId=parentValue(body.parentId);
      const position = body.position===undefined?Math.max(0,...chapterRows().filter(c=>(c.parent_id||null)===parentId).map(c=>c.position))+1:Number(body.position);
      if(!Number.isInteger(position)||position<1||position>100000)throw new AppError(400,'INVALID_POSITION','章节顺序须为正整数。');
      const releaseAt = body.releaseAt || null;
      if (releaseAt && !Number.isFinite(Date.parse(releaseAt))) throw new AppError(400, 'INVALID_DATE', '章节发布时间无效。');
      const chapterId = makeId('chapter');
      const status = body.publishNow || releaseAt ? 'published' : 'draft';
      db.prepare('INSERT INTO chapters(id,title,summary,position,status,release_at,created_at,parent_id) VALUES (?,?,?,?,?,?,?,?)').run(chapterId,title,summary,position,status,releaseAt,stamp(),parentId);
      return { chapter:asChapter(db.prepare('SELECT * FROM chapters WHERE id=?').get(chapterId)) };
    },
    updateChapter(role, chapterId, body = {}) {
      teacherOnly(role);
      const row = db.prepare('SELECT * FROM chapters WHERE id=?').get(chapterId);
      if (!row) throw new AppError(404, 'NOT_FOUND', '找不到这个课程章节。');
      const title = body.title===undefined?row.title:text(body.title, '章节名称', 160);
      const parentId=Object.hasOwn(body,'parentId')?parentValue(body.parentId,chapterId):row.parent_id;
      const position=body.position===undefined?row.position:Number(body.position);
      if(!Number.isInteger(position)||position<1||position>100000)throw new AppError(400,'INVALID_POSITION','章节顺序须为正整数。');
      const status=body.status===undefined?row.status:body.status;if(!['published','draft'].includes(status))throw new AppError(400,'INVALID_STATUS','章节状态无效。');
      const releaseAt=Object.hasOwn(body,'releaseAt')?(body.releaseAt||null):row.release_at;if(releaseAt&&!Number.isFinite(Date.parse(releaseAt)))throw new AppError(400,'INVALID_DATE','章节发布时间无效。');
      db.prepare('UPDATE chapters SET title=?,parent_id=?,position=?,status=?,release_at=? WHERE id=?').run(title,parentId,position,status,releaseAt,chapterId);
      return { chapter:asChapter(db.prepare('SELECT * FROM chapters WHERE id=?').get(chapterId)) };
    },
    previewResource(role, resourceId) {
      teacherOnly(role);
      const row = db.prepare('SELECT * FROM course_resources WHERE id=?').get(resourceId);
      if (!row) throw new AppError(404,'NOT_FOUND','找不到这份资料。');
      return { ...asResource(row),content:row.content };
    },
    publishChapter(role, chapterId, body = {}) {
      teacherOnly(role);
      const row = db.prepare('SELECT * FROM chapters WHERE id=?').get(chapterId);
      if (!row) throw new AppError(404, 'NOT_FOUND', '找不到这个课程章节。');
      const releaseAt = body.releaseAt || null;
      if (releaseAt && !Number.isFinite(Date.parse(releaseAt))) throw new AppError(400, 'INVALID_DATE', '章节发布时间无效。');
      db.prepare("UPDATE chapters SET status=?,release_at=? WHERE id=?").run(body.unpublish ? 'draft' : 'published',releaseAt,chapterId);
      return { chapter:asChapter(db.prepare('SELECT * FROM chapters WHERE id=?').get(chapterId)) };
    },
    async addResource(role, meta, filename, mimeType, buffer) {
      teacherOnly(role);
      const title = text(meta.title || filename, '资料名称', 160);
      const chapterId = meta.chapterId ? text(meta.chapterId, '所属章节', 100) : null;
      if (chapterId && !db.prepare('SELECT 1 FROM chapters WHERE id=?').get(chapterId)) throw new AppError(400, 'CHAPTER_NOT_FOUND', '所选课程章节不存在。');
      const section = meta.section ? text(meta.section, '资料位置', 160) : '课程资料';
      const version = meta.version ? text(meta.version, '资料版本', 80) : '教师上传';
      const sourceType = meta.sourceType || 'course';
      const audience = meta.audience || 'student';
      if (!['course','teacher_exam','research'].includes(sourceType) || !['student','teacher'].includes(audience)) throw new AppError(400,'INVALID_SCOPE','资料类型或可见范围无效。');
      if (sourceType !== 'course' && audience !== 'teacher') throw new AppError(400,'PRIVATE_SOURCE','试卷和研究材料仅允许教师查看。');
      const releaseAt = meta.releaseAt || null;
      if (releaseAt && !Number.isFinite(Date.parse(releaseAt))) throw new AppError(400,'INVALID_DATE','资料发布时间无效。');
      const safeExt = extname(filename).toLowerCase().replace(/[^.a-z0-9]/g,'').slice(0,12);
      const resourceId = makeId('resource');
      const filePath = resolve(storageDir, `${resourceId}${safeExt}`);
      const parsed = extractResourceText(filename, buffer);
      writeFileSync(filePath, buffer, { flag:'wx', mode:0o600 });
      const docId = parsed.content.length >= 10 && sourceType === 'course' ? makeId('doc') : null;
      db.exec('BEGIN');
      try {
        if (docId) db.prepare('INSERT INTO documents(id,title,section,version,content,status,source_type,audience,provenance,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(docId,title,section,version,parsed.content,'pending','course',audience,`教师上传文件：${filename}；请核对来源、版权、文字提取与教学准确性。`,stamp());
        db.prepare('INSERT INTO course_resources VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(resourceId,docId,chapterId,title,(['mp4','webm','mov','m4v'].includes(filename.toLowerCase().split('.').pop())?'video':['mp3','m4a','wav','ogg'].includes(filename.toLowerCase().split('.').pop())?'audio':['pdf','docx','pptx'].includes(filename.toLowerCase().split('.').pop())?'document':'text'),filename,mimeType||'application/octet-stream',filePath,buffer.length,parsed.status,releaseAt,'pending',sourceType,audience,section,version,parsed.content,stamp());
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return { resource:asResource(db.prepare('SELECT * FROM course_resources WHERE id=?').get(resourceId)), indexed:!!docId, extraction:parsed.status };
    },
    approveResource(role, resourceId) {
      teacherOnly(role);
      const row = db.prepare('SELECT * FROM course_resources WHERE id=?').get(resourceId);
      if (!row) throw new AppError(404,'NOT_FOUND','找不到这份上传资料。');
      db.prepare("UPDATE course_resources SET status='approved' WHERE id=?").run(resourceId);
      if (row.document_id) db.prepare("UPDATE documents SET status='approved' WHERE id=?").run(row.document_id);
      return { resource:asResource(db.prepare('SELECT * FROM course_resources WHERE id=?').get(resourceId)) };
    },
    getFile(role, resourceId) {
      const row = db.prepare('SELECT * FROM course_resources WHERE id=?').get(resourceId);
      if (!row || (role !== 'teacher' && !canStudentSee(row))) throw new AppError(404,'NOT_FOUND','找不到这份资料，或资料尚未对学生开放。');
      return { path:row.file_path, mimeType:row.mime_type, size:row.file_size, filename:row.filename };
    },
    visibleDocuments(documents) {
      const byDoc = new Map(resourceRows().filter(r => r.document_id).map(r => [r.document_id,r]));
      return documents.filter(d => { const r = byDoc.get(d.id); return !r || canStudentSee(r); });
    },
    chaptersForRole: role => listChapters(role),
    tasksForRole(role, tasks) { return role === 'teacher' ? tasks : tasks.filter(t => released(t.releaseAt,now()) && studentChapter(t.chapterId)); },
    addInteraction({question,attempt,answer,citations,provider='local'}) {
      const interactionId = makeId('interaction');
      db.prepare('INSERT INTO chat_interactions(id,student_id,question,attempt,answer,citations,provider,created_at) VALUES (?,?,?,?,?,?,?,?)').run(interactionId,'demo-student',question,attempt,answer,JSON.stringify(citations||[]),provider,stamp());
      return interactionId;
    },
    updateInteractionAnswer(interactionId, answer, provider) {
      db.prepare('UPDATE chat_interactions SET answer=?,provider=? WHERE id=?').run(answer,provider,interactionId);
    },
    feedback(role, interactionId, body) {
      if (role !== 'student') throw new AppError(403,'STUDENT_ONLY','此反馈仅供学习者提交。');
      if (!['helpful','not_helpful','needs_review'].includes(body.rating)) throw new AppError(400,'INVALID_FEEDBACK','请选择有效的答疑反馈。');
      const row = db.prepare('SELECT id FROM chat_interactions WHERE id=? AND student_id=?').get(interactionId,'demo-student');
      if (!row) throw new AppError(404,'NOT_FOUND','找不到这条答疑记录。');
      const note = body.note ? text(body.note,'补充意见',500,0) : '';
      db.prepare('UPDATE chat_interactions SET feedback=?,feedback_note=? WHERE id=?').run(body.rating,note,interactionId);
      return { saved:true, note:'反馈已记入本地教师复核队列，不会自动用于训练模型。' };
    },
    review(role, interactionId, body) {
      teacherOnly(role);
      const row = db.prepare('SELECT * FROM chat_interactions WHERE id=?').get(interactionId);
      if (!row) throw new AppError(404,'NOT_FOUND','找不到这条答疑记录。');
      const correction = text(body.correction,'教师修订内容',40000,10);
      const title = text(body.title || `教师答疑修订：${row.question.slice(0,50)}`,'修订标题',160);
      const section = text(body.section || '教师答疑修订','课程位置',160);
      const chapterId = body.chapterId || null;
      if (chapterId && !db.prepare('SELECT 1 FROM chapters WHERE id=?').get(chapterId)) throw new AppError(400,'CHAPTER_NOT_FOUND','所选课程章节不存在。');
      const docId = makeId('doc');
      db.prepare('INSERT INTO documents(id,title,section,version,content,status,source_type,audience,provenance,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(docId,title,section,'教师修订',correction,'pending','course','student',`由教师依据学习者答疑记录修订；原始对话不自动训练模型；需再次审核后进入课程检索。`,stamp());
      db.prepare('UPDATE chat_interactions SET reviewed=1 WHERE id=?').run(interactionId);
      return { documentId:docId, status:'pending' };
    }
  };
}
