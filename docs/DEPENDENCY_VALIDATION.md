# 依赖隔离重构验证（0.8.0）

2026-10-15，在 `refactor/dependency-isolation` 分支执行。此次交付为第一阶段：实际消费者接入依赖边界、基础 Doctor、会话能力报告和可选组件隔离。Windows/macOS 原生适配及更多工具版本组合仍属后续工作，不能从 Linux 或路径模拟结果推定。

## 实际环境

| 项目 | 本次使用 |
| --- | --- |
| 扩展宿主 | Linux x64，内核 6.18.44 |
| 开发 / 测试运行时 | Node.js 22.23.3 |
| VS Code | 1.96.4、1.142.0 |
| NASM / QEMU | 2.16.03 / 10.0.13，TCG，无 KVM |
| C 调试 | GNU GDB 16.3，GCC 14.2，GNU binutils 2.44 |
| 分发依赖 | 随包 iced-x86 1.21.0，含 JS 与 WASM |

QEMU/GDB 使用带空格的本地 wrapper 入口，项目和临时目录包含空格、逗号及中文。以上是实际测试组合，不是推定的最低版本或全部支持范围。C 测试用的 NASM/GCC/binutils 用来预编译临时固件；插件实际执行的外部构建器仅复制已生成的镜像，配置中的 NASM 故意指向不存在的路径。

## 类型、单测与边界回归

`npm run check`、`npm run compile`、`npm test` 通过。共 279 项：278 通过、1 跳过、0 失败。跳过项是大小写不敏感文件系统上的别名保护测试；当前卷区分大小写。不是因为缺少 NASM 而跳过。

新增与直接相关的覆盖：

- 显式 / PATH / 相对 PATH / 空格路径、执行权限、目录误配置、符号链接启动入口保持，以及错误码与真实启动路径一致。
- owned 进程树正常退出、取消、超时、抗 SIGTERM 后代和无关进程保护；交互式 MI 保留自己的管道并共享宿主清理边界。
- GDB 尚未返回 prompt 时取消：立即中止在途启动，等待后代清理完成后 `dispose()` 才结束。
- 基础检查按项目挑选工具，不执行自定义 builder、不追加版本参数；错误身份、非零退出、超时、取消和输出上限。
- 会话账本独立、快照不可反向修改；首次协议观察前绑定实际启动工具，观察后禁止修改归因范围。
- 物理内存读取须完成非零读取及地址模式恢复后才记录支持；目标地址错误不误判协议不支持。
- 延迟加载 iced：模块缺失、WASM 缺失 / 损坏和初始化失败不会阻止加载实际扩展模块树；第一次解码才失败并提示操作边界。
- 显示器 off、资源 / 面板初始化故障、连接 / 状态通知故障与取消清理；面板状态或日志通道异常不能再次阻断可选降级。

Windows Path/PATHEXT/.EXE/.COM 与 taskkill 的相关测试属于元数据 / 合同模拟。没有把它们计作 Windows 原生运行通过。

## 真实 QEMU 回归

下列 13 个现有实际工具脚本通过：

```sh
node scripts/integration.cjs
node scripts/debug-runtime-integration.cjs
node scripts/debug-integration.cjs
node scripts/stage-build-integration.cjs
node scripts/protected-integration.cjs
node scripts/inspection-integration.cjs
node scripts/watchpoint-runtime-integration.cjs
node scripts/machine-debug-integration.cjs
node scripts/physical-memory-integration.cjs
node scripts/paging-integration.cjs
node scripts/c-machine-integration.cjs
node scripts/c-source-integration.cjs
node scripts/display-integration.cjs
```

覆盖引导签名与串口、RSP 硬件断点与单步、保护模式切换、非零段基址、栈与内存、监视点、反汇编、页表与物理地址模式恢复、C 的 ELF/DWARF/变量/步进和 QMP 图像 / 键盘。PAE、unreal mode 等既有明确拒绝行为仍保留。

新增 `npm run test:dependencies` 实际通过：

- PATH 与显式工具都解析成真实启动入口，报告与 `child.spawnfile` 相符。
- NASM 的真实 QEMU 调试没有启动 GDB；初始协议项未知，真实握手 / 段缓存后记录协议证据，物理读取后才记录物理内存支持。
- 换目标 / 重新启动生成新会话，不继承之前的物理内存能力事实。
- 外部构建与 C/GDB 调试在插件 NASM 配置不存在时仍可用；编译链由项目负责。

## 实际 VS Code 与分发包

两版宿主的 `dependencies` 专项均通过。用公开命令检查路径 / 版本、构建、启动 NASM / C 调试、读取源码帧 / 物理内存、导出报告，并等待进程退出。显示 off 的真实 QEMU 参数不含 `-qmp`。显示分配故障测试只注入 `QemuScreen.create()` 的异常，其他 VS Code、NASM、QEMU、DAP 和单步均为真实执行；它证明降级路径，不声称复现了某个平台的原生资源故障。

依赖报告使用只读 `qemu-asm-report:` 文档，`isDirty=false`、`isUntitled=false`；报告显示后可直接启动调试，不弹出未保存报告的另存为对话框。基础工具结果和活动会话证据保存在不同范围中。

最终验收记录：

| 验收 | VS Code 1.96.4 | VS Code 1.142.0 |
| --- | --- | --- |
| trusted / untrusted / resources | 通过 | 通过 |
| NASM debug / display / protected | 通过 | 通过 |
| inspection / machine / paging | 通过 | 通过 |
| C source / DWARF / GDB 退出 | 通过（独立重跑） | 通过 |
| dependencies 专项 | 通过 | 通过 |
| 独立安装 VSIX dependencies 专项 | 通过 | 通过 |

C 宿主观察器现观察新 `localHost.spawn` 边界，以核对真实 GDB 的退出；没有替换工具或 MI 返回值。所有阶段均在隔离用户配置和临时工作区执行。

最终 `qemu-assembly-toolkit-0.8.0.vsix` 为 **652852 字节、50 个文件**。SHA256：

```text
61fbfeacdb1827a8a63112d54e132323ff5b63d7f5904044361db96217a022f9
```

两版 Code CLI 均用 `--force` 安装最终包，安装目录分别为 `/tmp/qemu-refactor-deps-vsix-min-extensions/nothingzhl.vscode-qemu-asm-0.8.0` 与 `/tmp/qemu-refactor-deps-vsix-current-extensions/nothingzhl.vscode-qemu-asm-0.8.0`。逐字节比对 41 个 dist / iced 产品文件：工作区产物、最终 VSIX 和两份独立安装完全一致。安装包专项覆盖只读报告、NASM / C 调试、物理内存、display off / 分配故障及 owned 进程清理。

本次工作区保留 `refactor-dependency-acceptance*.log`、`refactor-dependency-vsix-{install,proof}-{min,current}.log`、`refactor-dependencies-unit.log` 和各回归日志。日志未提交到仓库；按上方与下方命令可独立复跑。

## 复跑方式

先 `npm ci`，配置 `NASM_PATH`、`QEMU_PATH`、`GDB_PATH`。Linux 无桌面时使用 Xvfb；可用 `VSCODE_EXECUTABLE_PATH` 指定某一版真实 Code。

```sh
npm run check
npm test
npm run test:dependencies
QEMU_ASM_HOST_PHASES=dependencies xvfb-run -a npm run test:host
```

完整宿主脚本默认在 Linux 执行原有 10 个阶段和新增依赖阶段；C / 依赖专项需要本次 C 测试工具。打包时保留生产依赖，不使用 `--no-dependencies`。安装到仓库外的独立扩展目录后：

```sh
QEMU_ASM_VSIX_EXTENSION=/path/to/installed/extension \
  xvfb-run -a npm run test:vsix:dependencies
```

测试将输入脚本和临时固件复制到仓库外，产品模块全部从独立安装目录导入；不会用工作区的 dist 或 WASM 替代缺少的包内容。

## 边界

本阶段没有增加工具下载 / 便携包、远程 attach、64 位、SMP 或新的引导介质。QMP 截图仍要求共享文件命名空间，握手只记录 `unknown/protocol`；收到真实帧才记录 `supported/integration`。能力事实仅对应当前工具、目标和机器参数；未请求的功能保持未知。

Linux 新发行版默认工具组合、Windows x64、macOS arm64、WSL 与 Dev Container 需要逐一实际验收。现有 CI 矩阵的远端结果应单独查看，不把本地 Linux 验证写成跨平台通过。
