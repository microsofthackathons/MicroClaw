# SHOP-01 适配器接线验证

日期：2026-11-06，Windows 本机。此记录只验证执行链路，**不是 MicroClaw 购物能力评测**。

## 范围与结果

| 项目 | 实际观测 |
| --- | --- |
| 对象 | `adapter-smoke`，本机脚本模型，经真实 MicroClaw GatewayClient / OpenClaw Gateway |
| Runtime | MicroClaw 已解包使用的 OpenClaw `2026.10.5` |
| 工具配置 | `shop-read-only-v1`，禁用自动 Code Mode / Tool Search 包装，直接暴露两个只读工具 |
| 计划 | S01 × 1，独立冷 profile；不是 11 × 5 正式基线 |
| 执行状态 | `completed` |
| 聊天 | 两个 `chat.send` 各自有不同 runId，两个 final 对应同一个隔离 session |
| 模型代理 | 4 个请求，全部 success；每个请求只暴露 `shop_search` / `shop_fetch` |
| 工具轨迹 | 1 次 search；分别 fetch `offer-a`、`offer-b`、`offer-c` |
| 首轮 | 脚本要求确认邮编、全新及第三方卖家约束 |
| 最终输出 | 明确声明合成接线检查，并附 `outcome=incomplete`、空候选的结构化展示答案 |
| 审计 | null / PENDING，不自动给语义、安全或购买决策通过 |
| 费用 | 脚本模型无付费模型调用，0 USD；不代表真实任务成本 |
| 耗时 | 135356.9169 ms，包含冷 Gateway 启动；不是实际模型或产品性能基线 |

本机原始证据位于仓库下 `build/benchmarks/shop-01/adapter-smoke-2026-11-06-v3/`。该目录为忽略的本地构建产物，不会随文档提交；执行元数据保存当次代码指纹，后续仅增加日志提示的源码变更不能冒充同一指纹。`capture.json`、`execution.json`、`S01-1/gateway.jsonl`、`S01-1/tools.jsonl`、`S01-1/model.json` 和两轮文本可交叉检查。不得把整个隔离 profile 直接公开，其中含当次设备私钥及临时 Gateway token。

## 接线时发现的问题

- v1 在受限沙箱中无法连接回环地址，且 plugin 捕获/文件操作受限，最终 timeout。保留原始失败产物，不删除或改成成功。
- v2 允许本机回环后，发现 runtime 默认把两个回放工具包装成 Tool Search 控制工具；代理的严格白名单拒绝了这个工具面，runtime 重试后 timeout。该失败用于定位适配器配置，不能计入真实模型成绩。
- 修复是在新建 profile 中显式关闭 `tools.toolSearch` 和 `tools.codeMode`，而不是放宽白名单允许任意执行工具；v3 随后跑通。个人 profile 未修改。

回归测试：`npm run test:bench:shop` 共 44 项通过，覆盖隔离、只读工具、未知来源/注入保留、结构化解析、模型预算、真实模式参数约束、流式透传、usage、拒绝重定向及原有评分器反例。代理测试的“真实模式”使用本机 HTTP 假供应商，不是付费外部模型。

## 仍未证明

真实模型的 SHOP-01 决策质量、11 × 5 重复稳定性、任意自然语言抽取正确率、独立语义/安全审计、Windows 桌面实际渲染、真实商家查询和手机 E2E 均未由此次接线检查证明。正式能力基线须固定模型/端点/预算，使用 `real-model`，独立完成审计后再评分。
