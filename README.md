# Toys

个人小工具与实验项目合集。每个项目放在独立目录中，具体安装、使用方式和限制见各自的 README。

## 项目

| 项目 | 说明 |
| --- | --- |
| [My Udemy Dual Subtitles](myudemydualsubtitles/README.md) | Chrome 双语字幕插件：下载当前 Udemy 课时字幕、导入 SRT/VTT，并可通过本地 Flask 后端调用 Codex CLI 翻译为简体中文。 |

## 开始使用

```sh
git clone https://github.com/lvsoso/toys.git
cd toys/myudemydualsubtitles
```

在 Chrome 的 `chrome://extensions/` 页面启用开发者模式，选择「加载已解压的扩展程序」，加载 `myudemydualsubtitles` 目录，然后刷新 Udemy 课程页。

手动下载、导入字幕无需启动后端。自动翻译需要 Python 3.11+、Flask 3.x 和已配置模型服务的 Codex CLI；启动步骤见[项目文档](myudemydualsubtitles/README.md#本地-codex-翻译)。字幕会发送至 Codex 配置的模型服务，并产生相应模型用量。

## 仓库约定

- 各项目在自己的目录中维护代码、测试、README 和项目规则，使用前先阅读对应的 `AGENTS.md`。
- 本地索引、系统杂项、虚拟环境、Python 缓存及字幕翻译数据不提交到仓库，由根目录和子项目的 `.gitignore` 管理。
- 各项目的验证命令和已知限制以其 README 为准；本地模拟测试不代表真实站点联调通过。
