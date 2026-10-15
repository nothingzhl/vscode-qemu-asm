# 首版验证记录

日期：2026-10-15。执行环境：Linux x86_64 / Debian 13。

| 项目 | 结果 |
| --- | --- |
| Node.js | 22.23.3 |
| `npm ci` | 通过（缓存目录设为可写临时目录） |
| `npm run check` | 通过，TypeScript 严格模式 |
| `npm run compile` | 通过 |
| `npm test` | 10 项通过，0 跳过 |
| NASM | 2.16.03；实际构建镜像 512 字节，尾部 `55 aa` |
| QEMU | 10.0.13；TCG、无界面，串口收到 `QEMU_ASM_BOOT_OK` |
| 停止与失败 | 集成脚本确认 QEMU 结束；真实 NASM 错误后旧产物不存在 |
| VSIX | `@vscode/vsce package` 成功，包含编译后核心模块与入口 |

系统目录不可写，因此 NASM、QEMU 及缺失库通过 Debian 软件包下载并解包到临时目录。QEMU 包装脚本用 `exec` 转交启动，并用 `-L` 指定解包后的 QEMU / SeaBIOS 固件目录；没有使用 KVM。集成测试的项目目录包含空格和逗号，QEMU 工具包装路径也包含空格。

标准 Ubuntu 环境直接安装 `nasm qemu-system-x86`，然后运行 `npm run test:integration` 即可复现。完整命令与环境变量见 README；CI 已配置真实工具安装与验证，远端 CI 是否通过须以实际检查为准。

未验证：VS Code 扩展宿主 GUI 交互、实际 VSIX 安装、多工作区交互与宿主关闭流程，以及 macOS / Windows。核心进程清理和多工作区路径解析已有自动化测试，不能据此宣称以上平台及宿主场景已完成验收。

打包工具提示仓库尚未提供 LICENSE；本次没有擅自选择或添加许可证。
