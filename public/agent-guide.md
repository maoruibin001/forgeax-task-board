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
