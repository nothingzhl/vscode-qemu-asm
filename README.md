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

项目目录、带分隔符的相对工具路径均相对**所选工作区文件夹**解析；绝对路径原样使用，裸工具名从 PATH 查找。不展开 `~`、环境变量或 `${workspaceFolder}`。Windows 的 `C:tool.exe` 盘符相对路径会被拒绝，请使用 `C:\Tools\tool.exe` 完整路径。工具和项目路径支持空格，启动时使用参数数组，不执行 shell。

`qemu-asm.json` 示例：

```json
{
  "source": "boot.asm",
  "image": "build/boot.img"
}
```

源码与镜像路径相对**项目目录**解析。镜像必须在项目内部，不能覆盖源码或配置；删除旧产物前会检查实际文件身份，防止大小写别名或目录链接指向源码/配置。输出目录不能通过符号链接跳出项目。首版仅接受 512 字节、末尾为 `55 aa` 的引导扇区镜像。

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

`npm test` 覆盖配置解析、空格路径、多工作区基准、不覆盖文件、旧镜像失效、启动失败、超时、取消、符号链接边界、停止与强制终止、异常信号终止、分块 UTF-8 中文日志。额外路径测试使用 Node 的 `path.win32` 和 `path.posix` 验证 Windows 盘符、UNC、空格与中文路径；这些测试不代替原生平台执行。测试直接运行编译后的核心模块。

集成脚本调用插件共用的项目生成、构建和进程管理代码，在含空格及逗号的临时目录中：

- 实际用 NASM 构建并检查 512 字节与 `55 aa`。
- 实际用 QEMU TCG 无界面引导，15 秒内等待串口标记。
- 停止并确认进程结束，始终清理临时目录和进程。
- 将源码改为错误内容，确认真实 NASM 构建失败且旧镜像不可用。

可用 `NASM_PATH`、`QEMU_PATH` 环境变量覆盖集成脚本的工具路径。macOS 可先执行 `brew install nasm qemu`；Windows 可通过 Chocolatey 安装 `nasm qemu`，然后在插件设置中填写实际 `.exe` 路径。工具发现与停止行为需要在对应原生平台确认。

真实 VS Code 宿主验证：

```sh
# Linux 先安装 xvfb，然后运行
xvfb-run -a npm run test:host
# Windows / macOS 已有桌面会话时运行
npm run test:host
```

宿主脚本默认通过 `@vscode/test-electron` 下载稳定版 VS Code；可用 `VSCODE_VERSION=1.96.4` 选择最低支持版本，也可用 `VSCODE_EXECUTABLE_PATH` 指向已安装的 VS Code 可执行文件。脚本使用独立临时用户配置，验证真实宿主内的命令注册、信任限制、多工作区资源设置、真实 NASM/QEMU 构建运行停止、串口标记和错误 diagnostics。

CI 矩阵覆盖 Ubuntu、macOS、Windows，以及 VS Code 1.96.4 / stable；每组安装真实 NASM/QEMU，运行核心测试、集成与宿主测试。远端结果须以实际 Actions 检查为准。当前已执行的验证、平台限制及人工交互待验收项见 [验证记录](docs/VALIDATION.md)。
