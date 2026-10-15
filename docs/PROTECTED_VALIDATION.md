# 0.3.0 二阶段与保护模式验证

> 历史阶段记录：以下结果对应文中注明的版本、提交与执行环境，不是当前全部平台的兼容承诺。使用指南见[文档导航](README.md)，当前工具组合见[兼容性](COMPATIBILITY.md)。

日期：2026-10-15。环境：Linux x86_64 / Debian 13、Node.js 22.23.3、NASM 2.16.03、QEMU 10.0.13 TCG。目标宿主为官方 VS Code 1.96.4 与 1.142.0，使用 Xvfb。

以下结果来自实际 NASM、QEMU TCG 与 VS Code 宿主；CPU/协议验收没有用接口桩代替。原生 Windows/macOS 与手工 UI 交互仍按下方范围单独列出。

## 实现范围

- 新命令“创建二阶段保护模式项目”，生成 `boot.asm`、`stage2.asm` 和项目配置，拒绝覆盖已有文件。
- `stages` 指定独立 NASM 源文件、线性加载地址和磁盘 LBA。构建先独立汇编各阶段，再组合 1.44 MB raw 软盘（1474560 字节）；保留原有无 `stages` 的 512 字节镜像行为。
- 内置模板由 BIOS 读入引导扇区，再读取两个扇区到 `0x8000`，建立 GDT、置 CR0.PE、远跳转到 32 位代码，建立 `SS:ESP`，向 VGA 和串口输出 `PROTECTED_MODE_OK`。
- 同时保留多个源文件的断点，按实际 CS 缓存计算指令宽度与地址，支持 PE 置位到远跳转之间的 16 位过渡状态。栈指针宽度单独取自 SS 缓存，避免在切换过程中误用 32 位 ESP 或截断完整地址。
- 16/32 位寄存器、CR0/2/3/4、EFER、段缓存、EFLAGS、16 位字/32 位双字栈内存、可验证的 BP/EBP 调用者链。新增“CPU 模式与地址”作用域与 `mode`、`CS:EIP`、`SS:ESP`、`dword[地址]` 表达式，保留原表达式。
- 源码模式与 CPU 实际模式不同、CPU 进入未知代码时，不伪造源码位置。分页、VM86、SMM、unreal 和 64 位模式仍明确拒绝。

## 本轮结果

| 实际执行项目 | 结果 |
| --- | --- |
| `npm ci`、`npm run check`、`npm run compile` | 全部通过，TypeScript 严格模式 |
| `npm test` | 74 项，73 通过，1 项大小写不敏感文件系统专用测试在 Linux 跳过 |
| `npm run test:integration` | 通过：512 字节、55 aa、串口引导标记、停止、失败后旧镜像清除 |
| `npm run test:debug` | 通过：真实运行时与实模式 DAP 回归，包括保护模式/分页/unreal 边界 |
| `npm run test:display` | 通过：真实 QMP、文字/图形像素、模拟键盘与清理 |
| `npm run test:stage` | 通过：多阶段布局、扇区补零、真实二阶段引导、构建失败后清理 |
| `npm run test:protected` | 真实 QEMU / DAP 全部通过；混合与纯 32 位阶段、多文件断点、模式过渡、32 位栈与完整 EIP、重启/断开清理 |
| VS Code 1.96.4 / Linux x64 | 六阶段全部通过：可信、受限、多工作区、实模式调试、显示器、保护模式 |
| VS Code 1.142.0 / Linux x64 | 同上，六阶段全部通过 |
| 实际调试 UI / VS Code 1.142.0 | 1440×900 真实截图；九项 Watch、32 位栈、三帧调用栈与 VGA 成功标记同时可见；后续跳出/跨 CALL/重启/重开会话通过，无 DAP 失败 |
| VSIX 0.3.0 | 打包通过；VS Code 1.96.4 与 1.142.0 CLI 在独立配置/扩展目录实际安装成功，列表均确认 `nothingzhl.vscode-qemu-asm@0.3.0` |

### 直接验证的场景

构建集成使用真实 NASM，检查引导签名、1474560 字节镜像大小、1024 字节二阶段及其独立 listing。成功标记放在二阶段第二个扇区，真实 QEMU 必须完成多扇区加载并执行 32 位代码才能从串口输出标记。另检查多个文件的 LBA 布局、非整扇区补零，以及二阶段汇编错误后的旧镜像失效与临时文件清理。

保护模式调试集成使用真实 QEMU RSP 和插件 DAP，已通过跨 `boot.asm` / `stage2.asm` 的断点和 BIOS 装载。单步执行 CR0.PE 置位后保持 16 位过渡状态，远跳转后进入 32 位代码，最终观察 CS=0x08、DS/SS=0x10、ESP=0x90000。嵌套函数断点观察 EAX/EBX=0x11223344、ESP/EBP=0x8ffec，栈顶保存上一层 EBP=0x8fff8，参数为 0x11223344，`readMemory(0x8fff4)` 返回小端字节 `44 33 22 11`。EBP 调用者链、跳出和 F10 跨 32 位 CALL 通过，返回后 ESP 恢复 0x90000；重启和断开后的 QEMU 均结束。两版真实 VS Code 宿主的 protected 阶段均通过：从未激活状态直接启动调试触发冷激活，验证多文件断点、模式过渡、32 位寄存器/栈、两层 EBP 调用者、跳出、跨 CALL、重启、重新启动会话及清理。

另用自定义引导器先完成 LGDT、CR0.PE 和 32 位远跳转，验证直接以 `BITS 32` 开始的独立二阶段。首条源码指令在 0x8000 命中，单步到 0x8004；函数内观察 EAX=0x12345678、ESP=0x8fff4、压栈值 0x55667788，返回帧、跳出及 F10 跨 CALL 通过。执行 inc 后 EAX=0x12345679，重启仍可调试；全部 QEMU 清理。这个场景使用专门的客体加载器，并非直接把内置 16 位入口替换为 32 位源码。

运行时边界还实际检查非零 CS.base、SS 的 16/32 位切换、超过 1 MiB 的栈地址，以及真实程序开启分页和构造 unreal mode 后的拒绝行为。另构造大 limit 的 16 位保护模式代码段，用 o32 远跳转到 EIP=0x10020，再执行 o32 near jump，在 0x10026 / 0x1002c 验证断点、继续、单步和暂停；CS.D 决定默认指令位数，不会把实际 EIP 截断为 16 位。expand-down 栈段的有效上下界由专门单测验证。另将循环指令复制到 0x100000 并执行真实远跳转，暂停后寄存器 EIP、栈帧 instructionPointerReference 与表达式地址均保持完整 0x100000，未截断为 16 位，也未伪造低地址源码。

交付日志：

- `protected-unit-final.log`：74 项单测。
- `protected-boot-final.log`、`protected-stage-final.log`：单扇区与多阶段真实构建/引导。
- `protected-debug-final.log`、`protected-protected-final.log`：运行时、实模式及混合/纯 32 位阶段 DAP。
- `protected-display-regression.log`：真实显示器回归。
- `protected-host-regression-min.log`、`protected-host-regression-current.log`：两版宿主的原有五阶段。
- `qemu-asm-protected-host-min.log`、`qemu-asm-protected-host-current.log`：两版宿主的新增保护模式阶段。
- `protected-host-final-min.log`：最新代码在最低版本宿主的 debug / display / protected 复跑。
- `protected-ui-test.log`：最新版本宿主中的真实调试 UI 与实时 Watch 验收。
- `protected-vsix-package.log`、`protected-vsix-install-min.log`、`protected-vsix-install-current.log`：打包及两版实际安装。

## 实际界面

![真实 VS Code 保护模式断点与 QEMU VGA](images/protected-live.png)

截图来自 VS Code 1.142.0 的真实扩展开发宿主。程序停在 `stage2.asm` 第 98 行 `nop`：Watch 显示 EAX/EBX=0x11223344、ESP/EBP=0x8ffec、EIP=0x80c7、CR0=0x11、CS=0x08、SS=0x10、mode=protected32；左侧同时显示 32 位栈和当前帧加两层 EBP 调用者，右侧显示实际 QEMU VGA 的 `PROTECTED_MODE_OK`。图像通过运行中的 VS Code 截取，没有绘制模拟界面。

`npm run test:protected:ui` 可重复执行界面验收并截图；Linux 需要 Xvfb 或桌面会话，以及 Node.js 22。交付截图为 `qemu-asm-protected-live.png`，相应元数据为 `qemu-asm-protected-live.png.json`。

## 复现

```sh
npm ci
npm run check
npm run compile
npm test
npm run test:integration
npm run test:debug
npm run test:display
npm run test:stage
npm run test:protected
xvfb-run -a npm run test:host
```

通过 `NASM_PATH`、`QEMU_PATH` 指定工具路径。`VSCODE_EXECUTABLE_PATH` 指向已安装的 VS Code，或用 `VSCODE_VERSION=1.96.4` 选择下载版本。Windows / macOS 使用桌面会话运行 `npm run test:host`，不需要 Xvfb。宿主测试使用独立临时用户配置及扩展目录。

人工学习流程见[二阶段与保护模式](DEBUGGING.md#二阶段与保护模式)。在 `stage2.asm` 的 `mov cr0, eax` 处断下，单步至远跳转之后，再在 `learning_breakpoint` 后的 `nop` 处查看 EAX/EBX、EBP、ESP 和原始栈。上方截图是本轮保护模式验收，另有[显示器历史截图](DISPLAY_VALIDATION.md)。

## 限制与待验收

- 加载阶段最多 8 个；所有补齐后的磁盘范围须位于 LBA 1..17，合计最多 8704 字节；内存范围须位于 `0x8000..0x9ffff`。磁盘范围和内存范围都不得相互重叠。
- 内置加载器只从 LBA 1 将首阶段加载到 `0x8000`，`STAGE2_SECTORS` 为其扇区数。配置其余阶段或改变位置，需要自行修改客体加载器；构建器写入镜像不等于客体已加载。
- 调试映射只支持独立的 NASM flat bin 源文件及显式 ORG/BITS，引导文件须从 BITS 16 开始，加载阶段可从 BITS 16 或 BITS 32 开始，也允许在同一文件内切换；宏、include、incbin、section、条件预处理、ELF/DWARF 与重定位映射不支持。
- 支持单 CPU、标准实模式及无分页保护模式。无远程 attach、寄存器/内存写入、GDT/IDT 表结构查看。示例关闭中断，未提供 IDT、分页或完整内核运行环境。
- 调用栈依赖可验证的 16 位 BP / 32 位 EBP near CALL 链；无帧指针、far CALL、混合操作数宽度或任意手写栈不能保证展开。历史栈帧没有寄存器快照。
- Windows/macOS 原生结果仍须实际执行，不能用 Linux 结果或路径语义测试代替。目录选择、多工作区选择器、鼠标点击断点/状态栏、键盘快捷键和直接关闭整个宿主仍待人工 UI 验收；真实 VS Code 调试 API 测试不等于这些手工交互已验收。
