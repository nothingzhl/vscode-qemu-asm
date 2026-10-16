# 真实 OS 工程接入验证（2026-10-16）

本文记录此次工作区改动的本地执行结果。插件基线提交为 `8499b21`；候选是从该提交开始开发的本轮改动，以包含本报告的提交为准，不是已发布版本。接入方式见[DreamOS 指南](OS_PROJECT.md)，配置契约见[配置参考](CONFIGURATION.md)。

## 对象、环境和适配

上游工程：[dreamos82/Dreamos](https://github.com/dreamos82/Dreamos/tree/85393cbcdeb9ca0bafb84e9631c2c7f21be76141)，固定提交 `85393cbcdeb9ca0bafb84e9631c2c7f21be76141`。它是已有的 32 位 C/汇编 OS，包含文件系统、线程、内存管理和 shell。此次导出真实源码构建，没有用另写的小内核替代。

宿主：Debian 13，Linux x64，QEMU TCG 软件模拟，无 KVM。工具：

| 工具 | 本次实际版本 |
| --- | --- |
| Node.js / npm | 24.19.0 / 11.9.0 |
| TypeScript | 5.9.3 |
| NASM | 2.16.03 |
| GCC | 14.2.0（Debian 14.2.0-19） |
| GNU ld / Make | 2.44 / 4.4.1 |
| QEMU | 10.0.13（Debian 1:10.0.13+ds-0+deb13u1） |
| GDB | 16.3（Debian 16.3-1） |
| genisoimage | 1.1.11 |
| VS Code | 1.96.4，提交 cd4ee3b1c348a13bafd8f9ad8060705f6d4b9cba |

工具解包在 `/workspace/osdev-tools`，使用显式包装入口设置动态库与 QEMU 固件位置，没有更改系统安装或插件用户的 PATH。开发宿主启动时使用显式工具入口；本地 Make 包装器只为其子进程提供这些工具的路径。早期探索还用过 `xorriso -as mkisofs` 包装器，最终记录的完整接入套件与安装包验收使用实际 genisoimage。

[附加 Make 配方](../examples/dreamos/qemu-toolkit.mk) 包含上游 Makefile，补充现代 GCC 兼容参数、保留帧指针、修正 ISO 脚本预期的产物复制位置，并缩短 GRUB 菜单等待。上游内核源码、链接布局和加载器保持原样。重启测试在独立临时副本中故意修改一个全局变量初值，验收后恢复源码并在外部重建，再检查已有产物模式。

## 功能和失败路径

| 验证层次 | 本次结果 |
| --- | --- |
| 原生基线 | Make 构建原工程；直接启动 QEMU/GDB，命中 `main_loop`，Multiboot `mem_upper=129920`，未经过插件调试后端 |
| 插件 ISO 调试 | 从 GRUB Legacy ISO 启动，DWARF 绑定原 `src/kernel.c`；源码断点、参数、已初始化局部变量、F10/F11/跳出和嵌套调用栈通过 |
| 机器状态 | 反汇编、GDT、分页关闭时的地址一致性；继续到内核初始化自身 GDT/IDT 并开启分页后，实际 PDE/PTE 转换与虚拟/物理代码字节一致 |
| 修改后重启 | 将原内核 `module_end` 初值改为 `0x12345678`，通过重启重新构建 ISO/ELF；入口读取到新值，确认没有运行旧产物 |
| 外部构建失败 | 已有有效 ISO/ELF 时让构建器退出 7：DAP 启动失败，不启动 QEMU/GDB，原产物字节保留 |
| 已有产物 | 独立构建后设置 `build: false`，只启动 QEMU/GDB，不执行构建器或 NASM |
| 无效产物 | 缺失 ISO 和无效 ISO 在 QEMU/GDB 分配前拒绝 |
| 生命周期 | 真实构建器、QEMU、GDB 在重启、失败和停止后退出；临时工程清理 |
| 路径 | 所有工程调试输入位于含空格、逗号的目录 |
| VS Code 开发宿主 | 1.96.4：同一实际工程的调试、局部变量、内存、分页、重启和已有产物通过 |
| 独立 VSIX | 安装到仓库外，再从独立安装目录加载扩展；以相同工程执行相同宿主断言，通过 |

独立 VSIX 测试把输入和测试脚本复制到仓库外，使用实际 VS Code DAP 接入，没有从源码目录导入生产模块。真实工程宿主测试关闭显示器以隔离调试流程；此次没有对 DreamOS 的显示器界面或完整 shell 功能作验收。

## 回归与静态检查

- `npm ci`、`npm run check`、`npm run compile`、`npm run docs:check` 通过。
- 单元/契约测试 365 项：360 通过、5 跳过、0 失败。覆盖率门槛通过：语句/行 83.38%，分支 86.28%，函数 87.05%。
- 原有 14 组真实工具集成全部通过，覆盖 NASM/RSP、C/GDB、保护模式、内存、分页、反汇编、监视点、QMP 显示和依赖检查。
- 原有 VS Code 1.96.4 宿主阶段 `trusted,untrusted,resources,debug,dependencies` 通过。
- `@vscode/vsce` 4.0.0 打包成功；actionlint 1.7.7 与 `git diff --check` 通过。

新增单元断言覆盖：ISO 参数与文件名转义、兼容旧软盘配置、2 MiB ISO 元数据样本、损坏/UEFI-only/越界引导目录、已有产物不执行工具或创建缺失目录、增量构建能读取原产物、失败/超时/取消时保留项目文件。元数据样本不是可启动客体，实际固件启动由上述 DreamOS 场景证明。

## 复现与证据

先按[指南](OS_PROJECT.md#准备固定版本)准备固定上游检出，然后在插件仓库运行：

```sh
npm ci
npm run check
npm run compile
DREAMOS_SOURCE=/path/to/pinned-Dreamos npm run test:os-project
DREAMOS_SOURCE=/path/to/pinned-Dreamos \
  VSCODE_EXECUTABLE_PATH=/path/to/code \
  xvfb-run -a npm run test:os-project:host
```

独立安装包使用：

```sh
DREAMOS_SOURCE=/path/to/pinned-Dreamos \
  VSCODE_EXECUTABLE_PATH=/path/to/code \
  xvfb-run -a node scripts/os-project-installed.cjs /path/to/candidate.vsix
```

本地原始日志和结构化结果位于 `artifacts/os-project/`：`real/results.json`、两份真实工程日志、`installed.log`、`regression/results.json` 和 `quality/`。这些是被 Git 忽略的本地运行产物；本文保存可审查的执行范围与复现入口，后续 CI 应以各次上传的 `os-project-dreamos` 产物为准。

主 CI 新增固定上游提交的独立任务，执行原生/插件基线、VS Code 开发宿主和独立安装 VSIX，并纳入最终门禁。此次已在本地执行这些入口；远端 GitHub Actions 的实际结果以 PR 检查为准，不能将工作流配置视为远端已通过。

## PR 同步最新 main 后的补验

创建 PR 前合入 `main` 的 `584d18e`，保留 0.9.0 的启动方案、原生 QEMU 路径和 NASM 适配。ISO 引导继续使用选择后的机器参数；新增 JSON Schema 同时接受 `boot` 和 `build: false`。补充了 ISO 与启动方案组合、Windows 相对路径生成的行为断言；路径模拟不代表 Windows 原生 ISO 已通过。

合并后的本地执行结果：

- 类型检查、编译、文档检查、actionlint 与差异空白检查通过。
- 412 项单元/契约测试：407 通过、5 跳过、0 失败；覆盖率为行/语句 84.16%、分支 86.76%、函数 86.47%。
- 15 组真实工具集成全部通过，包括最新 main 的启动方案集成。
- DreamOS 原生基线、插件调试、VS Code 1.96.4 开发宿主和独立安装 0.9.0 候选 VSIX 再次通过。
- 用 JSON Schema 校验器检查真实工程配置及 `build: false` 配置，均通过。

补验日志在 `artifacts/os-project/pr-regression/`、`pr-real/` 和 `pr-installed.log`；最终远端 CI 结果以 PR 检查为准。

## 边界

本次仅验证上述 Linux 工具组合和 VS Code 1.96.4。CI 使用 Node 22，本地运行是 Node 24；其他版本与 Windows/macOS 的 ISO 接入未在本轮执行。仍不支持 ELF64、PAE、SMP、UEFI-only ISO、远程 attach 和动态符号重定位。

`build: false` 是用户明确选择复用已有产物，不推断源码、镜像和符号的新鲜度。外部构建返回成功后允许合法的增量构建沿用原产物；失败或取消会阻止本次启动，但不会替用户删除或回滚工程文件。ISO 元数据检查不代替固件实际引导验证。
