# ForgeaX Task Board

一个独立运行的个人待办与 Agent 协作面板。

支持标签作用域、多人协作者筛选、主任务/子任务、资料关联、Agent 独占租约、进度历史、网页登录和机器可读 AI 接入协议。

## 启动

```bash
bun install
bun run start
```

打开 http://localhost:19080。

可以用标签进入专属待办视图，例如碎界游戏待办使用：

```text
http://localhost:19080/?tag=game
```

在这个视图中新建或编辑任务时，服务端会自动加入并保留 `game` 标签。其他标签（例如 `P0`、`combat`）仍可同时使用。

云端配置了 `TASK_BOARD_AUTH_USER` 和 `TASK_BOARD_AUTH_PASSWORD` 后，网页会先进入应用内登录页；登录会话有效期为 12 小时。Agent API 仍支持 HTTP Basic Auth，详见 `deploy/anydev/README.md`。

任务支持独立的 `people` 协作人员数组，网页可按人员筛选；API 使用大小写不敏感的精确参数 `?person=<name>`。`people` 表示人工负责人或协作者，当前执行任务的 AI 仍由独占 `claim` 租约表示。

给其他 AI 的稳定接入入口：

```text
GET /.well-known/forgeax-task-board
GET /agent-guide.md
GET /api/agent-guide
```

第一个发现入口和 Markdown 指南无需认证，但不会暴露任务或凭据；机器可读指南和所有任务 API 仍遵循实例的认证策略。

数据保存在 `data/tasks.json`，服务启动后会在每天 10:00（默认 `Asia/Shanghai`）检查并广播提醒。浏览器打开面板后会收到 Web Notification；服务端也会输出提醒日志。

## Agent API

详见 `docs/api.md`。一个 Agent 的基本流程：

```bash
curl -s http://localhost:19080/api/tasks?status=ready
curl -s -X POST http://localhost:19080/api/tasks/TASK_ID/claim \
  -H 'content-type: application/json' \
  -d '{"agentId":"forge","sessionId":"session-1","process":"codex","cwd":"/workspace/game"}'
curl -s -X POST http://localhost:19080/api/tasks/TASK_ID/complete \
  -H 'content-type: application/json' \
  -d '{"agentId":"forge","result":"完成"}'
```

## 开机启动

macOS 可执行：

```bash
bash scripts/install-macos-autostart.sh
```

脚本会安装一个 LaunchAgent，让面板服务在用户登录后启动。卸载：

```bash
bash scripts/install-macos-autostart.sh --uninstall
```

## 参与维护

欢迎提交 Issue 和 Pull Request。提交前请运行：

```bash
bun run check
bun test ./tests
```

完整约定见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全问题见 [SECURITY.md](SECURITY.md)。真实 `.env`、任务数据和运行日志不会进入 Git 仓库。

## 许可证

本项目目前尚未选择开源许可证。公开仓库允许查看源码、Fork 和提交 Pull Request，但在复用、分发或嵌入其他产品前，请先与维护者确认许可；欢迎通过 Issue 讨论后续采用的许可证。
