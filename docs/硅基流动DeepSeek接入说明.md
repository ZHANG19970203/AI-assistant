# 硅基流动 DeepSeek 接入说明

更新日期：2026-11-03。课程问答可在本机配置 SiliconFlow API 后调用 DeepSeek。默认模型为 `deepseek-ai/DeepSeek-V4.1-Flash`，也可通过 `SILICONFLOW_MODEL` 更换为账户可用的模型。接口使用硅基流动 Chat Completions，模型 ID 应以其模型广场当前信息为准。[硅基流动 Chat Completions 文档](https://docs.siliconflow.cn/docs/api/chat-completions-post) [模型更新公告](https://docs.siliconflow.cn/docs/release-notes/overview)

## 当前工作方式

1. 本地检索先筛出最多三段“已审核、学生可见”的课程资料。
2. 没有足够摘录时，系统不调用模型，也不编造答案，而是将问题留在本地教师待答列表。
3. 有课程依据时，服务端把学生问题、自述和匹配摘录发送到 SiliconFlow。API Key 只保存在服务端进程环境中，不进入浏览器、小程序代码、日志或返回内容。
4. 模型以提示和追问支持学生自己推理；页面始终展示原文出处。上游调用失败时，系统回退到本地摘录并明确标注，不把摘录假装成模型生成内容。

接口地址为 `https://api.siliconflow.cn/v1/chat/completions`，采用 Bearer 认证和 OpenAI 兼容的请求格式。详细参数以[官方接口文档](https://docs.siliconflow.cn/docs/api/chat-completions-post)为准。

## 本机配置

- 密钥保存在项目根目录的 `.env.local`，变量名为 `SILICONFLOW_API_KEY`。
- 可选设置 `SILICONFLOW_MODEL`；未设置时使用上方默认模型。
- `.env.local` 已被 `.gitignore` 排除，也会被项目打包脚本排除。绝不能将密钥放进 `web/` 或 `miniprogram/`。
- 变更配置后，关闭并重新启动 `start.cmd`。
- 当前原型只在本机运行。未来部署服务器时，应在服务器密钥管理中设置这些环境变量，不要复制本地密钥进源码包。

## 学生信息与边界

提交问题时，问题文本、学生写下的初步解释和相应课程摘录会发送至 SiliconFlow。页面会提示这一点。启用真实学生前，教师/学校需确认供应商账户、额度、数据处理和学生告知条件；先使用虚构内容演练，不填姓名、学号、联系方式、健康记录等身份信息。模型输出可能出错，学生应核对原文并向教师求证。

模型调用会使用 SiliconFlow 账户额度。课堂音频、课堂转写、课件整理和 RAG 向量检索尚未接入该模型服务。

## 已完成与尚未验证

- 已完成服务端 API 调用适配、检索结果限定、密钥从本机忽略文件加载、无依据时拒答/转教师及模型故障回退。
- 2026-11-03 已用虚构演示讲义和演示问题完成一次真实 SiliconFlow / DeepSeek 请求，收到提示并显示两段原文引用；这确认了当前密钥和默认模型可用，不代表已评估回答准确率或课堂音频能力。
- 本地微信小程序仍为离线演示；部署到微信前需要另行完成 HTTPS 后端、登录、身份与课程权限隔离。
