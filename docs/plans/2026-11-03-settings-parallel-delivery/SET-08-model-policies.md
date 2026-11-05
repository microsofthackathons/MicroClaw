# SET-08 模型连接、默认/回退/用途与思考策略

阶段：主线 P1；复杂度：L。依赖：SET-01、SET-02、SET-03。D1 未决只阻止新增连接开放，不阻止已有连接和策略交付。

## 目标与边界

统一管理“连哪个提供方、哪个范围用哪个模型、失败如何回退”。主责 B01–B13；已有预设/本地模型/会话切换只回归，不重建整个本地模型系统。

## 实施范围

1. 保留预设提供方、已有 custom 连接的三种协议编辑、连接测试、本地模型准备/启用/取消/移除；先复核最新的移除连接实现。
2. 在固定 Runtime 支持的 Schema 内实现全局/Agent 默认模型、排序回退链、utility 用途模型；展示继承和会话覆盖，不强制重置现有会话模型。
3. 对支持的模型暴露思考/fast/verbose 等已验证选项；无模型 metadata 或 Runtime 不支持时明确未知/不可用，不猜 effort 值。
4. 对模型适用的 context/output/请求参数提供受支持的高级子集；Header、非本任务字段与 SecretRef 必须保留。
5. 区分认证缺失、连接失败、模型不存在、目录刷新失败、限额未知；配额/供应商状态仅在存在可靠来源时显示。
6. D1 决定正式开放新建 custom 后再接入口；OAuth/订阅供应商扩展、内部 Copilot 开关不能擅自开放。多媒体专用模型不列入本轮必须项。

## 写入范围

- 独占新增：`desktop/src/settings/models/`、`desktop/renderer/src/components/settings/models/` 及测试。
- 既有域独占：`components/ModelSetupDialog.vue` 及测试、模型表单/选择 utilities；已有本地模型组件原则只回归，必要改动声明具体文件。
- 既有 `SettingsView.models.test.ts` 的领域断言由本任务维护；`SettingsView.vue` 模型区替换交 SET-01。
- `model-config-application.ts`、MXC 模型事务、主进程/预加载接点交 SET-02；会话 model service 继续沿用，不复制一套。
- SET-07 通过公开 Agent 模型面板集成；SET-09 不直接实现模型字段写入；SET-17 后续提供凭据引用。

## 验收

- [ ] 新旧预设、已有 custom、无 Key/SecretRef、三种协议、本地连接及移除操作均不回归。
- [ ] 全局/Agent/会话来源可分辨；变更一个范围不偷偷清空另一个范围覆盖。
- [ ] 回退顺序、重复/失效模型和 utility 不可用有校验；模型失效测试不要求真实供应商付费调用。
- [ ] 高级/未知字段与凭据引用保存后完整，主进程脱敏查询不回显秘密。
- [ ] 并发配置、断连、Gateway 切换、需要重启及 MXC 生效验证均沿安全路径；不走整份通用回写。
- [ ] D1 未确认时保持既有新建 custom/内部 OAuth 门控，并将未开放项列入交付说明。

非目标：升级 Runtime、打开内部提供方、建立凭据保险库、重写 llama.cpp 下载器、实现完整媒体/语音模型控制台。
