import {randomUUID} from 'node:crypto';
export const DIMENSIONS=[['pre_discussion','课前讨论'],['in_discussion','课中讨论'],['post_discussion','课后讨论'],['pre_video','课前视频'],['pre_movement','课前体感'],['post_mindmap','课后导图']];
const WEEK=7*24*60*60*1000;
const PHASES=['pre','in','post'];
export const modeOf=token=>typeof token==='object'?token.mode||'new':'new';
export function createStudyPolicy({db,now,AppError,teacherOnly}){
  db.exec(`CREATE TABLE IF NOT EXISTS study_limits(learner TEXT PRIMARY KEY,attempts INTEGER DEFAULT 0,locked INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS makeup_requests(id TEXT PRIMARY KEY,learner TEXT,access_id TEXT,phase TEXT,status TEXT,created_at TEXT,granted_until TEXT,reason TEXT);
    CREATE TABLE IF NOT EXISTS study_resets(id TEXT PRIMARY KEY,learner TEXT,created_at TEXT,reason TEXT);`);
  if(!db.prepare('PRAGMA table_info(mail_contacts)').all().some(c=>c.name==='selected'))db.exec('ALTER TABLE mail_contacts ADD COLUMN selected INTEGER NOT NULL DEFAULT 1');
  db.exec('CREATE TABLE IF NOT EXISTS study_migrations(id TEXT PRIMARY KEY)');
  if(!db.prepare('SELECT 1 FROM study_migrations WHERE id=?').get('historical-contacts-v7')){
    db.exec('BEGIN');try{
      for(const table of ['email_deliveries','bulk_mail'])if(db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table))db.exec("INSERT OR IGNORE INTO mail_contacts(email,name,source,created_at,selected) SELECT lower(recipient),'','历史发送',COALESCE(sent_at,scheduled_at),1 FROM "+table+" WHERE status='sent' AND recipient<>''");
      db.prepare('INSERT INTO study_migrations VALUES (?)').run('historical-contacts-v7');db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
  }
  function migrate(){for(const table of ['lesson_events','lesson_answers','lesson_chats','lesson_submissions','study_recordings'])if(db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table)&&!db.prepare(`PRAGMA table_info(${table})`).all().some(c=>c.name==='mode'))db.exec(`ALTER TABLE ${table} ADD COLUMN mode TEXT NOT NULL DEFAULT 'new'`);}
  const key=a=>a.preview?'preview:'+a.id:a.recipient.trim().toLowerCase();
  const limit=a=>db.prepare('SELECT * FROM study_limits WHERE learner=?').get(key(a))||{attempts:0,locked:0};
  function window(a,s){const start=Math.max(Date.parse(a.created_at),s.releaseAt?Date.parse(s.releaseAt):0);return {start,end:start+WEEK};}
  function state(a,s,phase,mode='new'){
    const w=window(a,s),l=limit(a),time=now().getTime();const grant=db.prepare("SELECT * FROM makeup_requests WHERE access_id=? AND phase=? AND status='approved' AND granted_until>? ORDER BY created_at DESC LIMIT 1").get(a.id,phase,now().toISOString());
    const pending=db.prepare("SELECT id FROM makeup_requests WHERE access_id=? AND phase=? AND status='pending'").get(a.id,phase);
    return {open:!!s.enabled&&!l.locked&&time>=w.start&&(mode==='makeup'?!!grant:time<w.end),expired:time>=w.end,locked:!!l.locked,opensAt:new Date(w.start).toISOString(),expiresAt:new Date(w.end).toISOString(),grantUntil:grant?.granted_until||null,pending:!!pending,attempts:l.attempts,remaining:Math.max(0,3-l.attempts)};
  }
  function gate(a,s,phase,mode){if(!['new','review','makeup'].includes(mode))throw new AppError(400,'INVALID_MODE','学习模式无效');const status=state(a,s,phase,mode);if(!status.open)throw new AppError(403,status.locked?'COURSE_LOCKED':'STAGE_CLOSED',status.locked?'课程已锁定，请联系教师。':status.expired?'已超过7天，请进入亡羊补牢学习申请。':'当前阶段尚未开放。');return status;}
  function learnerAccesses(a){return a.preview?[a]:db.prepare('SELECT * FROM lesson_access WHERE lower(recipient)=? AND preview=0 AND revoked=0 ORDER BY created_at DESC').all(key(a));}
  const plan=a=>{const p=db.prepare('SELECT * FROM lesson_plans WHERE id=?').get(a.plan_id);return {...p,stages:JSON.parse(p.stages)};};
  function history(a){return learnerAccesses(a).flatMap(x=>{const p=plan(x);return PHASES.filter(phase=>p.stages[phase].enabled).map(phase=>{const status=state(x,p.stages[phase],phase);return {accessId:x.id,title:p.title,phase,reviewVisits:db.prepare("SELECT COUNT(*) AS n FROM lesson_events WHERE access_id=? AND phase=? AND mode='review' AND kind='phase_open'").get(x.id,phase).n,...status,reviewURL:`/study.html#token=${x.token}&phase=${phase}&mode=review`,makeupURL:`/study.html#token=${x.token}&phase=${phase}&mode=makeup`};});});}
  function request(a,p,phase){const s=p.stages[phase];if(!s?.enabled)throw new AppError(400,'NO_PHASE','阶段不存在');const st=state(a,s,phase);if(!st.expired)throw new AppError(400,'NOT_EXPIRED','尚在学习期限内');const existing=db.prepare("SELECT * FROM makeup_requests WHERE access_id=? AND phase=? AND status='pending'").get(a.id,phase);if(existing)return {status:'pending',duplicate:true,...limit(a)};if(st.grantUntil)return {status:'approved',grantUntil:st.grantUntil};
    const learner=key(a);db.prepare('INSERT OR IGNORE INTO study_limits(learner) VALUES (?)').run(learner);const l=limit(a);if(l.locked)return {status:'locked',attempts:l.attempts};
    db.exec('BEGIN');try{const attempts=l.attempts+1,locked=attempts>3;db.prepare('UPDATE study_limits SET attempts=?,locked=? WHERE learner=?').run(attempts,locked?1:0,learner);db.prepare('INSERT INTO makeup_requests VALUES (?,?,?,?,?,?,NULL,?)').run(randomUUID(),learner,a.id,phase,locked?'exhausted':'pending',now().toISOString(),locked?'申请机会已用完':'');db.exec('COMMIT');return {status:locked?'locked':'pending',attempts};}catch(e){db.exec('ROLLBACK');throw e;}
  }
  function decide(role,input){teacherOnly(role);const r=db.prepare('SELECT * FROM makeup_requests WHERE id=?').get(input.id);if(!r||r.status!=='pending')throw new AppError(400,'NOT_PENDING','申请已处理或不存在');if(!['approve','reject'].includes(input.action))throw new AppError(400,'INVALID_ACTION','请选择批准或拒绝');if(db.prepare('SELECT locked FROM study_limits WHERE learner=?').get(r.learner)?.locked)throw new AppError(403,'COURSE_LOCKED','课程已锁定，请先重置');db.prepare('UPDATE makeup_requests SET status=?,granted_until=?,reason=? WHERE id=?').run(input.action==='approve'?'approved':'rejected',input.action==='approve'?new Date(now().getTime()+WEEK).toISOString():null,String(input.reason||'').slice(0,500),r.id);return {saved:true};}
  function reset(role,input){teacherOnly(role);if(input.confirm!==true)throw new AppError(400,'CONFIRM','请确认重置');db.prepare('UPDATE study_limits SET attempts=0,locked=0 WHERE learner=?').run(input.learner);db.prepare("UPDATE makeup_requests SET status='reset' WHERE learner=? AND status='pending'").run(input.learner);db.prepare('INSERT INTO study_resets VALUES (?,?,?,?)').run(randomUUID(),input.learner,now().toISOString(),String(input.reason||'教师重置').slice(0,500));return {saved:true};}
  function stats(a){const dimensions=DIMENSIONS.map(([id,label])=>({id,label,done:0,total:0})),modules={};const items=[];
    for(const acc of learnerAccesses(a)){const p=plan(acc);for(const phase of PHASES){const s=p.stages[phase],w=window(acc,s);if(!s.enabled||now().getTime()<w.start)continue;
      const params=[acc.id,phase,new Date(w.start).toISOString(),new Date(w.end).toISOString()];
      const events=db.prepare("SELECT * FROM lesson_events WHERE access_id=? AND phase=? AND mode='new' AND created_at>=? AND created_at<?").all(...params).map(e=>({...e,detail:JSON.parse(e.detail)}));
      const submissions=db.prepare("SELECT * FROM lesson_submissions WHERE access_id=? AND phase=? AND mode='new' AND created_at>=? AND created_at<?").all(...params);
      const answers=db.prepare("SELECT * FROM lesson_answers WHERE access_id=? AND phase=? AND mode='new' AND created_at>=? AND created_at<?").all(...params);
      const put=(module,key,done,dimension=null)=>{modules[module]||={done:0,total:0};modules[module].total++;if(done)modules[module].done++;const d=dimensions.find(d=>d.id===dimension);if(d){d.total++;if(done)d.done++;}items.push({accessId:acc.id,phase,key,module,done:!!done,dimension});};
      if(s.thinking)put('讨论','discussion',submissions.some(x=>x.kind==='reflection'),phase+'_discussion');
      if(s.movement)put('体感','movement',submissions.some(x=>x.kind==='movement'),phase==='pre'?'pre_movement':null);
      if(s.mindmap)put('导图','mindmap',submissions.some(x=>x.kind==='mindmap'),phase==='post'?'post_mindmap':null);
      for(const q of s.questions)put('练习',q.id,answers.some(x=>x.question_id===q.id));
      if(s.oral)put('口头题','oral',!!db.prepare("SELECT 1 FROM study_recordings WHERE access_id=? AND phase=? AND kind='oral' AND mode='new' AND expected>0 AND created_at>=? AND created_at<?").get(...params));
      for(const id of s.resourceIds){const r=db.prepare('SELECT kind,title FROM course_resources WHERE id=?').get(id);if(!r)continue;let done=events.some(e=>e.resource_id===id&&e.kind==='resource_open');if(r.kind==='video'||r.kind==='audio'){
          const segments=events.filter(e=>e.resource_id===id&&e.kind==='video_progress');const duration=Math.max(0,...segments.map(e=>Number(e.detail.duration)||0));const intervals=segments.flatMap(e=>e.detail.ranges||[]).sort((a,b)=>a[0]-b[0]);let end=0,watched=0;for(const [from,to] of intervals){watched+=Math.max(0,to-Math.max(from,end));end=Math.max(end,to);}done=duration>0&&watched>=duration*.9;
        }put(r.kind==='video'?'视频':r.kind==='audio'?'音频':'文档',id,done,phase==='pre'&&r.kind==='video'?'pre_video':null);}
    }}
    for(const d of dimensions)d.percent=d.total?Math.round(d.done/d.total*100):null;return {dimensions,modules,items};
  }
  function admin(role){teacherOnly(role);return {requests:db.prepare('SELECT r.*,a.recipient,p.title FROM makeup_requests r JOIN lesson_access a ON a.id=r.access_id JOIN lesson_plans p ON p.id=a.plan_id ORDER BY r.created_at DESC').all(),limits:db.prepare('SELECT * FROM study_limits').all()};}
  function contact(role,input){teacherOnly(role);
    if(input.action==='selectAll'){db.prepare('UPDATE mail_contacts SET selected=?').run(input.selected?1:0);return {saved:true};}
    if(input.action==='deleteMany'){if(!Array.isArray(input.emails)||input.emails.length>1000)throw new AppError(400,'INVALID_LIST','名单无效');db.exec('BEGIN');try{for(const e of input.emails)db.prepare('DELETE FROM mail_contacts WHERE email=?').run(String(e).toLowerCase());db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}return {saved:true};}
    const email=String(input.email||'').trim().toLowerCase();if(!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)||email.length>254)throw new AppError(400,'EMAIL_INVALID','邮箱格式无效');
    if(input.action==='delete'){db.prepare('DELETE FROM mail_contacts WHERE email=?').run(email);return {saved:true};}
    if(input.action==='select'){db.prepare('UPDATE mail_contacts SET selected=? WHERE email=?').run(input.selected?1:0,email);return {saved:true};}
    db.prepare('INSERT INTO mail_contacts(email,name,source,created_at,selected) VALUES (?,?,?,?,1) ON CONFLICT(email) DO UPDATE SET name=excluded.name').run(email,String(input.name||'').slice(0,100),'手动添加',now().toISOString());return {saved:true};}
  return {contact,migrate,key,state,gate,history,request,decide,reset,stats,admin};
}
