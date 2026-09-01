# AnyDev deployment

This deployment runs the Task Board in a persistent `tmux` session because the AnyDev container does not expose a working systemd instance.

```bash
cp deploy/anydev/env.example .env
chmod 600 .env
deploy/anydev/start.sh
deploy/anydev/status.sh
```

The process survives SSH disconnects and restarts Bun after a process crash. AnyDev environment restarts stop all container processes, so run `deploy/anydev/start.sh` again after an environment restart.

The cloud instance must use a separate `data/tasks.json`; do not copy the workstation's global Task Board data. `TASK_BOARD_REQUIRED_TAG=game` makes the server ignore other requested tag scopes and forces all writes to retain `game`.

When `TASK_BOARD_AUTH_USER` and `TASK_BOARD_AUTH_PASSWORD` are configured, browser visits are redirected to `/login`. A successful login creates a 12-hour `HttpOnly`, `SameSite=Strict` session cookie. Agent and command-line API clients can continue to send the same credentials with HTTP Basic authentication:

```bash
curl --user "$TASK_BOARD_AUTH_USER:$TASK_BOARD_AUTH_PASSWORD" http://127.0.0.1:19080/api/summary
```

The cookie and Basic credentials are not encrypted on a plain HTTP connection. Keep this deployment inside the trusted AnyDev/company network, or put an HTTPS reverse proxy in front before exposing it to the public internet.
