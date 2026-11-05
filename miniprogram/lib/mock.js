// 独立的原生小程序离线教学流程演示，无持久化、无真实课程导入、无网络推送。
const source = {
  documentId: 'mini-original-demo-1', title: '原创演示：动作观察记录法',
  section: '第一节 · 先描述再解释', version: 'demo-2026-10-28',
  excerpt: '分析动作时，先写清观察的动作、起止位置和观察方向；再描述可见的关节运动。把观察到的现象与自己的解释分开，最后对照课程资料检查依据，并记录仍不能确定的问题。'
};
const state = {
  course: { id: 'mini-demo-course', title: '人体运动学', module: '独立离线演示 · 动作观察方法', note: '本内容为原创演示，尚非教师批准的正式课程。' },
  tasks: [
    { id: 'mini-pre', title: '先写下你的观察框架', phase: 'pre', description: '用一句话说明你会怎样描述一个日常动作。先保留自己的判断。', dueAt: '2026-10-30T08:00:00+08:00', status: 'pending' },
    { id: 'mini-in', title: '把现象与解释分开', phase: 'in', description: '选择一个日常动作，分别写“我看见了什么”和“我怎样解释”。不需要上传身体影像。', dueAt: '2026-10-30T10:00:00+08:00', status: 'pending' },
    { id: 'mini-post', title: '独立复述并留下一处疑问', phase: 'post', description: '关闭提示后，用自己的话复述观察步骤，记下一项需要教师确认的问题。', dueAt: '2026-10-31T18:00:00+08:00', status: 'pending' }
  ],
  settings: { reminders: false, quietStart: '22:00', quietEnd: '08:00', timezone: 'Asia/Shanghai' },
  practices: [
    { id: 'mini-observe', title: '基础练习 · 区分观察与解释', dimensionId: 'observation', stem: '记录一个日常动作时，哪种写法更适合作为“观察到的现象”？', options: [
      { id: 'A', text: '先写清起止位置和可见变化，把原因判断另列。' },
      { id: 'B', text: '只写我猜测的原因，不记录动作条件。' },
      { id: 'C', text: '直接写“已经掌握”，不保留观察过程。' }
    ], sourceLabel: '原创离线演示，非正式题库', attemptCount: 0, correctCount: 0, lastAttempt: null },
    { id: 'mini-evidence', title: '进阶练习 · 寻找判断依据', dimensionId: 'evidence', stem: '你的解释与课程资料看起来不一致时，下一步怎样做更合适？', options: [
      { id: 'A', text: '忽略差异，直接复制自己最喜欢的结论。' },
      { id: 'B', text: '核对观察条件和资料位置，保留差异，请教师确认。' },
      { id: 'C', text: '认为 AI 的说法一定正确，不需要资料。' }
    ], sourceLabel: '原创离线演示，非正式题库', attemptCount: 0, correctCount: 0, lastAttempt: null }
  ],
  notes: [], evidence: [], checkins: [],
  dimensions: [
    { id: 'concept', label: '概念辨析', score: null },
    { id: 'observation', label: '动作观察', score: null },
    { id: 'evidence', label: '证据运用', score: null },
    { id: 'transfer', label: '情境迁移', score: null },
    { id: 'reflection', label: '反思修正', score: null },
    { id: 'planning', label: '自主规划', score: null }
  ]
};
const practiceKeys = { 'mini-observe': 'A', 'mini-evidence': 'B' };
const practiceHints = {
  'mini-observe': [
    '先检查：这句话描述了“看见的变化”，还是在推测“为什么发生”？',
    '试着只保留起止位置、方向和可见变化；把原因猜测另放一栏。',
    '回看资料的“现象与解释分开”一句，再逐项检查自己的选择。写出你准备修改的一点。'
  ],
  'mini-evidence': [
    '先想一想：遇到不一致时，怎样让别人也能检查你的判断？',
    '寻找可核对的信息：观察条件、资料页/节，以及尚不能解释的差异。',
    '对照你已写的理由，检查是否保留了不确定性、来源和向教师求证的空间，然后重试。'
  ]
};
let sequence = 0;
function id(prefix) { sequence += 1; return prefix + '-' + sequence; }
function addEvidence(kind, title, dimensionId, referenceId) {
  state.evidence.unshift({ id: id('candidate'), kind, title, dimensionId: dimensionId || null, referenceId,
    status: 'pending-teacher-review', createdAt: new Date().toISOString() });
}
function copy(value) { return JSON.parse(JSON.stringify(value)); }

async function request(path, method, data) {
  if (path === '/api/bootstrap') {
    return copy({ course: state.course, tasks: state.tasks, documents: [], settings: state.settings,
      practices: state.practices, notes: state.notes,
      companion: { dimensions: state.dimensions, evidence: state.evidence, checkins: state.checkins, note: '六维尚无教师评分。候选证据不会自动变成分数。' },
      progress: { completed: state.tasks.filter(t => t.status === 'completed').length, total: state.tasks.length },
      status: { mode: 'offline-mini-demo', realStudentData: false, wechat: 'not-connected', llm: 'not-connected' }
    });
  }
  if (path === '/api/chat') {
    const relevant = /观察|动作|记录|分析|描述|步骤|现象|解释/.test(data.question || '');
    return relevant ? {
      answer: '先说说你会怎样观察，或哪一步最不确定。可以先把“看见的现象”和“我猜测的原因”分成两栏，再对照下面的演示资料检查自己的句子。',
      citations: [copy(source)], followUp: data.attempt ? '对照你刚才的判断，哪一句属于观察，哪一句属于解释？' : '请先选一个动作，用一句话记录你看见的现象。',
      needsTeacher: false, mode: 'offline-keyword-demo'
    } : { answer: '当前离线演示没有足够资料回答这个问题。正式课程需导入并审核资料后再由教师核对。', citations: [], followUp: '你可以先写下自己的判断，并保留需要教师确认的地方。', needsTeacher: true, mode: 'offline-keyword-demo' };
  }
  if (path === '/api/settings') {
    state.settings.reminders = Boolean(data.reminders);
    return copy(state.settings);
  }
  if (path === '/api/notes' && method === 'POST') {
    if (!data.title || !data.title.trim() || !data.content || !data.content.trim()) throw new Error('请填写笔记标题和自己的解释。');
    const note = { id: id('note'), title: data.title.trim(), content: data.content.trim(), sourceRef: (data.sourceRef || '').trim(), createdAt: new Date().toISOString() };
    state.notes.unshift(note);
    addEvidence('note', note.title, null, note.id);
    return { note: copy(note) };
  }
  if (path === '/api/checkin' && method === 'POST') {
    const advice = {
      concept: '先挑两个容易混淆的词，用自己的话各写一句；再标出你最不确定的差别，查对应资料或问教师。',
      observation: '先缩小到一个动作片段，写起止位置和观察方向。把“看见了什么”与“我猜为什么”分开。',
      application: '先比较新旧情境中改变了什么、保留了什么；只解释一条关系，找一处资料支持。',
      planning: '自选一个小步骤：读一段资料、记一句困惑、重试一题，或按计划休息。你可以修改这个选择。'
    }[data.difficulty];
    if (!advice) throw new Error('请选择你主动表达的卡点类型。');
    const checkin = { id: id('checkin'), difficulty: data.difficulty, message: (data.message || '').trim(), advice, createdAt: new Date().toISOString() };
    state.checkins.unshift(checkin);
    return { checkin: copy(checkin), advice };
  }
  const practiceMatch = path.match(/^\/api\/practice\/([^/]+)\/(submit|hint)$/);
  if (practiceMatch) {
    const practice = state.practices.find(p => p.id === decodeURIComponent(practiceMatch[1]));
    if (!practice) throw new Error('找不到该演示练习。');
    if (practiceMatch[2] === 'hint') {
      const level = Number(data.level);
      if (![1, 2, 3].includes(level)) throw new Error('提示级别须为1至3。');
      if (level === 3 && !practice.lastAttempt) throw new Error('先留下自己的尝试，再展开第三级核对线索。');
      return { practiceId: practice.id, level, hint: practiceHints[practice.id][level - 1], explanation: null,
        evidence: level > 1 ? [copy(source)] : [], sourceLabel: practice.sourceLabel };
    }
    if (!practice.options.some(option => option.id === data.choice)) throw new Error('请先选择一个选项。');
    if (!data.reasoning || !data.reasoning.trim()) throw new Error('请先写一句自己的判断理由。');
    const attempt = { id: id('attempt'), practiceId: practice.id, choice: data.choice, reasoning: data.reasoning.trim(),
      correct: practiceKeys[practice.id] === data.choice, createdAt: new Date().toISOString() };
    practice.attemptCount += 1; if (attempt.correct) practice.correctCount += 1; practice.lastAttempt = attempt;
    addEvidence('practice', practice.title + '：一次作答及理由', practice.dimensionId, attempt.id);
    return { attempt: copy(attempt), feedback: attempt.correct ? '本次演示判据下作答符合要求。请再用自己的话说明依据，不必追求连续做题。' : '本次还需要检查一处。先看一级线索，修改理由后可以重试；这里不公布答案。',
      explanation: null, hint: { level: 1, text: practiceHints[practice.id][0] }, sourceLabel: practice.sourceLabel };
  }
  const match = path.match(/^\/api\/tasks\/([^/]+)\/complete$/);
  if (match) {
    const task = state.tasks.find(t => t.id === decodeURIComponent(match[1]));
    if (!task) throw new Error('找不到该演示任务。');
    if (task.status === 'completed') return { task: copy(task), alreadyCompleted: true };
    if (!data.reflection || !data.reflection.trim()) throw new Error('请先写一句学习反思。');
    task.status = 'completed'; task.reflection = data.reflection.trim(); task.confidence = data.confidence;
    task.completedAt = new Date().toISOString();
    addEvidence('reflection', task.title + '：学习反思', 'reflection', task.id);
    return { task: copy(task), alreadyCompleted: false };
  }
  throw new Error('该功能不在离线演示范围。');
}
module.exports = { request };
