# 安装升级默认使用白名单轻量备份

日期：2026-11-09。适用：已有 OpenClaw 2026.10.5 的 MicroClaw 覆盖升级到 2026.10.10。

## 行为

- 新的核心升级只创建白名单恢复点，不再调用 `openclaw backup create` 全量归档，也不在失败后自动回退全量。
- 先停止/确认 Gateway 空闲，再创建并校验轻量备份，然后才允许 npm 替换核心。替换后仅校验目标版本与 Gateway 停止状态，不自动执行 Doctor 或状态迁移；原始文件不因未列入备份而删除。
- 中断后重试仍校验备份摘要；旧 `migrating` / `repairing` 记录可直接续接版本校验，不重复安装包或执行 Doctor。跳过 Doctor 不代表旧数据已经完成迁移，桌面启动健康检查保持不变。
- 配置、SQLite、凭据、会话和工作区仍需保护；不是“不备份直接迁移”。大工作区或附件多时，轻量备份也可能耗时。
- 旧事务已经生成的全量备份仍可按原校验和继续恢复安装，不重新生成或删除这些备份。

## 白名单

路径相对于实际 OpenClaw 状态目录，默认 `%USERPROFILE%/.openclaw`。

| 类别 | 保护内容 |
| --- | --- |
| 配置、身份 | `openclaw.json`、`openclaw.json.last-good`、`.env`、`config-journal-fingerprint.key`、`device-identity.json`、`identity/`、`devices/` |
| SQLite | 官方数据库所有权清单中的全局库、隔离库、所有 Agent 注册库、插件声明的持久化数据库；使用官方一致性快照，不直接复制活跃主库、WAL、SHM、历史 `.bak` 或 `.seal` |
| 会话 | `agents/*/sessions/`，包括 `.zst` 冷归档；数据库关联的冷归档同时由官方快照逻辑处理 |
| 凭据、渠道 | `credentials/`、实际 OAuth 凭据目录、`openclaw-weixin/`，以及数据库内的模型认证配置 |
| 用户内容 | `media/`、`skills/`、`hooks/`、`workspace/`、所有实际配置的外部工作区、Agent `workshop-skills/` |
| 技能管理 | `skill_catalog.json`、`managed_skill_catalog.json`、`microclaw-search-setup.json`、`skills_snapshot.json`、`skills_snapshot.sig`、`skills_signing_key.pem`、`skills_signing_key.pub` |
| 旧布局 | 存在时保护 `cron/jobs.json`、Agent `auth-profiles.json`、`auth.json`、`models.json` |
| 动态引用 | 实际 `$include` 文件、配置文件型 secrets provider、额外 skills/hooks 目录、插件明确声明的持久化资源 |

MicroClaw 桌面目录，默认 `%APPDATA%/MicroClaw`：

```text
config.json
settings.json
windows-node/identity/
windows-node/policy.json
windows-node/durable-approvals.json
windows-node/command-consent/exec-approvals.json
```

默认不归档状态根下的模型、浏览器 Profile、`_internal/` 旧安装包、编译缓存、运行日志、临时目录、工具和运行时依赖。
但显式配置的用户工作区按用户内容完整保护，不因为内部目录也叫 `logs`、`cache` 而直接跳过。
不恢复浏览器 Profile 的恢复场景可能需要重新登录；本恢复点不是整机灾备。

MicroClaw 安装器自身的受管文件替换/回滚事务保持原有机制；它与核心升级前的数据全量归档不是同一流程，未取消安装文件替换失败的保护。

## 一致性、安全边界与格式

- `deployer/assets/upgrade-backup.mjs` 使用固定版本、SHA-256 审查过的官方备份实现中的配置捕获和 SQLite 快照函数。
  只在本次子进程加载时导出这些内部函数，不修改安装包源码文件，不改写快照算法。
- 复用全局库/Agent 所有权验证、完整性检查、压缩快照、冷归档捕获、旧审计数据一致性捕获以及 lease/replay authority 清理。
- 当前审查版本为 2026.10.5、2026.10.10。未知版本、源文件哈希变化、未分类插件、相对的自定义敏感文件路径、目录链接/重定向、未获得快照的 SQLite 文件直接阻止升级，提示处理，不绕过保护或自动全量归档。
- 已知微信和 llama-cpp 的持久化位置在白名单内；其他插件需要声明 `backupResources`。实际资源声明不能越出其 state/agent 归属根。
- 新档案仍放在 `.microclaw/backups/openclaw-package/<transaction>/state.tar.gz`，但属于 MicroClaw 格式，不是官方全量档案，不能直接交给 `openclaw backup restore`。
- 内含 `manifest.json` 和编号 payload。清单声明 `microclaw-lightweight-v1` 范围、原始路径、文件大小、逐文件 SHA-256、工作区/空目录、排除范围和恢复注意事项。
- 归档完整读回并校验每个文件后才发布；随后记录整包 SHA-256。校验失败不替换核心，不覆盖已有恢复点。
- 重试保留同一个有效恢复点，不重复 npm 替换或静默降级；不自动将旧数据库覆盖回新核心。
- 恢复必须先停服务，解包到新的检查目录，按清单审查归属，再通过相应数据库所有权/安全恢复流程处理。凭据、设备身份和审批不可跨用户/机器盲目复用。

## 验证

```powershell
python -m unittest tests.test_lightweight_backup tests.test_openclaw_package_upgrade tests.test_windows_setup_upgrade tests.test_openclaw_upgrade -v
node --test tests/upgrade-backup.test.mjs
$env:MICROCLAW_BACKUP_TEST_PACKAGE = '<隔离的真实 OpenClaw 包目录>'
python -m unittest tests.test_lightweight_backup.RealOpenClawLightweightBackupTests -v
```

真实包测试在独立用户目录生成配置和数据库，验证官方快照、外部工作区、凭据、附件、会话和排除大目录，不读写真实用户状态。
更改此策略后，旧 EXE 不会自动带上新逻辑；发布前必须重打包，并重新运行真实 10.5 安装产物到新 EXE 的覆盖迁移验收。

## 本次验证记录

以下完整回归记录来自最初的轻量备份实现。移除自动 Doctor 后，单独运行的 `tests.test_openclaw_package_upgrade` 共 34 项通过；后续 Gateway 启动修复由用户确认可以启动，未额外运行测试或构建。准备 PR 时不将历史回归结果视为当前提交的完整验证。

- 关联 Python 回归：287 项通过，覆盖白名单归档、落盘失败、校验失败、npm/Doctor 顺序、失败重试和原有事务恢复。
- Node 目录选择与资源边界：11 项通过，覆盖外部工作区、冷归档、桌面身份、配置 include、文件型凭据、额外 skills/hooks、插件声明与目录链接拒绝。
- 真实 2026.10.5 包：隔离夹具的官方快照及轻量归档通过；7 个文件，46,916 字节，备份阶段 7.42 秒。
- 真实 2026.10.10 包：相同类别隔离验证通过；7 个文件，48,081 字节，备份阶段 9.58 秒。
- 上述时间不包括夹具的 Doctor 初始化，不能推算真实用户目录耗时；未归档的模型、浏览器缓存、旧安装包仍保留原位。
- Ruff、Prettier、差异空白检查通过。本轮没有重新打包 EXE，没有执行新版 EXE 的完整覆盖迁移验收，也没有发布或修改真实用户状态。
