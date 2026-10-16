# 架构重构验证

> 历史阶段记录：以下结果对应文中注明的版本、提交与执行环境，不是当前全部平台的兼容承诺。使用指南见[文档导航](README.md)，当前工具组合见[兼容性](COMPATIBILITY.md)。

本文保留首轮历史结果；最新代码及验收见 [第二轮重构验证](ARCHITECTURE_REFINEMENT.md)。

日期：2026-10-15。分支：`refactor/capability-architecture`。代码提交：`c8f1baf`、`819e138`；后续文档提交不改变产品代码。基础为 `f12dc2d`。安装包保留 0.8.0 版本号，是分支验证构建，没有发布 Marketplace。

架构及例外说明见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 本次实际执行结果

| 验证 | 结果 |
| --- | --- |
| `npm run check` / `npm run compile` | 通过，严格模式及新增的未使用声明/参数检查 |
| `npm test` | 284 项：283 通过，1 跳过，0 失败 |
| 真实工具集成 | 14 个脚本全部退出 0 |
| VS Code 1.96.4 开发宿主 | 全部 11 个阶段通过 |
| VS Code 1.142.0 开发宿主 | 全部 11 个阶段通过 |
| CLI 安装分支 VSIX | 成功，安装位置在仓库外 |
| 已安装 VSIX：1.96.4 | dependencies、c-source、machine、paging，4/4 通过 |
| 已安装 VSIX：1.142.0 | 同上，4/4 通过 |
| `git diff --check` | 通过 |

跳过项是需要大小写不敏感文件系统的构建防覆盖测试；当前 Linux 文件系统区分大小写。路径模拟测试不视为 Windows/macOS 原生验证。

新增测试覆盖：领域/能力/应用/DAP 的依赖方向；停止等待尚未结束的资源分配；退出与显式停止共用清理；新会话资源不被旧会话清理；显示连接失败时清理 VM；C 变量消费者脱离 VM、MI 和物理内存能力工作；根变量释放与过期帧拒绝。既有竞态测试改用显式构建器/后端注入，仍保留请求顺序和实际行为断言。

## 环境与实际集成范围

Linux x64，Node 22.23.3，NASM 2.16.03，QEMU 10.0.13，GDB 16.3，GCC 14.2.0，binutils 2.44。QEMU/GDB 可执行入口使用含空格的路径。QEMU 使用软件模拟，VS Code 通过 Xvfb 运行。

本次执行的脚本（均为 `node scripts/<名称>.cjs`）：

```text
integration
stage-build-integration
debug-runtime-integration
debug-integration
protected-integration
inspection-integration
watchpoint-runtime-integration
machine-debug-integration
physical-memory-integration
paging-integration
c-machine-integration
c-source-integration
display-integration
dependency-integration
```

开发宿主通过 `VSCODE_EXECUTABLE_PATH=<对应版本>/code xvfb-run -a node scripts/host-test.cjs` 执行：

```text
trusted, untrusted, resources, debug, display, protected,
inspection, machine, paging, c-source, dependencies
```

实际涵盖：NASM 入口/源码断点及 CALL 单步跨越；实模式到保护模式；BP/EBP 栈；虚拟与物理内存及非身份分页；指令/数据断点；C DWARF 栈、局部变量、结构体/数组及源码/指令步进；QEMU PNG 显示；工具解析、能力证据、显示关闭、NASM 无 GDB、外部构建/C 无 NASM及 owned 进程清理。显示资源初始化故障仍为注入验证，不冒充原生分配故障复现。

## 安装包验证

先删除整个生成目录 `dist`，重新编译，避免移动源文件后旧 JS 留在包内。随后使用 VSCE 正常打包，包含运行时依赖；没有使用 `--no-dependencies`。

```text
文件：vscode-qemu-asm-architecture.vsix
大小：697390 字节
包内容：115 个文件
SHA-256：831ecfc25859728a914161ddb9a90f140a57824392cb4f9990fdfc842387cc56
```

包内包含 `iced-x86` JS/WASM，不包含源代码、测试、源码映射或已删除的旧顶层运行时文件。实际通过 VS Code CLI 安装到独立目录，再执行：

```sh
QEMU_ASM_VSIX_EXTENSION=<仓库外安装目录> \
VSCODE_EXECUTABLE_PATH=<对应版本>/code \
xvfb-run -a node scripts/vsix-dependencies-test.cjs
# 同样执行 vsix-c-source-test.cjs、vsix-machine-test.cjs、vsix-paging-test.cjs
```

这些脚本把测试输入复制到另一临时目录，所有产品模块从已安装扩展目录加载。分页测试确认解码器来自安装包自己的 JS/WASM；C 测试使用真实 GDB/QEMU，不从仓库加载调试器实现。

## 文件粒度与 review

| 指标 | 基础提交 | 本次重构 |
| --- | ---: | ---: |
| 生产 TypeScript 文件 | 25 | 90 |
| 文件行数中位数 | 200 | 71 |
| 平均行数 | 234.9 | 102.3 |
| 250 行以内文件 | — | 82 / 90 |
| 总行数 | 5872 | 9203 |

总行数增加包含原来压缩写法的展开、显式契约、组装与资源所有者，不宣称减少了全仓总代码。重点是每个文件的职责和依赖可单独审查。仍有 8 个文件超过 250 行：5 个本次协调/状态机文件及 3 个存量模型/解析文件；具体理由在架构文档列出，没有以压行规避要求。

本次没有验证 Windows x64、macOS arm64、其他 Linux 工具组合、远程显示命名空间、64 位、SMP 或替代调试后端。接口隔离为后续适配提供边界，不构成这些组合已兼容的证据。
