# 搜索组件与免费替代方案调研

调研日期：2026-11-13。范围：官方文档、免费条件、当前 MicroClaw 接入代码和依赖包。未对各搜索引擎做同条件的质量、中文覆盖或延迟实测，因此不提供未经测量的搜索质量排名。

## 结论与建议

Parallel 适合作为当前“少配置即可开始”的默认候选，但不能据此称为搜索质量最强。它本身就有匿名免费 MCP，且 MicroClaw 已接入。此次失败发生在组件的 npm 元数据获取阶段，不能作为其搜索结果质量差的证据。[Parallel 官方说明](https://parallel.ai/mcp)

最值得做下一轮对照的是 Exa 的匿名 MCP，同样支持不填 Key 的基本使用。对于愿意注册账号的用户，Tavily 是已有接入口中的免费额度备选。企业有部署能力时可评估 SearXNG 自托管。以上推荐基于使用门槛和接入情况，是产品选型判断，不是实测成绩。[Exa 官方仓库](https://github.com/exa-labs/exa-mcp-server)、[Tavily 价格页](https://www.tavily.com/pricing)、[SearXNG 文档](https://docs.searxng.org/)

## “免费”需要分成三种

| 方案 | 免费条件 | 用户操作与限制 | 当前接入判断 |
| --- | --- | --- | --- |
| Parallel 匿名 MCP | 搜索、抓取等基础工具可免账号、免 Key 使用 | 匿名限流；本轮未取得可承诺的具体日/月次数。不能把免费 MCP 与付费 API 当成相同配额 | 已有 `parallel-free` 提供商，是现有默认候选。[官方](https://parallel.ai/mcp) |
| Exa 匿名 MCP | 支持匿名、受限使用 | OAuth/Key 可提高限额；匿名模式不是无限免费服务 | 当前设置页没有 Exa 选项，需要 MCP/搜索提供商适配。[官方仓库](https://github.com/exa-labs/exa-mcp-server) |
| Tavily API | 每月 1,000 credits；免费 Researcher 无需信用卡 | 注册并填写 API Key；basic search 消耗 1 credit，advanced 为 2，其他操作另计 | 当前设置页已有支持，额外接入成本低。[价格](https://www.tavily.com/pricing)、[计费说明](https://help.tavily.com/articles/8298987937-billing-credits-usage-limits) |
| Exa API 账号 | Starter 每月 $10 credits，另有 $10 onboarding bonus；无需支付方式 | 账号/API Key；不同搜索类型和内容提取消耗不同，不能直接换算成固定调用次数 | 与匿名 MCP 是两种使用方式，需要补充产品入口。[官方价格](https://exa.ai/pricing) |
| Brave Search API | 每月 $5 免费 credits；当前 Search 示例约 1,000 次 | 需要 API Key 和信用卡；官方说明没有独立 free plan | 当前设置页已有支持，但不符合“免注册免卡”的默认体验。[官方说明](https://api-dashboard.search.brave.com/documentation/resources/help-feedback) |
| SearXNG 自托管 | 免费开源软件，可自己部署 | 需要承担服务器、网络和维护成本；JSON 输出必须在实例配置中启用，许多公共实例会禁用 | 需要服务部署与适配，不宜直接依赖不受控的公共实例。[项目文档](https://docs.searxng.org/)、[API 文档](https://docs.searxng.org/dev/search_api.html) |

Exa 官方服务端源码给出的匿名限流默认值为 2 QPS、50 次/日，可被环境变量覆盖；这只是源码默认值，不是对当前公共托管服务配置的保证。[源码](https://github.com/exa-labs/exa-mcp-server/blob/main/api/mcp.ts)

## 当前 MicroClaw 的实际情况

设置页与 `search-provider-plugin.ts` 当前只声明 Parallel Free、Brave、Tavily 三种搜索提供商。接入 Exa 或 SearXNG 需要适配，不能只替换下拉框文字。

通过已固定版本的 `@openclaw/parallel-plugin@2026.10.10` 代码核对，`parallel-free` 与需要认证的 Parallel API 提供商是两条独立实现；免费实现调用 `https://search.parallel.ai/mcp`。Parallel 主站当前展示的通用 MCP 地址是 `https://mcp.parallel.ai/mcp`；本轮没有验证两个地址的兼容关系，也没有改动插件端点。[Parallel 官方 MCP 页面](https://parallel.ai/mcp)

当前包源修复已验证元数据获取、包下载、SHA-512 和隔离依赖安装，但没有把搜索插件预置到 EXE，也没有切换默认搜索服务。包能下载与搜索服务可用、检索质量好，是三个不同的验收项。

## 不直接列为“已确认永久免费”的其他候选

博查官方 MCP 仓库要求 API Key，本轮未从该仓库确认可持续免费额度，因此不将它列入已确认免费项；中文检索能力可作为后续候选单独实测。[官方仓库](https://github.com/bochaai/bocha-search-mcp)

本轮没有使用社区抓取客户端代替正式搜索 API，也未将某个公共自托管实例的可访问性当作稳定免费服务承诺。

## 下一步如何判断是否换默认值

建议先对照 Parallel 与 Exa，固定相同模型、提示词、结果数量和超时预算，分别测试：

- 当天天气：地点、当地日期、新鲜度、当前天气与全天预报区分。
- 中文购物：500 元会议耳机约束、型号/麦克风证据、卖家和价格条件、无合格项时的诚实结果。
- 普通网页与跨页核验：可点击引用、正文可获取、摘要与原文一致性。

记录有效任务完成率、事实与来源核验、延迟、429/失败比例、额外配置步骤和实际额度消耗。无账号的匿名服务与带 Key 的免费额度服务分开评估。天气或购物页面本身需要登录、动态加载或缺少配送信息时，单靠更换搜索引擎不一定解决。

在这组对照结果出现前，建议保留现有 Parallel 默认候选，把 Exa 放在优先调研适配位置，保留 Tavily 的用户可选入口。企业自托管需求则单独评估 SearXNG。
