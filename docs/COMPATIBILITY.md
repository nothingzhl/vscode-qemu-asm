# 平台与工具版本兼容性

本页区分实际运行结果、持续集成配置与尚未验证的范围。版本号可识别并不代表调试能力可用；下面的通过结果都启动了真实 QEMU，并对 C 调试使用了同一会话的 GDB/MI 通道。

## 本次已验证的版本

执行日期：2026-10-15。宿主为 Linux x64；旧工具运行在隔离的 Ubuntu 容器中，使用软件模拟，不需要 KVM。

| 工具环境 | NASM | QEMU | GDB | GCC | 实际结果 |
| --- | --- | --- | --- | --- | --- |
| Ubuntu 20.04 | 2.14.02 | 4.2.1 | 9.2 | 9.4.0 | NASM 与 C 兼容场景通过；完整 C 集成通过 |
| Ubuntu 22.04 | 2.15.05 | 6.2.0 | 12.1 | 11.4.0 | NASM 与 C 兼容场景通过；完整 C 集成通过 |
| Ubuntu 24.04 | 2.16.01 | 8.2.2 | 15.1 | 13.3.0 | NASM 与 C 兼容场景通过；实际执行 CI 容器脚本 |
| 当前 Linux 工具链 | 2.16.03 | 10.0.13 | 16.3 | 14.2.0 | NASM 与 C 兼容场景通过 |

这些是已验组合，不是最低支持版本，也不代表任意交叉组合已通过。Ubuntu 的维护更新可能改变补丁版本；每次 CI 都把当次精确版本写入 `result.json`。

本次版本矩阵覆盖：

- NASM 构建与直接 RSP 调试：把插件 GDB 配置指向不存在的路径，确认断点、寄存器、段缓存和物理内存仍可用。
- C/ELF/DWARF4 调试：实际源码与指令断点、F10/F11/Shift-F11、嵌套调用栈、局部变量、结构体、数组、指针及只读表达式。
- 机器观察：非恒等分页、虚拟与物理内存一致性、反汇编、原生和自定义数据断点，以及 GDB 对同值写入、读与访问监视点的行为。
- 生命周期：运行时读取限制、信任撤销、动态断点、暂停、重启后旧句柄失效与重新构建。

Ubuntu 20.04 与 22.04 还执行了完整 `c-source-integration.cjs`：DWARF5、带空格路径的 `sourceMap`、无效或剥离 ELF 启动前拒绝，以及实际 QEMU/GDB 进程退出检查。

此矩阵没有执行模拟显示器、VS Code 界面或安装 VSIX 的完整验收；这些由[主 CI](../.github/workflows/ci.yml)的独立任务覆盖。矩阵通过不能替代原生平台和编辑器宿主验证。

## 已发现并修复的差异

**GDB 9.2 没有 debuginfod 设置。** 原先无条件执行 `-gdb-set debuginfod enabled off` 会让 C 启动报出误导性的 “No symbol table is loaded”。现在先探测实际设置；仅在 GDB 明确返回 `Undefined show command` 时跳过不存在的功能，并保留原因。支持该功能的版本仍在加载 ELF 前明确关闭它。自动加载、函数调用防护和其他初始化失败仍会终止启动。

**GCC 9 与较新 GCC 的源码停点不同。** 旧编译器可能先停在函数声明，再进入首条初始化语句。集成测试按源码中的返回语句标记验证局部值，保留有界 F10 和函数断言；不再假定所有编译器用完全相同的单步次数到达该位置。

## 怎样理解能力报告

报告中的 `unknown`、`supported` 和 `unsupported` 均保留原意：

| 实际阶段 | 结果 |
| --- | --- |
| 会话尚未启动 | 所有能力为 `unknown / not-checked` |
| NASM 已连接 | RSP 与段寄存器为 `supported / protocol`；GDB、物理内存、显示与解码仍为 `unknown` |
| 完成物理内存读取 | 当前会话的物理内存变为 `supported / protocol` |
| C 已连接 | GDB MI、目标与段寄存器为 `supported / protocol`；尚未读取的物理内存仍为 `unknown` |
| C 完成分页与反汇编 | 物理内存为 `supported / protocol`，解码为 `supported / integration`；未创建的显示资源仍为 `unknown` |

GDB 9.2 的 `gdb.mi` 仍是已通过的 MI 能力，详情单独记录 `debuginfod: unsupported` 与实际错误原因；不会把这一可选设置的缺失误判为整个 GDB 不可用。能力事实按会话保存，不在不同版本和目标间共享。

## CI 与本地复现

[Tool compatibility 工作流](../.github/workflows/compatibility.yml)在 push、PR、手动触发及每周定时执行 Ubuntu 20.04、22.04、24.04 三个发行版的默认工具组合。各组独立失败并保留结果，避免一个版本遮住其他版本的失败。

已有工具时直接执行：

```bash
npm ci
npm run compile
node scripts/compatibility/runner.cjs --label local --output artifacts/compatibility
```

可通过 `NASM_PATH`、`QEMU_PATH`、`GDB_PATH` 和 `CC` 选择工具；不会替换插件用户的 PATH 或安装工具。容器测试脚本只供开发与 CI 使用，Docker 不是用户安装 VSIX 的依赖。

CI 上传 `compatibility-ubuntu-<发行版>` 产物，其中包含：

- `run.log`：工具安装、真实客体输出与测试失败位置。
- `result.json`：精确版本、开始和结束时间、执行结果及每个阶段的完整能力报告。
- 工作流摘要：直接展示版本与能力状态。安装工具失败时明确说明没有进入测试阶段。

本次本地原始证据保存在 `/tmp/qemu-compat-results/` 与 `/tmp/qemu-compat-*.log`；这些临时路径不是仓库永久发布产物，后续运行应以各次 CI 上传的文件为准。

## 尚未确认的范围

- Windows x64、macOS arm64、WSL 和 Dev Container 各自需要对应宿主的实际验证；Linux 版本矩阵不能替它们宣布兼容。
- 未测试 GDB 4.x、5.x 或本表以外的 QEMU 系列。旧工具能否满足当前 MI2、ELF/DWARF 和机器观察契约需要单独验证。
- 当前面向 i386 单 CPU 客体；不由工具版本测试推导 x86-64、SMP、其他架构或远程显示支持。
- 本次没有确定最低支持版本。增加旧版本时先获得可运行工具链、运行协议与完整场景，再按复现差异适配。
