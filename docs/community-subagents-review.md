# 社区 pi-subagents 源码与兼容性检查

2026-10-13。候选：https://github.com/nicobailon/pi-subagents 。本次只检查和离线探测，没有替换生产路径或全局安装扩展。

检查两个明确版本：上游 main `a4c8ced69a8176cdf4179b127feddc8875e3418f`（package.json 0.78.0）；实际 npm 发布版 `pi-subagents@0.77.0`，gitHead `1ac9b964eb9cda1662507c52f5277764637daccc`。发布包完整性：`sha512-kpTpUnV1hyGM0845thS7IT2QFZVBuodq/rdOqsmimQgZvixzw7fOStqt7zWN++xpb3j1AtmMFWeNU5tcp8i3uQ==`。不能把 main 检查结果直接当成发布版版本号。

## 结果

- 发布扩展入口可在现有 Pi 1.1.0 上导入。
- 实际使用发布包的 `createDefaultChildSessionFactory`，由原生 Pi 执行 write/read，产物 73，最终结果 Verified 73，持久原生 session JSONL。
- Provider 是 faux，ModelRuntime 注入内存实例、SettingsManager 注入禁用 compaction/retry 的 fixture；没有读取认证去调用模型，没有真实 API 费用。
- 这是扩展入口加载和真实社区子会话工厂/原生工具兼容性，不是完整 extension 注册、后台 runner、重启恢复或预算保护的端到端验收。

它支持前台同进程子会话、后台独立 runner、持久 artifacts 与完成回放。后台结果通知与原生 Pi 父进程绑定；文档明确指出重新打开到另一进程不会自动得到原来的完成 wake，需要读取 status。因此不能把它现成的通知当成我们 durable inbox/outbox 的跨进程恢复。

源码边界：`src/runs/shared/child-session.ts` 的默认工厂创建自己的 ModelRuntime，使用 Pi 原生认证，适合认证复用，但不会自然经过本项目 GUI 的 beforeProviderRequest 预算钩子。ChildSession API 不直接公开 AgentSession 的 streamFunction，需要受控工厂/SDK 包装注入请求上限、超时和输出限额；不能只检查最终累计 tokens。

`src/runs/foreground/execution.ts` 会处理 signal abort、恢复路径和 compaction 生命周期；默认 SettingsManager.create 也读取 Pi 设置。因此在集成验收前，需要明确禁用自动 retry/同步压缩并审查恢复请求预算。结果的显示截断与模型上下文压缩是不同机制，不能只看到 truncateOutput 就断言它裁剪了模型历史。

## 建议接法

复用社区扩展的执行、agent profiles 和结果功能，保留宿主现有 jobs/inbox/outbox 为任务关联与投递的权威记录。父 bot 的 subagent 调用先进入稳定 key 的持久 job，执行端使用 fresh child，不继承群聊/私聊全文。子会话共用 Pi 认证，并在每次请求、每次工具调用与最终发布前接入预算、权限、任务有效性检查。结果只回父 bot，由父 bot send_message；不让社区原生通知绕过现有路由。避免两套恢复机制重复投递或自动重跑写文件任务。

先验收单 worker，保持一 bot 一个活跃 worker、禁用递归与并行/自动恢复；再验证父消息抢占时存活、取消后过时写入/回复被阻止、重启不重复执行和共享预算。无需因此升级 Pi 1.2。

## 复现

仓库内执行：

```sh
npm install --prefix work/subagents-compat --no-save --ignore-scripts --legacy-peer-deps --registry=https://registry.npmjs.org pi-subagents@0.77.0
node --import tsx scripts/probe-community-subagents.mjs
```

仅隔离安装在忽略的 work/ 下，不改变项目依赖或全局 Pi。结果在 `work/subagents-compat/report.json`，原生 session/产物在 fixture/。该 probe 使用内部 child-session 模块，不是稳定公共 API；正式集成应固定发布版本，并评估公共 delegation transport 或明确维护一个薄适配层。
