# Claude Relay Service

Claude Relay Service 是一个面向 Claude Code、Codex 与兼容客户端的多账户中转和用量管理服务。

本仓库是在公开项目基础上长期演进的自维护分支。除基础的账户池、API Key、调度和统计能力外，本分支持续补充了多租户管理、精细计费、上游容错、请求审计及新模型支持。本文档以本分支的实际行为为准。

> [!CAUTION]
> 本项目可能涉及上游服务条款、账号安全和数据合规风险。请仅在获得授权的场景中使用，并自行承担部署和运营责任。

## 本分支主要增强

### V2 父子账户

- 可将普通 API Key 升级为 V2 父账户，并由父账户自行创建和管理多个子 API。
- 父账户统一管理总预算、已用量、并发数、Claude 周限额、Fable 周限额和来源 IP 白名单。
- 子 API 的费用和用量汇总到父账户总账，同时保留各子 API 的独立统计、时间线和请求明细。
- 管理员可展开查看子 API、进入父账户模拟视图、重置密码和测试指定子 API 的模型连通性。
- V2 自助后台提供用量时间筛选、API Key 管理、密钥重生成、使用教程和只读请求明细。

### 计费与配额

- 识别 OpenAI Responses 的 priority/fast 调用，并按模型应用实际倍率；GPT-5.5 与 GPT-5.6 系列使用 2.5 倍计价。
- 支持 GPT-Image-2 的文本 Token、图片 Token 和图片专用价格统计。
- 支持 Claude 5 分钟与 1 小时缓存写入、缓存读取的独立计费和展示。
- 支持 Claude、Fable 周限额，以及基于 OAuth 实际额度重置时间的本周成本展示。
- 为尚未进入远端价格表的模型提供本地价格回退，包括 Claude Opus 4.8 和 Claude Fable 5。
- 账户管理、API Key 统计、请求时间线和请求明细共用一致的计价规则。

### OpenAI、Codex 与图片能力

- 提供 OpenAI OAuth 账户管理、重新认证、额度刷新和账户连通性测试。
- 提供 `/openai` Codex Responses、Responses Lite、compact、search、models 和图片相关能力。
- 提供 `/general` OpenAI 兼容入口，支持 Responses、Chat Completions、图片生成和图片编辑。
- 支持 GPT-Image-2 流式请求保活，降低长时间无数据时被中间代理断开的概率。
- 支持按 API Key 禁用 GPT fast mode，并按实际发送给上游的模式统计。
- 支持 OpenAI 多网卡出口轮换、单网卡启停、429 冷却、自动换网卡重试及出口 IP 记录。

### Claude 稳定性与兼容

- Claude OAuth 支持重新认证、Refresh Token 到期时间、额度后台刷新和周成本聚合。
- Claude OAuth 在 15 分钟滚动窗口内累计 3 次 429 后才暂停调度，避免单次限流误停账户。
- 支持账户错误历史、上游错误响应留存、临时冷却和状态恢复。
- 支持可选的 Anthropic 1 小时缓存 TTL 注入；仅改写请求中已有的 ephemeral 缓存断点，不主动新增断点。
- 支持 Claude 会话在兼容上游切换到官方 OAuth 时进行可选的有损续接。
- 可配置拒绝 Claude fast mode，以及拦截受策略限制的模型。

### API Key 与访问控制

- 支持总额、每日费用、并发、模型、服务类型和客户端类型限制。
- 支持多个来源 IP 或 CIDR 白名单，并可在受信代理场景读取真实客户端 IP。
- 普通用户可在自助统计页维护自己的 IP 白名单；V2 父账户可维护父级白名单。
- 支持 API Key 明文查看和安全重生成；可由系统生成，也可输入符合长度限制的自定义值。
- 支持 Claude Code 客户端版本校验、Codex CLI/TUI 识别和 API Key 标签筛选持久化。

### Grok 与新增模型

- 提供 Grok OAuth 账户管理、模型同步、额度查询、测试和 `/grok/responses` 入口。
- 支持 GPT-5.4、GPT-5.5、GPT-5.6 系列、GPT-Image-2、Claude Opus 4.8、Claude Fable 5 等本地扩展模型。
- 模型价格页可展示本地回退价格、fast 价格以及图片 Token 价格。

### 审计与运维

- 请求明细支持按小时配置留存周期，并可选保存脱敏后的请求体和响应信息。
- Redis 保持请求明细权威数据，SQLite 作为可重建的查询索引，提高筛选和分页速度。
- 管理员与 V2 用户使用一致的请求明细样式，展示缓存读写、fast 标识、耗时、出口 IP 和图片 Token。
- 支持后台 OAuth 额度刷新、服务日志轮转、systemd 自动恢复和敏感凭据日志脱敏。
- 提供模型连通性测试、账户测试历史、错误历史和健康检查。

## 基础能力

- Claude OAuth、Claude Console、OpenAI OAuth、Grok OAuth、Gemini、Antigravity、AWS Bedrock 等账户类型。
- 多账户调度、代理配置、粘性会话、专属账户、自动故障切换和并发队列。
- 独立 API Key、模型白名单、用量限制、成本核算和统计报表。
- 管理后台、用户自助统计页、V2 父账户后台和公开状态页。
- 流式响应、Token 统计、缓存统计、请求时间线和 Webhook 通知。

## 运行要求

最低环境：

- Node.js 18 或更高版本
- Redis 6 或更高版本
- Linux 生产环境
- 1 核 CPU、1 GB 内存和足够的日志/请求明细存储空间
- 可访问所配置的上游服务

生产环境建议使用 HTTPS 反向代理，并只将应用端口暴露给受信代理。若启用转发 IP 信任，必须确保源站无法被绕过，否则客户端可以伪造相关请求头。

## 源码部署

### 1. 安装依赖

```bash
git clone git@gitlab.shenjc.net:JC-S/claude-relay-service-jc.git
cd claude-relay-service-jc
npm install
npm run install:web
```

### 2. 创建配置

```bash
cp config/config.example.js config/config.js
cp .env.example .env
```

至少需要在 `.env` 中设置：

```dotenv
NODE_ENV=production
PORT=3000
JWT_SECRET=replace-with-a-long-random-secret
ENCRYPTION_KEY=replace-with-a-32-character-key
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
```

不要在服务投入使用后随意更换 `ENCRYPTION_KEY`，否则已加密保存的 OAuth 凭据和 API Key 明文可能无法解密。

### 3. 初始化并构建

```bash
npm run setup
npm run build:web
```

初始化生成的管理员凭据保存在 `data/init.json`。也可以在初始化前通过 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 指定管理员账号。

### 4. 启动服务

```bash
npm run service:start:daemon
npm run service:status
```

启动后访问：

- 管理后台：`http://127.0.0.1:3000/admin-next`
- 健康检查：`http://127.0.0.1:3000/health`

账户添加、API Key 创建和客户端配置均可在管理后台完成。README 不再重复各客户端和各 API 端点的接入教程。

## 常用维护命令

```bash
npm run service:status          # 查看状态
npm run service:logs            # 查看日志
npm run service:logs:follow     # 持续查看日志
npm run service:restart:daemon  # 重启服务
npm run service:stop            # 停止服务
npm run build:web               # 重新构建管理后台
npm test                        # 运行测试
npm run lint:check              # 检查后端代码规范
```

如果系统已安装 `claude-relay-service.service`，上述服务管理命令会优先调用 systemd。服务异常退出后是否自动拉起，取决于 systemd 单元中的 `Restart` 配置。

## 数据与备份

主要持久化内容包括：

- Redis：账户、API Key、用量聚合、配额、调度状态和请求明细权威数据。
- `data/`：初始化信息、SQLite 请求明细索引及其他本地状态。
- `logs/`：业务日志、错误日志和服务输出日志。
- `.env` 与 `config/config.js`：运行配置及加密密钥。

备份时应同时保存 Redis 数据、`data/`、`.env` 和 `config/config.js`。SQLite 请求明细数据库是读索引，可以从 Redis 重建，但不应将其作为唯一备份。

## 可选配置

完整配置及说明见 [.env.example](.env.example) 和 [config/config.example.js](config/config.example.js)。常用配置包括：

| 配置 | 用途 |
| --- | --- |
| `TRUST_PROXY` | 是否信任反向代理提供的客户端信息 |
| `OPENAI_UPSTREAM_LOCAL_ADDRESSES` | OpenAI 多网卡出口的本地 IP 列表 |
| `OAUTH_USAGE_REFRESH_*` | Claude/OpenAI OAuth 额度后台刷新 |
| `REQUEST_DETAIL_SQLITE_*` | 请求明细 SQLite 读索引 |
| `LOG_LEVEL`、`LOG_MAX_SIZE`、`LOG_MAX_FILES` | 应用日志级别和轮转 |
| `TOKEN_USAGE_RETENTION` | Token 用量数据留存时间 |
| `GROK_PROVIDER_ENABLED` | 是否启用 Grok provider |

敏感配置不要提交到 Git，也不要通过普通日志或截图传播。

## 管理流程

1. 访问 `/admin-next` 并使用初始化管理员账号登录。
2. 在账户管理中添加上游账户并执行连通性测试。
3. 在 API Keys 中创建密钥并设置权限、配额、并发、模型和 IP 限制。
4. 如需多租户自助管理，将普通 API Key 升级为 V2 父账户并创建子 API。
5. 在仪表盘、使用统计、请求明细和错误历史中核对运行情况。

具体客户端配置由后台“使用教程”提供，避免 README 与实际 UI 或模型列表不同步。

## 安全说明

- 管理后台、Redis 和应用源站不应直接暴露到不受信网络。
- 必须使用随机且足够长的 `JWT_SECRET`，并妥善保管 `ENCRYPTION_KEY`。
- API Key 和 OAuth Token 具有实际访问权限，应按凭据级别保护。
- 开启请求体留存会增加敏感数据和磁盘占用，应按最小必要原则配置保留时间。
- 来源 IP 白名单依赖真实客户端 IP。使用 Cloudflare Tunnel 或其他反向代理时，应同时正确配置代理信任边界。
- 上线前应测试流式响应、长请求超时、上传大小、日志轮转和备份恢复。

## 故障排查

```bash
redis-cli ping
npm run service:status
npm run service:logs:follow
curl http://127.0.0.1:3000/health
```

排查顺序：

1. 确认 Redis、应用进程和健康检查正常。
2. 在账户管理中执行对应上游账户测试。
3. 查看账户错误历史和请求明细中的状态码、上游信息及耗时。
4. 检查 API Key 的服务权限、模型限制、客户端限制、IP 白名单和剩余额度。
5. 检查反向代理是否缓冲 SSE、截断请求头或提前终止长连接。

## 许可证与来源

本项目采用 [MIT License](LICENSE)。本仓库包含源自公开 Claude Relay Service 项目的代码，并在其基础上持续维护和扩展。
