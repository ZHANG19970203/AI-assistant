import {randomUUID} from 'node:crypto';

export function createLessonTools({db,now,teacherOnly,AppError,access,stage}) {
  const fail=message=>{throw new AppError(400,'LESSON_TOOLS',message);};
  const stamp=()=>now().toISOString();
  db.exec(`CREATE TABLE IF NOT EXISTS lesson_question_bank(id TEXT PRIMARY KEY,chapter_id TEXT,phase TEXT,question TEXT,created_at TEXT);
    CREATE TABLE IF NOT EXISTS lesson_feedback(id TEXT PRIMARY KEY,access_id TEXT,phase TEXT,content TEXT,reply TEXT DEFAULT '',created_at TEXT,replied_at TEXT);
    CREATE TABLE IF NOT EXISTS lesson_images(id TEXT PRIMARY KEY,chapter_id TEXT,access_id TEXT,phase TEXT,mime TEXT,bytes BLOB,created_at TEXT);
    CREATE TABLE IF NOT EXISTS lesson_tools_migrations(id TEXT PRIMARY KEY);`);
  // Copy the latest existing plan into editable chapter drafts once. Assigned plans remain immutable.
  if(!db.prepare('SELECT 1 FROM lesson_tools_migrations WHERE id=?').get('question-bank-v1')){
    db.exec('BEGIN');try{
      const seen=new Set();
      for(const plan of db.prepare('SELECT chapter_id,stages FROM lesson_plans ORDER BY created_at DESC,rowid DESC').all()){
        if(seen.has(plan.chapter_id))continue;seen.add(plan.chapter_id);
        for(const [phase,s] of Object.entries(JSON.parse(plan.stages))){
          if(db.prepare('SELECT 1 FROM lesson_question_bank WHERE chapter_id=? AND phase=?').get(plan.chapter_id,phase))continue;
          for(const {id:oldId,...q} of (s.questions||[]))db.prepare('INSERT INTO lesson_question_bank VALUES (?,?,?,?,?)').run(randomUUID(),plan.chapter_id,phase,JSON.stringify(q),stamp());
        }
      }
      db.prepare('INSERT INTO lesson_tools_migrations VALUES (?)').run('question-bank-v1');db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
  }
  const validPhase=p=>{if(!['pre','in','post'].includes(p))fail('请选择课前、课中或课后');};
  function questions(role){teacherOnly(role);return db.prepare('SELECT * FROM lesson_question_bank ORDER BY created_at,rowid').all().map(r=>({id:r.id,chapterId:r.chapter_id,phase:r.phase,...JSON.parse(r.question)}));}
  function question(role,input){teacherOnly(role);validPhase(input.phase);
    if(!db.prepare('SELECT 1 FROM chapters WHERE id=?').get(input.chapterId||''))fail('请选择章节');
    const old=input.id?db.prepare('SELECT * FROM lesson_question_bank WHERE id=? AND chapter_id=? AND phase=?').get(input.id,input.chapterId,input.phase):null;
    if(input.id&&!old)fail('题目不存在，请刷新后再试');
    if(input.action==='delete'){if(!old)fail('请选择要删除的题目');db.prepare('DELETE FROM lesson_question_bank WHERE id=?').run(old.id);return {saved:true,questions:questions(role)};}
    const q=input.question;
    if(!q||typeof q.prompt!=='string'||!q.prompt.trim()||q.prompt.length>1000||!Array.isArray(q.options)||q.options.length!==4||q.options.some(x=>typeof x!=='string'||!x.trim()||x.length>500)||!Number.isInteger(q.correct)||q.correct<0||q.correct>3)fail('请填写题干、4个选项和正确选项');
    if(!old&&db.prepare('SELECT COUNT(*) AS n FROM lesson_question_bank WHERE chapter_id=? AND phase=?').get(input.chapterId,input.phase).n>=20)fail('每阶段最多20题');
    const value=JSON.stringify({prompt:q.prompt.trim(),options:q.options.map(x=>x.trim()),correct:q.correct,explanation:String(q.explanation||'').slice(0,2000)}),id=old?.id||randomUUID();
    db.prepare('INSERT INTO lesson_question_bank VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET question=excluded.question').run(id,input.chapterId,input.phase,value,stamp());return {id,saved:true,questions:questions(role)};
  }
  const messages=token=>db.prepare('SELECT id,phase,content,reply,created_at,replied_at FROM lesson_feedback WHERE access_id=? ORDER BY created_at DESC,rowid DESC').all(access(token).a.id);
  function feedback(token,input){const {a,p}=access(token);validPhase(input.phase);if(!p.stages[input.phase]?.enabled)fail('该阶段未布置');const content=String(input.content||'').trim();if(!content||content.length>2000)fail('请填写反馈，最多2000字');const id=randomUUID();db.prepare("INSERT INTO lesson_feedback VALUES (?,?,?,?,'',?,NULL)").run(id,a.id,input.phase,content,stamp());return {id,saved:true};}
  function allFeedback(role){teacherOnly(role);return db.prepare('SELECT f.*,a.recipient,a.preview,p.title FROM lesson_feedback f JOIN lesson_access a ON a.id=f.access_id JOIN lesson_plans p ON p.id=a.plan_id ORDER BY f.created_at DESC,f.rowid DESC').all();}
  function reply(role,input){teacherOnly(role);const content=String(input.content||'').trim();if(!content||content.length>2000)fail('请填写回复，最多2000字');if(!db.prepare('SELECT 1 FROM lesson_feedback WHERE id=?').get(input.id||''))fail('反馈不存在');db.prepare('UPDATE lesson_feedback SET reply=?,replied_at=? WHERE id=?').run(content,stamp(),input.id);return {saved:true};}
  function imageUpload(role,token,input,bytes){let chapterId=input.chapterId||'',accessId='',mode='new';validPhase(input.phase);
    if(token){const ctx=stage(token,input.phase);if(!ctx.s.mindmap)fail('本阶段未布置思维导图');accessId=ctx.a.id;chapterId=ctx.p.chapter_id;mode=ctx.mode;}
    else {teacherOnly(role);if(!db.prepare('SELECT 1 FROM chapters WHERE id=?').get(chapterId))fail('请选择章节');}
    if(!bytes.length||bytes.length>5*1024*1024)fail('图片最大5 MB');
    const mime=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':bytes[0]===255&&bytes[1]===216&&bytes[2]===255?'image/jpeg':bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'?'image/webp':'';
    if(!mime)fail('请选择PNG、JPG或WebP图片');const id=randomUUID();
    db.exec('BEGIN');try {db.prepare('INSERT INTO lesson_images VALUES (?,?,?,?,?,?,?)').run(id,chapterId,accessId,input.phase,mime,bytes,stamp());if(token)db.prepare('INSERT INTO lesson_submissions VALUES (?,?,?,?,?,?,?)').run(randomUUID(),accessId,input.phase,'mindmap','image:'+id,stamp(),mode);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}return {id,saved:true};
  }
  function validateImage(id,chapterId){if(id&&!db.prepare("SELECT 1 FROM lesson_images WHERE id=? AND chapter_id=? AND access_id=''").get(id,chapterId))fail('导图图片不属于本章');return id||'';}
  function image(role,token,id,phase){const r=db.prepare('SELECT * FROM lesson_images WHERE id=?').get(id);if(!r)throw new AppError(404,'IMAGE_MISSING','图片不存在');if(token){const {a,s}=stage(token,phase);if(!(r.access_id===a.id&&r.phase===phase)&&s.mindmapImageId!==id)throw new AppError(403,'IMAGE_DENIED','无权查看此图片');}else teacherOnly(role);return r;}
  return {questions,question,messages,feedback,allFeedback,reply,imageUpload,image,validateImage};
}
