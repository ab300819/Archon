# 本 fork 的维护说明（opt/rework 分支）

原则：Archon 零修改。agent-hub 独有的东西放在 agent-hub，通过 Archon 现有接口（工作流、provider 插件、workflow pack）接入。本 fork 默认不带任何补丁。

分支：

- `dev`：上游 `coleam00/Archon` 的 `dev` 的镜像。跟踪 `upstream/dev`，只做快进，从不在其上提交，从不强推。
- `opt/rework`：可选增强（本分支），默认不启用。
- 远程：`upstream` = `https://github.com/coleam00/Archon.git`，`origin` = `git@github.com:ab300819/Archon.git`（fork）。

## 同步 dev 镜像

```sh
git fetch upstream
git switch dev && git merge --ff-only upstream/dev     # 不能快进就停下，查明原因
git push origin dev:dev                                # 只会是快进；被拒就停下，绝不强推 dev
```

本地 `dev` 一直跟踪 `upstream/dev`（拉取用），推送时显式写 `origin dev:dev`。

## opt/rework：评审打回（可选）

内容：agent 节点的 `rework: { to, when, max }`。`when` 命中时只重跑 `to` 及其下游，评审输出以 `$REWORK_FEEDBACK` 注入 `to`；预算耗尽以 `max_reworks` 失败；计数与缓存失效可随 resume 恢复。入口 `packages/workflows/src/dag/rework.ts`，测试 `packages/workflows/src/dag/rework.test.ts`。提交：功能与测试一个，生成文件（`node-execution.md`、`api.generated.d.ts`）一个，其余是本说明。

已知限制：`--dry-run` 不模拟 rework；预算耗尽时评审节点会先后出现 completed 与 failed 两条记录。

### 何时启用

原版 `loop_group` 已能表达常见的打回：body 内 implement → gate → review，`until_bash` 读评审结论（如 `v=$review.output.verdict; test "$v" = accept`），implement 用 `$LOOP_PREV.review.output`、`$LOOP_PREV.gate.output` 回灌，`max_iterations` 作上限。只有以下形状才需要本分支：

- 返工区包含 `workflow:` / `fan_out` 子运行（loop_group body 不允许）；
- 返工区中间有人工 gate / wait（loop_group 里它们只能是 body 唯一的终点）；
- 多个评审各自退回不同的上游节点。

### 如何启用

本分支不随上游自动同步。启用时先基于最新 `dev` 重新摞，再重新生成生成文件、跑检查：

```sh
# 先完成上面的"同步 dev 镜像"
git switch opt/rework && git rebase dev
```

rebase 在生成文件上冲突时不要手工解决：取任一侧后重新生成并继续。即使没有冲突，也在 rebase 后重新生成一次并核对。

```sh
bun install --frozen-lockfile
bun run generate:node-execution-reference
(cd packages/server && bun run generate:api-types)
git add packages/docs-web/src/content/docs/reference/node-execution.md packages/web/src/lib/api.generated.d.ts
git rebase --continue        # rebase 结束后若生成文件仍有变化，提交到生成文件那个提交（git commit --fixup + git rebase --autosquash dev）
```

若上游新增了结构化的注册表（失败类型、模板槽位、节点字段、用户可控变量等），本补丁可能需要补一行登记；对应的一致性测试会指出位置。

检查（全部通过才算启用成功）：

```sh
bun run type-check
bun run lint
bun run check:api-types
bun run check:node-execution-reference
(cd packages/workflows && bun run test)   # 必须跑完；运行器遇到首个失败文件即停止，修复后重跑
bun run check:ratchet                     # 以 origin/dev 的合并基为比较点，先推送 dev 镜像
```

rebase 改写了本分支历史，推送时只用 `git push --force-with-lease origin opt/rework`，且只对本分支。
