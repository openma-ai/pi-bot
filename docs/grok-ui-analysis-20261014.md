# Grok Bot 前端分析与 Pi Bot GUI 改版（2026-10-14）

本轮按用户指定的已安装 Grok Bot 效果重做本地 IM。现有 React / Radix Themes 保留，加入 Lucide 图标、react-markdown / remark-gfm。没有使用 Ant Design、Chatscope 或 AI 聊天 runtime；原有 Pi SDK、消息路由、群聊共享可见性和认证接口继续使用。

## 参考来源和 REA 证据

- 通过 computer use 观察 `/Applications/Grok Bot.app` 的联系人列表、私聊、群聊、详情、定时任务开关和电脑预览。没有发送 Grok Bot 消息、改变其任务或读取凭据/聊天数据库。
- REA `rea-agents@6.4.0` 的 `extract-artifact` 提取安装包，`analyze-javascript-application` 静态分析选定 renderer 文件。归档 SHA-256、各文件摘要、Evidence ID 和统计见 [分析摘要](gui-evidence/grok-renderer-analysis-20261014.json)。原始资源和完整大图谱仅保存在忽略的 `work/gui/grok-analysis/`。
- 四份 JS：2,660,164 字节，783,935 AST 节点，零解析失败；应用图谱 625 节点、3,384 边。另查阅 renderer CSS。分析范围是选定文件子集，未解析全部动态 import，不代表完整源码恢复。
- 默认完整归档分析因一个 unpacked 原生依赖与归档声明的哈希不一致而失败。后续提取使用 `record-and-continue`，保留矛盾记录，不执行归档代码。选定 renderer 目录独立分析通过。
- `recover-javascript-sources` 在本机不可用：REA 要求另行配置 Linux x64 Wakaru；没有把失败写成已恢复源码。此次完成的是资源提取、静态 AST/关系分析和实际窗口观察。
- 公开的 [Grok Bot 社区重建仓库](https://github.com/b-nnett/grok-bot-0.18-reconstructed) 明确说明发行版没有原始前端源码或 source maps；其前端目录是部分重建。未确认所谓原始前端源码泄漏。

没有把 Grok Bot 的压缩代码、品牌素材或用户数据加入 Pi Bot。头像为本项目新写的 SVG；布局、间距、交互和视觉层级依据观察重新实现。

## 实现

后续用户指出侧栏、搜索、输入框和错误提醒未达到预期；现已改为成熟 Sidebar / cmdk 并补真实截图链路验收，见 [后续修复报告](gui-navigation-errors-20261014.md)。本文件下面的实现描述和 232 项测试属于第一版历史记录。

- 侧栏固定页脚，联系人列表独立滚动。主页头像、搜索、新建、联系人与群聊使用简单 IM 导航。
- 居中的会话身份按钮；可关闭的右侧详情，窄窗口用 Radix 对话框。详情包含所属 bot 的定时任务、监控和电脑；底层会话/工具信息折叠。
- 深色消息气泡和高对比的暖色用户气泡；按时间间隔显示时间分隔，私聊隐藏重复作者及普通投递标签。异常/待处理状态仍显示；不冒充“已读”或“任务完成”。
- Markdown 列表、代码和表格。HTML 不执行，远程图片不自动加载。裸绝对路径独立显示，可横向查看及复制完整路径；原消息和路径字节不裁剪。
- 查看旧消息时保留位置，提供“最新消息”；会话切换和保持在底部时跟随新消息及尺寸变化。
- 六色、三形的稳定 SVG 头像，眨眼、悬停倾斜，真实运行时轻微摆动；后台 job 也纳入运行状态。排队、运行、待处理请求区分，完成的历史 turn 不算运行。减少动态效果设置禁用动画。
- 手机宽度下联系人抽屉，选中后关闭；Escape 收起。没有新增演示消息或假任务。

## 验证

- 类型检查、生产构建通过。232/232 离线测试通过，其中新增四项验证运行状态、排队状态、完整路径保留和稳定头像身份。离线测试与下面真实 API 结果分开。
- GUI 通过实际 browser/computer use 检查 1360×900、390×844 和原窗口 793×897：无页面横向溢出、联系人抽屉、可关闭详情、@成员 / @全体成员插入、定时任务及监控创建表单归属。
- 原生 GUI 实测一项任务：inbox → 原生 bash `echo $((7*8))` → exit 0 / `56` → `send_message` → GUI `GUI-STYLE-20261014=56`。实际 turn 完成且无错误，[脱敏轨迹](gui-evidence/gui-real-task-20261014.json) 保留工具、job、inbox 和 send_message。该 turn 原生 usage 为 input 22,536、output 313、cacheRead 15,232、reasoning 61；provider token 分类按原生定义保留，不自行相加。此 GUI smoke 不替代真实消息洪流 benchmark。
- 实际 Linux 桌面预览、noVNC 窗口与 Watching → Controlling → Watching 验收。只验证接管状态和交回，没有向远程桌面输入内容；本轮不扩大之前的跨 bot 窗口隔离验收结论。
- `21st review` 未报告交互/无障碍阻塞问题，报告 80 条颜色常量信息提示。新的视觉方向记录在 `.21st/design.json` 和 `.impeccable.md`。

界面证据：[正常窗口](gui-evidence/gui-final-20261014.png)、[宽屏详情](gui-evidence/gui-wide-20261014.png)、[完整路径复制](gui-evidence/gui-path-20261014.png)、[交回后的真实桌面](gui-evidence/desktop-watching-20261014.png)。截图证明对应画面与状态，动效由实际 DOM 动画样式核对，不把静态截图当作动画录制。

## 复现

REA CLI 无需永久修改 Codex 的 MCP 设置或重启当前聊天：

```sh
npx -y rea-agents@6.4.0 extract-artifact '/Applications/Grok Bot.app/Contents/Resources/app.asar' --integrity-policy record-and-continue --format json
# 从上一步的 output_root 选择 renderer 文件到独立目录，然后：
npx -y rea-agents@6.4.0 analyze-javascript-application /absolute/path/to/selected-renderer --analysis-timeout-ms 60000 --format json
npm run check
npm test
npm run gui:build
```

运行正常 daemon 后打开 `http://127.0.0.1:4317/`，选择 bot 发送任务；右上角打开详情管理该 bot 的任务和电脑。Grok Bot 本机用户数据、认证及服务连接均不需接入。
