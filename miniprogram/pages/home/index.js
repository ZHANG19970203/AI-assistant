const api = require('../../lib/api');
const config = require('../../config');
const phases = { pre: '课前', in: '课中', post: '课后' };

function taskView(task) {
  // API 时间均含偏移，显示时明确北京时间；不依赖手机本地时区。
  const date = new Date(task.dueAt);
  const bjt = Number.isNaN(date.valueOf()) ? '' : new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
  return Object.assign({}, task, { phaseLabel: phases[task.phase] || task.phase, dueLabel: bjt ? bjt + ' 北京时间' : '时间待确认' });
}

Page({
  data: {
    busy: false, error: '', loaded: false,
    course: { title: '人体运动学', module: '' }, tasks: [], documents: [],
    progress: { completed: 0, total: 0 }, settings: { reminders: false },
    question: '', attempt: '', reply: null,
    selectedTaskId: '', selectedTaskTitle: '', reflection: '', confidenceIndex: 2,
    confidenceLabels: ['1 · 需要更多帮助', '2 · 不太确定', '3 · 基本理解', '4 · 能够解释', '5 · 能够迁移'],
    subscriptionNote: '尚未接入真实微信订阅；默认离线演示的偏好仅保存在当前小程序进程中。',
    transportNote: config.transportMode === 'offline-demo' ? '离线演示 · 无持久化 · 与网页数据库独立' : '本地 API 适配待联调 · 无真实认证'
  },

  onLoad() { this.refresh(); },

  async refresh() {
    this.setData({ busy: true, error: '' });
    try {
      const state = await api.bootstrap();
      this.setData({
        loaded: true, course: state.course,
        tasks: (state.tasks || []).map(taskView), documents: state.documents || [],
        progress: state.progress, settings: state.settings
      });
    } catch (err) { this.setData({ error: err.message }); }
    finally { this.setData({ busy: false }); }
  },

  updateQuestion(event) { this.setData({ question: event.detail.value }); },
  updateAttempt(event) { this.setData({ attempt: event.detail.value }); },
  updateReflection(event) { this.setData({ reflection: event.detail.value }); },
  updateConfidence(event) { this.setData({ confidenceIndex: Number(event.detail.value) }); },

  async ask() {
    const question = this.data.question.trim();
    if (!question || this.data.busy) return;
    this.setData({ busy: true, error: '', reply: null });
    try { this.setData({ reply: await api.chat(question, this.data.attempt.trim()) }); }
    catch (err) { this.setData({ error: err.message }); }
    finally { this.setData({ busy: false }); }
  },

  selectTask(event) {
    this.setData({ selectedTaskId: event.currentTarget.dataset.id, selectedTaskTitle: event.currentTarget.dataset.title, reflection: '', confidenceIndex: 2 });
  },

  cancelCompletion() { this.setData({ selectedTaskId: '', selectedTaskTitle: '' }); },

  async complete() {
    if (!this.data.selectedTaskId || this.data.busy) return;
    if (!this.data.reflection.trim()) {
      this.setData({ error: '请先写一句你的发现或仍未解决的问题。' });
      return;
    }
    this.setData({ busy: true, error: '' });
    try {
      await api.completeTask(this.data.selectedTaskId, this.data.reflection.trim(), this.data.confidenceIndex + 1);
      this.cancelCompletion();
      await this.refresh();
      wx.showToast({ title: '已记录学习反思', icon: 'success' });
    } catch (err) { this.setData({ error: err.message }); }
    finally { this.setData({ busy: false }); }
  },

  async toggleReminders(event) {
    this.setData({ busy: true, error: '' });
    try { this.setData({ settings: await api.setReminders(Boolean(event.detail.value)) }); }
    catch (err) { this.setData({ error: err.message }); }
    finally { this.setData({ busy: false }); }
  },

  requestWechatSubscription() {
    // 必须由学生点击触发，不在 onLoad/onShow 自动调用。
    if (!config.enableWechatSubscription || !config.subscriptionTemplateIds.length) {
      wx.showModal({ title: '真实微信订阅尚未接入', content: '需要真实小程序主体、模板及服务端授权账本。当前可使用站内任务和本地提醒演示。', showCancel: false });
      return;
    }
    wx.requestSubscribeMessage({
      tmplIds: config.subscriptionTemplateIds,
      success: (res) => {
        const accepted = config.subscriptionTemplateIds.filter(id => res[id] === 'accept');
        this.setData({ subscriptionNote: accepted.length ? '客户端返回同意。服务端授权回传与平台事件尚未实现，本项目不会据此发送真实消息。' : '未获得订阅同意；仍可正常查看和完成任务。' });
      },
      fail: () => this.setData({ subscriptionNote: '本次未完成订阅；仍可正常使用站内学习任务。' })
    });
  }
});
