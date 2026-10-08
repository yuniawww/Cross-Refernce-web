# Cloud Foundry / Linux 部署准备

## Node.js Buildpack 源码部署

项目根目录提供 `manifest.yml` 和 `apt.yml`，直接使用 CF 原生源码部署。应用名为 `part-crawler-tool`，配置 2G 内存、2G 磁盘、1 个实例；按 `apt-buildpack → nodejs_buildpack` 顺序构建，执行 `npm start`，以 `/health` 做 HTTP 健康检查。入口端口由 CF 注入 `PORT`，无需手动配置。

清单固定使用 `cflinuxfs4`（Ubuntu 22.04），与 `apt.yml` 的 `libasound2` 等包名对应。目标平台需提供此 stack、支持 Node `>=22.18.0 <23` 的 `nodejs_buildpack`，并允许所配置的 apt-buildpack Git 地址。若平台只提供其他 stack，需要同时调整 stack 和对应的 apt 包名，不能只换其中一个。[CF stack 说明](https://docs.cloudfoundry.org/devguide/deploy-apps/stacks.html)、[多 Buildpack 与 manifest 属性](https://docs.cloudfoundry.org/devguide/deploy-apps/manifest-attributes.html)。

apt-buildpack 安装共享库与中文字体；Node.js buildpack 安装 npm 依赖，并由 Puppeteer 下载配套的 Linux Chrome。清单启用 Chrome 下载、跳过本项目未使用的 `chrome-headless-shell`，不设置本机 `PUPPETEER_EXECUTABLE_PATH`。浏览器缓存沿用 `node_modules/.puppeteer-cache`。CF 启动时的 `.profile` 将 apt 层字体链接到 Fontconfig 可发现的用户字体目录，并将 XDG 配置和缓存放在 `./tmp`，不需要 root 权限或镜像构建。

使用 CF CLI v8，先登录并选择已有组织、空间。首次部署按以下顺序执行；将示例中的 API、组织、空间、Redis 服务实例名及密钥替换为实际值：

```sh
cf login --sso -a https://YOUR-CF-API
cf target -o YOUR_ORG -s YOUR_SPACE
cf stacks
cf buildpacks
cf services

# 数据更新后先准备只读部署副本；不要在 CF 启动时运行此命令。
npm run prepare:db

# 先上传，绑定 Redis 和注入密钥后再启动。
cf push -f manifest.yml --no-start
cf bind-service part-crawler-tool YOUR_REDIS_SERVICE

# 仅首次生成；后续部署和所有实例保持同一密钥。
openssl rand -base64 32
cf set-env part-crawler-tool COOKIE_ENCRYPTION_KEY 'REPLACE_WITH_GENERATED_BASE64_KEY'
cf start part-crawler-tool

cf app part-crawler-tool
cf logs part-crawler-tool --recent
```

Redis 服务实例必须已经创建成功。连接信息从服务绑定的 `VCAP_SERVICES` 读取；如果有多个 Redis 绑定，再设置 `REDIS_SERVICE_NAME`。也可通过安全的环境变量注入 `REDIS_URL`。`manifest.yml` 不写入服务凭据和加密密钥，也不填一个不存在的服务名。缺少 Redis 或密钥时应用会拒绝启动。

后续代码部署运行 `cf push -f manifest.yml`；已有服务绑定和密钥继续使用。若只修改环境变量或服务绑定，可用 `cf restage part-crawler-tool` 重新构建启动。通过 `cf app` 输出的 HTTPS 路由访问应用，健康接口为同一路由下的 `/health`，远程登录也走该路由。

清单按要求配置 Bosch 代理 `http://proxy.bosch.com:8080`，并同时提供大小写代理变量以供不同下载工具使用。浏览器启动器把 `HTTP_PROXY` / `HTTPS_PROXY` 映射为 Chromium 的 `--proxy-server`，把 `NO_PROXY` 转换为 `--proxy-bypass-list`，因此代理同时作用于构建下载和爬虫网页访问；`.bosch.com`、`localhost`、`127.0.0.1` 保持直连。代理地址需能从 BPC staging 和运行容器访问。Chromium 代理参数不支持 URL 内嵌用户名/密码，当前配置不包含代理凭据。[Chromium 代理配置](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md)。

本地 YAML 和启动参数检查不能代替 CF staging 验收。实际部署还需确认 Linux 依赖下载、企业代理可达、Redis 绑定及目标站点查询成功。

## 本地启动与检查

使用 Node `>=22.18.0 <23`（项目使用 Node 内置 SQLite 的只读 API）。BPC 实际安装的 Node buildpack 需包含此范围内的版本；本阶段未修改平台或部署应用。

```sh
nvm install 22
nvm use 22
npm ci
npm run prepare:db
cp .env.example .env
node --env-file=.env server.js
npm test
CF_SERVER_TEST=1 npm test
```

`package.json` 的 `engines` 不会自动切换终端的 Node。项目提供 `.nvmrc`，每个新终端可执行 `nvm use`。Node 22.9 无法直接加载 `node:sqlite`；不要仅添加实验开关，因为旧版本仍不满足本项目的只读 SQLite 要求。

本地尚未配置 Redis 时，可以直接运行：

```sh
nvm install 22
nvm use 22
NODE_ENV=development STATE_STORE=memory PORT=3000 npm start
```

内存模式仅用于本地，重启丢失任务、Cookie 和历史。若使用 `NODE_ENV=production`，还必须配置 `STATE_STORE=redis` 和真实 `REDIS_URL`，或绑定 Redis 服务。

`npm start` 执行 `node server.js`，要求环境已提供有效 `PORT`。本地可使用 `.env`，CF 会注入 `PORT`，不要在 manifest 中固定它。服务绑定 `0.0.0.0`。

`GET /health` 返回 `200 {"status":"ok"}`，仅检查进程 HTTP 存活，不访问业务首页、Redis、数据库或浏览器。根目录 manifest 已配置：

```yaml
health-check-type: http
health-check-http-endpoint: /health
```

## 基准库

根目录的 `sparkplug.db`、`brakeoil.db` 是本地准备数据源，不上传 CF。`npm run prepare:db` 使用 SQLite backup API 创建一致性快照，向 `data/` 中的部署副本建立索引、转换为 DELETE journal 模式并检查完整性。此过程不修改源库，即使源库使用 WAL 也不依赖遗漏的 WAL 文件。数据更新后必须重新执行。

只上传 `data/sparkplug.db` 与 `data/brakeoil.db`。运行时以 `readOnly: true` 打开，不建表、不建索引；发现未准备的 WAL 库会拒绝启动/查询。可用 `SPARK_DATABASE_PATH`、`BRAKE_DATABASE_PATH` 覆盖部署副本路径；准备脚本的数据源可用 `SPARK_DATABASE_SOURCE`、`BRAKE_DATABASE_SOURCE` 指定。

制动液 Excel 导入现在原子替换 Redis 内的 VIN 映射，后续查询用只读基准库补齐车型与规格；不再修改 `brakeoil.db`。历史本地导入状态与 Cookie 不会自动上传。

## Redis 服务绑定

已实现 Redis 适配器。创建并绑定 Redis 服务后，无需再修改业务代码。连接配置优先级：

1. `REDIS_URL`，支持 `redis://` 和 `rediss://`。
2. `VCAP_SERVICES` 中的 Redis 服务；多个服务时用 `REDIS_SERVICE_NAME` 选择。

支持服务凭据的 `uri` / `url`，或 `hostname` / `host`、`port`、`username`、`password`、`tls` 字段。其他 broker 凭据格式可显式注入 `REDIS_URL`，不要提交凭据到代码库。TLS 不关闭证书校验。

`STATE_STORE=redis` 可明确选择 Redis；`STATE_KEY_PREFIX` 默认 `cross-reference:`，不同应用/环境应使用不同前缀。生产或 CF 环境禁止 `memory`，缺少 Redis 配置时拒绝启动。本地无 Redis 时默认内存模式，启动会提示重启丢失数据；不会退回文件存储。

任务快照、轮询心跳、取消请求、请求去重和会话互斥使用 Redis，可由不同 CF 实例处理 HTTP 请求。浏览器进程仅由启动该任务的实例持有。任务保留 1 小时，页面超过 30 秒未轮询会取消，跨实例取消在下一次检查（约 3 秒）生效。实例丢失后，任务显示失败，需重新提交，不会自动重放爬取。搜索历史每用户保留最近 10 条。

Redis 的跨重启持久性、备份、容量和淘汰策略由后续选择的服务计划保证。应选择支持持久化且不会随意淘汰业务键的计划。VIN 导入仍允许最多 100 万行，会占用 Redis 和 Node 内存；大数据量需按容量配置实例，或后续改用 PostgreSQL。当前未实现 PostgreSQL 适配器。

## 浏览器与登录

所有爬虫使用统一启动器：所有平台默认无头；CF 始终无头。`BROWSER_HEADLESS=true/false` 可显式选择本地模式，但不能关闭 CF 的无头模式。启动参数包含 `--no-sandbox`、`--disable-setuid-sandbox`、`--disable-dev-shm-usage`。profile、缓存和诊断输出位于项目 `tmp/`，profile 每次运行独立，浏览器退出时清理，容器重启可丢弃。

MANN、Bendix 和 ZF 使用统一的目录页面初始化：保持真正的无头 Chromium 进程，在首次请求前将 User-Agent 的 `HeadlessChrome/` 产品标识改为 `Chrome/`，保留实际浏览器版本和操作系统，并设置桌面视口。无需人工窗口、Xvfb、固定 macOS 路径或 Docker。MANN 等待搜索后的新页面结果；ZF 等待 Nuxt 初始化完成，再使用真实键盘输入及 Enter 提交。

目标站点返回 403/429/5xx 时会明确报告访问限制或服务不可用，而不会继续等待不存在的搜索框。

`.puppeteerrc.cjs` 将 Puppeteer 下载的浏览器二进制放在 `node_modules/.puppeteer-cache`，随 CF staging 产物保留。`.cfignore` 排除本地 `node_modules`，避免上传 macOS 二进制。CF staging 必须允许 Puppeteer 的安装脚本和 Linux 浏览器下载，并且提供 Chrome 需要的系统库。若 BPC 已提供 Chromium，则设置 `PUPPETEER_EXECUTABLE_PATH`；只有确定该路径在 staging/runtime 可用时才设置 `PUPPETEER_SKIP_DOWNLOAD=true`。不要把本机浏览器路径写入部署配置。

MAHLE、Purolator、Tora、NGK 在 URL、可见二维码/验证码/登录控件、HTTP 401 或未登录业务错误出现时，暂停当前查询并创建临时无头登录浏览器。前端弹出“打开远程浏览器完成授权”，用户在新标签页看见浏览器画面，可扫码、点击、拖动、输入手机号/验证码。检测到业务页面的登录标记后，程序将 Cookie 和同源页面存储转移回查询浏览器，验证登录状态，保存加密 Cookie，关闭临时浏览器及调试端口，然后重试当前查询项；已完成的查询项保留。

远程入口使用应用现有 HTTPS 路由 `/remote-login.html#...`，不使用 `http://应用域名:9222`。CDP 仅监听容器回环地址的随机端口，不暴露到公网，也不需要 Docker、Xvfb 或额外 CF TCP 路由。HTTP 画面轮询和操作队列经 Redis 转发，支持请求落在其他 CF 实例，不要求粘性会话或 WebSocket。参考 [CF 自定义端口说明](https://docs.cloudfoundry.org/devguide/custom-ports.html)。

入口使用随机短期令牌，只有提交该任务的客户端 ID 能从任务接口取得链接；打开的链接本身也是授权凭证，请勿分享。当前应用以浏览器中的随机客户端 ID 区分用户，并未新增账号登录系统。链接令牌位于 URL fragment，不随页面请求或 Referer 发送；后续 API 使用 Bearer 认证。仅开放鼠标、文字和受限键盘操作，不开放任意 CDP 命令或 JavaScript 执行。

登录最长等待 5 分钟。成功、取消、超时、任务取消或实例正常停止时均关闭临时浏览器，删除画面及操作队列。登录标签页会维持任务心跳；关闭查询主页面仍遵循原有的取消任务行为。实例异常退出时链接会失效，需重新提交查询。认证完成会验证原查询浏览器的登录状态，不把“二维码消失”单独当作登录成功。

**使用 Redis 时必须配置 `COOKIE_ENCRYPTION_KEY`**：

```sh
openssl rand -base64 32
# 将生成值安全注入 CF 环境变量 COOKIE_ENCRYPTION_KEY；不要提交到代码或 manifest。
```

所有实例必须使用同一个 32 字节 Base64 密钥，并在重部署后保留。Cookie、临时画面、验证码输入队列和链接令牌用 AES-256-GCM 加密后写 Redis；认证附加数据绑定各自用户/会话键，防止跨用户替换。内存开发模式使用进程临时密钥。换密钥前应清理旧 Cookie 和未完成任务，再重新授权；不会尝试明文降级。旧版本的明文 Cookie 不再使用，需重新授权或导入。持久池保存 Cookie；同源 localStorage/sessionStorage 只用于本次浏览器间交接，不写本地文件。

登录时会同时运行查询浏览器和临时登录浏览器，需给 CF 实例留出相应内存。微信/短信验证码由用户本人完成；源站的出口 IP 限制或额外设备策略仍需在实际 CF 上联调。

也可将已有 Puppeteer Cookie 从 stdin 导入指定用户会话：

```sh
# 先配置 REDIS_URL 和 COOKIE_ENCRYPTION_KEY；Cookie 文件只用于导入，不上传。
npm run import:cookies -- ngk USER_SESSION_ID < /secure/path/cookies.json
```

用户 ID 为前端已有 `crossReferenceClientId`。Cookie 按品牌与用户隔离；不再读取根目录旧 Cookie 或共享 profile。

远程授权浏览器验收：`REMOTE_LOGIN_BROWSER_TEST=1 node --test tests/remote_login.test.js`。使用模拟站点验证真实无头浏览器的 401 检测、远程验证码输入、跨应用实例转发、Cookie 加密、续查及浏览器回收，不使用真实微信账号。

## 环境配置与上传内容

品牌站点地址参见 `.env.example`。页面目录链接和前端来源校验使用相同配置；外部静态资源可用 `TAILWIND_URL`、`FONT_CSS_URL`、`ICON_CSS_URL`、`XLSX_URL` 替换。仅这些公开配置通过 `/runtime-config.js` 提供给浏览器，服务凭据和其他环境变量不会输出。

`.cfignore` 排除本地依赖、旧 profile、Cookie、历史记录、`.env`、密钥、日志、测试、个人文档、原始数据库及 SQLite sidecar，仅保留准备后的只读数据库。旧本地文件留在本机，不自动删除。

## 验证范围

`npm test` 包含只读写入拒绝、导入后基准库不变、端口验证、服务绑定解析、任务跨实例模拟、Cookie/历史存储和原有爬虫单元测试。`CF_SERVER_TEST=1 npm test` 额外启动真实 HTTP 服务验证健康接口与导入。`ZF_BROWSER_TEST=1 npm test` 启用浏览器页面 fixture 测试，可通过 `PUPPETEER_EXECUTABLE_PATH` 使用本机已安装的兼容浏览器。实际 BPC stack、Linux 系统库、目标网站可达性及服务计划需在第二阶段部署联调确认。

参考：[CF Node buildpack](https://docs.cloudfoundry.org/buildpacks/node/)、[CF 环境变量与服务绑定](https://docs.cloudfoundry.org/devguide/deploy-apps/environment-variable.html)、[Puppeteer 容器排错](https://pptr.dev/troubleshooting)、[Node SQLite API](https://nodejs.org/docs/latest-v22.x/api/sqlite.html)。

## 无头目录验收

```sh
npm run check:catalogues
# 也可以单独检查：
npm run check:catalogues -- mann bendix_au bendix_my zf_trw_cn
```

该命令强制无头模式，依次执行真实查询：MANN `111`、Bendix `DB1086`、ZF/TRW `GDB1330`。每项输出产品数量和成功状态，有失败时返回非零退出码；临时 profile 仍只写 `tmp/`。它不创建业务任务或写搜索历史，无需 Redis 即可检查目录。

在 CF 实例中也可运行相同命令，验证该实例实际安装的 Linux 浏览器、系统库及出口网络。工作区中的无头验证不能代替目标 CF 实例的网络验收。若出现 403/429，应按站点的允许访问方式处理，不无限重试或改为交互浏览器。

额外浏览器回归：`CATALOGUE_BROWSER_TEST=1 ZF_BROWSER_TEST=1 CF_SERVER_TEST=1 npm test`。包括无头进程参数、真实 HTTP User-Agent、导航后配置保持、ZF 延迟初始化与键盘提交。
