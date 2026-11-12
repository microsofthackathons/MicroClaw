# Agent 比价实现路线调研

日期：2026-11-11（Asia/Singapore）。承接 [Shopping connector 接入调研](shopping-connector-research-2026-11-11.md)，本次关注已经公开的产品路线和实现方式。

范围：官方产品/数据接口文档、开源源码静态抽查、一个学术基准。没有登录电商账号、运行第三方 Agent、申请服务或实测价格。下述案例用于说明可观察的实现路线，不代表市场份额；产品公开资料也不等于其完整内部架构。

## 结论与对上一轮建议的补充

可观察到四类主要数据获取路线：平台商品库或深度合作接口、第三方商品/搜索服务、通用网页搜索与详情解析、浏览器或手机界面操作。它们可以组合，MCP 只是把这些能力暴露给 Agent 的方式。

对 MicroClaw，正式平台 API 仍值得评估，但不必等待三家 API 都获批才验证购物体验。更适合并行推进：用搜索或可用数据接口发现候选，以受控浏览器核验少量明确商品，再把真实可靠的数据源接入统一报价模型。浏览器实测结果决定是否值得继续投入，不能根据 README 就承诺稳定服务。

首个验证任务宜是“比较两三个明确商品链接/型号”，随后扩展到自然语言选购和跨平台发现。手机 App 路线可以后续单独研究，它需要额外设备、登录与会话管理。

## 四类路线与代表案例

| 路线 | 公开案例 | 价格如何进入 Agent | 主要约束（工程判断） |
| --- | --- | --- | --- |
| 商品库、商家 Feed、平台合作接口 | Google Shopping Graph、ChatGPT 商家商品 Feed、Perplexity 商家集成、千问与淘宝接口 | 先取得结构化商品与商家报价，再用于检索、筛选和对话展示 | 依赖商品数据覆盖与商务/平台接入；公开目录价未必包括用户专属优惠 |
| 第三方商品/搜索 API 或 MCP | SerpApi Shopping、EveryInfra 的国内电商工具案例 | 服务提供方返回价格、店铺、商品链接等字段，Agent 调用并聚合 | API 能返回 JSON 不等于数据授权、时效和字段质量已经核实 |
| 通用搜索加网页提取 | PriceAgent；ComparePrice-Agent 的 Tavily、商品链接模式 | 搜索发现网页或摘要，再解析页面/让模型提取报价 | 摘要可能过期；页面可能隐藏价格；模型可能混淆商品规格 |
| 浏览器或手机 UI 操作 | Playwright 京东/淘宝 MCP；ComparePrice-Agent 的京东浏览器；UCloud OrderWise | 浏览器读取 DOM/页面；手机 Agent 看截图、操作 App、读取当前会话报价 | 需要登录或人工接管；页面和优惠状态影响结果；交互较重，部分精确报价流程会修改购物车 |

### 商品库与平台合作

- Google 官方购物说明明确将商品展示、价格、库存和比较能力关联到 Shopping Graph。这支持“已有商品数据基础设施承接购物 Agent”的判断，不证明每次回答都实时访问每家商户网站。[官方说明，2025-11-13](https://blog.google/products-and-platforms/products/shopping/agentic-checkout-holiday-ai-shopping/)
- OpenAI 官方文档公开了商家商品 Feed 接入流程，涉及已批准合作方、结构化商品数据和目录刷新；产品规范对商品/变体分别建记录，包含商家、价格、库存等字段。它说明了 ChatGPT 的一种公开商品数据来源，不应被描述成所有购物回答唯一的数据来源，也不是供 MicroClaw任意读取 ChatGPT 商品库的接口。[接入文档](https://developers.openai.com/commerce/guides/get-started)、[商品规范](https://learn.chatgpt.com/commerce/specs/file-upload/products)
- Perplexity 官方购物公告描述了 Shopify 集成和商家直接提供规格及更新信息。公告可证明商家数据接入路线；其中历史套餐及结账条件不作为当前可用性结论。[官方购物公告](https://www.perplexity.ai/en-GB/hub/blog/shop-like-a-pro)
- 千问的官方信息共享清单列明淘宝商品搜索通过接口传输。这是平台合作接口的直接证据；不意味着它开放了供第三方任意使用的淘宝、京东、拼多多跨平台比价接口。[官方清单](https://terms.alicdn.com/legal-agreement/terms/privacy_description_of_sharing/20240716181048950/20240716181048950.html)

### 第三方商品数据服务

SerpApi 的 Shopping 文档提供商品标题、来源商家、价格数值、配送信息、商品标识和进一步详情入口。它是第三方提供的 Google Shopping 结果提取服务，不能称为 Google 官方对外商品 API。[服务商文档](https://serpapi.com/shopping-results)

EveryInfra 发布的 Qwen-Agent 实践描述了把远程 MCP 与 REST 工具混合用于淘宝、京东、闲鱼商品分析，同时记录了评论为空、详情价格不可见及接口失败等情况。它能作为“国内电商聚合服务加 Agent”的公开案例；其测试、计费和结果是服务商自述，本次没有独立复现，也没有验证底层数据许可或覆盖率。新商品与二手商品的价格差异不能直接当作同款同条件优惠。[实践原文](https://everyinfra.com/blog/qwen-agent-mcp-ecommerce-review-analyst)

### 通用网页搜索与提取

`nktmane8/PriceAgent` 的 `agent.py` 实际包含模型内置搜索工具调用，把需求、地区和规格交给模型，要求返回商品报价 JSON，再做类型、长度和 URL 等处理。其提示词要求仅扣除已验证的即时优惠，但抽查到的清洗代码本身不是独立的优惠适用性核验器。

该项目也有独立的商品名称归一化模块。需要区分“代码存在规格归一化”与“所有跨店同款匹配均可靠完成”；后者需要真实样本验收。

源码快照 `7b481a19276ac86e3e2afde3e8de554fcb273f94`：[Agent 与结果清洗](https://github.com/nktmane8/PriceAgent/blob/7b481a19276ac86e3e2afde3e8de554fcb273f94/agent.py)、[商品名称归一化](https://github.com/nktmane8/PriceAgent/blob/7b481a19276ac86e3e2afde3e8de554fcb273f94/product_identity.py)。本次未验证其各模型配置在服务端的兼容性。

### 浏览器与手机操作

`HaonanYu123/JD-Taobao-MCP` 是本地 Playwright 浏览器 MCP，提供搜索、详情提取及页面操作；它要求登录和安全验证由用户完成。本轮沿用上一轮静态检查结论，没有运行该项目。[项目说明](https://github.com/HaonanYu123/JD-Taobao-MCP)

`WuFengXueYing/ComparePrice-Agent` 在同一架构下包含多个数据模式：

- 默认模式为模拟数据。
- Tavily 模式通过搜索服务取得公开网页候选和价格线索。
- 链接模式只抓取用户提供的商品详情链接。
- 京东浏览器模式使用 Playwright 持久化独立会话，读取搜索页和详情页。
- `jd_browser` 模式仍混入淘宝、拼多多的模拟连接器；`jd_browser_only` 才只保留真实京东浏览器连接器。

源码快照 `e17bd82a3b0a5b581fbecdf1a187174e789f0fad`：[连接器选择](https://github.com/WuFengXueYing/ComparePrice-Agent/blob/e17bd82a3b0a5b581fbecdf1a187174e789f0fad/src/price_agent/connectors/__init__.py)、[浏览器实现](https://github.com/WuFengXueYing/ComparePrice-Agent/blob/e17bd82a3b0a5b581fbecdf1a187174e789f0fad/src/price_agent/connectors/jd_browser.py)。因此，这个项目能说明混合架构，不能据此认定三个平台都已完成真实接入。

UCloud `orderwise-agent` 展示了更贴近个人应付价的手机路线。其覆盖场景是美团、京东外卖、淘宝闪购的外卖商品，不是京东商城与淘宝全品类。流程包括预先登录、配置地址、为不同平台分配设备并执行任务，再提取商品价、配送费、包装费和总额。

该项目的任务配置实际要求加购物车、进入结算页，并在相关场景选择可用优惠，随后读取应付金额；提示词明确要求停在提交订单/支付之前。这类“比价”已经包含账号状态修改，不能作为只读商品查询接入，也不能把提示词要求当作不可绕过的执行控制。

源码快照 `9583dbe16394a0b0522eacfa55fc00adcf663c0d`：[平台任务配置](https://github.com/ucloud/orderwise-agent/blob/9583dbe16394a0b0522eacfa55fc00adcf663c0d/examples/apps_config.json)、[调度与汇总](https://github.com/ucloud/orderwise-agent/blob/9583dbe16394a0b0522eacfa55fc00adcf663c0d/orderwise_agent/core/compare.py)、[价格提取](https://github.com/ucloud/orderwise-agent/blob/9583dbe16394a0b0522eacfa55fc00adcf663c0d/phone_agent/utils/price_extractor.py)。价格提取代码从 Agent 最终文字中用规则取值，这不是直接调用平台报价 API。

## 比价流程通常如何拆分

以下是对所查实现的归纳与建议，并非所有项目都已完整实现：

1. **明确商品与条件。** 把用户输入拆成型号、规格、件数、地区和预算；区分“同款找低价”与“预算内选替代品”。
2. **发现候选。** 用商品目录、搜索 API 或界面搜索取得商品标识与链接。
3. **补充与核验详情。** 获取具体变体、店铺、库存和报价；搜索摘要只作线索。
4. **判断是否可比。** 对齐品牌、型号、容量/尺寸、版本、新旧状态和套餐；不确定项保留，不把相似度分数直接当同款证明。
5. **明确价格口径。** 区分页面标价、预估优惠价、当前账号和地址的结算总额。只有适用条件已核实的优惠才能扣减。
6. **汇总与解释。** 数值规则处理已核实报价，Agent 解释推荐理由和差异；保存来源、查询时间及必要的页面证据。

在抽查代码中，既有独立的公式/规则模块，也有主要依靠模型输出价格的实现。模型生成了字段齐全的 JSON，不代表价格已经通过独立核验。

例如 ComparePrice-Agent 的匹配器会把部分 `similar` 结果标为可比较的同商品，链接解析器也存在缺价后使用 0 的处理。OrderWise 的价格提取对部分未达到起送条件返回 0。这些都提示：缺失价格、不可购买状态和不同规格必须在最终排序前独立处理，不能照搬示例排序逻辑。[匹配规则](https://github.com/WuFengXueYing/ComparePrice-Agent/blob/e17bd82a3b0a5b581fbecdf1a187174e789f0fad/src/price_agent/matcher.py)、[链接解析](https://github.com/WuFengXueYing/ComparePrice-Agent/blob/e17bd82a3b0a5b581fbecdf1a187174e789f0fad/src/price_agent/connectors/link_spider.py)

## 成熟度如何判断

接口存在、源码有网络调用、作者演示成功、真实场景稳定运行是不同证据层级。本次确认到了前两类及部分作者自述，没有完成后者。

OrderWise README 的性能结果来自作者五个任务的测试，不宜推广为一般购物成功率。[项目说明](https://github.com/ucloud/orderwise-agent)

WebMall 研究使用四个离线模拟商店评估跨店商品发现与比价，论文摘要仍报告最优 Agent 在部分任务类型中完成率低于 65%。这个结果不代表当前全部商业产品的表现，但说明跨店同款搜索和最低价选择需要专门验收。[论文，2026-04-30 修订版](https://arxiv.org/abs/2508.13024)

## 对 MicroClaw 的建议

把 Shopping 做成可组合的任务流程：商品数据连接器、网页/浏览器能力负责取得证据；统一报价模型负责比较条件；Agent 负责理解需求、调度及解释。暂不预设必须先增加三个个人购物账号 Provider。

建议按三步验证：

1. **明确商品链接比较。** 用户提供两个或三个链接，受控浏览器读取并核对规格、页面价格及店铺信息，展示来源和价格口径；需要登录时由用户在受控会话完成。先测京东与淘宝，拼多多是否纳入由实际页面可访问性决定。
2. **搜索发现加少量页面核验。** 接入合适的官方或第三方数据源发现候选，再核验少量结果；无权限或失败的平台返回覆盖状态。该混合方案是本报告的工程建议，并非对某商业产品内部架构的断言。
3. **单独验证个人应付价。** 如果产品需要券、地区、运费等账号相关价格，另行设计有状态交互的授权、隔离和恢复机制；与普通只读搜索区分。手机 App 支持作为独立扩展。

建议记录成功取得真实报价的比例、同款误匹配率、用户接管次数、单任务耗时/成本、价格口径完整度及平台失败分布。原型阶段保留证据和未知项，比展示一个未经核实的最低价数字更能判断产品是否可用。
