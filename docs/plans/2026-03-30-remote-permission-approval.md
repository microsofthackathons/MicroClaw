# 远程权限审批：通过微信消息流授权 MicroClaw 操作

**日期**: 2026-03-30  
**状态**: 设计阶段  
**依赖**: AppContainer 沙箱权限系统、openclaw-weixin 插件

---

## 1. 问题背景

当前 MicroClaw 的权限审批流程是**本地同步阻塞**的：

```
Gateway 需要权限 → IPC → Electron 弹窗 → 用户本地点击 → 写 response 文件 → Atomics.wait 解除阻塞
```

这在用户**坐在电脑前**时运行正常。但用户通过微信远程连接 MicroClaw 时，会出现问题：

- 用户通过微信发送命令
- MicroClaw 执行命令时需要文件/应用权限
- 权限弹窗出现在本地桌面，但用户**不在电脑前**
- 操作因 60 秒超时被默认拒绝

**约束**：微信插件是官方开发的，我们无法修改微信客户端 UI，只能通过文本消息收发进行交互。

---

## 2. 设计思路

核心洞察：现有权限系统已经是**异步的请求/响应模式**（response file + `Atomics.wait` 轮询），只需要把"本地弹窗 → 用户点击"替换为"发微信消息 → 用户文本回复"。

**不需要微信提供特殊 UI 或回调机制**，整个方案仅依赖纯文本消息的收发。

---

## 3. 详细流程

### 3.1 正常流程（用户批准）

```
┌─────────────┐    ┌──────────────┐    ┌──────────────┐    ┌─────────────┐
│   Gateway    │    │ Electron Main│    │ WeChat Plugin│    │  微信用户    │
│  (沙箱内)    │    │   Process    │    │  (monitor)   │    │  (远程)     │
└──────┬───────┘    └──────┬───────┘    └──────┬───────┘    └──────┬──────┘
       │                   │                   │                   │
       │ 1. 需要写入权限    │                   │                   │
       │ IPC: sandbox-     │                   │                   │
       │ file-permission   │                   │                   │
       │──────────────────>│                   │                   │
       │                   │                   │                   │
       │   Atomics.wait()  │ 2. 检测会话来源    │                   │
       │   (阻塞等待)      │    = 微信远程用户   │                   │
       │                   │                   │                   │
       │                   │ 3. 发送权限请求消息 │                   │
       │                   │──────────────────>│                   │
       │                   │                   │ 4. 推送到微信      │
       │                   │                   │──────────────────>│
       │                   │                   │                   │
       │                   │                   │   "⚠️ MicroClaw   │
       │                   │                   │    需要写入权限    │
       │                   │                   │    路径: C:\Users\ │
       │                   │                   │    xxx\report.xlsx │
       │                   │                   │    回复 Y 允许 /   │
       │                   │                   │    N 拒绝"         │
       │                   │                   │                   │
       │                   │                   │ 5. 用户回复 "Y"    │
       │                   │                   │<──────────────────│
       │                   │                   │                   │
       │                   │ 6. 拦截到权限回复  │                   │
       │                   │<──────────────────│                   │
       │                   │                   │                   │
       │                   │ 7. 授予 ACL       │                   │
       │                   │ 8. 写 response    │                   │
       │                   │    文件            │                   │
       │                   │                   │                   │
       │ 9. Atomics.wait   │                   │                   │
       │    解除阻塞       │                   │                   │
       │ 10. 操作继续      │                   │                   │
       │                   │                   │                   │
```

### 3.2 超时 / 拒绝流程

```
用户回复 "N"  → 写 response { approved: false }  → 操作被拒绝，Gateway 报告权限不足
超时 60 秒    → 默认拒绝，同时发微信通知 "⏰ 权限请求已超时，操作已取消"
```

### 3.3 多个待审批请求

当同一操作触发多个权限请求时，使用编号方式：

```
📋 MicroClaw 权限请求：
[1] 写入 C:\Users\xxx\Documents\report.xlsx
[2] 启动应用 Excel

回复方式：
  "Y"    - 全部允许
  "N"    - 全部拒绝
  "Y1"   - 仅允许 #1
  "N2"   - 仅拒绝 #2
```

---

## 4. 三种权限类型的适配

| 权限类型 | 当前触发方式 | 微信消息内容 |
|---|---|---|
| **文件写入权限** | `requestFilePermission()` | `"⚠️ 需要写入: {filePath}"` |
| **Shell 命令重试** | Access Denied → 弹窗 | `"⚠️ 命令被拒绝，是否授权目录: {dir}"` |
| **应用启动审批** | 拦截非白名单 app | `"⚠️ 需要启动应用: {appName}"` |

---

## 5. 需要的代码改动

### 5.1 Electron Main 进程 (`desktop/src/main.ts`)

**改动：权限请求处理分支**

在现有 `handlePermissionRequest` / `handleShellPermissionRequest` / `handleAppApprovalRequest` 中增加分支：

```typescript
// 伪代码
async function handlePermissionRequest(request: PermissionRequest) {
  const sessionSource = getSessionSource(request.sessionKey);
  
  if (sessionSource?.type === 'remote-channel') {
    // 远程通道 → 走消息流审批
    await handleRemotePermissionApproval(request, sessionSource);
  } else {
    // 本地 → 走现有弹窗
    await showPermissionDialog(request);
  }
}
```

**新增：远程审批管理器**

```typescript
interface PendingRemoteApproval {
  requestId: string;
  type: 'file-permission' | 'shell-permission' | 'app-approval';
  description: string;       // 人类可读的权限描述
  responseFile: string;      // response-<uuid>.json 路径
  channelType: string;       // 'openclaw-weixin'
  channelUserId: string;     // 微信用户 ID
  contextToken: string;      // 微信回复需要的 context_token
  createdAt: number;
  timeoutMs: number;         // 默认 60000
}

// 全局待审批队列
const pendingRemoteApprovals = new Map<string, PendingRemoteApproval>();
```

### 5.2 Gateway ↔ Main IPC 扩展

**新增 IPC 消息类型**：

```typescript
// Gateway → Main: 权限请求携带来源信息
{
  type: 'sandbox-file-permission-request',
  id: string,
  filePath: string,
  responseFile: string,
  // 新增字段：
  sessionSource?: {
    channelType: string,     // 'openclaw-weixin' | 'local' | ...
    channelUserId?: string,  // 远程用户标识
  }
}
```

这要求 Gateway 进程在发起权限请求时，传递当前命令的来源通道信息。Gateway 已经知道当前请求来自哪个插件（通过 session context），需要把这个信息透传到 IPC。

### 5.3 微信插件 (`plugins/openclaw-weixin/`)

**改动 1：发送权限请求消息**

新增模块 `src/permissions/remote-approval.ts`：

```typescript
import { sendMessageWeixin } from '../messaging/send';

export async function sendPermissionRequest(
  approval: PendingRemoteApproval,
  contextToken: string,
  accountConfig: AccountConfig,
): Promise<void> {
  const message = formatPermissionMessage(approval);
  await sendMessageWeixin(accountConfig, contextToken, approval.channelUserId, message);
}

function formatPermissionMessage(approval: PendingRemoteApproval): string {
  switch (approval.type) {
    case 'file-permission':
      return `⚠️ MicroClaw 需要文件写入权限\n路径: ${approval.description}\n\n回复 Y 允许 / N 拒绝`;
    case 'app-approval':
      return `⚠️ MicroClaw 需要启动应用\n应用: ${approval.description}\n\n回复 Y 允许 / N 拒绝`;
    case 'shell-permission':
      return `⚠️ 命令访问被拒绝，需要目录权限\n目录: ${approval.description}\n\n回复 Y 允许 / N 拒绝`;
  }
}
```

**改动 2：拦截权限回复**

在 `src/monitor/monitor.ts` 的 `processOneMessage` 中增加拦截逻辑：

```typescript
async function processOneMessage(message: WeixinMessage, deps: MessageDeps) {
  const text = message.body?.trim();
  
  // 检查是否是权限回复
  if (text && isPermissionResponse(text)) {
    const handled = await handlePermissionResponse(text, message.userId);
    if (handled) return; // 不转发给 AI
  }
  
  // ... 现有的消息处理逻辑
}

function isPermissionResponse(text: string): boolean {
  // 匹配: Y, N, y, n, 允许, 拒绝, Y1, N2, 等
  return /^[YNyn]\d*$|^(允许|拒绝)(全部|\d+)?$/i.test(text);
}
```

### 5.4 context_token 管理

**问题**：发送微信消息需要 `context_token`，它来自最近一条入站消息。

**方案**：
- 用户发微信命令 → `getUpdates` 获取 `context_token` → 存入 `contextTokenStore`
- 命令执行触发权限请求 → 从 `contextTokenStore` 取 token → 发送审批消息
- 用户回复 Y/N → `getUpdates` 获取新 token → 更新 store → 处理回复

因为权限请求总是由用户消息触发的命令产生的，所以 `context_token` 在权限请求时一定是可用的。

**边界情况**：如果 token 过期（长时间未回复），发送失败时应降级为本地弹窗。

---

## 6. 会话来源识别

需要在 Gateway 的 session context 中标记消息来源通道：

```
用户通过微信发消息
  → getUpdates 收到消息
  → processOneMessage 创建 session context，标记 source = { type: 'openclaw-weixin', userId: 'wxid_xxx' }
  → AI 执行命令
  → 沙箱需要权限
  → IPC 携带 session source 信息
  → Main 进程判断 source.type !== 'local' → 走远程审批
```

---

## 7. 安全考虑

### 7.1 回复验证

- 只接受来自**发起命令的同一用户**的权限回复（按 `userId` 匹配）
- 防止其他微信用户替别人授权

### 7.2 防重放

- 每个审批请求有唯一 `requestId`
- 回复处理后立即从 `pendingRemoteApprovals` 移除
- 过期请求不可再批准

### 7.3 信息最小化

- 权限消息中不暴露完整路径，可选截断或仅显示文件名
- 敏感目录名做脱敏处理

### 7.4 降级策略

| 场景 | 处理 |
|---|---|
| context_token 失效 | 降级为本地弹窗 |
| 微信消息发送失败 | 降级为本地弹窗 |
| 用户 60 秒未回复 | 默认拒绝，发超时通知 |
| 网络中断 | 保持现有 Atomics.wait 超时机制 |

---

## 8. 斜杠命令扩展（可选）

为微信用户提供主动权限管理命令：

| 命令 | 功能 |
|---|---|
| `/permissions` | 查看当前待审批的权限请求列表 |
| `/approve [id]` | 批准指定权限请求 |
| `/deny [id]` | 拒绝指定权限请求 |
| `/trust <path>` | 永久信任某个目录（加入 RW 白名单） |

---

## 9. 实现优先级

### P0 - 最小可用版本
1. Gateway IPC 传递 session source 信息
2. Main 进程按来源分支处理权限请求
3. 微信插件发送权限请求文本消息
4. 微信插件拦截 Y/N 回复并写 response 文件

### P1 - 增强体验
5. 多请求编号系统
6. 超时通知
7. `/permissions` 斜杠命令

### P2 - 可选优化
8. 路径脱敏
9. 预授权规则（如"本次会话全部允许"）
10. 批量授权支持

---

## 10. 关键依赖与风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| context_token 有效期不明确 | 无法发送审批消息 | 降级为本地弹窗 + 记录日志 |
| 微信消息延迟 | 60 秒超时内用户来不及回复 | 适当延长远程审批超时（如 120 秒） |
| 用户误发 "Y"/"N" 被拦截 | 正常聊天被当作权限回复 | 仅在有 pending approval 时拦截；或使用更明确的格式如 `/approve` |
| 多用户同时操作 | 权限回复混淆 | 按 userId 隔离 pending 队列 |
