# 本 fork 的补丁维护说明

分支模型：

- `dev`：上游 `coleam00/Archon` 的 `dev` 的镜像。跟踪 `upstream/dev`，只做快进，从不在其上提交。
- `hub`：本 fork 的补丁分支，基于最新的 `dev`，每个补丁是一个（或一组）提交。
- 远程：`upstream` = `https://github.com/coleam00/Archon.git`，`origin` = `git@github.com:ab300819/Archon.git`（fork）。

## 补丁清单

| 补丁 | 提交 | 内容 |
|---|---|---|
| rework：评审打回 | `A reviewer node can send work back…` | agent 节点的 `rework: { to, when, max }`：`when` 命中时只重跑 `to` 及其下游，评审输出以 `$REWORK_FEEDBACK` 注入 `to`；预算耗尽以 `max_reworks` 失败；计数与缓存失效可随 resume 恢复。入口 `packages/workflows/src/dag/rework.ts`，测试 `packages/workflows/src/dag/rework.test.ts`。 |
| rework：生成文件 | `Regenerate node execution reference and web API types for rework` | 由脚本生成，rebase 时不要手工合并，直接重新生成（见下）。 |
| 本说明 | `Add patch maintenance notes` 及后续修订 | 本文件。 |

已知限制：`--dry-run` 不模拟 rework；预算耗尽时评审节点会先后出现 completed 与 failed 两条记录。

## 同步上游

```sh
git fetch upstream
git switch dev && git merge --ff-only upstream/dev     # 不能快进就停下，查明原因
git push origin dev:dev                                # 镜像推到 fork；只会是快进，被拒就停下，绝不强推 dev
git switch hub && git rebase dev
```

本地 `dev` 一直跟踪 `upstream/dev`（拉取用），推送时显式写 `origin dev:dev`。

rebase 在生成文件上冲突时，不要手工解决：取任一侧后重新生成并继续。

```sh
bun install --frozen-lockfile
bun run generate:node-execution-reference
(cd packages/server && bun run generate:api-types)
git add packages/docs-web/src/content/docs/reference/node-execution.md packages/web/src/lib/api.generated.d.ts
git rebase --continue
```

若上游新增了结构化的注册表（例如失败类型、模板槽位、节点字段、用户可控变量），rework 补丁可能需要补一行登记；对应的一致性测试会指出位置。

## 同步后的检查

```sh
bun run type-check
bun run lint
bun run check:api-types
bun run check:node-execution-reference
(cd packages/workflows && bun run test)   # 必须跑完；运行器遇到首个失败文件即停止，修复后重跑
bun run check:ratchet
```

`check:ratchet` 以 `origin/dev`（即 fork 上的 `dev`）的合并基为比较点，所以要在推送 `dev` 镜像之后再跑；否则比较范围会混进上游提交。

## 检查通过后推送 hub

```sh
git push --force-with-lease origin hub
```

`hub` 在 rebase 后历史会变，必须强推；只用 `--force-with-lease`（远程若有本地没见过的提交会被拒），且只对 `hub`。`dev` 永远不强推。
