// 仅供同一电脑的微信开发者工具模拟器。真机不得使用本机回环地址。
module.exports = {
  apiBaseUrl: 'http://127.0.0.1:4317',
  // offline-demo 在当前小程序进程中保存演示状态；不会连接网页端数据库。
  // local-api 仅保留接口契约；微信 Referer 等适配未完成，不能视为已联调。
  transportMode: 'offline-demo',
  demoMode: true,
  // 当前后端未实现真实登录/订阅回传/平台事件处理。完成这些服务后才能开启。
  enableWechatSubscription: false,
  subscriptionTemplateIds: []
};
