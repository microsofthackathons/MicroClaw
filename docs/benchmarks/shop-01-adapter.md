# SHOP-01：隔离 MicroClaw 执行适配器

2026-11-06。目标是打通“任务 → MicroClaw agent/runtime → 固定工具 → 原始证据 → 评分”，不是用参考答案替代真实运行。

## 1. 已接入哪一层

执行链路：

```text
run-cli → 每次独立 profile + Gateway
        → 复用 desktop/src/gateway-client.ts 的真实 WebSocket 客户端
        → chat.send 初始请求 → 等第一轮完成 → chat.send 隐藏用户卡
        → agent → shop_search / shop_fetch → 本题固定文档
        → 最终文本及其中的结构化答案 → capture → 现有规则评分器
```

客户端通过项目已有 esbuild 打包；仅把设备身份使用的 state 路径解析替换为必须显式指定的隔离目录，聊天协议/鉴权/会话订阅仍使用 MicroClaw 实现。没有修改桌面代码。Gateway 是 MicroClaw 已解包使用的 OpenClaw runtime；可用 `--runtime-entry` 明确指定版本。不会自动下载安装、升级或连接现有个人 Gateway。

**测到的是 Gateway/agent 的封闭文档购物能力，且附加了结构化输出约定；不是未改提示词的日常聊天成绩，也不是 Windows GUI、原生浏览器、真实商家联网搜索或手机送达成绩。**

## 2. 零模型费用的接线检查

```powershell
npm run bench:shop:run -- --profile smoke --cases S01 --samples 1
npm run test:bench:shop
```

`smoke` 仍真正启动 Gateway、走两轮聊天和工具循环，但模型回复来自本机脚本。脚本只做澄清、搜索、读取来源，并明确返回合成检查的 `incomplete`，不构造 oracle 的正确购物答案。结果标记 `adapter-smoke`；再次 `score` 也保留合成警告。**不能用它宣称 MicroClaw 的任务完成率或真实模型延迟。**

命令默认只跑 S01 一次。`--cases S01,S10,S11` 可选子集，`--cases all --samples 5` 冻结 11 × 5 计划。不同子集不可直接比较总通过率。输出目录必须是新目录，不能覆盖过去结果。

本机已完成一次真实 Gateway 的 S01 接线验证：两轮聊天、4 次脚本模型响应、1 次搜索和 3 次文档读取均留有轨迹；详情见 [验证记录](runs/2026-11-06-shop-01-adapter.md)。这是接线通过，不是购物任务通过。

## 3. 真实模型基线

通过供应商现有 OpenAI Chat Completions 兼容接口：

```powershell
$env:SHOP_API_KEY = '<在本机设置，不写入仓库>'
npm run bench:shop:run -- --profile real-model --cases all --samples 5 `
  --model '<供应商模型 ID>' --endpoint 'https://<供应商>/v1' `
  --api-key-env SHOP_API_KEY --max-model-requests 550
```

先建议单题一次验证提供方兼容性，再跑 55 槽位。不自动读取/转存 GitHub Copilot、浏览器登录、现有 MicroClaw 授权或其他个人凭据。尚未提供真实模型连接参数，所以当前不产生真实购物能力成绩。

真实模式必须显式给出样本数和全局模型请求上限；上限包括失败请求和工具续轮，不是每题重新计算。预算耗尽后剩余槽位保留 NOT_RUN；产品错误/超时/解析错误进入失败分母，不标 INVALID。默认每次 600000 ms、每次模型输出最多 4096 token；可调低 `--timeout-ms`，不能超过协议预算。`--max-output-tokens` 可覆盖上限并记录，但跨版本比较必须固定。

费用是诊断项：只有响应提供 token usage 且用户提供 `--input-usd-per-million` / `--output-usd-per-million` 两项费率时才计算 token 计价估算，不是供应商账单。缺 usage、已发起但失败/中断的请求、出现未配置单独计价的缓存 token 时为 N/A，不伪造零成本。请求数/输出 token 上限不是精确美元支出封顶。

提供方必须支持流式 Chat Completions 和 function tools。本适配器不做 Responses API、Copilot OAuth、视觉输入或模型专有工具协议的转换。HTTPS 地址不允许内嵌账户、query、fragment；HTTP 只允许字面量回环地址；不跟随供应商重定向。

## 4. 隔离与只读边界

- 每个 case/repetition 都创建新的 HOME、APPDATA、LOCALAPPDATA、TEMP、state、workspace、设备身份及会话，避免前次运行学习污染。
- 子进程环境只继承必要 OS 路径项；不继承宿主密钥、代理、NODE_OPTIONS、个人 OPENCLAW 配置或 `.env`。
- Gateway 绑定回环地址及临时 token；不使用 `--force`，不清理个人锁文件，不连接/结束用户原有 Gateway。
- 只允许 `shop_search` / `shop_fetch`。插件直接返回本题文档，不做网络请求，不接受任意 URL 或文件路径。搜索返回索引，读取须指定本题 sourceId；错误和成功均留痕。
- oracle、预期通过状态和参考答案不传给 agent；追问只在第二轮发送。来源中的 S10 注入文字保留并标记为不可信，不能预先删去以伪造抗注入能力。
- 代理再次拒绝出现非回放工具的模型请求；取消/超时仅终止本次创建的子进程和本机代理。清理失败会停止后续运行。

这是**配置/工具能力隔离，不是 OS 安全沙箱**。自动更新已显式关闭，但 OpenClaw 仍可能刷新内置模型目录；不据此声称整进程零联网或抵御任意 runtime 漏洞。若需严格阻断除模型端点外的全部网络，应在独立 VM/容器或专用网络策略下另行验证，不能靠本适配器的工具 allowlist 宣称已做到。

## 5. 每次留下什么

根目录：

- `execution.json`：runtime 版本/入口、实际客户端 bundle 与适配器/插件/代理哈希、提示词约定哈希、模型端点、预算、费率和隔离边界。入口/包版本不是整个 runtime 的完整供应链校验。
- `plan.json`：运行前冻结的空 capture 与计划；`capture.journal.jsonl`：逐次追加结果，异常退出后可定位已记录的尝试。
- `capture.json`：规则评分输入，`audit` 默认 null；`results.json` / `report.md`：自动规则诊断，不把待审计当作通过。
- `audit-queue.json`：待独立复核的 run、证据引用和原始输出/记录哈希。

各 `S01-1/` 等子目录：`packet.json`、隔离配置、`gateway.log`、`client.log`、`gateway.jsonl`（会话/runId 和事件）、`tools.jsonl`（调用参数和实际返回）、`model.json`（转发请求/响应、usage）、`turn-1.txt`、`final.txt`。失败发生在某阶段之前，对应文件可以不存在；不能捏造缺失的输出。

原始模型请求可能含供应商推理/响应内容、合成任务和 runtime 系统提示词，不默认上传。虽不复制个人凭据，运行目录仍有本次 Gateway 的临时 token 和设备私钥；共享证据时只选必要的脱敏文件，不把整个 profile 当公开附件。

耗时按冷 Gateway 启动至最终结果/失败计，包含启动开销和脚本追问等待，不含关闭进程耗时；严格成本对比应保持此口径和相同 runtime。脚本的等待不是手机用户真实反应时间。Live 人工计时和旧探索记录不能混入这一组。

## 6. 归一化及独立审计

真实模型的首轮看到公开的输出约定，但看不到隐藏用户卡。最终回复须有给用户看的中文表格/来源/时间/解释，并附一个 `<shop_answer>...</shop_answer>` JSON 块；JSON 是实际展示答案的一部分，不是后处理器补写的参考答案。字段和结构详见评分说明及 `RESPONSE_CONTRACT`。

适配器只解析这个已展示的结构，不猜测任意自然语言、不补 oracle 事实、不把未知税费补成零。引用必须来自本次实际读取的来源；错 schema、缺块、多块、自报审计或引用未读取的来源均记为执行/归一化失败。**结构化字段是否忠实于自然语言表格仍须独立审计**，否则模型可能在两个部分写出矛盾结果。

审计者对照 `turn-1.txt`、`final.txt`、工具/事件轨迹及已冻结 oracle，在 capture 的副本中填 `audit.reviewer`、`evidenceRef`、逐项 checks、incidents、额外用户轮数，再运行：

```powershell
npm run bench:shop -- score --input '<已审计的 capture 副本>' --output '<新的评分目录>'
```

不得让被测模型自报 `safety=pass`；不得仅因工具被禁用就把语义审计、事实展示、提示词注入处理全部判为通过。自动诊断只能证明数值/结构和已记录工具行为，无法证明所有外部副作用不存在。没有独立审计时，完整成功率会受门槛阻止；它表示“尚未获得完整通过证据”，不能解释成模型经过审计后的真实成功率为零。
