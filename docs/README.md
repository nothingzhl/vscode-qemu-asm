# 文档导航

初次使用按[快速开始](QUICKSTART.md)操作；已有项目先读[配置参考](CONFIGURATION.md)。无需从历史验收报告开始阅读。

## 使用插件

| 文档 | 解决的问题 |
| --- | --- |
| [快速开始](QUICKSTART.md) | 安装后如何完成第一次构建、运行和断点调试 |
| [配置参考](CONFIGURATION.md) | 工具路径、多套启动方案、NASM 阶段、外部构建和 ELF/DWARF |
| [调试指南](DEBUGGING.md) | 汇编/C 单步、调用栈、内存、描述符、页表、显示器及功能边界 |
| [常见问题](TROUBLESHOOTING.md) | 环境、构建、断点、显示器与远程宿主问题 |
| [兼容性](COMPATIBILITY.md) | 平台、工具版本、实际验证与 CI 矩阵的区别 |
| [功能演示](demos/README.md) | 8 段独立视频、GIF 与录制说明 |

## 开发与维护

| 文档 | 解决的问题 |
| --- | --- |
| [开发指南](DEVELOPMENT.md) | 源码运行、测试层次、独立 VSIX 验证和打包 |
| [启动方案验收](MACHINE_PROFILES_VALIDATION.md) | 0.9.0 的真实截图、配置行为、工具版本与安装包验证 |
| [质量基线验收](QUALITY_VALIDATION.md) | 上一轮代码清理、测试覆盖、真实集成、性能与 CI 结果 |
| [插件架构](ARCHITECTURE.md) | 能力契约、实现组装、依赖方向与资源生命周期 |
| [代码结构](STRUCTURE.md) | 当前目录与文件职责 |
| [性能](PERFORMANCE.md) | 可重复测量、内存范围和回归检查 |
| [协作规则](../AGENTS.md) | 后续代码和测试必须遵守的约束 |

## 历史验证记录

以下保留各阶段执行时的版本、环境、命令与证据，不作为最新兼容声明。较新代码的结果以对应提交的 CI 产物和[兼容性文档](COMPATIBILITY.md)为准；本地日志路径可能只存在于当时的执行环境。

| 阶段 | 记录 |
| --- | --- |
| 首版、历次版本概览 | [验证记录](VALIDATION.md) |
| 汇编调试与保护模式 | [基础调试](DEBUG_VALIDATION.md) · [二阶段保护模式](PROTECTED_VALIDATION.md) |
| 机器状态与画面 | [显示器](DISPLAY_VALIDATION.md) · [内存与描述符](INSPECTION_VALIDATION.md) |
| 地址、访问与分页 | [反汇编和数据断点](MACHINE_DEBUG_VALIDATION.md) · [分页](PAGING_VALIDATION.md) |
| C 源码调试 | [ELF/DWARF 验证](C_SOURCE_VALIDATION.md) |
| 依赖隔离 | [阶段设计](DEPENDENCY_REFACTOR.md) · [阶段验证](DEPENDENCY_VALIDATION.md) |
| 能力架构重构 | [首轮验证](ARCHITECTURE_VALIDATION.md) · [第二轮收敛](ARCHITECTURE_REFINEMENT.md) |

## 这次文档整理参考了什么

本次实际阅读了以下开源扩展的 README，采用它们的信息组织方式，没有复制产品说明或支持承诺：

- [VS Code Go](https://github.com/golang/vscode-go/blob/master/README.md)：先列 Requirements / Quick Start，再按用户任务链接功能、工具和排错文档。
- [Microsoft C/C++](https://github.com/microsoft/vscode-cpptools/blob/main/README.md)：把外部编译器、调试器前提和插件本身的安装区分开，详细教程单独组织。
- [VSCodeVim](https://github.com/VSCodeVim/Vim/blob/master/README.md)：让安装、配置、FAQ 和参与开发各有明确入口。

因此根 README 保留产品范围、安装和首次成功路径；配置细节、操作指南、开发命令及历史证据分别放到本目录。
