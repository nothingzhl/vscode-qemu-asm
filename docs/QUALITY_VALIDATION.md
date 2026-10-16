# 质量、兼容性与性能验收

执行日期：2026-10-15；分支：`refactor/capability-architecture`。本轮基于 `acb05af`，生产修复提交为 `9aa2bcf`，CI 与指南提交为 `d926281`。没有发布 Marketplace。

## 完成的工作

- 删除不可达的进程终止分支、重复的栈边界算法与内存校验、无消费者的内部导出及失效测试注入。`debug/` 与 `core.ts` 仍供独立集成使用，保留兼容入口。
- 修复运行/调试停止期间晚到资源的清理、并发释放、工厂重入与清理错误传播。两条 DAP 路径清理失败仍发送一次 `terminated`，自然退出没有未处理拒绝；构建器也会被释放。
- C 变量与调用栈使用代际校验、并发查询去重和有界分页缓存，释放过期根变量对象。增加取消、失败、并发、容量与旧句柄回归。
- 静止画面复用一个 PNG 与摘要，跳过重复 Webview 传输；显式刷新及重新打开仍重发。观察器历史淘汰复用迭代器，仍限制为 4,096 字节。
- README 收敛为安装、第一次成功调试与文档入口。配置、调试、排错、开发、兼容、性能各有指南，历史报告保留并明确标记。参考项目见[文档导航](README.md#这次文档整理参考了什么)。

## 本次实际执行

Linux x64，Node 22.23.3；NASM 2.16.03、QEMU 10.0.13、GDB 16.3、GCC 14.2.0、binutils 2.44。QEMU/GDB 通过含空格的可执行入口运行，客体使用软件模拟。

| 检查 | 结果 |
| --- | --- |
| `npm ci`、类型检查与干净编译 | 通过 |
| 单元、契约与架构测试 | 359 项，358 通过，1 项文件系统条件跳过，0 失败；比原基线增加 67 项 |
| 无 NASM/QEMU/GDB 的单元运行 | 354 通过、5 条件跳过、0 失败；包含 4 项可选 NASM 案例 |
| V8 源码覆盖率 | 行/语句 82.45%，分支 86.20%，函数 91.94%；80/80/80/85 门槛通过 |
| 真实后端集成 | 14/14 脚本通过 |
| VS Code 1.96.4 | 11/11 完整宿主阶段通过 |
| VS Code 1.142.0 | 11/11 完整宿主阶段通过 |
| 独立安装 VSIX，两版 VS Code | 每版 machine、paging、c-source、dependencies 各 4/4 通过 |
| 性能与资源保留 | 模块、100 次生命周期、真实 QEMU 显示三入口 `--enforce` 通过 |
| 工作流静态检查 | 三工作流通过 actionlint 1.7.7 与 ShellCheck 0.10.0 |
| 文档与失败传播 | 链接/锚点、7 份指南的 6 个 JSON 示例及命令/设置检查通过；CI 参数、失败日志和结果门禁回归通过 |

覆盖率包含未加载的普通生产文件；纯类型声明、模板数据与兼容导出排除，详见 [.c8rc.json](../.c8rc.json)。Node 单元覆盖率不等于 VS Code 宿主或客体覆盖率，宿主和真实后端独立验收。

## 版本兼容性

四组实际通过：QEMU/GDB **4.2.1/9.2、6.2.0/12.1、8.2.2/15.1、10.0.13/16.3**。前三组运行于 Ubuntu 20.04/22.04/24.04 隔离容器；不是用户安装依赖。

矩阵实际运行 NASM 无 GDB、C 源码断点与步进、变量/调用栈、机器断点、分页与生命周期场景。旧版还发现并修复了 GDB 9.2 缺少 debuginfod 设置的启动问题。完整工具版本、额外 DWARF5 验证与未覆盖范围见[兼容性](COMPATIBILITY.md)。未宣称 GDB 4.x/5.x 或任何最低版本已兼容。

## 性能结果和代价

相同环境五轮交替测量的中位数：静止截图 CPU 268 → 90 ms/100 次，真实 QEMU 静止截图 291 → 114 ms/75 次，观察器 2,899 → 495 ms/5,000 次。持续变化截图 294 → 337 ms/100 次，约增加 15%，来自摘要成本。

本轮减少重复工作、限制缓存和验证释放后的保留内存；未证明整个插件 RSS 下降。模块进程峰值 RSS 中位数 143 → 150 MiB，真实显示进程 91.45 → 87.75 MiB。原始五轮样本、测量边界与宽松 CI 门槛见[性能说明](PERFORMANCE.md)及[原始样本](performance-baseline.json)。

## Actions 与复现

[主 CI](../.github/workflows/ci.yml)分为质量、真实后端、宿主、打包、独立安装与最终门禁；macOS/Windows 配置原生 NASM/RSP 与宿主冒烟。安装包包含 iced-x86 JS/WASM，README 链接固定到打包提交。每组记录退出码、日志和 JSON；门禁拒绝 failure、cancelled 和 skipped。

[工具兼容](../.github/workflows/compatibility.yml)独立运行三个 Ubuntu 工具矩阵；[性能](../.github/workflows/performance.yml)独立运行预算检查。三工作流分别显示状态和上传产物，主 CI 门禁没有跨工作流聚合。它们没有用 `continue-on-error` 隐藏失败。

当前环境访问 GitHub Actions API 被网络策略拒绝，因此无法读取历史失败日志或确认推送后的远端运行结果。旧工作流的任务耦合、重复编译和缺少安装包验证属于本次修复的结构问题，不能据此认定是历史每次失败的根因。Windows/macOS 原生执行与 GitHub 托管 runner 的结果仍需对应远端运行确认。

```bash
npm ci
npm run check
npm run test:coverage
npm run docs:check
npm run test:ci
npm run test:compatibility
npm run test:performance
npm run test:performance:resources
npm run test:performance:display
```

宿主与独立安装命令见[开发指南](DEVELOPMENT.md)。本次本地日志在 `/tmp/qemu-quality-final-*`，旧版工具结果在 `/tmp/qemu-compat-results/`，性能 JSON 在 `artifacts/performance/`；临时日志不作为永久下载链接，后续以各次 CI 产物为准。

## 本地安装包

`vscode-qemu-asm-quality.vsix`：710,488 字节、148 个归档项；只包含 iced-x86 生产依赖，没有源码、测试、覆盖率报告或源码映射。包内版本仍为 0.8.0，本次为分支质量验收包。

SHA-256：`49210826d80646b0ae82095450705b96fd8d117ae27c1936287918f7e35825e3`。包内 README 链接固定到 `d92628173c67a96d1c6c60b4fb1b90ada696202f`。
