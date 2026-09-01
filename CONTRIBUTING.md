# 参与维护

欢迎通过 Issue 和 Pull Request 共同维护 ForgeaX Task Board。

## 本地开发

需要安装 Bun，然后运行：

```bash
bun run start
```

默认访问地址为 `http://localhost:19080`。开发模式：

```bash
bun run dev
```

## 提交前检查

每个 Pull Request 至少需要通过：

```bash
bun run check
bun test ./tests
```

涉及任务字段、筛选或 Agent 生命周期时，请同时补充集成测试，并保证旧版 `data/tasks.json` 能向后兼容加载。

## Pull Request 约定

1. 从 `main` 创建小而聚焦的分支。
2. 在 PR 描述中说明动机、行为变化和验证结果。
3. 如果改变 API，请同步更新 `docs/api.md`、`public/agent-guide.md` 和 `/api/agent-guide`。
4. 不要把真实任务、账号、密码、Cookie、日志或内网凭据提交到仓库。
5. Agent claim 需要保留 `agentId`、`sessionId`、`process`、`cwd` 和 lease 生命周期语义。

## 人员与 Agent 语义

- `people[]` 是人工负责人或协作者，可以有多人。
- `claim` 是当前唯一的 Agent 执行租约。
- 人员筛选是协作视图，不是权限控制；若要增加身份认证或 RBAC，请在 PR 中明确安全边界和迁移策略。
