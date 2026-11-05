import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync, createReadStream } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, relative, sep } from 'node:path';
import { createService, AppError } from './lib/service.mjs';
import {createVoiceInput} from './lib/voice-input.mjs';
import { isSiliconFlowConfigured, siliconFlowModel, generateTutorAnswer } from './lib/siliconflow.mjs';
import { qqMailConfigured, sendQQMail } from './lib/qq-mail.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
function loadLocalEnv() {
  try {
    const contents = readFileSync(resolve(root, '.env.local'), 'utf8').replace(/^\uFEFF/, '');
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || Object.hasOwn(process.env, match[1])) continue;
      let value = match[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      process.env[match[1]] = value;
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
loadLocalEnv();
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8' };
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}
async function body(req,limit=160000) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new AppError(415, 'JSON_REQUIRED', '请使用 application/json 请求正文。');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new AppError(413, 'BODY_TOO_LARGE', '单次输入过大；请将资料拆为小段文本。');
    chunks.push(chunk);
  }
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError(400, 'INVALID_JSON', '请求正文不是有效 JSON。'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new AppError(400, 'INVALID_INPUT', '请求正文须为 JSON 对象。');
  return parsed;
}
async function binaryBody(req,limit){
  if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/octet-stream'))throw new AppError(415,'BINARY_REQUIRED','请使用二进制上传。');
  let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>limit)throw new AppError(413,'BODY_TOO_LARGE','文件或录音片段超过本地大小限制。');chunks.push(chunk);}return Buffer.concat(chunks);
}

export function createApp({ service, dbPath, now, voiceTranscribe, webRoot = resolve(root, 'web') } = {}) {
  const store = service || createService({ dbPath: dbPath || resolve(root, 'data/companion.sqlite'), now });
  const recognizeVoice=createVoiceInput(voiceTranscribe);
  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || '';
      const port = server.address()?.port;
      if (![ `127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}` ].includes(host)) throw new AppError(403, 'LOCAL_ONLY', '仅支持本机演示地址。');
      const remote = req.socket.remoteAddress;
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) throw new AppError(403, 'LOCAL_ONLY', '仅限本机使用。');
      const url = new URL(req.url, `http://${host}`);
      const origin = req.headers.origin;
      if ((origin && origin !== `http://${host}`) || req.headers['sec-fetch-site'] === 'cross-site') throw new AppError(403, 'ORIGIN_REJECTED', '不接受跨站请求。');
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.referer) {
        let refererOrigin;
        try { refererOrigin = new URL(req.headers.referer).origin; } catch { throw new AppError(403, 'ORIGIN_REJECTED', '请求来源无效。'); }
        if (refererOrigin !== `http://${host}`) throw new AppError(403, 'ORIGIN_REJECTED', '不接受跨站写入。');
      }
      const role = req.headers['x-demo-role'] || 'student';
      if (!['student', 'teacher'].includes(role)) throw new AppError(400, 'INVALID_ROLE', '演示角色须为 student 或 teacher。');
      const path = url.pathname;
      if (path.startsWith('/api/')) {
        const studyToken={value:req.headers['x-study-token']||url.searchParams.get('access'),mode:req.headers['x-study-mode']||url.searchParams.get('mode')||'new'};
        if(req.method==='POST'&&['/api/voice/transcribe','/api/study/voice/transcribe','/api/study/voice/navigate'].includes(path)){
          const authorize=()=>{if(path==='/api/study/voice/navigate')return store.lessonFlow.authorizeNavigation(studyToken);if(path==='/api/study/voice/transcribe')return store.lessonFlow.authorizeVoice(studyToken,url.searchParams.get('phase'));if(role!=='teacher')throw new AppError(403,'TEACHER_ONLY','请从教师端或专属学习链接使用语音输入。');return 'teacher';};
          const key=authorize();
          if(req.headers['x-voice-consent']!=='yes')throw new AppError(400,'VOICE_CONSENT','请点击语音输入并确认开始录音。');
          const bytes=await binaryBody(req,8*1024*1024);const result=await recognizeVoice(key,bytes,req.headers['x-audio-mime']||'');authorize();return json(res,200,result);
        }
        const imageRoute=path.match(/^\/api\/(lesson-flow|study)\/images(?:\/([a-zA-Z0-9-]+))?$/);
        if(imageRoute){const imageToken=imageRoute[1]==='study'?studyToken:null;if(req.method==='POST'&&!imageRoute[2]){if(!imageToken&&role!=='teacher')throw new AppError(403,'TEACHER_ONLY','仅教师可上传');const bytes=await binaryBody(req,5*1024*1024);return json(res,201,store.lessonFlow.tools.imageUpload(role,imageToken,{chapterId:url.searchParams.get('chapterId'),phase:url.searchParams.get('phase')},bytes));}if(req.method==='GET'&&imageRoute[2]){const r=store.lessonFlow.tools.image(role,imageToken,imageRoute[2],url.searchParams.get('phase'));res.writeHead(200,{'Content-Type':r.mime,'Content-Length':r.bytes.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});return res.end(Buffer.from(r.bytes));}}
        if(path==='/api/study/feedback'&&req.method==='GET')return json(res,200,store.lessonFlow.tools.messages(studyToken));
        if(path==='/api/lesson-flow'&&req.method==='GET')return json(res,200,store.lessonFlow.report(role));
        if(path==='/api/study'&&req.method==='GET')return json(res,200,store.lessonFlow.view(studyToken));
        const materialView=path.match(/^\/api\/study\/materials\/([a-zA-Z0-9-]+)$/);
        if(materialView&&req.method==='GET')return json(res,200,store.lessonFlow.material(studyToken,materialView[1],url.searchParams.get('phase')));
        const recordingUpload=path.match(/^\/api\/study\/recordings\/([a-zA-Z0-9-]+)\/chunks$/);
        if(recordingUpload&&req.method==='POST'){const bytes=await binaryBody(req,10*1024*1024);return json(res,200,await store.lessonFlow.media.chunk(studyToken,recordingUpload[1],url.searchParams.get('phase'),Number(url.searchParams.get('sequence')),bytes,req.headers['x-audio-mime']||'audio/webm'));}
        if(path.startsWith('/api/study/')&&req.method==='POST'){

          const data=await body(req);
          if(path==='/api/study/recordings/retry')return json(res,200,await store.lessonFlow.media.retry(studyToken,data));
          if(path==='/api/study/recordings/start')return json(res,201,store.lessonFlow.media.start(studyToken,data));
          if(path==='/api/study/recordings/finish')return json(res,200,await store.lessonFlow.media.finish(studyToken,data));
          if(path==='/api/study/feedback')return json(res,201,store.lessonFlow.tools.feedback(studyToken,data));
          if(path==='/api/study/submissions')return json(res,201,store.lessonFlow.media.submit(studyToken,data));
          if(path==='/api/study/makeup')return json(res,200,store.lessonFlow.makeup(studyToken,data));
          if(path==='/api/study/events')return json(res,200,store.lessonFlow.event(studyToken,data));
          if(path==='/api/study/answer')return json(res,200,store.lessonFlow.answer(studyToken,data));
          if(path==='/api/study/chat')return json(res,200,await store.lessonFlow.chat(studyToken,data,isSiliconFlowConfigured()?generateTutorAnswer:null));
          throw new AppError(404,'NOT_FOUND','未知学习操作');
        }
        if (req.method === 'GET' && path === '/api/health') return json(res, 200, { ok: true, mode: 'local-demo', persistence: 'sqlite', email: qqMailConfigured() ? 'qq-smtp-configured' : 'not-configured', llm: isSiliconFlowConfigured() ? 'siliconflow-configured' : 'not-connected', model: isSiliconFlowConfigured() ? siliconFlowModel() : null });
        if (req.method === 'GET' && path === '/api/bootstrap') {
          const result = store.bootstrap(role);
          if(role==='student'){result.documents=[];result.resources=[];result.chapters=[];result.tasks=[];}
          result.status.llm = isSiliconFlowConfigured() ? 'siliconflow-configured' : 'not-connected';
          result.status.model = isSiliconFlowConfigured() ? siliconFlowModel() : null;
          result.status.email = qqMailConfigured() ? 'qq-smtp-configured' : 'not-configured';
          return json(res, 200, result);
        }
        const emailPreview = path.match(/^\/api\/email\/tasks\/([a-zA-Z0-9-]+)\/preview$/);
        if (req.method === 'GET' && emailPreview) return json(res,200,store.emailDelivery.preview(role,emailPreview[1]));
        const resourcePreview=path.match(/^\/api\/resources\/([a-zA-Z0-9-]+)\/preview$/);
        if(resourcePreview&&req.method==='GET')return json(res,200,store.previewResource(role,resourcePreview[1]));
        const recordedFile=path.match(/^\/api\/study\/audio\/([a-zA-Z0-9-]+)$/);
        const studyFile=path.match(/^\/api\/study\/files\/([a-zA-Z0-9-]+)$/);
        const resourceFile = recordedFile||studyFile||path.match(/^\/api\/resources\/([a-zA-Z0-9-]+)\/file$/);
        if (req.method === 'GET' && resourceFile) {
          if(!studyFile&&!recordedFile&&role!=='teacher')throw new AppError(403,'STUDY_LINK_REQUIRED','请从专属学习链接查看资料');
          const item = recordedFile?store.lessonFlow.media.file(studyToken,recordedFile[1],url.searchParams.get('phase')):studyFile?store.lessonFlow.file(studyToken,resourceFile[1],url.searchParams.get('phase')):store.getResourceFile(role, resourceFile[1]);
          const info = await stat(item.path);
          let start = 0, end = Math.max(0, info.size - 1), status = 200;
          const range = req.headers.range;
          if (range) {
            const match = range.match(/^bytes=(\d*)-(\d*)$/);
            if (!match || (!match[1] && !match[2])) throw new AppError(416,'INVALID_RANGE','视频播放请求范围无效。');
            if (!match[1]) { const suffix = Number(match[2]); start = Math.max(0, info.size - suffix); }
            else start = Number(match[1]);
            if (match[1] && match[2]) end = Math.min(Number(match[2]), info.size - 1);
            if (start > end || start >= info.size) { res.writeHead(416, {'Content-Range':`bytes */${info.size}`}); return res.end(); }
            status = 206;
          }
          const headers = {'Content-Type':item.mimeType,'Content-Length':String(end-start+1),'Accept-Ranges':'bytes','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Disposition':`inline; filename*=UTF-8''${encodeURIComponent(item.filename)}`};
          if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
          res.writeHead(status,headers);
          if (req.method === 'HEAD') return res.end();
          createReadStream(item.path,{start,end}).pipe(res);
          return;
        }
        const resourceApproval = path.match(/^\/api\/resources\/([a-zA-Z0-9-]+)\/approve$/);
        if (req.method === 'POST' && resourceApproval) { await body(req); return json(res,200,store.approveResource(role,resourceApproval[1])); }
        if (req.method === 'POST' && path === '/api/resources/upload') {
          if(role!=='teacher')throw new AppError(403,'TEACHER_ONLY','课程资料上传仅供教师使用。');
          const buffer = await binaryBody(req,128*1024*1024);
          let meta, filename;
          try { meta=JSON.parse(decodeURIComponent(req.headers['x-resource-meta']||'')); filename=decodeURIComponent(req.headers['x-file-name']||''); }
          catch { throw new AppError(400,'INVALID_METADATA','上传资料信息格式无效。'); }
          if (!filename || filename.length > 220 || /[\\/\0]/.test(filename)) throw new AppError(400,'INVALID_NAME','文件名无效。');
          const allowed = /\.(txt|md|srt|vtt|docx|pptx|pdf|mp4|webm|mov|m4v|mp3|m4a|wav|ogg)$/i;
          if (!allowed.test(filename)) throw new AppError(415,'UNSUPPORTED_FILE','支持 TXT、Markdown、字幕、Word、PPT、PDF、常见视频和音频格式。');
          return json(res,201,await store.addResource(role,meta,filename,req.headers['x-file-mime']||'application/octet-stream',buffer));
        }
        if(req.method==='GET'&&/^\/api\/classroom\/sessions\/[a-zA-Z0-9-]+$/.test(path))return json(res,200,store.classroom.view(role,path.split('/').at(-1)));
        const classroomUpload=path.match(/^\/api\/classroom\/sessions\/([a-zA-Z0-9-]+)\/(assets|chunks)$/);
        if(req.method==='POST'&&classroomUpload){
          if(role!=='teacher')throw new AppError(403,'TEACHER_ONLY','课堂上传仅供演示教师使用。');
          const buffer=await binaryBody(req,classroomUpload[2]==='chunks'?4*1024*1024:128*1024*1024);
          if(classroomUpload[2]==='assets'){let name;try{name=decodeURIComponent(req.headers['x-file-name']||'');}catch{throw new AppError(400,'INVALID_NAME','文件名无效。');}return json(res,201,await store.classroom.upload(role,classroomUpload[1],{name,mime:req.headers['x-file-mime'],buffer}));}
          if(!['sequence','startMs','endMs'].every(k=>url.searchParams.has(k)))throw new AppError(400,'INVALID_CHUNK','录音片段缺少序号或时间。');
          return json(res,201,store.classroom.chunk(role,classroomUpload[1],{sequence:Number(url.searchParams.get('sequence')),startMs:Number(url.searchParams.get('startMs')),endMs:Number(url.searchParams.get('endMs')),mime:req.headers['x-audio-mime'],buffer}));
        }
        if (req.method !== 'POST') throw new AppError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方式。');
        if(path==='/api/email/import') {
          if(role!=='teacher')throw new AppError(403,'TEACHER_ONLY','仅教师可导入');
          const bytes=await binaryBody(req,5*1024*1024);
          return json(res,200,await store.emailDelivery.bulk.importFile(role,bytes,decodeURIComponent(req.headers['x-file-name']||'名单.xlsx')));
        }
        const data = await body(req,path==='/api/lesson-flow/save'?1200000:160000);
        if(path==='/api/lesson-flow/makeup/decide')return json(res,200,store.lessonFlow.policy.decide(role,data));
        if(path==='/api/lesson-flow/makeup/reset')return json(res,200,store.lessonFlow.policy.reset(role,data));
        if(path==='/api/lesson-flow/contacts')return json(res,200,store.lessonFlow.policy.contact(role,data));
        if(path==='/api/lesson-flow/rate')return json(res,200,store.lessonFlow.rate(role,data));
        if(path==='/api/lesson-flow/questions')return json(res,200,store.lessonFlow.tools.question(role,data));
        if(path==='/api/lesson-flow/feedback/reply')return json(res,200,store.lessonFlow.tools.reply(role,data));
        if(path==='/api/lesson-flow/save')return json(res,201,store.lessonFlow.save(role,data));
        if(path==='/api/lesson-flow/assign'){
          const result=store.lessonFlow.assign(role,data);
          if(!data.preview)store.lessonFlow.run(sendQQMail,qqMailConfigured()).catch(()=>console.error('学习邮件处理失败'));
          return json(res,200,result);
        }
        if(path==='/api/email/bulk/queue') {
          if(data.immediate===true && !qqMailConfigured())throw new AppError(503,'SMTP_NOT_CONFIGURED','发件邮箱尚未配置');
          const result=store.emailDelivery.bulk.queue(role,{...data,...(data.immediate===true?{scheduledAt:null}:{})});
          if(data.immediate===true)store.emailDelivery.bulk.run(sendQQMail,qqMailConfigured(),data.taskId).catch(()=>console.error('立即群发处理失败，请查看邮件记录'));
          return json(res,200,result);
        }
        if(path==='/api/email/bulk/remove')return json(res,200,store.emailDelivery.bulk.remove(role,data.email));
        if(path==='/api/classroom/sessions')return json(res,201,store.classroom.create(role,data));
        const classroomAction=path.match(/^\/api\/classroom\/sessions\/([a-zA-Z0-9-]+)\/(transcript|end|draft|publish|consent)$/);
        if(classroomAction)return json(res,200,store.classroom[classroomAction[2]](role,classroomAction[1],data));
        if (path === '/api/chat') {
          if(role!=='teacher')throw new AppError(403,'STUDY_LINK_REQUIRED','请从专属学习链接使用答疑');
          const result = store.chat(data);
          if (result.needsTeacher || !result.citations?.length || !isSiliconFlowConfigured()) return json(res, 200, result);
          try {
            result.answer = await generateTutorAnswer({ question: data.question, attempt: data.attempt || '', citations: result.citations });
            result.mode = 'siliconflow-deepseek';
          } catch {
            result.mode = 'lexical-fallback';
            result.providerWarning = '本次模型暂不可用，以下内容为本地课程资料摘录。';
          }
          if (result.interactionId) store.updateInteractionAnswer(result.interactionId,result.answer,result.mode);
          return json(res, 200, result);
        }
        if (path === '/api/settings') return json(res, 200, store.updateSettings(data));
        if (path === '/api/documents') return json(res, 201, store.addDocument(role, data));
        if (path === '/api/chapters') return json(res,201,store.addChapter(role,data));
        const chapterEdit = path.match(/^\/api\/chapters\/([a-zA-Z0-9-]+)\/update$/);
        if (chapterEdit) return json(res,200,store.updateChapter(role,chapterEdit[1],data));
        const chapterPublish = path.match(/^\/api\/chapters\/([a-zA-Z0-9-]+)\/publish$/);
        if (chapterPublish) return json(res,200,store.publishChapter(role,chapterPublish[1],data));
        if (path === '/api/tasks') return json(res, 201, store.addTask(role, data));
        if (path === '/api/email/profile') return json(res,200,store.emailDelivery.setProfile(role,data));
        const emailSend = path.match(/^\/api\/email\/tasks\/([a-zA-Z0-9-]+)\/send$/);
        if (emailSend) {
          if(data.confirm!==true)throw new AppError(400,'CONFIRM_REQUIRED','发送前需要明确确认。');
          return json(res,200,await store.emailDelivery.sendTask(role,emailSend[1],sendQQMail,qqMailConfigured()));
        }
        if (path === '/api/scheduler/run') {
          const local=store.runScheduler(role);
          const mail=await store.emailDelivery.runDue(role,sendQQMail,qqMailConfigured());
          return json(res,200,{...local,email:mail,reason:mail.reason});
        }
        if (path === '/api/notes') return json(res, 201, store.addNote(data));
        if (path === '/api/checkin') return json(res, 201, store.checkin(data));
        if (path === '/api/feedback') return json(res, 201, store.addFeedback(role, data));
        const chatFeedback = path.match(/^\/api\/chat-interactions\/([a-zA-Z0-9-]+)\/feedback$/);
        if (chatFeedback) return json(res,200,store.chatFeedback(role,chatFeedback[1],data));
        const chatReview = path.match(/^\/api\/chat-interactions\/([a-zA-Z0-9-]+)\/review$/);
        if (chatReview) return json(res,201,store.reviewInteraction(role,chatReview[1],data));
        const practiceSubmission = path.match(/^\/api\/practice\/([a-zA-Z0-9-]+)\/submit$/);
        if (practiceSubmission) return json(res, 200, store.submitPractice(practiceSubmission[1], data));
        const practiceHint = path.match(/^\/api\/practice\/([a-zA-Z0-9-]+)\/hint$/);
        if (practiceHint) return json(res, 200, store.practiceHint(practiceHint[1], data));
        const completion = path.match(/^\/api\/tasks\/([a-zA-Z0-9-]+)\/complete$/);
        if (completion) return json(res, 200, store.completeTask(completion[1], data));
        const approval = path.match(/^\/api\/documents\/([a-zA-Z0-9-]+)\/approve$/);
        if (approval) return json(res, 200, store.approveDocument(role, approval[1]));
        throw new AppError(404, 'NOT_FOUND', '找不到这个接口。');
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw new AppError(405, 'METHOD_NOT_ALLOWED', '仅支持读取页面。');
      let decoded;
      try { decoded = decodeURIComponent(path); } catch { throw new AppError(400, 'INVALID_PATH', '页面地址无效。'); }
      if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').some(p => p.startsWith('.'))) throw new AppError(404, 'NOT_FOUND', '找不到页面。');
      const filename = resolve(webRoot, '.' + (decoded === '/' ? '/index.html' : decoded));
      const rel = relative(webRoot, filename);
      if (rel.startsWith('..' + sep) || rel === '..' || rel.includes(':')) throw new AppError(404, 'NOT_FOUND', '找不到页面。');
      const extension = filename.slice(filename.lastIndexOf('.'));
      if (!types[extension]) throw new AppError(404, 'NOT_FOUND', '找不到页面。');
      let content;
      try {
        if (!(await stat(filename)).isFile()) throw new Error('not a file');
        content = await readFile(filename);
      } catch { throw new AppError(404, 'NOT_FOUND', '找不到页面。'); }
      res.writeHead(200, { 'Content-Type': types[extension], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : '服务暂时无法处理，请查看本地服务窗口。', code: error.code || 'INTERNAL_ERROR' });
      else res.end();
      if (!error.status) console.error(error);
    }
  });
  return { server, service: store, close: async () => { await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())); store.close(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 4317);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT 必须为 1024–65535 的整数。');
  const app = createApp({ dbPath: process.env.DATABASE_PATH ? resolve(root, process.env.DATABASE_PATH) : undefined });
  app.server.on('error', error => { console.error(`无法启动本地原型：${error.message}`); app.service.close(); process.exitCode = 1; });
  app.server.listen(port, '127.0.0.1', () => console.log(`人体运动学学习伴侣本地演示已启动：http://127.0.0.1:${port}\n${isSiliconFlowConfigured() ? `已配置 SiliconFlow / ${siliconFlowModel()}；` : '未配置大模型；'}${qqMailConfigured() ? 'QQ邮件SMTP已配置；' : 'QQ邮件SMTP待配置；'}仅本机可访问。`));
  const timer = setInterval(() => { try { app.service.runScheduler('teacher'); app.service.lessonFlow.run(sendQQMail,qqMailConfigured()).catch(()=>console.error('学习邮件处理失败')); app.service.emailDelivery.runDue('teacher',sendQQMail,qqMailConfigured()).catch(error=>console.error('邮件任务处理失败：',error.message)); } catch (error) { console.error('任务检查失败：', error.message); } }, 60000);
  timer.unref();
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { clearInterval(timer); await app.close(); process.exit(0); });
}
