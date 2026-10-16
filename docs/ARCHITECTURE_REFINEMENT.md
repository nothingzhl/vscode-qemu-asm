# 第二轮架构收敛与验收

> 历史阶段记录：以下结果对应文中注明的版本、提交与执行环境，不是当前全部平台的兼容承诺。使用指南见[文档导航](README.md)，当前工具组合见[兼容性](COMPATIBILITY.md)。

日期：2026-10-15。分支：`refactor/capability-architecture`。本轮产品代码提交：`bbd5c29`；后续文档提交不改变产品代码。第一轮验收保留在 [ARCHITECTURE_VALIDATION.md](ARCHITECTURE_VALIDATION.md)，当前图及目录见 [架构说明](ARCHITECTURE.md)、[完整结构](STRUCTURE.md)。

## 收敛结果

- `debug/` 全部成为兼容入口；生产源码不导入该目录。NASM listing、源语句校验、临时 listing 生命周期归 `backends/nasm`；RSP 传输、编码和寄存器布局归 `backends/rsp`。
- 汇编会话通过 `AssemblySourceLoader` 获取源码映射；该能力只加入汇编会话，不要求 C 后端实现。应用不解析 NASM listing，不拼接 MI 命令，不加载具体解码库。
- 内存/描述符/分页检查进入 `application/inspection`；数据模型、源码映射与纯 x86 描述符解码进入 `domain`；读取契约复用 `ports` 中的小能力。
- NASM 源码映射与分页校验、F10 规划、两条路径的源码断点请求各自独立。运行中的断点更新仍由会话协调暂停、保留真实停止、恢复执行，保持事件顺序。
- VS Code 示例创建、构建诊断和观察器注册进入独立功能文件；观察器类型、响应校验、快照读取/内存差异历史与刷新状态分开。
- `SessionResourceOwner` 被两条调试路径实际使用：停止等待尚未结束的分配；晚到资源在发布给会话前被释放；信任检查或能力观察失败释放完整资源对。`releaseAll` 等待所有清理动作结束后报告首个错误。
- 架构测试禁止反向依赖及使用兼容入口绕过边界；文件预算防止普通文件超过 250 行，以及 4 个已说明的状态机无声增长。AGENTS.md 已同步。

没有新增用户功能、工具依赖或后端。包版本仍为 0.8.0，是本分支的验证构建。

## 文件规模

所有行数按实际文件统计，包含空行、注释和兼容入口，没有以压行降低计数。

| 指标 | 第一轮交付 | 本轮交付 |
| --- | ---: | ---: |
| TypeScript 生产文件 | 90 | 121 |
| 行数中位数 | 71 | 61 |
| 平均行数 | 102.3 | 85.8 |
| 250 行以内 | 82 / 90 | 117 / 121 |
| 超过 250 行 | 8 | 4 |
| 总行数 | 9203 | 10386 |
| 汇编 DAP 协调器 | 582 | 457 |
| C DAP 协调器 | 459 | 430 |
| VS Code 激活入口 | 308 | 237 |
| 观察器模型 | 275（原有压缩写法） | 229（展开后，类型/校验/快照已独立） |

文件数量和总代码增加包含显式资源归属、契约及展开写法，不宣称减少了全仓总代码。4 个保留例外及行数预算见架构文档。本轮停止在责任清楚、依赖方向受检查、失败清理有测试的边界，保留协议状态机的完整性。

## 本次实际验证

| 验证 | 结果 |
| --- | --- |
| `npm run check` | 通过，包含严格模式及未使用声明/参数检查 |
| `npm test`（同时编译） | 292 项：291 通过，1 跳过，0 失败 |
| 真实工具集成 | 14 个脚本全部通过 |
| VS Code 1.96.4 | 11 个完整宿主阶段通过 |
| VS Code 1.142.0 | 11 个完整宿主阶段通过 |
| 独立安装 VSIX，VS Code 1.96.4 | dependencies、c-source、machine、paging，4/4 通过 |
| 独立安装 VSIX，VS Code 1.142.0 | 同上，4/4 通过 |
| `git diff --check` | 通过 |

新增回归验证包括晚到资源、分配期间信任撤销、能力观察器失败、重复清理、同步/异步清理错误，以及完整 C DAP 在显示资源分配期间停止的行为。该 DAP 测试确认 dispose 等待清理、后端不启动、资源各释放一次、terminated 只发送一次。观察器原有过期响应、差异历史和断点竞态测试全部保留通过。

唯一跳过项需要大小写不敏感文件系统；当前 Linux 文件系统区分大小写。没有把协议替身、路径模拟或故障注入当作原生平台验收。

### 环境与复现入口

Linux x64；Node 22.23.3，NASM 2.16.03，QEMU 10.0.13，GDB 16.3，GCC 14.2.0，binutils 2.44。QEMU/GDB 使用含空格的可执行入口，QEMU 使用软件模拟，VS Code 通过 Xvfb 运行。

执行 `node scripts/<名称>.cjs`：

```text
integration, stage-build-integration, debug-runtime-integration,
debug-integration, protected-integration, inspection-integration,
watchpoint-runtime-integration, machine-debug-integration,
physical-memory-integration, paging-integration, c-machine-integration,
c-source-integration, display-integration, dependency-integration
```

两个版本分别执行：

```sh
VSCODE_EXECUTABLE_PATH=<对应版本>/code xvfb-run -a node scripts/host-test.cjs
```

完整阶段为 trusted、untrusted、resources、debug、display、protected、inspection、machine、paging、c-source、dependencies。

### 安装包

先删除 `dist` 再编译，随后正常 VSCE 打包并通过 CLI 安装到仓库外。安装包保留 iced-x86 JS/WASM；没有旧的 application/assembly listing 构建器或旧 inspection 聚合实现，也没有源码、测试或源码映射。

```text
文件：vscode-qemu-asm-architecture-r2.vsix
大小：718371 字节
内容：146 个文件
SHA-256：5adc989a81138809382ae7bd6e6e9ef003e6b8b8575f5f79cd795954986907ec
```

两个版本分别在独立安装目录执行：

```sh
QEMU_ASM_VSIX_EXTENSION=<仓库外安装目录> \
VSCODE_EXECUTABLE_PATH=<对应版本>/code \
xvfb-run -a node scripts/vsix-dependencies-test.cjs
# 同样执行 vsix-c-source-test.cjs、vsix-machine-test.cjs、vsix-paging-test.cjs
```

安装包测试把测试输入复制到另一临时目录，产品模块与 WASM 均从实际安装目录加载；实际构建、QEMU/GDB 调试和进程清理通过，不能由仓库中遗留的编译文件代替。

本轮没有执行 Windows/macOS 原生验证或其他工具版本组合，没有新增 LLDB、其他虚拟机、64 位、SMP、远程显示或热插拔支持，也没有发布 Marketplace。
