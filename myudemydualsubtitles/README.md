# My Udemy Dual Subtitles

独立 Chrome 插件：下载当前 Udemy 课时原字幕，手动翻译后导入，或交给本地 Codex 后端翻译为简体中文。双语字幕显示在视频上的统一背景浮层中，并支持本地复用。
不修改参考插件，不下载视频，不做语音识别或整门课程批量翻译。

## 0.4.2 更新后

到 `chrome://extensions/` 重新加载本插件，再刷新已打开的 Udemy 页面，启用新的字幕样式文件。此次字号/位置功能不需要重启后端、不增加权限，也不需要重新翻译。

## 调整字幕大小和位置

弹窗顶部的「字幕显示」提供：

- **字号**：18–48px，默认 24px，拖动滑块立即生效。
- **上下位置**：10–100%，数值越小越靠上，默认 85%。使用视频区域的相对位置；100% 时浮层底部贴近视频底边（播放器控制栏出现时可能遮挡字幕，可适当调高）；长句自动换行。
- **恢复默认**：恢复 24px / 85%，不清除字幕或翻译缓存。

设置保存在 `chrome.storage.local.subtitle_style`，所有课时共用，并同步到其他已打开的 Udemy 标签页。字号是像素值，全屏时也使用所选字号；位置随视频区域变化。手动导入和 Codex 双语字幕都使用同一设置，官方字幕不受本插件样式影响。

## 从旧版启用本地后端

到 `chrome://extensions/` 重新加载本插件，再刷新 Udemy 页面。本版新增仅访问 `127.0.0.1` 的权限，用于本地后端；后台脚本固定连接 `127.0.0.1:8765`，不代理任意地址。

## 本地 Codex 翻译

需要 Python 3.11+、Flask 3.x 和可调用模型服务的 Codex CLI（本机验证版本 0.171.0）。

1. 到 `chrome://extensions/` 复制本插件的 **ID**（32 位字母）；也可在插件弹窗展开「本地后端启动方式」，复制已填好 ID 的命令。
2. 在项目根目录启动后端。本机 `/opt/anaconda3/bin/python` 已有 Flask，可直接使用：

   ```sh
   cd ~/lvsoso/toys/myudemydualsubtitles
   /opt/anaconda3/bin/python -m backend.app --extension-id 这里替换为插件ID
   ```

   其他 Python 环境若没有 Flask，使用项目虚拟环境，不安装全局依赖：

   ```sh
   python3 -m venv .venv
   .venv/bin/python -m pip install -r backend/requirements.txt
   .venv/bin/python -m backend.app --extension-id 这里替换为插件ID
   ```

3. 在课程页打开插件，选择原字幕语言，点击「翻译为中文并显示双语字幕」。这一步会把原字幕提交给本地后端，再由 Codex 发送至它配置的模型服务，产生相应模型用量。
4. 弹窗显示排队/翻译中/失败/完成及已完成条数。关闭弹窗甚至关闭课程标签页后，后端仍继续执行；后端进程必须保持运行。重新进入同一课时即可恢复查询。
5. 每批成功后，课程页会先显示该批的原文和译文。全部完成后存入本课浏览器缓存，下次打开无需启动后端即可显示。
6. 失败时点击「重试未完成部分」，已成功批次不重翻。超时、断网或后端重启都不会自动重新发起模型请求；未保存结果的失败批次重试可能再次产生用量。

后端使用 `gpt-6-luna` 和 `low` 推理强度。只读现有 `CODEX_HOME/config.toml` 中的 provider 路由，复用原认证；不更改全局配置。使用 `--ignore-user-config`、独立临时工作目录、只读沙箱，并关闭 shell、MCP（不加载用户配置）、插件等能力。不会继承日常编码会话或 hooks。

模型只返回每条字幕的 ID 和译文，后端校验 ID 完整、唯一及译文非空；时间轴保持原值。按约 2,000 字符分批（尽量在句末标点处切批，找不到则硬切；原始空白字幕不发送、不显示），附带前两条原文作为上下文；每批超时 180 秒，只有一个模型请求同时运行。后端日志不记录字幕正文，唯一例外是模型返回空译文时，记录该 ID 前后各 2 条原文用于定位。

当前仅适用于本机个人使用、macOS/Linux、一个后端进程；不使用数据库、Redis 或 Celery。后端目录用进程锁防止重复启动，服务只监听 `127.0.0.1:8765`，校验 Host、扩展 ID 与 Origin。扩展 ID 不是秘密令牌，此设计不隔离同一机器上的其他本地程序。

## 翻译任务与缓存

- 原文、时间轴、源/目标语言、模型服务配置、模型、推理强度和提示词版本共同生成任务内容哈希；重复提交同一任务直接返回现有状态或结果。
- `backend/data/<任务ID>.json` 持久保存原字幕、译文、状态和已成功批次。缓存文件包含课程内容，仅存在本机，已加入 `.gitignore`。不自动淘汰或删除文件。
- 状态只有 `queued`、`running`、`completed`、`failed`。服务重启将中断任务标为 `failed`，等待手动续办。HTTP 202 仅表示受理。
- 插件用 `translation:<原课时缓存键>` 保存任务关联；完整译文继续使用原有本课字幕缓存。手动导入会解除本课的自动加载关联，避免迟到结果覆盖手动字幕，但不会取消后端已受理的任务。
- 相同字幕在不同课时可以共享后端译文，但各课时的浏览器显示关联独立。清空浏览器数据后重新提交原字幕仍可命中后端缓存。
- 没有官方字幕时仍能手动导入；首版自动翻译按钮只处理当前选择的官方字幕。

接口（由扩展后台访问；均需 `X-MyUdemy-Extension: <插件ID>`）：

| 接口 | 含义 |
| --- | --- |
| `POST /translations` | 提交 `{source_language, cues: [{start, end, text}]}`；新任务返回 202，已完成缓存返回 200 |
| `GET /translations/<id>` | 获取 `state / done / total / error / cues`，`cues` 仅包含已完成的双语字幕 |
| `POST /translations/<id>/retry` | 仅失败任务重新入队；请求体为 `{}` |

只有用户主动提交或重试才发起翻译。没有 SSE、自动付费重试或并行翻译；接口本身快速返回，耗时模型调用在单个后台线程中执行。

## 翻译日志排查

日志带时间、级别和任务 ID 前 12 位。同一任务从 `task_created`、`batch_started`、`codex_started`、`codex_finished` 到 `batch_saved` / `translation_completed` 可连续关联。`cache_hit` 表示完整缓存命中，`task_reused` 表示返回已有任务状态，`task_retry` 表示人工续办。

`batch_started` 记录本批 ID 范围、预期条数、文本字符数、上下文条数和模型；`codex_finished` 记录退出码和单次 CLI 耗时。`batch_saved` 代表本批结果已通过校验并保存，不只是模型调用结束。

条数或 ID 不匹配时，`translation_result_invalid` 会显示 `expected`、`actual`、返回容器类型、缺失条数，以及最多 10 个缺失/重复/越界数字 ID。`translation_failed` 汇总任务完成度和经过处理的错误原因。日志不输出原文、译文、完整模型响应、请求地址或认证信息。

输出 Schema 限定本批数组长度和合法字幕 ID，后端仍校验完整性、唯一性和非空译文。即使模型服务未正确执行 Schema，也不会把漏条译文作为成功缓存。接口/Schema 加固不会清空已有缓存。

## 安装和使用

1. Chrome 打开 `chrome://extensions/`，启用开发者模式。
2. 点击「加载已解压的扩展程序」，选择本项目目录。
3. **刷新已经打开的 Udemy 课程页面**，进入正式视频课时。首次安装必须刷新，才能捕获页面 GraphQL 数据。
4. 打开插件，选择原字幕语言，点击「下载 SRT」。操作过程中保持弹窗打开。
5. 自行翻译下载文件：只修改字幕文本，保留序号、起止时间和条目间空行。可把原文、译文放在同一条字幕的不同文本行。
6. 在同一课时的插件弹窗选择翻译好的 `.srt` / `.vtt`（UTF-8，最多 2 MiB），立即保存并显示。
7. 下次打开此课时自动加载。重新导入会替换本课缓存；「显示本地字幕」开关仅影响显示，不删除缓存。

字幕背景随文字宽度收缩并居中，最大占视频宽度的 92%，长句自动折行。显示时合并同一条字幕内连续的英文行（空格连接）和中文行（直接连接），保留中英文之间的换行；中英混排或无法识别语言的行保持分行。只调整显示，不改已缓存的字幕、原始时间轴，也不重新翻译。隐藏的原生 TextTrack 负责时间同步，支持暂停、拖动和倍速。播放器容器全屏使用相同浮层；若仅 video 元素全屏或进入画中画，使用原生字幕（背景仍由浏览器按行绘制）。原字幕若重叠，可在 Udemy 播放器关闭官方字幕。
纯译文和双语都按导入文件内容显示；不自动判断语言、不自动对齐错误时间轴。

## 获取方式与边界

- 参考旧插件的获取思路，独立实现：旧页面从 `div.ud-main-content div.ud-app-loader` 的 `data-module-args.courseId` 获取课程 ID，再请求 `/api-2.0/users/me/subscribed-courses/{course_id}/lectures/{lecture_id}/?fields[asset]=captions`。
- 新页面在 MAIN world 观察同站点 GraphQL fetch 的副本，从 `data.lectures` / `data.lecture` 的 `asset.captions` 读取语言及 URL，不修改 Udemy 响应。
- 字幕 URL 只接受 HTTPS 的 `udemy.com` / `udemycdn.com` 及其子域。下载由页面上下文权限范围内的 fetch 完成，受 CORS 约束；不绕过认证或跨域规则。遇到新 CDN 域名需经确认扩展支持。
- 支持 `*.udemy.com` 下正式课时，包括相同路径形式的 Udemy Business；不支持预览页或整门课程批量下载。真实站点布局/接口兼容性需要实测。
- 无字幕、权限不足、未捕获到新页面数据或下载失败时明确提示；仍可以导入自己准备的字幕。
- 不依赖原插件的 API、license、计费逻辑、框架或压缩代码。

## 本地存储和权限

- 请求 `storage` 和 `http://127.0.0.1/*` 权限；content scripts 仅运行在 HTTPS Udemy 页面，localhost 访问由扩展 service worker 执行。
- `chrome.storage.local` 键为 `subtitle:{hostname}:{course_path_slug}:{lecture_id}`，值为 `{name, text}`。`text` 是导入的完整原文件，时间轴不改写。
- 同课时不随 URL 查询参数/播放位置改变；不同租户域名、课程、课时相互隔离。课程路径改名后需要重新导入。
- 使用 Chrome 默认本地存储额度（通常 10 MiB），不申请无限存储。不自动淘汰字幕；额度不足时导入失败并保留旧字幕，原始文件请自行保管。
- 同一浏览器扩展存储不按 Udemy 登录账号隔离；共用浏览器配置的用户也共用本地字幕。卸载扩展会清除扩展存储。
- 显示开关是当前页面会话状态，刷新后默认显示已保存字幕。多个已打开的同课时标签页不会实时同步替换结果，刷新后读取最新缓存。
- 页面 bridge 仅返回字幕元数据，不接收文件，不写存储，不代理任意网络请求；不记录字幕正文、签名 URL 或登录凭据。

## 文件结构与验证

- `manifest.json`：MV3 注册与权限。
- `subtitles.js`：SRT/VTT 解析、SRT 导出、课时键。
- `bridge.js`：新页面 GraphQL 元数据观察。
- `content.js`：旧页面 REST、下载、缓存、字幕浮层及隐藏的时间同步轨道。
- `content.css`：只匹配本插件 cue 类的字号和行高样式。
- `popup.html` / `popup.css` / `popup.js`：下载与导入界面。
- `background.js`：固定本地后端接口代理。
- `backend/app.py`：Flask API、来源校验和单进程启动。
- `backend/jobs.py`：串行任务、内容缓存、原子批次检查点和手动续办。
- `backend/codex_translate.py`：独立 Codex 调用、超时终止和模型结果校验。
- `backend/requirements.txt`：后端 Python 依赖。
- `tests/test_backend.py`：后端状态、缓存、来源限制和失败恢复测试。
- `tests/*.test.cjs`：Node 内置测试，无第三方依赖。
- `tests/browser.html` / `tests/browser.js`：真实浏览器字幕浮层与原生时间同步冒烟测试，以本地生成的媒体和模拟存储运行真实 content 脚本，不访问 Udemy。

插件无需构建或前端依赖。Node.js 20+，后端测试需已安装 Flask 的 Python 3.11+：

```sh
node --test tests/*.test.cjs
node --check subtitles.js
node --check bridge.js
node --check content.js
node --check popup.js
node --check background.js
python -m unittest discover -s tests -p 'test_*.py' -v
```

自动验证覆盖解析、毫秒格式、长时间轴、缓存隔离、导入失败保留旧数据、刷新恢复、课时切换及 GraphQL 请求体处理。
用 Chrome 打开 `tests/browser.html`，页面应显示 `PASS`，验证真实字幕轨道的暂停、前后拖动、倍速设置、字幕间隙和课时缓存恢复。

真实 Udemy 验收：

1. 已登录课程分别在旧/新版页面列出语言，下载 SRT，核对首尾字幕和时间轴。
2. 导入包含纯译文/双语的文件，确认显示；暂停、向前/向后拖动、2 倍速、全屏均与视频一致。
3. 刷新当前课时恢复字幕，切到其他课时不串字幕，再切回恢复。
4. 无原字幕课时仍能导入；错误文件不覆盖已有字幕；下载/导入过程中切换课时应报错，不显示到新课时。
5. 关闭再打开弹窗、切换显示开关，确认没有重复轨道或重复字幕。
6. 拖动字号/位置滑块，在普通播放与全屏中检查文字完整、位置可调；刷新及切换课时保持设置；恢复默认不删除字幕。

本地模拟测试通过不等于实际 Udemy 接口和播放器兼容性验证通过。

本次开发验证：真实 `gpt-6-luna` / `low` 成功翻译两条通用英文字幕，端到端约 15.35 秒（包含 CLI 启动和模型请求）；此数据不能外推整课耗时。实际 Udemy 课时的「获取 → 后端翻译 → 页面显示」完整联调仍需在已登录浏览器中验收。
