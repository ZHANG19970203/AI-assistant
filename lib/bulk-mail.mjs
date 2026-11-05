import ExcelJS from 'exceljs';
import {randomUUID} from 'node:crypto';
export function createBulkMail({db,now,teacherOnly,AppError,taskRow,render}) {
  db.exec(`CREATE TABLE IF NOT EXISTS mail_contacts(email TEXT PRIMARY KEY,name TEXT,source TEXT,created_at TEXT);
    CREATE TABLE IF NOT EXISTS bulk_mail(id TEXT PRIMARY KEY,task_id TEXT,recipient TEXT,subject TEXT,body TEXT,html TEXT,status TEXT,reason TEXT,scheduled_at TEXT,sent_at TEXT,message_id TEXT,UNIQUE(task_id,recipient));`);
  db.prepare("UPDATE bulk_mail SET status='uncertain',reason='发送中服务中断，请核对发件邮箱后处理' WHERE status='sending'").run();
  const fail=m=>{throw new AppError(400,'MAIL_INPUT',m);};
  async function importFile(role,buffer,filename){
    teacherOnly(role);
    const book=new ExcelJS.Workbook();
    try{await book.xlsx.load(buffer);}catch{fail('无法读取，请上传 Excel .xlsx 文件（旧版 .xls 请另存为 .xlsx）。');}
    const rows=[],invalid=[],seen=new Set();let duplicate=0;
    for(const sheet of book.worksheets){
      const headers=sheet.getRow(1).values.map(v=>String(v||'').trim());
      const col=headers.findIndex(v=>/邮箱|电子邮件|email|e-mail/i.test(v));
      const nameCol=headers.findIndex(v=>/姓名|name/i.test(v));
      if(col<1)continue;
      sheet.eachRow((row,i)=>{if(i===1)return;const email=row.getCell(col).text.trim().toLowerCase();if(!email)return;
        if(!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(email)){invalid.push(`${sheet.name} 第 ${i} 行：${email}`);return;}
        if(seen.has(email)){duplicate++;return;}seen.add(email);rows.push({email,name:nameCol>0?row.getCell(nameCol).text.slice(0,100):''});});
    }
    if(!rows.length)fail('未找到有效邮箱。第一行请使用“姓名”“邮箱”作为列名。');
    if(rows.length>1000)fail('每次最多导入 1000 个邮箱。');
    db.exec('BEGIN');try{for(const r of rows)db.prepare('INSERT INTO mail_contacts(email,name,source,created_at) VALUES (?,?,?,?) ON CONFLICT(email) DO UPDATE SET name=excluded.name,source=excluded.source').run(r.email,r.name,filename,now().toISOString());db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
    return {imported:rows.length,duplicate,invalid};
  }
  function state(role){return role==='teacher'?{mailContacts:db.prepare('SELECT * FROM mail_contacts ORDER BY created_at,email').all(),bulkDeliveries:db.prepare('SELECT * FROM bulk_mail ORDER BY scheduled_at DESC LIMIT 1000').all().map(({body,html,...r})=>r)}:{};}
  function queue(role,data){teacherOnly(role);if(data.confirm!==true)fail('请确认收件名单和发送内容。');
    const task=taskRow(data.taskId);if(!task)fail('任务不存在。');
    if(!Array.isArray(data.emails)||!data.emails.length)fail('请先导入并选择收件人。');
    const scheduled=data.scheduledAt?new Date(data.scheduledAt):now();if(!Number.isFinite(+scheduled))fail('发送时间无效。');
    const content=render({...task,email_conversation:0},'');let added=0;
    db.exec('BEGIN');try{for(const email of new Set(data.emails)){if(!db.prepare('SELECT 1 FROM mail_contacts WHERE email=?').get(email))fail('收件人不在名单中。');added+=Number(db.prepare("INSERT OR IGNORE INTO bulk_mail VALUES (?,?,?,?,?,?,'queued','等待发送',?,NULL,NULL)").run(randomUUID(),task.id,email,content.subject,content.text,content.html,scheduled.toISOString()).changes);}db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}return {added};
  }
  let running=false;
  async function run(send,configured,taskId=null){if(running||!configured)return;running=true;try{
    const rows=taskId?db.prepare("SELECT * FROM bulk_mail WHERE status='queued' AND scheduled_at<=? AND task_id=? LIMIT 20").all(now().toISOString(),taskId):db.prepare("SELECT * FROM bulk_mail WHERE status='queued' AND scheduled_at<=? LIMIT 20").all(now().toISOString());
    for(const row of rows){if(!db.prepare("UPDATE bulk_mail SET status='sending' WHERE id=? AND status='queued'").run(row.id).changes)continue;
      try{const result=await send({to:row.recipient,subject:row.subject,text:row.body,html:row.html});if(!result?.accepted?.length)throw new Error('SMTP_NOT_ACCEPTED');db.prepare("UPDATE bulk_mail SET status='sent',reason='SMTP 已接受（不代表已读或已进入收件箱）',sent_at=?,message_id=? WHERE id=?").run(now().toISOString(),String(result.messageId||''),row.id);}
      catch(e){db.prepare("UPDATE bulk_mail SET status='failed',reason=? WHERE id=?").run(`发送失败：${String(e.code||'SMTP_ERROR').slice(0,60)}；请核对后再处理`,row.id);}
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
  }finally{running=false;}}
  function remove(role,email){teacherOnly(role);db.prepare('DELETE FROM mail_contacts WHERE email=?').run(email);db.prepare("UPDATE bulk_mail SET status='cancelled',reason='收件人已移除' WHERE recipient=? AND status='queued'").run(email);return {ok:true};}
  return {importFile,state,queue,run,remove};
}
