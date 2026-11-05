import { createBulkMail } from './bulk-mail.mjs';
import { randomUUID } from 'node:crypto';

const studentId='demo-student';
const makeId=()=>`mail-${randomUUID()}`;
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dateLabel=value=>value?new Intl.DateTimeFormat('zh-CN',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Shanghai'}).format(new Date(value)):'创建后开放';
const phases={pre:'课前',in:'课中',post:'课后'};

export function createEmailDelivery({db,now,AppError,text,teacherOnly}){
  db.exec(`CREATE TABLE IF NOT EXISTS email_profiles(student_id TEXT PRIMARY KEY,email TEXT NOT NULL DEFAULT '',consent INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS email_deliveries(id TEXT PRIMARY KEY,student_id TEXT NOT NULL,task_id TEXT NOT NULL REFERENCES tasks(id),recipient TEXT NOT NULL DEFAULT '',subject TEXT NOT NULL,body_text TEXT NOT NULL,body_html TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('queued','sent','held','failed')),reason TEXT NOT NULL,message_id TEXT,scheduled_at TEXT NOT NULL,created_at TEXT NOT NULL,sent_at TEXT,UNIQUE(student_id,task_id));`);
  const columns=new Set(db.prepare('PRAGMA table_info(tasks)').all().map(r=>r.name));
  if(!columns.has('email_enabled'))db.exec('ALTER TABLE tasks ADD COLUMN email_enabled INTEGER NOT NULL DEFAULT 0');
  if(!columns.has('email_conversation'))db.exec('ALTER TABLE tasks ADD COLUMN email_conversation INTEGER NOT NULL DEFAULT 1');
  const stamp=()=>now().toISOString();
  const profile=()=>db.prepare('SELECT * FROM email_profiles WHERE student_id=?').get(studentId)||{student_id:studentId,email:'',consent:0,updated_at:null};
  const taskRow=taskId=>db.prepare(`SELECT t.*,c.title AS chapter_title,c.summary AS chapter_summary,c.status AS chapter_status,c.release_at AS chapter_release_at FROM tasks t LEFT JOIN chapters c ON c.id=t.chapter_id WHERE t.id=? AND t.student_id=?`).get(taskId,studentId);
  const visibleMaterials=chapterId=>chapterId?db.prepare(`SELECT title,filename,section FROM course_resources WHERE chapter_id=? AND status='approved' AND source_type='course' AND audience='student' AND (release_at IS NULL OR release_at<=?) ORDER BY created_at`).all(chapterId,stamp()):[];
  function render(task, recipient){
    const phase=phases[task.phase]||'学习';
    const chapter=task.chapter_title||'人体运动学';
    const chats=[];
    if(task.email_conversation){
      const rows=db.prepare('SELECT * FROM chat_interactions WHERE student_id=? ORDER BY created_at DESC LIMIT 100').all(studentId);
      const chapterDocIds=task.chapter_id?new Set(db.prepare('SELECT document_id FROM course_resources WHERE chapter_id=? AND document_id IS NOT NULL').all(task.chapter_id).map(r=>r.document_id)):null;
      for(const row of rows){
        const citations=JSON.parse(row.citations||'[]');
        const matches=!chapterDocIds||citations.some(c=>chapterDocIds.has(c.documentId));
        if(matches)chats.push({question:row.question,attempt:row.attempt,answer:row.answer,citations,createdAt:row.created_at});
        if(chats.length>=5)break;
      }
    }
    const materials=visibleMaterials(task.chapter_id);
    let base='';try{const url=new URL(process.env.PUBLIC_BASE_URL||'');if(['http:','https:'].includes(url.protocol)&&!['localhost','127.0.0.1','::1'].includes(url.hostname))base=url.href.replace(/\/$/,'');}catch{}
    const subject=`【人体运动学】${phase}学习任务：${task.title}`;
    const lines=[
      '你好，',
      '',
      `这是《人体运动学》的${phase}学习任务。`,
      `任务：${task.title}`,
      `章节：${chapter}`,
      `学生开放时间：${dateLabel(task.release_at||task.created_at)}`,

      '',
      '学习目标与要求：',task.description,
      task.chapter_summary?`\n本章提示：\n${task.chapter_summary}`:'',
      materials.length?`\n本章已开放资料：\n${materials.map(m=>`• ${m.title}${m.section?`（${m.section}）`:''} · ${m.filename}`).join('\n')}`:'',
      base?`\n打开课程学习空间：${base}`:'',
      '\n建议先写下自己的解释，再核对课程资料；遇到疑问时，回看下面的答疑线索。',
      '\n相关对话回顾：'
    ].filter(Boolean);
    if(!task.email_conversation)lines.push('教师未选择在此邮件中附上对话记录。');
    else if(!chats.length)lines.push(task.chapter_id?'目前还没有检索到与本章节引用资料对应的答疑记录。':'目前还没有可回顾的答疑记录。');
    else chats.reverse().forEach((chat,index)=>{
      lines.push(`\n${index+1}. ${dateLabel(chat.createdAt)}`,`学生问题：${chat.question}`,chat.attempt?`学生初步解释：${chat.attempt}`:'学生初步解释：未填写',`学习提示：${chat.answer}`);
      if(chat.citations.length)for(const citation of chat.citations)lines.push(`课程出处：${citation.title} · ${citation.section} · ${citation.version}`,`资料摘录：${String(citation.excerpt||'').slice(0,700)}`);
    });
    lines.push('\n这封邮件帮助你回顾任务和自己的思考；请结合课程原资料核对结论。');
    const bodyText=lines.join('\n').replace(/\n{3,}/g,'\n\n');
    const bodyHtml=`<div style="font-family:Arial,'Microsoft YaHei',sans-serif;max-width:700px;margin:auto;color:#183b3b;line-height:1.75"><h2>《人体运动学》${escapeHtml(phase)}学习任务</h2><p><b>任务：</b>${escapeHtml(task.title)}<br><b>章节：</b>${escapeHtml(chapter)}<br><b>开放：</b>${escapeHtml(dateLabel(task.release_at||task.created_at))}</p><h3>学习目标与要求</h3><p>${escapeHtml(task.description).replace(/\n/g,'<br>')}</p>${task.chapter_summary?`<h3>本章提示</h3><p>${escapeHtml(task.chapter_summary)}</p>`:''}${materials.length?`<h3>本章已开放资料</h3><ul>${materials.map(m=>`<li>${escapeHtml(m.title)}${m.section?`（${escapeHtml(m.section)}）`:''} · ${escapeHtml(m.filename)}</li>`).join('')}</ul>`:''}${base?`<p><a href="${escapeHtml(base)}">打开课程学习空间</a></p>`:''}<p>建议先写下自己的解释，再核对课程资料；遇到疑问时，回看下面的答疑线索。</p><hr><h3>相关对话回顾</h3>${!task.email_conversation?'<p>教师未选择在此邮件中附上对话记录。</p>':!chats.length?`<p>${task.chapter_id?'目前还没有检索到与本章节引用资料对应的答疑记录。':'目前还没有可回顾的答疑记录。'}</p>`:chats.reverse().map((chat,index)=>`<article style="padding:14px;background:#f6f7f2;border-radius:10px;margin:12px 0"><small>${escapeHtml(dateLabel(chat.createdAt))}</small><p><b>${index+1}. 学生问题：</b>${escapeHtml(chat.question)}</p><p><b>初步解释：</b>${escapeHtml(chat.attempt||'未填写')}</p><p><b>学习提示：</b>${escapeHtml(chat.answer).replace(/\n/g,'<br>')}</p>${chat.citations.length?`<ul>${chat.citations.map(c=>`<li><b>${escapeHtml(c.title)} · ${escapeHtml(c.section)} · ${escapeHtml(c.version)}</b><br>${escapeHtml(String(c.excerpt||'').slice(0,700)).replace(/\n/g,'<br>')}</li>`).join('')}</ul>`:''}</article>`).join('')}<p style="color:#667">这封邮件帮助你回顾任务和自己的思考；请结合课程原资料核对结论。</p></div>`;
    return {to:recipient||'',subject,text:bodyText,html:bodyHtml,conversationCount:chats.length,materialCount:materials.length};
  }
  function profileView(){const p=profile();return {email:p.email,consent:!!p.consent,updatedAt:p.updated_at};}
  function setProfile(role,body){
    teacherOnly(role);
    if(typeof body.consent!=='boolean')throw new AppError(400,'INVALID_CONSENT','请明确记录是否已取得学生接收课程邮件的同意。');
    let email='';
    if(body.email){email=text(body.email,'学生邮箱',254);if(!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email))throw new AppError(400,'INVALID_EMAIL','学生邮箱地址格式无效。');email=email.toLowerCase();}
    if(body.consent&&!email)throw new AppError(400,'EMAIL_REQUIRED','学生同意接收邮件时，必须填写收件邮箱。');
    if(!body.consent)email='';
    const previous=profile();
    db.prepare('INSERT INTO email_profiles(student_id,email,consent,updated_at) VALUES (?,?,?,?) ON CONFLICT(student_id) DO UPDATE SET email=excluded.email,consent=excluded.consent,updated_at=excluded.updated_at').run(studentId,email,body.consent?1:0,stamp());
    if(!body.consent||previous.email!==email)db.prepare("UPDATE email_deliveries SET status='held',recipient='',body_text='',body_html='',reason='收件邮箱或接收授权已变更；邮件已暂停，未发送' WHERE student_id=? AND status IN ('queued','failed')").run(studentId);
    return profileView();
  }
  function preview(role,taskId){
    teacherOnly(role);
    const task=taskRow(taskId);if(!task)throw new AppError(404,'NOT_FOUND','找不到这项学习任务。');
    const p=profile();
    return {...render(task,p.email),emailConsent:!!p.consent,taskEmailEnabled:!!task.email_enabled};
  }
  function deliveryView(row){return {id:row.id,taskId:row.task_id,title:row.subject,recipient:row.recipient,status:row.status,reason:row.reason,scheduledAt:row.scheduled_at,createdAt:row.created_at,sentAt:row.sent_at};}
  function getDelivery(taskId){return db.prepare('SELECT * FROM email_deliveries WHERE student_id=? AND task_id=?').get(studentId,taskId);}
  function createOrRefreshQueued(task, p, explicit=false){
    const existing=getDelivery(task.id);
    if(existing?.status==='sent')return existing;
    const allowed=!!p.consent&&!!p.email;
    const content=allowed?render(task,p.email):{subject:`【人体运动学】学习任务：${task.title}`,text:'',html:''};
    const status=allowed?'queued':'held';
    const reason=allowed?'等待邮件发送': '收件邮箱未配置或未确认接收；没有发送';
    const scheduledAt=task.release_at||task.created_at||stamp();
    if(existing){
      if(existing.status==='held'&&allowed&&explicit)db.prepare("UPDATE email_deliveries SET recipient=?,subject=?,body_text=?,body_html=?,status='queued',reason=?,scheduled_at=? WHERE id=?").run(p.email,content.subject,content.text,content.html,'等待教师明确发送；尚未发送',scheduledAt,existing.id);
      return getDelivery(task.id);
    }
    const deliveryId=makeId();
    db.prepare('INSERT INTO email_deliveries(id,student_id,task_id,recipient,subject,body_text,body_html,status,reason,scheduled_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(deliveryId,studentId,task.id,p.email||'',content.subject,content.text,content.html,status,reason,scheduledAt,stamp());
    return getDelivery(task.id);
  }
  const delivering=new Set();
  async function deliver(row,sendMail,configured){
    if(delivering.has(row.id))return {sent:false,queued:true};
    const p=profile();
    if(!p.consent||!p.email){db.prepare("UPDATE email_deliveries SET status='held',reason='收件授权缺失或已撤回；未发送' WHERE id=?").run(row.id);return {sent:false,held:true};}
    if(!configured||typeof sendMail!=='function')return {sent:false,queued:true};
    delivering.add(row.id);
    try{
      const result=await sendMail({to:row.recipient,subject:row.subject,text:row.body_text,html:row.body_html});
      if(!result?.accepted?.some(email=>String(email).toLowerCase()===row.recipient.toLowerCase()))throw new Error('SMTP 未接受收件地址');
      db.prepare("UPDATE email_deliveries SET status='sent',reason='SMTP已接受邮件',message_id=?,sent_at=? WHERE id=?").run(String(result?.messageId||''),stamp(),row.id);
      return {sent:true};
    }catch(error){
      const safe=String(error?.code||'SMTP_ERROR').slice(0,60);
      db.prepare("UPDATE email_deliveries SET status='failed',reason=? WHERE id=?").run(`发送失败，需要教师处理：${safe}`,row.id);
      return {sent:false,failed:true};
    }finally{delivering.delete(row.id); }
  }
  async function runDue(role,sendMail,configured){
    teacherOnly(role);
    const time=now().getTime();
    const due=db.prepare(`SELECT t.*,c.title AS chapter_title,c.summary AS chapter_summary,c.status AS chapter_status,c.release_at AS chapter_release_at FROM tasks t LEFT JOIN chapters c ON c.id=t.chapter_id WHERE t.student_id=? AND t.status='pending' AND t.email_enabled=1`).all(studentId);
    let queued=0,sent=0,held=0,failed=0;
    for(const task of due){
      if(Date.parse(task.release_at||task.created_at||0)>time)continue;
      if(task.chapter_id&&(!task.chapter_status||task.chapter_status!=='published'||Date.parse(task.chapter_release_at||0)>time))continue;
      const before=getDelivery(task.id);
      let row=createOrRefreshQueued(task,profile());
      if(!before&&row.status==='queued')queued++;
      if(row.status==='held'){held++;continue;}
      if(row.status==='failed'||row.status==='sent')continue;
      const result=await deliver(row,sendMail,configured);
      if(result.sent)sent++;else if(result.failed)failed++;
    }
    return {queued,sent,held,failed,externalSent:sent,reason:configured?'已检查到期课程邮件；具体状态见邮件发件箱。':'邮件已暂存；SMTP尚未配置，真实邮件发送为 0。'};
  }
  async function sendTask(role,taskId,sendMail,configured){
    teacherOnly(role);
    const task=taskRow(taskId);if(!task)throw new AppError(404,'NOT_FOUND','找不到这项学习任务。');

    if(!configured)throw new AppError(503,'SMTP_NOT_CONFIGURED','QQ邮箱SMTP尚未配置；邮件只保留预览，没有发送。');
    const p=profile();if(!p.email||!p.consent)throw new AppError(400,'EMAIL_CONSENT_REQUIRED','需要先登记收件邮箱和接收授权。');
    let row=createOrRefreshQueued(task,p,true);
    if(row.status==='sent')return deliveryView(row);
    if(row.status==='failed')db.prepare("UPDATE email_deliveries SET status='queued',reason='教师请求重新发送' WHERE id=?").run(row.id);
    row=getDelivery(task.id);
    const result=await deliver(row,sendMail,configured);
    const updated=getDelivery(task.id);
    if(result.failed)throw new AppError(502,'SMTP_SEND_FAILED',updated.reason);
    if(!result.sent)throw new AppError(400,'EMAIL_HELD','邮件当前处于暂缓状态。');
    return deliveryView(updated);
  }
  const bulk=createBulkMail({db,now,teacherOnly,AppError,taskRow,render});
  function bootstrap(role){
    const rows=role==='teacher'?db.prepare('SELECT e.*,t.title AS task_title FROM email_deliveries e JOIN tasks t ON t.id=e.task_id WHERE e.student_id=? ORDER BY e.created_at DESC LIMIT 100').all(studentId):[];
    return {...bulk.state(role),emailProfile:role==='teacher'?profileView():null,emailDeliveries:rows.map(r=>({...deliveryView(r),title:r.task_title}))};
  }
  return {setProfile,preview,runDue:async (...args)=>{const result=await runDue(...args);await bulk.run(args[1],args[2]);return result;},sendTask,bootstrap,bulk};
}
