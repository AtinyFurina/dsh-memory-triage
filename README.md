# dsh-memory-triage

DeepSeek Harness 记忆分诊插件：自动判断记忆保留 / 归档，并自动路由到项目桶或总体桶。

规则优先 + LLM 兜底。自动动作只做可恢复的归档，永不直接删除。

## 功能

- 每轮对话结束自动分诊（防抖 5s + 阈值触发：新增 3 条或 3000 字符）
- 全局条目（用户画像、沟通偏好、纪律等）留在总体记忆
- 项目条目（具体项目的状态与决策）自动迁入 project 桶
- 低价值条目（importance ≤ 2 且非全局豁免的 preference）归档
- 近义重复条目自动合并（标题 dice 相似度 ≥ 0.62 或内容包含），其余归档
- 规则拿不准的条目用 LLM 兜底判定（每批 ≤ 8 条，失败静默跳过）
- 镜像 Markdown 与 dsh-mneme 格式字节级兼容，人工编辑仍可合并回库

## 安装

插件文件放到 `~/.dsh/profiles/web/plugins/dsh-memory-triage`，在
`~/.dsh/profiles/web/cordis.patch.yml` 挂载：

```yaml
- insert:
    - id: dsh-memory-triage
      name: ./plugins/dsh-memory-triage/lib/index.js
      config:
        memoryDir: ~/.dsh/memory
        enabled: true
        debounceMs: 5000
        triggerThresholdCount: 3
        triggerThresholdChars: 3000
        archiveLowImportance: true
        llmFallback: true
        llmBatchSize: 8
        purgeDays: 30
        purgeOnSchedule: false
```

重启宿主后生效。

## 命令

- `/triage-run` —— 立即全库分诊
- `/triage-purge` —— 彻底删除归档超过 `purgeDays` 天（默认 30）的条目（仅限已归档）

## 配置

| 键 | 默认 | 说明 |
|----|------|------|
| `memoryDir` | `~/.dsh/memory` | dsh-mneme 记忆目录（共用同一 SQLite） |
| `enabled` | `true` | 总开关 |
| `debounceMs` | `5000` | 回合结束防抖 |
| `triggerThresholdCount` | `3` | 触发阈值（新增条数） |
| `triggerThresholdChars` | `3000` | 触发阈值（新增字符） |
| `archiveLowImportance` | `true` | 低价值偏好自动归档 |
| `minDice` | `0.62` | 合并相似度阈值 |
| `exemptKeywords` | 内置清单 | 全局豁免词（命中保留总体记忆） |
| `projectKeywords` | 内置清单 | 项目词（命中迁入 project 桶） |
| `llmFallback` | `true` | LLM 兜底开关 |
| `llmBatchSize` | `8` | 兜底每批条数 |
| `purgeDays` | `30` | 归档超期天数 |
| `purgeOnSchedule` | `false` | 分诊时自动清理超期归档（默认关） |

## 安全设计

- 自动分诊只做三类软操作：保留、迁移类型、归档（archived=1，可恢复）
- 真删仅发生在 `/triage-purge` 或 `purgeOnSchedule: true`，且只作用于已归档条目
- LLM 兜底失败 / 余额不足时静默跳过，绝不影响记忆写入
- 与 dsh-mneme 多连接共用 WAL，busy_timeout 8000ms 串行化写入

## 测试

```bash
node --test test/triage.test.mjs
```

14 个单元测试覆盖分类规则、去重合并、LLM 决策解析。

## License

MIT
