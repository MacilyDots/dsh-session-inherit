# dsh-session-inherit（继承）

[English](README.md) | [简体中文](README.zh-CN.md)

把一段跑了很久的会话，交接给一个**干净的新会话**。

在会话行的「…」菜单里多出一行 **继承**。点它 → 预览一份从源会话机械提取出来的
交接单 → 确认 → 新建一个不带旧历史的会话，把这份交接单作为它的第一条消息发出，
工作在新会话里继续。原会话原样保留。

```
置顶          ← DSH 原版（Pin）
重命名        ← DSH 原版（Rename）
分叉          ← DSH 原版（Fork）
继承          ← 本插件（order 350）
归档          ← DSH 原版（Archive）
```

除「继承」外的四行都是 DSH 原版自带的条目（`sidebar.workspaces.session.menu.item`
slot 的官方内容）。如果装了别的会话菜单插件，你的列表里还会多出它们的条目——
本插件只负责「继承」这一行。

---

## 为什么不是 /compact、也不是「分叉」

现在的 DSH 里已经有两条"继续干"的路，但这个需求是第三条：

| 做法 | 它搬过去的东西 | 对本场景的问题 |
|---|---|---|
| `/compact` | 把历史换成摘要，会话不变 | 实测把 541,227 token 压到 25,602 后 **4 步内退化复发**，且重复词从「做。」变成「好。」——长度不是因，上下文内容也不是因 |
| 官方**分叉** | 复制源会话的整段历史前缀 | 等于把退化诱因一起带走，新会话一睁眼就是几十万 token 的历史 |
| **本插件的继承** | 只搬**可核对的具体锚点**，历史一律不带 | 新会话的上下文从几千字符起步 |

## 为什么不用 LLM 做摘要

`/compact` 那次的证据很直接：摘要保留下来的是"要做验收、要写报告"这类**抽象意图**，
丢掉的恰恰是文件路径、下一步参数这类**具体锚点**。模型握着模糊意图在抽象层反复
自我告诫，而它每次告诫用的句式几乎相同——这本身就是喂给重复退化的燃料。

所以本插件的交接单**一次模型调用都不发**，只做机械提取：任务原文、最近的用户指令
（原话，不改写）、动过的文件、跑过的命令、最后一次待办状态、源会话最后一条回复。
每条都能追回源会话去核对。

交接单开头还写死三条执行规约：

> 不要复述本单，不要总结本单，不要回应"收到/了解了"。
> 读完直接做「下一步」。第一步只做一个具体动作，做完停下汇报；不要同时铺开多个方向。

## 交接单长什么样

```
📋 会话继承单

> 来源：`session-xxx`（标题） · 共 15 轮 · 最后活动 2026-10-08 19:37
> **执行规则**：不要复述本单…

## 1. 任务目标              ← 源会话第一条真实用户消息
## 2. 最近的用户指令（由旧到新）  ← source.kind === 'user' 的原话
## 3. 涉及的文件（绝对路径）      ← 带出现次数，按最近使用排序
## 4. 项目内相对引用             ← 工具参数里的相对路径片段
## 5. 最近执行的命令
## 6. 待办（源会话最后一次 todo 状态）
## 7. 源会话最后一次回复
## 8. 下一步                    ← 你在预览框里写
```

第 2 节只认 `source.kind === 'user'`。实测某个真实会话的 42 条 `user/message` 里，
有 27 条是 `agent-instructions` / `runtime-context` / `skill-catalog` / `time-context` /
记忆提示 / 模型选择 / 压缩检查点 这类运行时注入——全是噪音，
现在被挡在门外。

## 用法

1. 鼠标移到侧边栏任一会话，点行尾的「…」；
   **对哪个会话点都行，包括已经冷掉的会话**（读取走 `sessionQuery.readSession`，不激活 agent）。
2. 点 **继承**。
3. 弹出预览：上面是源会话信息（标题 / 轮次 / 文件数 / 命令数 / 待办数），
   中间是可编辑的交接单全文，下面是一个勾选框。
4. 在 `## 8. 下一步` 下面写上你接下来要它做的事——**越具体越好**
   （点名哪个文件、做哪一个动作），然后点「创建并继承」。

新会话会自动打开，标题是 `继承: <源标题>`，工作目录、模型路由、agent preset 都和
源会话一致。

勾选框「创建后立即开始工作」默认勾上：交接单会经
`sessionController.prompt` 作为一条正常用户消息发出并立刻开始。
取消勾选时改为直接写入会话日志（`session:append`），只记录、不触发首轮，
打开后你自己说要做什么。

## 安装

本插件没有发布到 npm，从仓库直接装。改 profile 的 `package.json`，两处都要加：

```json
{
  "dependencies": {
    "dsh-session-inherit": "link:/path/to/dsh-session-inherit"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-session-inherit"
      ]
    }
  }
}
```

`bundles` 才是加载权威——只写进 `dependencies` 不会挂载。装完重启 DSH。

> 桌面端的 profile 由 Electron 独占管理，全局 CLI 会拒绝操作它；
> 那种情况直接改该 profile 的 `package.json` 再重启即可。

## 版本适配

在 **DSH 0.2.0-rc.2**（Windows）上验证通过。插件依赖若干 DSH 内部服务与菜单
slot 名，DSH 升级后可能失配。如果菜单项不出现、或插件页显示「异常」，先查
profile 的 `compatibility.json`——profile 启动时会校验插件对 `@deepseek-ai/dsh`
与 `dsh-*` 的 peerDependencies，不满足的 bundle 会被整体跳过（日志里打印
`skipping profile bundle`）。把当前 DSH 版本加进 `compatibility.json` 的允许
列表即可。

## 组件构成

- 宿主半 `index.mjs`：注册 `POST /__session-inherit/preview` 与
  `POST /__session-inherit/commit`（同源校验，仅本机 loopback 使用）
- 客户端半 `client.js`：注册
  `sidebar.workspaces.session.menu.item`(id `session-inherit`, order 350) 与
  `shell.overlay` 上的预览对话框

只消费公开服务：`agents`（硬依赖）、`sessionQuery`、`sessionController`、
`workspaceRegistry`、`sessionTitle`、`agentPresets`、`agentDefaultModel`、`webServer`。
除 `agents` 外全部按需查找，缺一个就降级一项，不会让整个插件失活。

## 配置

profile 的 `cordis.patch.yml` 里可以覆盖（全部可选）：

```yaml
- id: session-inherit
  config:
    enabled: true        # false = 完全不注册
    recentUsers: 6       # 交接单里带多少条最近的用户指令（1–50）
    startByDefault: true # 预览框里那个勾选框的默认值
    cacheTtlMs: 120000   # preview → commit 之间复用一次日志读；0 = 不缓存
```

## 已知限制（如实说）

- **它不修复解码退化。** 退化发生在"生成当前这一步"，是解码层的问题；本插件做的
  是换一个不带旧上下文的干净会话接着干，把"长历史 + 抽象意图"这两个诱因去掉。
  新会话第一步照样有可能退化——那属于解码层的问题，由在生成侧做重复检测并中止的
  独立插件（如 `dsh-degen-guard`）处理，本插件不碰。
- 交接单是机械提取，不会替你想"下一步"。空着的话模型会先问你一句，这也是故意的。
- 源会话的第一条用户消息如果是很短的寒暄/引言，它就会以原样出现在「任务目标」里。
- 含空格的项目路径能完整抓到；含 `§` 之类的非 ASCII 标点片段会被丢弃。
- 交接单上限 14,000 字符，超了截断（真实的长会话实测约 4,500 字符）。

## 测试

```sh
node test/extract.test.mjs   # 提取器纯函数（13）
node test/host.test.mjs      # 宿主半：假 ctx 跑通端点注册与 preview/commit 全链路（10）
node test/client.test.mjs    # 客户端半：模块协议、slot 注册、降级菜单行，以及菜单→preview→确认→commit 全链路（4）
```

## 与已有插件的关系

写之前查过现成的方案，没有完全重合的：

- **[WeiYe6/dsh-session-handoff](https://github.com/WeiYe6/dsh-session-handoff)**（`dsh-session-handoff`）
  最接近：`/handoff` 命令，同工作区新建会话 + 注入交接文档 + 自动打开。差别是它
  用 LLM 总结最近 N 轮，而且只能在**当前会话**里敲命令；本插件的入口在会话行菜单，
  对任意（含冷）会话可用，且不调模型、只搬具体锚点。
- **[ZhijiangTang/dsh-handoff](https://github.com/ZhijiangTang/dsh-handoff)**：
  确定性地导出一份 `HANDOFF.md`，但不建新会话。
- **[liangmianya/dsh-synapse](https://github.com/liangmianya/dsh-synapse)**：
  可视化会话地图，按 DSH 原生 fork 关系连线——走的是"带上全部历史"的那条路。
- **`@michengai/dsh-archive-manager`**：它还往同一个菜单里注册了 `delete-session`
  （order 500）。本插件用 order 350，两者不冲突。

## License

MIT
