# QEMU Assembly Toolkit

用于 VS Code 1.96+ 的 x86 NASM 引导扇区开发插件。首版提供“创建项目 → 构建 → QEMU 运行 → 停止”的完整流程，中文命令、构建错误定位、串口日志与状态栏。暂不提供语法高亮、补全或 GDB 调试。

## 安装与快速开始

开发环境使用 Node.js 22。Ubuntu / Debian 安装工具：

```sh
sudo apt-get update
sudo apt-get install -y nasm qemu-system-x86
npm ci
npm run check
npm run compile
```

在 VS Code 打开本仓库，按 F5 启动扩展开发宿主。在宿主中打开并信任一个本地文件夹，然后从命令面板依次执行：

1. **QEMU Assembly: 检查环境**：显示 NASM、qemu-system-i386 的路径和版本；缺失时提示配置方法。
2. **QEMU Assembly: 创建引导项目**：选择目录，生成 `boot.asm` 和 `qemu-asm.json`，并保存该工作区的项目位置。任一目标文件已存在则拒绝覆盖；若中途冲突，仅回滚本次创建的文件。
3. **QEMU Assembly: 构建并运行**：保存文件、停止已有实例、重新构建，再通过 TCG 无界面启动 QEMU。输出面板出现 `QEMU_ASM_BOOT_OK` 表示示例已引导成功。
4. **QEMU Assembly: 停止**：或点击状态栏，停止插件启动的进程。重复运行会先停止上一实例；扩展退出也会清理。

也可单独执行 **QEMU Assembly: 构建**。NASM 错误显示于“问题”面板，可跳转到源码。日志在“输出 → QEMU Assembly”。构建超时为 15 秒；失败会清除旧镜像，运行命令始终重新构建，不运行失败前的产物。

安装分发版本时，可在仓库根目录执行 `npx @vscode/vsce package` 生成 VSIX，然后通过 VS Code 的“扩展：从 VSIX 安装”安装。不自动发布 Marketplace。

## 配置

设置支持按工作区文件夹配置。多工作区时，命令先让用户选择项目所属的工作区。

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `qemuAsm.nasmPath` | `nasm` | 可执行文件路径，不含参数或包裹路径的引号 |
| `qemuAsm.qemuPath` | `qemu-system-i386` | 同上；Windows 可填写完整 `.exe` 路径 |
| `qemuAsm.projectDirectory` | `.` | 包含 `qemu-asm.json` 的项目目录 |
| `qemuAsm.qemuArgs` | `[]` | 额外 QEMU 参数，采用选项和值成对的字符串数组 |

项目目录、带分隔符的相对工具路径均相对**所选工作区文件夹**解析；绝对路径原样使用，裸工具名从 PATH 查找。不展开 `~`、环境变量或 `${workspaceFolder}`。工具和项目路径支持空格，启动时使用参数数组，不执行 shell。

`qemu-asm.json` 示例：

```json
{
  "source": "boot.asm",
  "image": "build/boot.img"
}
```

源码与镜像路径相对**项目目录**解析。镜像必须在项目内部，不能覆盖源码或配置，且输出目录不能通过符号链接跳出项目。首版仅接受 512 字节、末尾为 `55 aa` 的引导扇区镜像。

额外参数示例：`["-m", "32M", "-cpu", "qemu32", "-smp", "1"]`。首版仅接受 `-m`、`-cpu`、`-smp`，以维持插件对镜像、串口及前台进程生命周期的控制。固定使用 TCG、软盘只读 raw 镜像、无显示、串口 stdout、无网络，不依赖 KVM。

外部工具执行与示例创建均要求 Workspace Trust；只支持文件系统工作区。停止仅针对插件创建的直接子进程；工具配置应指向真正的 NASM/QEMU 可执行文件，若使用包装脚本，应通过 `exec` 转交执行，不能自行后台派生进程。

## 可重复验证

```sh
npm ci
npm run check
npm run compile
npm test
npm run test:integration
```

`npm test` 覆盖配置解析、空格路径、多工作区基准、不覆盖文件、旧镜像失效、启动失败、超时、取消、符号链接边界、停止与强制终止。测试直接运行编译后的核心模块。

集成脚本调用插件共用的项目生成、构建和进程管理代码，在含空格及逗号的临时目录中：

- 实际用 NASM 构建并检查 512 字节与 `55 aa`。
- 实际用 QEMU TCG 无界面引导，15 秒内等待串口标记。
- 停止并确认进程结束，始终清理临时目录和进程。
- 将源码改为错误内容，确认真实 NASM 构建失败且旧镜像不可用。

可用 `NASM_PATH`、`QEMU_PATH` 环境变量覆盖集成脚本的工具路径。CI 在 Ubuntu 上安装真实工具并执行上述所有命令。

已在 Linux、Node.js 22、NASM 2.16.03、QEMU 10.0.13 上完成核心测试及真实 TCG 集成验证。云端使用解包到临时目录的工具及以 `exec` 启动的 QEMU 包装脚本，补充本地固件搜索路径；标准系统安装不需要该包装。

**待人工验证**：VS Code 宿主中的命令交互、目录对话框、多工作区设置写入、信任提示、问题面板跳转、状态栏及关闭宿主的清理；macOS / Windows 工具发现、路径与进程停止兼容性。类型检查与核心集成通过不代表这些宿主交互已验收。CI 远端运行结果以 PR 检查为准。
