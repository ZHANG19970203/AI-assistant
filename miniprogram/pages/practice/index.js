const api = require('../../lib/api');

Page({
  data: { busy: false, error: '', practices: [], selectedIndex: 0, active: null, choice: '', reasoning: '', feedback: '', hintText: '', hintLevel: 0, evidence: [], attemptTotal: 0, correctTotal: 0, correctRate: null,
    difficultyIndex: 0, difficulties: [{ id: 'concept', label: '术语或概念分不清' }, { id: 'observation', label: '不确定怎样观察动作' }, { id: 'application', label: '换个情境就不知道怎样解释' }, { id: 'planning', label: '不知道下一步怎样安排' }], checkinMessage: '', checkinAdvice: '' },
  onShow() { this.refresh(); },
  async refresh() {
    this.setData({ error: '' });
    try {
      const state = await api.bootstrap();
      const practices = state.practices || [];
      const index = Math.min(this.data.selectedIndex, Math.max(0, practices.length - 1));
      const attempts = practices.reduce((sum, p) => sum + p.attemptCount, 0);
      const correct = practices.reduce((sum, p) => sum + p.correctCount, 0);
      this.setData({ practices, selectedIndex: index, active: practices[index] || null,
        attemptTotal: attempts, correctTotal: correct, correctRate: attempts ? Math.round(correct * 100 / attempts) : null });
    } catch (err) { this.setData({ error: err.message }); }
  },
  selectPractice(event) {
    const index = Number(event.detail.value);
    this.setData({ selectedIndex: index, active: this.data.practices[index], choice: '', reasoning: '', feedback: '', hintText: '', hintLevel: 0, evidence: [], error: '' });
  },
  selectChoice(event) { this.setData({ choice: event.detail.value }); },
  updateReasoning(event) { this.setData({ reasoning: event.detail.value }); },
  selectDifficulty(event) { this.setData({ difficultyIndex: Number(event.detail.value), checkinAdvice: '' }); },
  updateCheckin(event) { this.setData({ checkinMessage: event.detail.value }); },
  async askForOneStep() {
    this.setData({ busy: true, error: '' });
    try {
      const difficulty = this.data.difficulties[this.data.difficultyIndex];
      const result = await api.checkin(difficulty.id, this.data.checkinMessage.trim());
      this.setData({ checkinAdvice: result.advice });
    } catch (err) { this.setData({ error: err.message }); }
    finally { this.setData({ busy: false }); }
  },
  async submit() {
    if (this.data.busy || !this.data.active) return;
    if (!this.data.choice || !this.data.reasoning.trim()) { this.setData({ error: '请先选择并写一句自己的理由。' }); return; }
    this.setData({ busy: true, error: '' });
    try {
      const result = await api.submitPractice(this.data.active.id, this.data.choice, this.data.reasoning.trim());
      this.setData({ feedback: result.feedback, hintText: result.hint ? result.hint.text : '', hintLevel: result.hint ? result.hint.level : 0 });
      await this.refresh();
    } catch (err) { this.setData({ error: err.message }); }
    finally { this.setData({ busy: false }); }
  },
  async nextHint() {
    if (this.data.busy || !this.data.active) return;
    const next = Math.min(this.data.hintLevel + 1, 3);
    this.setData({ busy: true, error: '' });
    try {
      const result = await api.practiceHint(this.data.active.id, next);
      this.setData({ hintLevel: result.level, hintText: result.hint, evidence: result.evidence || [] });
    } catch (err) { this.setData({ error: err.message }); }
    finally { this.setData({ busy: false }); }
  },
  writeReflection() {
    getApp().globalData.noteDraft = { title: '练习反思 · ' + (this.data.active ? this.data.active.title : ''),
      content: '我原来的判断：' + this.data.reasoning + '\n我准备修正的一点：\n我参考的依据：\n下次我会怎样检查：', sourceRef: this.data.active ? this.data.active.sourceLabel : '' };
    wx.switchTab({ url: '/pages/notes/index' });
  }
});
