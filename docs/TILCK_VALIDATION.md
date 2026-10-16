# 第二个真实工程：Tilck 接入与验证

本阶段验证 [Tilck](https://github.com/vvaltchev/tilck) 的固定提交 `01dacaa51a074474a4e5491fc80addfe98956500`。它是使用 C/C++/GAS、CMake 和 musl 交叉工具链的实际内核，提供进程、调度、文件系统与部分 Linux 系统调用。上游采用 BSD-2-Clause；本仓库只保存验证脚本，不复制内核。

## 范围与选型

Tilck 的 i386 目标适合当前产品边界。它在汇编入口开启非 PAE 分页，再进入高虚拟地址的 `kmain`，可验证 DreamOS 以外的构建链和地址布局。依据为上游 `README.md`、`docs/building.md`、`docs/debugging.md`、`CMakeLists.txt`、`kernel/arch/i386/start.S` 和链接脚本。

另外检查了 `pdoane/osdev` 和 `levex/osdev`：前者使用 ELF64，超出当前支持范围；后者把旧 i586 工具名写入多个 Makefile，主要运行路径还依赖软盘/硬盘镜像，本阶段未选。

本脚本直接使用 QEMU 的 Multiboot 加载器与 GNU GDB，不调用插件。它提供后续接入前的独立基线，不能代替 ISO、插件适配器、VS Code 宿主或独立安装 VSIX 验收。

## 工具环境

首次尝试使用上游 CI 镜像 `ghcr.io/vvaltchev/tilck-i386:v10`，固定 amd64 manifest 为 `sha256:0ad99e8294b36de7b1d04cc898619540b5aa21acb763fad95c846c0cabe2a4fd`。压缩层约 1772 MiB，但本环境 Docker 使用 vfs，创建容器时达到 32 GB 磁盘上限。该次只完成配置与 BIOS 引导器编译，随后停止并清理本次容器和镜像。

第二次改用基础 Ubuntu 24.04 和上游默认工具包，将 `/tc` 绑定到工作区目录以复用下载及安装结果。未构建可选桌面应用、额外编译器版本或上游完整 CI 工具集。容器系统依赖如下：

```sh
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates ruby ruby-dev ruby-minitest build-essential cmake git \
  wget curl xz-utils bzip2 file patch python3 bison flex pkg-config \
  mtools dosfstools gdisk libncurses-dev zlib1g-dev rsync bc
```

这些是开发者主动准备的构建依赖，不是插件用户的安装要求。容器中的网络客户端须使用当前环境的代理与可信 CA；插件不会下载或安装这些工具。

## 构建与执行

先主动克隆并固定上游提交；Tilck 自身要求源码路径不含空格。构建容器内将源码挂载到 `/work`，持久工具目录挂载到 `/tc`，设置 `TCROOT=/tc`、`GCC_TC_VER=13.3.0`、`RUNNING_IN_CI=1`、`GITHUB_ACTIONS=1`。最后一个变量沿用上游 `build_fatpart` 的 CI 复制策略：默认硬链接无法跨两个 bind mount，复制策略避免 `Invalid cross-device link`，不修改上游脚本。在源码目录执行：

```sh
./scripts/build_toolchain -n
./scripts/cmake_run -DCMAKE_BUILD_TYPE=Debug \
  -DBOOTLOADER_EFI=0 -DBOOT_INTERACTIVE=0 -DMOD_acpi=0
cmake --build build --parallel 2
```

`-n` 跳过系统包安装，使用已显式准备的依赖；其余安装和编译遵循上游包管理器。Debug 构建保留上游链接布局和内核源码，不改成平坦低地址客体。

构建生成 `build/tilck`、`build/tilck_unstripped`、`build/fatpart` 后，在本插件仓库运行：

```sh
TILCK_SOURCE=/path/to/tilck \
QEMU_PATH=/path/to/qemu-system-i386 GDB_PATH=/path/to/gdb \
npm run test:tilck:baseline
```

脚本检查固定 HEAD 和 ELF32/i386，使用 TCG、128 MiB RAM、单 CPU，在回环动态端口连接 GDB；断言实际 Multiboot magic、高虚拟地址 PC、CR0 分页位及源码步进。它显式映射构建时 `/work` 的 DWARF 路径到本地源码，不修改加载或链接地址，不启用上游 GDB 自动加载脚本。成功或失败均结束自身启动的 QEMU。

## 本次执行结果

2026-10-16，Linux x64：精简环境完整构建通过，包括 `tilck_image`；交叉 GCC 13.3.0 / musl 1.2.5，CMake 3.28.3。调试使用 QEMU 10.0.13、GDB 16.3，无 KVM。

`npm run test:tilck:baseline` 通过：Multiboot magic 为 `0x2badb002`，C 入口 PC 为 `0xc0123408`，QEMU 报告 `CR0=80010011`。源码步入 `call_kernel_global_ctors`，调用栈包含 `kmain` 与 `_start`，随后步出返回 C 初始化流程。上游 Git 工作树没有源码修改。精简环境与构建产物准备完成后，本环境总磁盘使用约 1.7 GB。

本次原始日志为 `/tmp/tilck-slim-build.log`（含首次打包的跨挂载点硬链接失败）、`/tmp/tilck-slim-resume.log`（完整构建通过）和 `/tmp/tilck-native-baseline.log`（原生调试通过）。这些是本地执行证据，不代表插件适配器、VS Code 宿主、安装 VSIX 或远端 CI 已通过。

## ISO 与插件接入

构建基线通过后，将 [项目配置](../examples/tilck/qemu-asm.json)、[外部构建脚本](../examples/tilck/tilck-iso.cjs)和 [GRUB 菜单](../examples/tilck/grub.cfg)复制到自己的 Tilck 源码根目录；不要覆盖已有配置。脚本重新执行 `cmake --build build --parallel 2`，用 `grub-mkrescue` 打包原有 `tilck` 和 `fatpart`，生成 `build/tilck-toolkit.iso` 与同次构建的 `build/tilck-toolkit.elf`。编译或 ISO 打包失败时保留之前的已发布产物，插件中止本次启动。

构建还需要 BIOS GRUB 工具（Ubuntu 的 `grub-pc-bin`、`grub-common`）、xorriso 和 Node.js。它们是本例构建工具，不是插件运行 C 调试的额外依赖。可显式设置 `TILCK_CMAKE`、`GRUB_MKRESCUE` 的可执行路径，使用已有工具或自己的包装器；插件不会强制 Docker 或替换 PATH。容器构建时请映射源码和输出，确保包装器等待构建完成并传递失败退出码。若工具依赖其他可执行文件，也需在包装器或当前扩展宿主 PATH 中显式准备好。

默认配置停在 `kmain`，RAM 为 128 MiB，关闭显示器。`debug.sourceMap` 将构建容器中的 `/work` 映射到本地根目录；若在其他路径构建，请按实际 DWARF 路径调整。打开并信任工程后执行 **QEMU Assembly: 开始引导调试**。修改源码后重启会重新构建并打包；手动构建后可设置 `build: false`，使用匹配的现有 ISO/ELF。

## 自动化闭环

测试使用专用、固定版本且内核源码干净的 Tilck checkout。它暂时修改 `kernel/main.c` 中已有变量的初始值并在结束时恢复；不要指向日常开发工作副本。两个验收进程不能共享该 checkout：脚本使用排他锁阻止并发编辑。非正常强制终止后，应先核对源码和仍在运行的进程，再清理遗留的 `.tilck-toolkit-test.lock`。Tilck 构建源码路径仍要求无空格；测试另外创建含空格和逗号的插件工作区，引用外部源码和构建目录。

```sh
export TILCK_SOURCE=/path/to/dedicated-tilck-checkout
# 可选：设置 TILCK_CMAKE、GRUB_MKRESCUE、QEMU_PATH、GDB_PATH
npm run test:tilck
export VSCODE_EXECUTABLE_PATH=/path/to/existing/code
xvfb-run -a npm run test:tilck:host
OS_PROJECT_KIND=tilck xvfb-run -a node scripts/os-project-installed.cjs /path/to/candidate.vsix
```

三层共用同一套实际断言：高地址源码断点、参数和局部变量、嵌套调用栈、单步/步入/步出、非恒等分页映射与虚实内存对照；修改初值后重启，核对运行值、ISO/ELF 哈希和再次命中断点；恢复源码后再重启，检查原值恢复。宿主另验证停止会话后以 `build: false` 再次启动；适配器层另验证失败构建不启动 QEMU/GDB、已有产物保持不变以及子进程清理。这里验证 VS Code 调试 API 接入，不代替鼠标和快捷键界面操作验收。

独立的 [Tilck 工作流](../.github/workflows/tilck.yml)支持手动触发，或为 PR 添加 `run-tilck` 标签执行；带该标签的 PR 后续推送也会重新验收。标签方式允许新工作流进入默认分支前执行验证。固定源码提交、GCC 与宿主环境，缓存上游工具链并在工具准备成功后立即保存；后续构建或测试失败不会丢失已准备的工具。它不加入每次 PR 的默认任务，也不拉取完整上游 CI 镜像。远端结果与本地结果应分别报告。

本次 Linux x64 执行：实际 ISO 适配器、VS Code 1.96.4 开发宿主与独立安装 VSIX 均通过上述调试和修改/恢复后重启场景。QEMU 10.0.13、GDB 16.3；无 NASM 配置参与外部构建。插件工作区路径包含空格与逗号，源码编译保留上游无空格路径。宿主最初因其 PATH 未包含本地 xorriso 包装器而打包失败，显式在 GRUB 包装器中指定 xorriso 后通过；没有修改插件的 PATH 或工具选择规则。

三层日志保存在 `artifacts/tilck/tilck-integration.log`、`artifacts/tilck/tilck-host.log`、`artifacts/tilck/tilck-installed.log`（本地忽略的执行产物）。构建配方另有单元验证，覆盖编译/ISO 打包失败保留既有产物、清理 staging 目录，以及并发验收锁。新增手动工作流通过 actionlint，本次未在 GitHub 触发运行；也没有新增 macOS/Windows 或其他 VS Code 版本的兼容性结论。生产能力契约、后端、组装和生命周期实现均未增加 Tilck 分支。
