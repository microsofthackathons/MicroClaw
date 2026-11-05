# SET-03 实际能力矩阵、作用域与受限原因

阶段：主线 P0；复杂度：M。依赖：SET-01、SET-02。

## 目标与边界

回答“配置了没有、策略允许吗、当前是否生效、为什么失败”，让各功能页共用一致解释。主责 F06、F11；浏览器/记忆/设备等受限能力本任务只说明，不开放执行。

## 实施范围

1. 从实际配置、Runtime 广告、MXC 状态、节点和连接状态汇总脱敏快照，包含来源/时间和目标。
2. 区分 requested、effective、unsupported、policy-blocked、pending、failed、unknown；缺数据不能等于关闭或成功。
3. 分清 MXC `off/full/limited-dacl`、host/容器、命令同意模式、Gateway/node generation；复核当前模式分离提交。
4. 覆盖 exec、网页搜索/读取、技能/插件、微信、Cron/Hooks、MCP、浏览器、记忆、设备/语音等状态；只读矩阵不转化为新授权入口。
5. 提供领域可复用的状态提示组件和原因码映射；每页可展示全局/Agent/会话来源和安全下一步。

## 写入范围

- 独占新增：`desktop/src/settings/capabilities/`、`desktop/renderer/src/components/settings/capabilities/`、`components/settings/common/CapabilityState.vue` 及测试。
- 只读复用 `windows-node-mxc-disclosure.ts`、`windows-node-mxc-modes.ts`、命令同意/Runtime 状态接口；不修改实际策略或运行模式。
- 共享注册/类型交 SET-02，设置分组/文案注册交 SET-01。
- SET-06/07/08/09/10/12/13/15/16 消费此结构；领域特有执行结果仍由领域服务负责，不把状态服务变成业务写入中枢。

## 验收

- [ ] 策略允许但断连、配置请求开启但被保护暂停、已保存但待重启等状态可区分。
- [ ] 切换 Agent、运行模式/同意模式、Gateway generation 时旧响应不会覆盖新目标状态。
- [ ] host 模式不会显示“已获 MXC 保护”；`allow-always` 不被显示为获得新目录权限。
- [ ] Cron/Hooks 暂停、MCP/记忆/浏览器受限原因来源准确，默认下一步不是关闭 MXC。
- [ ] Runtime 不支持和权限不足显示为不同状态，不猜测所有版本可用。
- [ ] 状态矩阵在正式设置可达，可被搜索；不调用写 RPC，不泄露凭据或用户内容。

非目标：实现工具执行、MCP/浏览器/记忆服务、变更保护默认值、重新发明实时审批。既有能力只解释，不能把只读矩阵的完成算成执行功能完成。
