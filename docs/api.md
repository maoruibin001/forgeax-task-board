# Agent API

所有接口返回 JSON。Agent claim 使用 lease，默认 30 分钟；续租会把 lease 延长 30 分钟。lease 过期后任务会自动回到 `ready`。

AI 应先读取无需认证的 `GET /.well-known/forgeax-task-board`，再按其中的 `machineGuide` 读取 `GET /api/agent-guide`。适合直接分享给 AI 或团队成员的文档入口是 `GET /agent-guide.md`。

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/tasks` | 查询任务，可用 `status`、`priority`、`projectSlug`、`tag`、`person`、`search`、`topLevel=true`（只返回主任务） |
| POST | `/api/tasks` | 创建任务 |
| PATCH | `/api/tasks/:id` | 更新任务 |
| DELETE | `/api/tasks/:id` | 删除任务 |
| GET | `/api/tasks/:id` | 获取完整任务详情，包含主任务、子任务、资料分组和 Agent 协作状态 |
| GET | `/api/tasks/recent?limit=3` | 获取最近更新的主任务，支持用 `tag` 限定标签作用域 |
| POST | `/api/tasks/:id/resources` | 关联需求文档、Bug 单、验收文档或验收产物 |
| DELETE | `/api/tasks/:id/resources/:resourceId` | 移除一条关联资料 |
| POST | `/api/tasks/:id/claim` | Agent 领取任务 |
| POST | `/api/tasks/:id/renew` | Agent 续租 |
| POST | `/api/tasks/:id/progress` | Agent 记录进度、阶段或阻塞原因 |
| POST | `/api/tasks/:id/release` | Agent 释放任务 |
| POST | `/api/tasks/:id/complete` | Agent 完成任务 |
| GET | `/api/board` | 首页只读原子快照：`sourceAt`、`requiredTag`、授权实例内全部主/子任务，含最后进展报告；不修改领取或父单状态 |
| GET | `/api/summary` | 看板摘要，支持用 `tag` 限定标签作用域 |
| GET | `/api/tags` | 获取标签及任务数；可用 `projectSlug`、`topLevel=true` 过滤统计范围 |
| GET | `/api/people` | 获取协作人员及任务数；可用 `tag`、`projectSlug`、`topLevel=true` 过滤统计范围 |
| GET | `/api/agent-guide` | 获取机器可读的 AI 接入协议、查询方式和 claim 生命周期 |
| GET | `/api/events` | SSE 实时事件流 |

## 标签作用域

`tag` 是大小写不敏感的精确匹配，不是全文搜索。以下接口都支持标签作用域：

```bash
curl -s 'http://localhost:19080/api/tasks?tag=game&status=ready'
curl -s 'http://localhost:19080/api/summary?tag=game&topLevel=true'
curl -s 'http://localhost:19080/api/tasks/recent?tag=game&limit=3'
```

浏览器打开 `http://localhost:19080/?tag=game` 会进入 `#game` 专属视图。列表、统计、最近任务和任务详情都会被限定在该标签内。

在带 `tag` 的作用域中创建或更新任务时，服务端会自动加入并保留该标签；即使请求中的 `tags` 漏掉它，也不会把任务移出当前作用域：

```bash
curl -s -X POST 'http://localhost:19080/api/tasks?tag=game' \
  -H 'content-type: application/json' \
  -d '{"title":"接通技能动作条","tags":["P0"]}'
```

上述任务最终标签为 `P0`、`game`。带标签作用域创建子任务时，主任务也必须拥有同一标签。

## 协作人员筛选

任务的 `people` 是人工负责人/协作者数组，与表示当前唯一 AI 租约的 `claim` 相互独立。`person` 使用大小写不敏感的精确匹配，并可与标签、状态和优先级组合：

```bash
curl -s 'http://localhost:19080/api/people?tag=game&topLevel=true'
curl -s 'http://localhost:19080/api/tasks?tag=game&person=小明&status=ready'
curl -s 'http://localhost:19080/api/summary?tag=game&person=小明&topLevel=true'
```

## 云端固定作用域与基础认证

云端独立实例可以通过环境变量强制只暴露一个标签，并启用 HTTP Basic Authentication：

```bash
TASK_BOARD_REQUIRED_TAG=game
TASK_BOARD_AUTH_USER=game
TASK_BOARD_AUTH_PASSWORD='独立生成的高强度密码'
TASK_BOARD_HOST=0.0.0.0
```

设置 `TASK_BOARD_REQUIRED_TAG=game` 后，API 会忽略调用者传入的其他 `tag` 并始终限定为 `game`；根页面会重定向到 `/?tag=game`，所有新建或更新任务都强制保留 `game`。认证用户名和密码必须同时设置；只设置其中一个时所有请求都会返回 401。

创建任务示例：

```json
{
  "title": "整理游戏启动流程",
  "description": "检查默认场景和 bootstrap 的衔接",
  "priority": "high",
  "deadline": "2026-07-30T18:00:00+08:00",
  "tags": ["architecture", "game"],
  "people": ["小明", "小红"],
  "projectSlug": "hellforge",
  "parentTaskId": null
}
```

`parentTaskId` 为空表示主任务；填写一个主任务 ID 即创建子任务。子任务只能挂在主任务下，主任务详情中的 `subtasks` 会列出它们。

关联资料示例：

```json
{
  "kind": "acceptance_artifact",
  "title": "Playwright 验收截图",
  "url": "docs/evidence/task-123.png",
  "note": "覆盖主流程和异常流程",
  "actorId": "agent-id"
}
```

`kind` 支持 `requirement`、`bug`、`acceptance_doc`、`acceptance_artifact`。任务详情和 claim 响应都会返回 `resources`、`resourcesByKind`、`parentTask`、`mainTask`、`subtasks`，以及当前 `claim`、`assignee`、`history`，Agent 可以直接据此执行和验收。
进度记录示例：

```json
{
  "agentId": "forge",
  "progress": 60,
  "note": "已完成 API 和数据模型，正在接入 UI"
}
```

任务响应中的 `history` 是追踪记录；每次 claim、renew、progress、blocked、release、complete 都会追加事件。Agent 不应只在最终完成时更新任务。

领取任务时必须传 `agentId`、`sessionId`、`process` 和 `cwd`：`sessionId` 区分 Agent 会话，`process` 记录领取任务的进程/宿主，`cwd` 记录当前工作目录。它们会写入 `claim` 与 `assignee`，并显示在任务卡上。


## 逐项验收与完成门槛

有验收标准的任务在 `acceptanceCriteria` 中登记 `{id, criterion, status, evidence}`。`id`稳定且唯一，`status`为 `pending`、`passed`、`failed`；`evidence`是实际验收结果或可核对资料，不能只写“实现了”。

`POST /api/tasks`或`PATCH /api/tasks/:id`保存标准与结果。所有项必须为passed且有非空证据，才能经`complete`、PATCH done或新建done完成；否则409，原状态与历史不变，应按正常progress/blocked交个人分身判断。编辑界面使用同一检查。已登记项不可直接删除；改写标准会使该项恢复pending并清空旧证据。历史没有结构化标准的记录保留，不据此推断过去已经验收。读取/领取、实现/测试/上线、主管审阅分别留证，登记为passed也仍需主管核查引用证据。

## 首页快照与筛选口径

`GET /api/board` 与任务 API 使用同一认证和 `TASK_BOARD_REQUIRED_TAG` 边界。它返回当前授权实例内的全部主/子任务和服务端 `sourceAt`，不接受可选标签/人员/优先级筛选。浏览器在这一份快照上按各任务自己的标签、人员、优先级、搜索及日期条件筛选；子任务不会继承父任务的优先级或人员。标签、人员选项计数也包括子任务。`/api/tasks`、`/api/summary` 原有筛选含义保持不变。

首页上方统计为当前筛选的任务数（主、子分别计数），全局行指当前实例授权范围，强制标签仍生效。工作流只列匹配主任务和匹配子任务的关联主任务；关联卡明确说明其本身不匹配筛选。主卡汇总为授权实例内的全部子单，并注明匹配数量；不据子单状态改写父单。当前领取区按筛选显示有效 `claimed` 子/主单，筛选外有效领取单独计数，可通过普通按钮清除筛选查看。关联父单与原子单链接读取原 ID；选中筛选不是访问权限。

有效领取要求 `status=claimed` 且租约未过期；租约只说明领取权，不说明执行进程实时在跑。`latestReport` 同时出现在任务列表、详情及子任务摘要中，仅取本次领取以来的 progress/blocked/completed/released/lease_expired 事件，不把 renew 或旧领取轮的百分比当成新进展。没有本次报告时明确显示未知，不生成平均百分比。来源读取失败时首页隐藏旧任务、统计和详情，标示不可用及上次成功来源时间；刷新成功后恢复。

首页显眼的“可领取子任务”队列与第一项统计仅计算同一快照中 `parentTaskId` 非空且 `status=ready` 的原子单。队列列出当前筛选数量、当前授权实例的全局数量与筛选外数量，展示父方向、原 ID 和详情入口；默认预览六项，可展开全部，或清除筛选查看全局。它不读取另一份任务列表，也不改变任何状态、claim 或父子关系。

`ready` 不代表前置或验收依赖已满足。队列可以展开原任务说明，不推断结构化依赖；`ready` 同时带有非空 `blockedReason` 时，保留在原状态计数中并明显标示“状态需核对”，原详情同步显示说明。主工作流仅代表主单状态，“方向管理 · 待推进”用于 inbox 容器；已拆解的容器显示子单数量，不暗示尚未整理。主单 ready 列明确标为“主单可领取”，与子任务队列分别计数。来源不可用时队列与数量也隐藏旧结果。


## 独立验证阶段与进度图表

保留原 `status`（包括 `done`），增加独立 `verification` 记录。未登记返回 `status=pending`，UI 显示“验证未登记”，不表示历史未做过验收；旧逐项标准、证据、ID和历史不变。历史 done 不自动转为 verified。

`POST /api/tasks/:id/verification` 是唯一写入入口，沿用原认证及实例/标签/人员作用域。先 GET 详情，核对实际交付与证据，再提交：

```json
{
  "status": "verified",
  "reviewer": "实际验证人的署名",
  "evidence": "实际结果、报告或截图入口；不能只写实现了",
  "expectedBasis": "GET详情返回的verificationBasis"
}
```

- `verified`：验证完成。必须已 `done`、有明确逐项标准、全部 passed 且逐项有证据，并有实际交付结果。仍须验证人审阅实际证据；字符串非空不是事实真实性证明。
- `failed` / `insufficient`：验证不通过 / 证据不足。已完成后记录具体原因，保留完成历史，移出验证完成计数。需要返工时通过正常编辑改为 blocked；不能凭失败记录宣称当前真实验收通过。
- `pending`：退回验证未登记，必须署名并说明原因；此前历史保留。
- `invalidated`：交付结果、逐项标准/证据或完成状态变化后自动失效，记录原因与时间。普通说明、标题、标签、人员、优先级、关联资料增补与续租不使验证失效。实质需求变更应登记到逐项标准，实际产物变更应更新交付结果。验收项仅重排不使验证失效。

所有写入须提供验证人、实际证据/原因和当前 `expectedBasis`。过时依据返回409；新建/PATCH直接写 `verification` 返回400。验证人与证据是署名记录，不是新增身份认证或权限。每次结果和失效写入 `history`，历史事件包含当时完整 verification 快照。标准变化仍沿原规则重置为 pending 并清空该项证据；带未通过验收的记录不能保存为 done。已完成记录不带 status 的标准更新会退到 blocked，需按原门槛重新完成。

首页环图、四项数字、比例、当前/全局与任务明细均来自同一次 `/api/board` 的 `sourceAt`。主/子各计一项，容器保持原状态，验证完成是已完成的子集，不能相加；有效领取按快照时未过期的 claimed 租约计数，其本轮已报告与未知单列，不代表此刻进程在跑。图表支持正常标签、人员、优先级、搜索、日期、验证阶段筛选；展开明细可进入原 ID。

测试任务以显式 `test:true` 或精确标签 `test=true` 识别，首页默认排除，正常复选框可纳入；全局和当前沿用同一测试开关。既有任务 API 返回语义不变，不因 UI 测试筛选隐藏 API 记录。当前库内精确 `archived-YYYYMMDD` 标签识别的历史归档默认排除，可用“含历史归档”正常复选框纳入；不凭done/cancelled猜测归档。仅统计当前任务库，全局和当前沿用同一归档开关，不读取额外归档库、不重建第二任务库。来源失败时隐藏旧图表、任务和明细并显示上次成功时间。
