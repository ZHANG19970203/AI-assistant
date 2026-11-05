const clean=s=>String(s||'').toLowerCase().replace(/[\s，。！？、：:（）()「」“”]/g,'');
export function resolveNavigation(text,role,{chapters=[],plans=[],history=[]}={}){
 const raw=clean(text),query=raw.replace(/^(请|帮我|带我|打开|查看|进入|跳转到|跳到|去|到)+/,'').replace(/(的资料|的任务|任务页面|页面|吧)$/,'');
 if(!query)return {error:'请说出要打开的页面或任务。'};
 if(/删除|发送邮件|群发|提交答案|批准|重置/.test(raw))return {error:'语音导航只负责打开页面，请进入页面后操作。'};
 const phase=/课前|预习/.test(query)?'pre':/课中/.test(query)?'in':/课后/.test(query)?'post':null;
 if(role==='teacher'){
  const candidates=[...chapters.map(c=>({type:'chapter',id:c.id,title:c.title})),...plans.map(p=>({type:'plan',id:p.id,chapterId:p.chapter_id,title:p.title}))];
  const exact=candidates.filter(c=>clean(c.title)===query),matches=exact.length?exact:candidates.filter(c=>query.length>=3&&clean(c.title).includes(query));
  if(matches.length===1)return {...matches[0],phase};if(matches.length>1)return {error:'找到多个结果，请说完整名称：'+matches.slice(0,3).map(c=>c.title).join('；')};
  if(/学情|学习反馈|学习记录|过程反馈|统计/.test(query))return {type:'teacher',section:'report'};
  if(/收件|邮箱|邮件|发放/.test(query))return {type:'teacher',section:'recipients'};
  if(/补学申请/.test(query))return {type:'teacher',section:'report'};
  if(phase)return {type:'teacher',phase};
  if(/^(章节|课程章节|课程资料|目录)$/.test(query))return {type:'chapters'};
  if(/学习引擎|学习任务/.test(query))return {type:'teacher'};
 }else{
  if(/学情|学习反馈|完成情况|六维/.test(query))return {type:'student',view:'feedback'};
  if(/亡羊补牢|补学/.test(query))return {type:'student',view:'makeup'};
  if(/温故|复习/.test(query))return {type:'student',view:'review'};
  const matches=history.filter(h=>query.length>=3&&clean(h.title).includes(query)&&(!phase||h.phase===phase));
  if(matches.length===1)return {type:'history',entry:matches[0]};
  if(phase||/知新|本次学习|当前任务/.test(query))return {type:'student',view:'learn',phase};
  if(/AI|ai|助教|提问|答疑/.test(query))return {type:'student',view:'learn',focus:'chat'};
 }
 return {error:role==='teacher'?'可以说“打开章节”“去课前任务”“查看学习反馈”，或说完整章节、任务名称。':'可以说“去课前任务”“查看学情反馈”“打开温故学习”“打开补学”或“我要问AI”。'};
}
