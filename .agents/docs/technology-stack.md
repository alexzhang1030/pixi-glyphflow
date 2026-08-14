# Technology stack

状态：2026-08-15 的未盖章项目记录。依赖版本由 [`package.json`](../../package.json) 与
[`bun.lock`](../../bun.lock) 固定。

## 当前选择

| 领域 | 选择 | 理由与边界 |
| --- | --- | --- |
| 包管理、脚本、测试、审计 | Bun 1.3.14 | 一个原生工具覆盖 install、text lockfile、script、test 与 audit；CI 使用 `bun ci` 复现锁文件。 |
| 类型检查 | TypeScript 7.0.2 | 原生 `tsc` 提供并行类型检查；项目启用 strict、isolated declarations 与完整的 unused/unchecked 诊断。 |
| Library build | tsdown 0.22.14 | Rolldown/Oxc 路径生成 ESM、`.d.ts` 与 source map；`pixi.js` 通过 `deps.neverBundle` 保持 peer 边界。 |
| Lint 与 format | Oxlint 1.78.0、Oxfmt 0.63.0 | Oxc 工具共享原生实现；warnings 进入失败门槛，formatter 同时处理 TS、JSON、Markdown 与 workflow YAML。 |
| Package shape | publint 0.3.23、Are the Types Wrong 0.18.5 | tarball metadata、exports、声明文件与 ESM consumer resolution 在发布前验证。 |
| Pixi compatibility | `pixi.js` 8.19.0 dev pin，`^8.19.0` peer | 开发与测试使用精确版本，消费者在当前 v8 minor line 内复用自己的 Pixi instance。 |
| 发布 | npm 12、GitHub OIDC Trusted Publishing | 首次人工发布建立包；后续 tag 通过短期 OIDC 身份与 provenance 发布。 |

## 关键兼容事实

- TypeScript 7.0 提供 CLI 与 language server；稳定 programmatic API 进入 7.1 路线。项目的 tsdown
  declaration 路径依赖 `isolatedDeclarations` 和 Oxc transform，因此保持在 CLI 边界内。参考
  [TypeScript 7.0 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)
  与 [tsdown declaration docs](https://tsdown.dev/options/dts)。
- tsdown 0.22 要求 Node.js `^22.18.0 || ^24.11.0 || >=26.0.0` 作为正式运行范围，并将 Bun
  runtime 标为 experimental。当前仓库在 Bun 1.3.14 与 Node 26.6.0 本地组合上验证 build。参考
  [tsdown getting started](https://tsdown.dev/guide/getting-started)。
- Bun 的 `bun.lock` 是提交到仓库的 text lockfile；CI 的 `bun ci` 强制 package 与 lock 对齐。参考
  [Bun install docs](https://bun.sh/docs/pm/cli/install)。
- Oxfmt 通过 `ignorePatterns` 保护 PCR 记录和 canonical `AGENTS.md`，project-owned source、public
  docs、JSON 与 workflows 进入统一 format gate。参考
  [Oxfmt ignore docs](https://oxc.rs/docs/guide/usage/formatter/ignore-files)。
- 包采用 ESM-only contract；`attw --profile esm-only` 将 ESM 与 bundler resolution 作为发布门槛。
- PixiJS 8.19 依赖 `@webgpu/types@0.1.71`，TypeScript 7 的 `lib.dom` 同时提供 WebGPU 声明。
  consumer type smoke 使用 `skipLibCheck` 收窄 dependency declaration overlap，项目源码、导出 API
  和生成声明继续接受 strict TypeScript 7 检查。复现入口：`bun run package:smoke`。

## 当前法律状态

`package.json` 使用 `UNLICENSED`。开源许可证需要一次明确的人类法律选择，并在选择落定后同步
package metadata 与许可证文件。
