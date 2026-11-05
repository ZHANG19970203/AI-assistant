const config = require('../config');
const mock = require('./mock');

function request(path, method, data) {
  if (config.transportMode === 'offline-demo') return mock.request(path, method, data);
  if (!config.demoMode) {
    return Promise.reject(new Error('正式身份会话适配器尚未实现，请先完成后端认证。'));
  }
  return new Promise((resolve, reject) => {
    wx.request({
      url: config.apiBaseUrl + path,
      method: method || 'GET',
      data: data,
      header: { 'content-type': 'application/json', 'x-demo-role': 'student' },
      timeout: 15000,
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(res.data);
        else if (res.statusCode === 403) reject(new Error('接口未接受当前微信请求。微信 Referer 与正式会话适配尚未完成，请继续使用默认离线演示；不要关闭服务端来源保护。'));
        else reject(new Error((res.data && res.data.error) || '请求失败，请稍后重试。'));
      },
      fail() { reject(new Error('无法连接本地服务。请确认电脑上的服务已启动，并核对开发工具的域名校验设置。')); }
    });
  });
}
function offlineFeature(path, data) {
  if (config.transportMode !== 'offline-demo') return Promise.reject(new Error('新增学生页面当前仅在默认离线演示中可用；正式服务适配尚待联调。'));
  return mock.request(path, 'POST', data);
}

module.exports = {
  bootstrap: () => request('/api/bootstrap'),
  chat: (question, attempt) => request('/api/chat', 'POST', { question, attempt }),
  completeTask: (id, reflection, confidence) => request('/api/tasks/' + encodeURIComponent(id) + '/complete', 'POST', { reflection, confidence }),
  setReminders: (reminders) => request('/api/settings', 'POST', { reminders }),
  submitPractice: (id, choice, reasoning) => offlineFeature('/api/practice/' + encodeURIComponent(id) + '/submit', { choice, reasoning }),
  practiceHint: (id, level) => offlineFeature('/api/practice/' + encodeURIComponent(id) + '/hint', { level }),
  saveNote: (title, content, sourceRef) => offlineFeature('/api/notes', { title, content, sourceRef }),
  checkin: (difficulty, message) => offlineFeature('/api/checkin', { difficulty, message })
};
