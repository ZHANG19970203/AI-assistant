const api = require('../../lib/api');

Page({
  data: { error: '', dimensions: [], evidence: [] },
  onShow() { this.refresh(); },
  onReady() { this.drawRadar(); },
  async refresh() {
    try {
      const state = await api.bootstrap();
      const companion = state.companion || {};
      this.setData({ error: '', dimensions: companion.dimensions || [], evidence: companion.evidence || [] }, () => this.drawRadar());
    } catch (err) { this.setData({ error: err.message }); }
  },
  drawRadar() {
    // 仅绘制底图，不把null当0画成绩面；本骨架没有教师评分入口。
    const ctx = wx.createCanvasContext('evidenceRadar', this);
    const cx = 150; const cy = 142; const maxRadius = 92;
    const point = (index, radius) => ({ x: cx + Math.cos(-Math.PI / 2 + index * Math.PI / 3) * radius, y: cy + Math.sin(-Math.PI / 2 + index * Math.PI / 3) * radius });
    ctx.clearRect(0, 0, 300, 290);
    ctx.setStrokeStyle('#d2dfcf'); ctx.setLineWidth(1);
    [0.25, 0.5, 0.75, 1].forEach(scale => {
      ctx.beginPath();
      for (let i = 0; i < 6; i += 1) { const p = point(i, maxRadius * scale); if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); }
      ctx.closePath(); ctx.stroke();
    });
    for (let i = 0; i < 6; i += 1) { const p = point(i, maxRadius); ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(p.x, p.y); ctx.stroke(); }
    const labels = ['概念辨析', '动作观察', '证据运用', '情境迁移', '反思修正', '自主规划'];
    const anchors = [{ x: 150, y: 24 }, { x: 254, y: 80 }, { x: 254, y: 207 }, { x: 150, y: 272 }, { x: 46, y: 207 }, { x: 46, y: 80 }];
    ctx.setFontSize(12); ctx.setFillStyle('#4f6c57'); ctx.setTextAlign('center');
    labels.forEach((label, i) => ctx.fillText(label, anchors[i].x, anchors[i].y));
    ctx.setFontSize(15); ctx.setFillStyle('#6f8268'); ctx.fillText('待教师证据评分', cx, cy + 5);
    ctx.draw();
  }
});
