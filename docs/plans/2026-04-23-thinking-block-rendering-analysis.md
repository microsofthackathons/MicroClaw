# Thinking Block 渲染时序分析

**日期**: 2026-04-23  
**状态**: 分析完成

## 现象

模型输出的正文内容在流式传输过程中实时渲染，但 Thinking（推理过程）在模型输出完成后才突然出现在消息顶部的折叠面板中。

## 根因

问题根源在 **Gateway 侧**：OpenClaw Gateway 在流式 delta 事件中只发送纯文本，不包含 thinking 内容块。Thinking 块仅存在于 Gateway 持久化的会话历史中，前端通过 `loadHistory()` 获取后才能渲染。

## 详细流程

### 1. 流式阶段（delta 事件）

Gateway `emitChatDelta` 发送的 payload 结构：

```javascript
{
  state: "delta",
  message: {
    role: "assistant",
    content: [{ type: "text", text: mergedText }],  // 仅纯文本，无 thinking
    timestamp: now
  }
}
```

前端 `chat.ts` 中 `extractText()` 从 delta 提取文本并写入 `streamText`，实时渲染在 `ChatMessageList.vue` 的 streaming 区域。

### 2. 完成阶段（final 事件）

Gateway `emitChatFinal` 发送的 payload 同样只包含纯文本：

```javascript
{
  state: "final",
  message: {
    role: "assistant",
    content: [{ type: "text", text }],  // 仍然无 thinking
    timestamp: Date.now()
  }
}
```

前端收到 final 后：
- 将消息写入 `messages` 数组
- 清除流式状态（`streaming = false`，`streamText = ""`）
- 调用 `loadHistory()` 从 Gateway 获取完整会话历史

### 3. 历史加载阶段（loadHistory）

`loadHistory()` 通过 IPC 调用 `window.openclaw.chat.loadHistory(key)` 获取 Gateway 存储的完整消息。Gateway 返回的历史记录中，assistant 消息的 `content` 数组包含完整结构：

```javascript
{
  role: "assistant",
  content: [
    { type: "thinking", thinking: "Let me analyze this..." },
    { type: "text", text: "The answer is 42." }
  ]
}
```

`messages` 数组被替换后，`ChatMessageList.vue` 检测到 `hasThinking(msg)` 为 true，渲染 💭 Thinking 折叠面板。

## 涉及的关键代码

| 文件 | 函数/区域 | 作用 |
|------|----------|------|
| `desktop/renderer/src/stores/chat.ts` | `extractText()` | 从 delta 消息提取显示文本，跳过 thinking 块 |
| `desktop/renderer/src/stores/chat.ts` | `extractThinking()` | 从历史消息提取 thinking/reasoning 内容 |
| `desktop/renderer/src/stores/chat.ts` | delta handler | 将 `extractText()` 结果写入 `streamText` |
| `desktop/renderer/src/stores/chat.ts` | final handler | 写入 messages → 调用 `loadHistory()` |
| `desktop/renderer/src/stores/chat.ts` | `loadHistory()` | 从 Gateway 获取含 thinking 块的完整历史 |
| `desktop/renderer/src/components/chat/ChatMessageList.vue` | streaming 区域 | 只渲染 `displayStreamText`，无 thinking |
| `desktop/renderer/src/components/chat/ChatMessageList.vue` | 历史消息区域 | 渲染 thinking 折叠面板 + 正文 |
| Gateway `emitChatDelta` | — | 硬编码只发 `{ type: "text" }` |
| Gateway `emitChatFinal` | — | 同上，只发纯文本 |

## 时序图

```
用户发送消息
    │
    ▼
Gateway 开始流式生成
    │
    ├── delta ──► { content: [{ type: "text", text }] }
    │              前端实时渲染正文 ✓
    │              thinking 不可见 ✗
    │
    ├── delta ──► (同上，文本持续累积)
    │
    ├── final ──► { content: [{ type: "text", text }] }
    │              前端写入 messages，清除流式状态
    │              调用 loadHistory()
    │
    ▼
loadHistory() 返回完整历史
    │
    ▼
messages 被替换为含 thinking 块的版本
    │
    ▼
💭 Thinking 折叠面板出现（此时正文已渲染完毕）
```

## 改进方向

若要实现 thinking 块的实时渲染，需要同时修改 Gateway 和前端：

### Gateway 侧（openclaw npm 包）
- `emitChatDelta` 需在 `content` 数组中携带 `{ type: "thinking", thinking }` 块
- 或新增独立的 thinking delta 事件类型

### 前端侧（MicroClaw）
- delta handler 中调用 `extractThinking()` 将 thinking 内容存入新的 `streamThinking` ref
- `ChatMessageList.vue` 的 streaming 区域在 `displayStreamText` 上方渲染 thinking 折叠面板
- final 阶段清除 `streamThinking`，由 `loadHistory()` 的完整消息接管

### 限制
Gateway 是外部依赖（`openclaw` npm 包），MicroClaw 前端无法单独完成此改进。
