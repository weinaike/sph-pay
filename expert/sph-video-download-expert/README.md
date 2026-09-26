# sph-video-download-expert · 视频号下载专家（小视）

WorkBuddy 专家包。角色「小视」：按内置技能 `sph-video-wechat-channels-downloader` 的文档完成微信视频号视频下载，交付本地无水印原画 MP4；支持达人检索与批量下载。

规范依据：<https://open.workbuddy.cn/docs/expert>（内置技能方式参照官方模板 design-experts.zip 的 `skills` 字段用法）

## 设计要点：技能内置 + 软链引用源码

技能**随专家包内置**：`plugin.json` 声明 `"skills": ["./skills/sph-video-wechat-channels-downloader"]`，用户召唤专家即用，**无需再去技能市场安装**。仓库内该目录是**相对软链**，指向唯一事实源：

```
skills/sph-video-wechat-channels-downloader -> ../../../skill/sph-video-wechat-channels-downloader
```

- 平时只维护 `skill/sph-video-wechat-channels-downloader/`（本仓库的 skill 源码），专家包不产生副本、不会漂移。
- **打包时才落成实体文件**：macOS `zip -r` 默认解引用软链，会把技能真实文件（SKILL.md、references/、scripts/）打进压缩包。

## 目录结构

```
sph-video-download-expert/            # 仓库内（skills/ 为软链）
├── .codebuddy-plugin/
│   └── plugin.json                   # 核心配置 + 市场展示字段 + skills 声明
├── avatars/
│   └── expert.png                    # 512×512 PNG，≤500KB
├── agents/
│   └── sph-video-downloader.md       # agent 定义：frontmatter + 系统提示词
├── skills/
│   └── sph-video-wechat-channels-downloader -> ../../../skill/sph-video-wechat-channels-downloader
└── README.md
```

## 打包发布

```bash
cd expert
rm -f sph-video-download-expert.zip
zip -r sph-video-download-expert.zip sph-video-download-expert -x "*.DS_Store"
# 验证：压缩包里必须是技能实体文件，不能是软链条目或空目录
unzip -l sph-video-download-expert.zip | grep -c 'sph-video-wechat-channels-downloader/SKILL.md'  # 应为 1
```

zip 顶层保留专家目录名（与本仓库 `skill/*.zip` 的打包约定一致）。在 WorkBuddy 开放平台提交 zip 前自查：

- [x] `author.email` = `yestek@agent.qq.com`（与技能内反馈邮箱一致）
- [ ] `displayDescription.zh` 字数在 40–50 之间
- [ ] `defaultInitPrompt` 与 `quickPrompts[0]` 完全一致
- [ ] `tags` / `quickPrompts` 各固定 3 条
- [ ] 头像 512×512、≤500KB、漫画/插画风
- [ ] `categoryId` = `06-ContentCreative`（内容创作：视频制作、多媒体）
- [ ] 压缩包内 `skills/sph-video-wechat-channels-downloader/` 为实体文件（SKILL.md / references / scripts 齐全）
- [ ] 技能源码更新后**重新打包**（软链只在打包瞬间快照，之后源码再变不追溯）

## 专家与技能的分工

- **专家（本包）**：需求识别 → 技能加载确认（预加载/读 SKILL.md）→ 按技能编排执行 → 异常对照 → 交付汇报。
- **技能（内置）**：全部精确命令与 API 契约（`https://sph.yes-tek.com`），源码在本仓库 `skill/sph-video-wechat-channels-downloader/`。

无 MCP / 连接器依赖，不需要 `dependencies` 字段。
