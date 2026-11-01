# llm 代理网关
对外提供 Openai 和 Anthropic 两种方言接口
对内模拟 Minimax Code, Qoder, Workbuddy 等桌面客户端向上游转发请求

## 术语定义

**Agent**：专指 buddyProxy API 的调用方。比如 pi, opencode, hermes, dsh 等。

**模拟端**：有些上游 API 仅限自家封闭客户端调用，buddyProxy 需要在调用时将请求的指纹信息与上游对应的封闭客户端对齐，达到欺骗效果。保持这些封闭客户端的会话活跃，模拟请求指纹的行为主题（代码模块）就叫**模拟客户端**，简称**模拟端**。

**Upstream**：指上游的 API。一个 upstream 对应一个平台的某个服务（一个平台可能会有多个服务，比如 MiniMax 的开放 API（API Key 认证）和 MiniMax Code（OAuth 认证），权益不同，属于不同的 upstream）。

**Provider**：指单个账号，通过 OAuth 登录或者账号密码登录。一个平台会有多个账号，即一个 upstream 会有一个或多个 provider。

Upstream 内部可以设置多 provider 的策略（fallback、balance 等）。主路由直接接入 upstream，而不是接入 provider。主路由的策略与 upstream 的策略互相独立，共同生效。

## 平台与账号

provider 表的每一行是**一个账号**，不是一个平台。平台是代码里的模板（`lib/kinds/` 注册，
注册表在 `lib/provider-kinds.ts`），
它决定用哪个 kind、能用哪些策略。账号行归某个平台，可以有多个账号；账号带自己的启用状态、
权重与凭据。

**平台的生效策略管它名下那些账号怎么选**（`single` / `fallback`，TokenRhythm 另有
`expiry_first`）：选哪个账号、失败换不换人。账号自己的权重决定降级时的先后。

注销账号 = 彻底删干净：账号行、凭据、旧位置的那些记录、健康快照里它的那段，都没了。
只有请求日志和用量统计留着。`account_seq` 是平台级的序号计数（保证账号 id 不复用），不是账号记录，注销不删它。迁移前的备份（`buddy.db.bak-*`）也不在「删干净」范围内：里面有当时全部的凭据，迁移确认无误后手动删除。

## 仓库结构

- `router-proxy.ts`：唯一入口，Koa 服务，默认端口 6450（`ROUTER_PORT` 可改），面板在 `/admin`。
- `lib/`：后端。`platforms.ts` 写死平台模板，`provider-kinds.ts` 注册 kind 与策略，`kinds/` 是各平台 kind，`router/` 是主路由，`store.ts` 是数据库（`data/buddy.db`）。
- `web/`：React 面板（TanStack Router + React Query + shadcn）。`web/.gen/` 是契约生成物，由 `lib/gen/` 复制而来（gitignore，别手改）。
- `proto/buddy/`：契约，`buf.gen.yaml` 生成 `lib/gen` 与 `web/.gen`。
- `test/`：离线测试，全打假上游，不花额度；`test/fixtures/` 是录下来的上游响应（录制时按字段脱敏，见 `test/fixture-scrub.ts`）。两份 MiniMax fixture（`post-minimax-v1-messages-*`）是经局域网里的中转网关录的，不是直连 MiniMax Code（`upstream` 字段写着来源）。
- `helper/`：Python 小工具（配额提醒等）；`lib/admin/`、`lib/dialect/` 是面板 API 与方言转换。

## 开发环境与命令

工具版本由 `mise.toml` 统一（node / pnpm / buf），所有命令走 mise，不要手敲。

- 跑服务：`mise run serve`（等价 `node router-proxy.ts`，需带 mise 的 NODE_OPTIONS）
- 后端类型检查：`mise run typecheck`
- 后端测试：`mise run test`（含 `bash test/smoke.sh` 与约 65 个单测任务）。测试起的网关预加载 `test/net-guard.ts`：向 127.0.0.1 以外发请求直接报错，网关日志里出现 `[NET-GUARD]` 测试就判失败。mise 的每个 node 测试任务也带 `--import ./test/net-guard.ts`，测试进程自己出网同样被拦并以非零退出。边界：只拦 fetch 与 node:http/https，不拦裸 socket 与 DNS；测试自己 spawn 的子进程要自己带 `--import`（harness 与 cleanup-admin-check 已带，其余 spawn 的是假上游与种子脚本）；`bash` 任务（smoke、aggregate）里的 curl 不受管（smoke 里直接起的 node 测试已带 `--import`）。
- 面板：`mise run web:dev` / `mise run web:build` / `mise run web:typecheck` / `mise run web:test`
- 全量检查：`mise run check`（= typecheck + web:typecheck + test + web:test）
- 契约：`mise run proto`（buf generate + `cd web && pnpm run gen:sync`）、`mise run proto:lint`、`mise run proto:breaking`
- 文件体积提示：`mise run lint:size`（扫 lib、web/src、router-proxy.ts、config-cli.ts，超过 400 行的点名）。只是提示，不失败，也不在 `check` 里；`--strict` 才失败。
- 构建镜像：`mise run build`（面板 + podman image）；部署见 README 的「With Docker / With docker compose」一节与 `docker-compose.yml`
- Python 工具：`mise run helper:sync` / `mise run helper:todo` / `mise run test:helper`

## 排查问题
优先查日志定位原因，查不到日志再考虑构建请求复现问题。解决问题后要复盘这个问题能不能通过提前加日志解决
问题修复之后先部署验证，验证完毕没问题才能推送 github

上游的响应正文要一起记进日志（不只是状态码）——排查上游行为时，正文往往比状态码有用。
上游的额度很小，排查时优先录一次响应、之后对着假上游跑。

## 生成物与检查

- 碰了 `proto/**` 的人自己跑 `mise run proto`（生成两份：`lib/gen` 与面板的 `web/.gen`），跑不通不许交付。
- 交付前跑 `mise run check`（两边 typecheck + 两套测试），不要手敲单条命令。
- 提交信息用 conventional 风格、带模块作用域：`feat(models): ...`、`fix(workbuddy): ...`、`test: ...`、`data(workbuddy): ...`。

## 派单纪律

- 每个实现单跑完，必须再派一次 review（后端 `be-review`、前端 `fe-review`），照它们的「改动清点」逐条给结论。
- 派单必须写清授权范围（精确路径或目录），并给 `tools/subagent-watch.ts` 留出可读的事件流路径。
- `tools/` 是本机工具目录（已在 .gitignore 里，仓库里没有），换机器要自己放。

## 本地实验

可以在本机再起一个实例做实验，前提是它用**自己的** `BUDDY_DATA_DIR`，而且**不持有 NAS 上
那些账号的会话**——同一份会话两边轮流用会把令牌用废（2026-10-25 的事故就是这么发生的）。

不要拿生产库的副本起第二个网关实例。要在本地用某个账号的令牌，就让官方桌面端持有它，
网关用同步脚本跟着搬（见 `tools/sync-zcode-auth.ts`）。

## 陷阱

- Node 版本：mise 装 node 26（mise.toml 的 `[tools]`，pnpm 12.16.1）。Node 26 删掉了 `--experimental-transform-types`，只剩原生类型剥离，而剥离不认 enum、参数属性（`constructor(private x)`）、namespace。所以契约生成物用 `erasable_syntax=true` 生成（buf.gen.yaml），enum 是 `as const` 对象加同名类型别名；手写代码也不要用这几种语法。package.json 的 engines 是 `>=22.18`（类型剥离默认开启的版本）。镜像仍是 node:24-alpine，`NODE_OPTIONS` 只剩 `--disable-warning=ExperimentalWarning`。
- 测试任务的命令行上写着 `node --experimental-strip-types`，那是旧写法的残留：Node 26 默认就剥类型，这个 flag 是空操作。`[env]` 的 NODE_OPTIONS 另带 `--no-experimental-webstorage`（否则 vitest 下 jsdom 的 localStorage 搬不进来），手敲命令时也要带上。
- 测试默认串行（mise `jobs = 1`，约 83 秒）。并行跑会抢同一批端口和临时目录，随机挂在不相干的断言上。
- `test/smoke.sh` 依赖 `test/fixtures/`（录制的上游响应），没有 fixtures 先跑 `test/capture.sh`。
- `mise run proto:breaking` 的基线是 `.git#branch=buddy/main`，本地只有 `origin` / `fork` 两个远端，用之前先加 remote 或换基线。
- 平台 id 就是请求路径段（`/minimax/v1/messages`），改平台名等于打断调用方的 base_url。
- `.env` 走 `lib/env.ts` 的白名单读取，只有显式请求的键会被解析，其余密钥不加载不记录；`.env` 不入库。
- 账号开关、平台策略都在数据库里，不在环境变量里；改行为先确认是走数据库还是环境变量。
