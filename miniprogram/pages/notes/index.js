const api = require('../../lib/api');

Page({
  data: { busy: false, error: '', title: '', content: '', sourceRef: '', notes: [] },
  onShow() {
    const draft = getApp().globalData.noteDraft;
    if (draft) { this.setData(draft); delete getApp().globalData.noteDraft; }
    this.refresh();
  },
  async refresh() {
    try { const state = await api.bootstrap(); this.setData({ notes: state.notes || [] }); }
    catch (err) { this.setData({ error: err.message }); }
  },
  updateTitle(event) { this.setData({ title: event.detail.value }); },
  updateContent(event) { this.setData({ content: event.detail.value }); },
  updateSource(event) { this.setData({ sourceRef: event.detail.value }); },
  insertReflectionFrame() {
    if (this.data.content.trim()) return;
    this.setData({ content: '我原来怎样想：\n我观察到什么：\n我参考的依据：\n我修正的一点：\n下一步我选择：' });
  },
  async save() {
    if (this.data.busy) return;
    if (!this.data.title.trim() || !this.data.content.trim()) { this.setData({ error: '请填写标题，并用自己的话记下一点。' }); return; }
    this.setData({ busy: true, error: '' });
    try {
      await api.saveNote(this.data.title.trim(), this.data.content.trim(), this.data.sourceRef.trim());
      this.setData({ title: '', content: '', sourceRef: '' }); await this.refresh();
      wx.showToast({ title: '已保存离线笔记', icon: 'success' });
    } catch (err) { this.setData({ error: err.message }); }
    finally { this.setData({ busy: false }); }
  }
});
