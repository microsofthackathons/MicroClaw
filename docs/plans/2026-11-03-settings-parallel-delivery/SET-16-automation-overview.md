# SET-16 自动化只读入口、任务详情与暂停解释

阶段：主线 P1；复杂度：M。依赖：SET-01、SET-02、SET-03。

## 目标与边界

把已有 Cron 查询接成正式、准确的只读页面。主责 E07，并提供 E09 可验证的只读历史部分；不因为普通模式没暂停就自动开放写操作。

## 实施范围

1. 复用 `TasksView.vue`、`stores/tasks.ts` 与现有 `cron.list` IPC，核实未注册路由、任务状态和保护暂停注解。
2. 正式页面显示任务身份、调度/时区、下一次运行、目标 Agent/会话、requested/effective 及暂停原因；不依靠单一 enabled 字段。
3. 详情和历史只使用 Runtime 实际广告且已允许的只读 RPC；没有历史能力时明确不可用，不伪造空历史。
4. 保护期间明确“不执行/不会自动补跑错过任务”，切换模式仍以主进程实际状态为准。
5. 新建、编辑、删除、立即运行的后续入口说明 SET-19 条件，不给只读任务添加隐藏写 IPC。

## 写入范围

- 独占新增：`desktop/src/settings/automation-readonly/`、`desktop/renderer/src/components/settings/automation/` 及测试。
- 既有域独占：`views/TasksView.vue`、`stores/tasks.ts` 及相关测试。
- `windows-node-mxc-cron.ts` 与恢复 fence 只读；只读 registrar/类型交 SET-02，正式入口交 SET-01。
- SET-19 使用独立 automation-execution 目录；复用本任务组件需在完成后显式交接，不能并行改同一任务 Store。

## 验收

- [ ] 正式构建可通过设置入口进入，空列表/错误/断连和刷新有一致处理。
- [ ] 请求开启但被保护暂停、普通关闭、Runtime 不支持、未知状态可区分。
- [ ] 时间与时区正确，模式/Agent 变化后旧响应不能覆盖新状态。
- [ ] 只读页面不发 add/update/remove/run 等变更，不扩大 Gateway RPC 允许列表。
- [ ] 能力缺失不误报“暂无运行记录”；历史内容不泄露任务载荷或秘密。
- [ ] 既有暂停/恢复 fence 与“不重放”约束无回归。

非目标：Cron 编辑器、手动执行、Hooks/Webhook 接收、补跑系统、告警调度器。只读入口可独立交付，不以 SET-19 安全决策为前置。
