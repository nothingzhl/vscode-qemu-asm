# 文档导航

本项目面向操作系统开发，当前聚焦 QEMU 上的 x86 引导程序与 32 位内核调试。已有 OS 工程先读[配置参考](CONFIGURATION.md)与[调试指南](DEBUGGING.md)；首次检查工具链可按[快速开始](QUICKSTART.md)运行最小示例。

## 使用插件

| 文档 | 解决的问题 |
| --- | --- |
| [快速开始](QUICKSTART.md) | 安装后如何完成第一次构建、运行和断点调试 |
| [真实 OS 工程](OS_PROJECT.md) | 接入固定版本 DreamOS，保留已有 Make / GRUB / ISO 构建链 |
| [配置参考](CONFIGURATION.md) | 工具路径、多套启动方案、引导介质、外部构建和 ELF/DWARF |
| [调试指南](DEBUGGING.md) | 汇编/C 单步、调用栈、内存、描述符、页表、显示器及功能边界 |
| [常见问题](TROUBLESHOOTING.md) | 环境、构建、断点、显示器与远程宿主问题 |
| [兼容性](COMPATIBILITY.md) | 平台、工具版本、实际验证与 CI 矩阵的区别 |
| [功能演示](demos/README.md) | 8 段独立视频、GIF 与录制说明 |

## 开发与维护

| 文档 | 解决的问题 |
| --- | --- |
| [开发指南](DEVELOPMENT.md) | 源码运行、测试层次、独立 VSIX 验证和打包 |
| [插件架构](ARCHITECTURE.md) | 能力契约、实现组装、依赖方向与资源生命周期 |
| [代码结构](STRUCTURE.md) | 当前目录与文件职责 |
| [性能](PERFORMANCE.md) | 可重复测量、内存范围和回归检查 |
| [协作规则](../AGENTS.md) | 后续代码和测试必须遵守的约束 |

## 历史验证记录

以下保留各阶段执行时的版本、环境、命令与证据，不作为最新兼容声明。较新代码的结果以对应提交的 CI 产物和[兼容性文档](COMPATIBILITY.md)为准；本地日志路径可能只存在于当时的执行环境。

| 阶段 | 记录 |
| --- | --- |
| 启动方案（0.9.0） | [启动方案验收](MACHINE_PROFILES_VALIDATION.md) |
| 真实 OS 工程接入（2026-10-16） | [DreamOS ISO 验证](OS_PROJECT_VALIDATION.md) |
| 首版、历次版本概览 | [验证记录](VALIDATION.md) |
| 汇编调试与保护模式 | [基础调试](DEBUG_VALIDATION.md) · [二阶段保护模式](PROTECTED_VALIDATION.md) |
| 机器状态与画面 | [显示器](DISPLAY_VALIDATION.md) · [内存与描述符](INSPECTION_VALIDATION.md) |
| 地址、访问与分页 | [反汇编和数据断点](MACHINE_DEBUG_VALIDATION.md) · [分页](PAGING_VALIDATION.md) |
| C 源码调试 | [ELF/DWARF 验证](C_SOURCE_VALIDATION.md) |
| 依赖隔离 | [阶段设计](DEPENDENCY_REFACTOR.md) · [阶段验证](DEPENDENCY_VALIDATION.md) |
| 能力架构重构 | [首轮验证](ARCHITECTURE_VALIDATION.md) · [第二轮收敛](ARCHITECTURE_REFINEMENT.md) |
| 2026-10-15 质量整理 | [质量验收](QUALITY_VALIDATION.md) |
