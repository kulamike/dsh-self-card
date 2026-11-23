# 发布清单

这台机器上**没有 git、没有 gh、也没有任何 GitHub 凭据**，所以推不出去。包已经按"推上去就能用"的形态整理好了，差最后一步。

## 一、目录

`C:\Users\Administrator\.dsh\plugins-src\dsh-self-card\`

```
package.json        # name: dsh-self-card，dsh.bundle.patch 指向 cordis.patch.yml
cordis.patch.yml    # 装载模板（cardPath 是占位符，装的人自己改）
index.js            # Host 插件本体，6 个 card__* 工具
README.md           # 边界说明 + 配置表 + 工具表
LICENSE             # MIT
.gitignore
```

已自查：**没有任何私有路径、真人名、token**。

## 二、推送（二选一）

### A. 有 git 之后（推荐）

```powershell
cd C:\Users\Administrator\.dsh\plugins-src\dsh-self-card
git init
git add -A
git commit -m "dsh-self-card 0.1.0：让角色自己受约束地改她的角色卡"
git branch -M main
git remote add origin https://github.com/<你的账号>/dsh-self-card.git
git push -u origin main
```

先在 GitHub 建一个空仓库（不要初始化 README），名字建议 `dsh-self-card`。

### B. 不装 git：网页上传

GitHub 新建仓库 → "uploading an existing file" → 把上面 6 个文件拖进去 → Commit。

## 三、发布之后别忘

1. **打 tag**：`git tag v0.1.0 && git push --tags`，别人才能用 `dsh-self-card@0.1.0` 装。
2. **改 README 顶部**加仓库地址和一句安装命令。
3. **如果要进插件市场**：本地 profile 里 `plugin_market` 列出的是市场索引；进索引需要把仓库加进对应索引的 `plugins` 清单（那是索引维护方的活）。
4. **推广渠道**（按你之前的边界，我不擅自发）：可发的是 B站动态（她那个号 `mcp__self__bili_post_dynamic`）或群里提一句；但发之前要想清楚会不会暴露自己的部署细节——README 里只有通用配置示例，安全。

## 四、装回来（别人用）

```bash
# 在 DSH 里
plugin_manager install_bundle <绝对路径或包名>
# 或：Plugins 页面 → Add plugin → 选目录
```

⚠ 注意：**本机这台**的 `install_bundle` 目前会因为 `dsh-bili-whale` 的 tarball 完整性错误在 `pnpm install` 阶段超时（跟本包无关）。要么先修那个依赖，要么继续用 junction（`profiles\desktop\node_modules\dsh-self-card` → 本目录）。
