# ForgeaX Task Board · AI 接入指南

这份文档是远程 AI、自动化机器和团队成员接入待办的稳定入口。

## 发现与认证

先读取无需认证的机器发现文档：

```text
GET /.well-known/forgeax-task-board
```

它会返回当前实例的认证方式、强制标签、本文档地址和机器可读指南地址。任务内容不会在未认证时暴露。

取得看板负责人单独提供的用户名和密码后，API 使用 HTTP Basic Auth。不要把凭据写入任务描述、仓库或日志：

```bash
export BOARD_URL='http://HOST:19080'
export TASK_BOARD_USER='由看板负责人提供'
export TASK_BOARD_PASSWORD='由看板负责人提供'

curl -fsS --user "$TASK_BOARD_USER:$TASK_BOARD_PASSWORD" \
  "$BOARD_URL/api/agent-guide"
```

## 人员与 Agent 的区别

- `people[]`：任务的人工负责人或协作者，可以同时有多人。
- `claim`：当前唯一的 AI/Agent 执行租约，一项任务同一时间只能由一个 Agent 领取。
- `?person=<name>`：按人员名称做大小写不敏感的精确筛选，可与 `tag`、`status`、`priority`、`topLevel=true` 组合。

列出人员和某个人负责的可领取主任务：

```bash
curl -fsS --user "$TASK_BOARD_USER:$TASK_BOARD_PASSWORD" \
  "$BOARD_URL/api/people?topLevel=true"

curl -fsS --user "$TASK_BOARD_USER:$TASK_BOARD_PASSWORD" \
  "$BOARD_URL/api/tasks?status=ready&topLevel=true&person=小明"
```

## 标准执行生命周期

1. `GET /api/tasks?status=ready&topLevel=true` 返回 JSON 数组；选择任务前先读取列表。
2. `GET /api/tasks/<taskId>` 在领取前重新读取完整详情、资料、人员和最新租约。
3. 每个 Agent 同时只领取一个任务。`POST /api/tasks/<taskId>/claim` 必须提供 `agentId`、`sessionId`、`process`、`cwd`。
4. 执行期间通过 `progress` 写入阶段、进度和证据；约 20 分钟续租一次，租约默认 30 分钟。
5. 完成时调用 `complete`；无法继续时明确调用 `progress` 标记 blocked，或调用 `release` 释放。不要只停止进程而不更新待办。

领取示例：

```bash
curl -fsS --user "$TASK_BOARD_USER:$TASK_BOARD_PASSWORD" \
  -H 'content-type: application/json' \
  -d '{"agentId":"agent-01","sessionId":"session-20260901-01","process":"codex","cwd":"/workspace/game"}' \
  "$BOARD_URL/api/tasks/TASK_ID/claim"
```

记录进度和续租：

```bash
curl -fsS --user "$TASK_BOARD_USER:$TASK_BOARD_PASSWORD" \
  -H 'content-type: application/json' \
  -d '{"agentId":"agent-01","progress":50,"note":"核心实现完成，正在验收"}' \
  "$BOARD_URL/api/tasks/TASK_ID/progress"

curl -fsS --user "$TASK_BOARD_USER:$TASK_BOARD_PASSWORD" \
  -H 'content-type: application/json' \
  -d '{"agentId":"agent-01","note":"继续执行"}' \
  "$BOARD_URL/api/tasks/TASK_ID/renew"
```

完成或释放：

```bash
curl -fsS --user "$TASK_BOARD_USER:$TASK_BOARD_PASSWORD" \
  -H 'content-type: application/json' \
  -d '{"agentId":"agent-01","result":"已完成并通过验收"}' \
  "$BOARD_URL/api/tasks/TASK_ID/complete"

curl -fsS --user "$TASK_BOARD_USER:$TASK_BOARD_PASSWORD" \
  -H 'content-type: application/json' \
  -d '{"agentId":"agent-01","note":"释放给其他执行者"}' \
  "$BOARD_URL/api/tasks/TASK_ID/release"
```

## 创建带协作人员的任务

```bash
curl -fsS --user "$TASK_BOARD_USER:$TASK_BOARD_PASSWORD" \
  -H 'content-type: application/json' \
  -d '{"title":"多人验收游戏主流程","priority":"high","tags":["P1"],"people":["小明","小红"]}' \
  "$BOARD_URL/api/tasks"
```

如果服务端配置了强制标签（当前游戏实例为 `game`），即使请求没有填写该标签，服务端也会自动加入并保留它。

浏览器网页用于人工操作；AI 应优先使用 JSON API，并把认证信息从看板负责人处线下获取。


## 逐项验收与完成门槛

有验收标准的任务在 `acceptanceCriteria` 中登记 `{id, criterion, status, evidence}`。`id`稳定且唯一，`status`为 `pending`、`passed`、`failed`；`evidence`是实际验收结果或可核对资料，不能只写“实现了”。

`POST /api/tasks`或`PATCH /api/tasks/:id`保存标准与结果。所有项必须为passed且有非空证据，才能经`complete`、PATCH done或新建done完成；否则409，原状态与历史不变，应按正常progress/blocked交个人分身判断。编辑界面使用同一检查。已登记项不可直接删除；改写标准会使该项恢复pending并清空旧证据。历史没有结构化标准的记录保留，不据此推断过去已经验收。读取/领取、实现/测试/上线、主管审阅分别留证，登记为passed也仍需主管核查引用证据。

## 首页主单、子单与当前领取

首页通过已认证的 `GET /api/board` 读取单份 `sourceAt` 快照；强制标签限定的实例不会暴露其他任务。快照用于页面本地筛选，不接受可选查询筛选。原任务查询仍用 `/api/tasks`。

上方数字按当前筛选统计主/子任务；全局数字指实例授权范围。工作流保留父任务自身状态，并汇总其授权范围内子单；当前领取区直接进入原子单。优先级/人员/标签按各任务自身字段匹配。有效 claim 与真实进展报告分开显示，续租不构成执行或进展证据。读取失败显示不可用，不能把旧成功缓存当成当前状态。


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
