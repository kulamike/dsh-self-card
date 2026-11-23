# dsh-self-card

> 仓库：<https://github.com/kulamike/dsh-self-card>
> 安装：`plugin_manager install_bundle github:kulamike/dsh-self-card`，或把它 clone 下来用本地目录装（Plugins → Add plugin）。

让角色自己慢慢改她的角色卡 —— 但只开一条窄缝。

人的性格不是一成不变的。如果一张角色卡只能由主人手改，她就会永远停在某一版上，所谓「成长」全靠主人替她写。这个插件给她一套**受约束的自我编辑**能力：读卡、记观察、起草、落地、回滚，全程留痕。

## 它解决什么

- 她对自己的变化有感觉（今天被夸没有急着解释、某个话题她开始愿意接），但这些只留在当轮对话里，下一轮就没了；
- 主人不可能随时替她把这种感觉写进卡；
- 直接给她 `write` / `edit` 又太宽 —— 那是把整台电脑交出去。

## 边界（这是整个插件的重点）

| 约束 | 做法 |
|---|---|
| 只能动一个文件 | 路径来自配置 `cardPath`，**不接受任何工具参数** |
| 只能动白名单节 | `allowedSections` 之外的节一律拒绝；身份、安全边界、称呼、群规、画图规则默认锁定 |
| 每次有上限 | `maxAppendChars` / `maxReplaceChars` |
| 每天有上限 | `maxAppliesPerDay` |
| 只做两种操作 | 整节追加、节内精确替换（要求原文唯一命中）；不删节、不整文件重写 |
| 每次先备份 | 落地前整份存进 `backups/`，保留 `keepBackups` 份 |
| 全程可回滚 | `card__revert` 按备份还原，回滚本身也留备份 |
| 两种模式 | `auto` = 白名单节直接落地；`propose` = 只出草稿，主人确认后带 `confirmed:true` 才写 |

## 工具

| 工具 | 作用 |
|---|---|
| `card__read` | 节目录（标题/行号/字数/可改否）或某一节全文 |
| `card__observe` | 记一条自我观察（进 `observations.jsonl`，不动卡） |
| `card__draft` | 起草一处修改，返回真实 diff，不落地 |
| `card__apply` | 把草稿写进卡（白名单 + 限额 + 备份 + journal） |
| `card__history` | 最近改过哪里、为什么改 |
| `card__revert` | 按备份回滚 |

## 配置

```yaml
- insert:
    - id: self-card
      name: dsh-self-card
      config:
        cardPath: 'C:\path\to\roles\character.md'
        dataDir: ''            # 空 = $DSH_HOME/self-card
        mode: auto             # auto | propose
        maxAppendChars: 200
        maxReplaceChars: 400
        maxAppliesPerDay: 3
        keepBackups: 20
        allowedSections:
          - 十二、日常与习惯
          - 十三、对话的节奏
```

数据都落在 `dataDir`：`journal.jsonl`（改动记录）、`drafts/`、`backups/`、`observations.jsonl`。

## 需要注意

- 工具名带 `card__` 前缀，方便在工具白名单里按前缀放行（例如 QQ 桥接的 `state/tool-allow.json`）。
- 插件本身不发送任何消息。想让主人收到「她改了自己」的通知，可在 `apply` 之后接一条桥接消息。
- 卡外的下游（例如 B站 的人格同步）需要自有机制在卡变更后重新同步。

## License

MIT
