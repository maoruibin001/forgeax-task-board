# 安全策略

## 不要公开提交敏感数据

以下内容不得出现在 Issue、Pull Request、提交或测试夹具中：

- `.env` 和真实认证凭据；
- `data/tasks.json`、服务日志和真实任务内容；
- Basic Auth 密码、浏览器 Cookie、云机器密钥或内网令牌；
- 可识别个人、客户或内部项目的非公开资料。

仓库已通过 `.gitignore` 排除运行数据，但提交者仍需在 push 前检查 staged 文件。

## 报告安全问题

请不要在公开 Issue 中披露可利用的安全漏洞或真实凭据。优先使用本仓库的 GitHub Security Advisory 私密报告渠道；如果该渠道尚未启用，请只创建不含利用细节的 Issue，请求维护者提供私密联系方式。

当前 AnyDev 示例使用 HTTP Basic Auth 和应用会话 Cookie。普通 HTTP 不提供传输加密；对公网部署时必须在前面配置 HTTPS，并限制网络访问。
