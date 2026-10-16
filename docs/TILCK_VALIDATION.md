# 第二个真实工程：Tilck 构建与原生调试基线

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

## 下一阶段

原生基线通过后，再增加 BIOS GRUB ISO 打包配方与 `qemu-asm.json`，沿用已有外部构建和 ELF 配置。逐层验证高地址源码断点、变量、调用栈、单步、非恒等虚实地址观察及修改后重启；遇到差异修复通用能力，不加入 Tilck 专用的生产逻辑。完整上游 CI 镜像不直接加入每次 PR 的默认任务。
