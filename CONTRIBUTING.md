# 项目规范

禁止直接向远端 `main` 推送
从最新 main 开分支，
在分支上提交，
自测没问题后开 PR
用 GitHub 的 **Merge pull request**自行合并自己的提交

## 分支命名

`<提交人名字>/<类型>-<描述>`，全小写，短横线分隔。

```
name/fix-login-crash
name/feat-user-profile
```

## Commit Message

```
<类型>: <标题>

<正文>
```

- 标题 ≤ 30 中文汉字
- 标题与正文之间空一行
- 正文写**为什么**，不写改了什么；每行 ≤ 72 字符

破坏性变更在类型后加 `!`，如 `feat!: 上传接口改为必须登录`

## 不要提交

`data/` · `.workbuddy/` · `AGENTS.md` · 密钥 · `.env`

请自行判断写进 `.gitignore`

