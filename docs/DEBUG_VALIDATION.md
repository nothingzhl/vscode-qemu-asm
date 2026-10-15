# 0.1.0 操作系统学习调试验证

日期：2026-10-15。环境：Linux x86_64、Node.js 22.23.3、NASM 2.16.03、QEMU 10.0.13 TCG，官方 VS Code 1.96.4 与 1.142.0，Xvfb 无界面宿主。

## 已交付

- VS Code `qemu-asm` 调试类型与“开始实模式调试”命令、源码断点、继续/暂停、指令单步、跨 CALL / INT、BP 帧跳出、重启/停止。
- AX/EAX 等通用寄存器、段寄存器、EFLAGS 及标志位、SS:SP 栈内存、BP 调用者链、监视表达式及 DAP readMemory。
- 严格的 NASM listing 映射、CPU 模式和段缓存校验；不支持的源码或模式明确拒绝。
- 使用 QEMU 内置 GDB Remote Serial Protocol，不增加外部 GDB 依赖；端口仅监听本机回环，进程按会话清理。
- 创建项目的示例增加标准 BP 函数帧；不修改用户已有项目。

## 实际结果

| 验证 | 结果 |
| --- | --- |
| `npm ci`、`npm run check`、`npm run compile` | 全部通过 |
| `npm test` | 42 项，41 通过，1 项大小写不敏感卷专用测试在 Linux 跳过 |
| `npm run test:integration` | 示例 512 字节 / 55 aa、串口标记、停止、真实构建失败清除旧产物通过 |
| `npm run test:debug` | 真实 QEMU RSP 运行时与完整 DAP 调试集成通过 |
| VS Code 1.96.4 / 1.142.0 | 各 4 阶段：普通命令、受限工作区、多工作区资源配置、调试，全部通过 |
| 直接启动调试 | 两版宿主均确认插件启动前未激活，`startDebugging` 后自动激活并停在入口 |
| VSIX | 0.1.0 打包通过；VS Code 1.96.4 CLI 安装后列表确认为 `nothingzhl.vscode-qemu-asm@0.1.0` |

真实调试程序：入口初始化 SS:SP、BP 与 AX，near CALL 进入函数，建立 BP 栈帧并 push AX，在函数内设置源码断点。验证暂停时 AX=0x1111、SP=0x7bfa、BP=0x7bfc、栈顶字为0x1111，调用者精确指向 CALL 后指令。单步执行 mov/inc 后 AX 分别为0x1234/0x1235；跳出后 BX=0x1111、SP 恢复0x7c00。另验证 F10 跨真实 CALL、循环中暂停、重新构建/重启、断开后重新启动，所有观察到的 QEMU 进程均结束。

单独实际执行 far jump：CS:IP=07c0:0005，真实 CS base=0x7c00，映射到引导源码物理地址0x7c05；随后单步更新 AX。实际置 CR0.PE 后寄存器与继续操作被拒绝；再用实际程序建立 unreal-mode 段缓存并清除 PE，仍正确识别并拒绝。

修复并回归了真实调试中发现的 Z1 原地重复命中、以 e8 开头的正常内存包误判错误、目标 XML 注释寄存器、停止和重启并发清理、自然断点与动态断点更新竞争、返回地址落入指令中间的假 BP 调用者。生命周期竞态使用独立接口桩单测；上述 CPU/协议/宿主结果均使用真实 QEMU 与 VS Code，没有用桩替代集成验收。

## 复现

```sh
npm ci
npm run check
npm run compile
npm test
npm run test:integration
npm run test:debug
xvfb-run -a npm run test:host
```

可设置 NASM_PATH、QEMU_PATH、VSCODE_EXECUTABLE_PATH 或 VSCODE_VERSION；Windows/macOS 的宿主测试不需要 Xvfb。CI 已在三操作系统 × 最低/稳定 VS Code 矩阵中加入以上调试验证和日志 artifact。

交付日志：`qemu-asm-debug-unit.log`、`qemu-asm-debug-integration.log`、`qemu-asm-debug-host-min.log`、`qemu-asm-debug-host-current.log`。

## 范围与待验收

当前支持单 CPU、单文件 BITS16/ORG7c00、512 字节引导程序。宏/include、多阶段加载、保护模式、unreal mode、虚拟8086、64位内核、远程attach、条件/日志断点、写寄存器/内存不支持。调用栈只还原可验证的16位 near CALL BP 链，原始栈内存始终可看；历史调用者没有寄存器快照。调试中修改源码请重启以重建映射。

Windows/macOS 原生 CI 结果尚未取得，不能用 Linux 或路径语义测试替代。GUI 手工点击断点边栏、目录/多工作区选择框、快捷键、状态栏及窗口关闭仍待人工操作验证；自动测试已通过真实 VS Code 调试 API 验证同一调试会话功能。
