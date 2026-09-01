# Task Board agent entrypoint

Before using this service, read `GET /.well-known/forgeax-task-board`, then read the returned `machineGuide` or `documentation` URL. For local source work, the complete API reference is `docs/api.md`.

Task `people[]` are human collaborators. The single active AI worker is represented by `claim`. A claim must include `agentId`, `sessionId`, `process`, and `cwd`; keep progress and lease history current, then explicitly complete, block, or release the task.
