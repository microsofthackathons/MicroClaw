# SET-06 正式版技能管理与逐 Agent 生效状态

阶段：主线 P1；复杂度：M。依赖：SET-01、SET-02、SET-03。

## 目标与边界

将已有开发技能能力产品化，交付正式入口、清晰状态和安全变更闭环。主责 D01、D02、D05；不把去掉 DEV 条件当成完成。

## 实施范围

1. 复用 `components/skills/SkillsDevPanel.vue` 和 preload 已有 list/status/refresh/allowlist/managed entries/Agent skills 等能力，先复核当前真实实现。
2. 正式面板提供筛选、来源、技能详情、依赖缺失与完整性状态；区分全局停用、Agent 未选择、策略阻断、Runtime 不支持和加载失败。
3. 支持已安全允许的全局启停、逐 Agent 选择与刷新；目标稳定绑定，提交后查询实际状态，不乐观伪造启用。
4. 完整性变更仍走现有检查、确认和恢复流程；保留启动时的完整性提示，不取消校验换便利。
5. 已安装但缺依赖时显示可操作说明；安装按钮链接后续 SET-18，不在本任务执行任意下载或 shell。

## 写入范围

- 独占新增：`desktop/src/settings/skills/`、`desktop/renderer/src/components/settings/skills/` 及测试。
- 既有域独占：`components/skills/SkillsDevPanel.vue` 及其测试；按需复用 `skill-config.ts`、`agent-owned-skills.ts`、`skill-integrity.ts`，安全/完整性实现变更先交 SET-02 审查。
- 设置可见性/路由与 i18n 注册交 SET-01；preload/main 注册交 SET-02，不直接改 `App.vue` 启动校验。
- SET-07 仅链接/嵌入公开技能面板，不修改技能 allowlist；SET-18 只负责后续安装准入，不接管本任务的启用语义。

## 验收

- [ ] 打包正式版无 DEV 开关也能进入；开发专有操作仍保持原门控。
- [ ] 合成技能覆盖全局禁用、Agent 未选、缺二进制/凭据、完整性异常、保护限制和可用状态。
- [ ] Agent 切换时旧加载/提交不能污染新 Agent；并发冲突可恢复草稿。
- [ ] 修改 allowlist/启停后确认实际生效；受限操作明确失败，不扩大插件允许列表。
- [ ] 完整性告警和已有启动流程无回归；不自动安装缺失依赖、不下载网络内容。

非目标：技能市场、依赖包安装、技能凭据中心、任意 Skill 脚本执行、修改全局保护策略。交付正式技能页和技能领域回归结果。
