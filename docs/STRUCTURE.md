# 当前代码结构

本文按职责导航生产代码，不绑定开发分支；文件清单应随相关代码改动更新，不包含生成的 `dist/` 或 `node_modules/`。

| 目录 | 职责 |
| --- | --- |
| `composition` | 实现选择与依赖组装 |
| `ports` | 按使用场景拆分的能力契约 |
| `domain` | CPU、源码映射、检查结果与能力模型 |
| `application` | 功能流程、会话资源、变量和断点状态 |
| `integration` | DAP / VS Code 请求、注册与展示接入 |
| `backends` | NASM、RSP、QEMU、GDB/MI、iced-x86 的实现细节 |
| `platform` | 宿主、进程、网络端点 |
| `project` | 项目与启动方案配置、构建、安全创建及模板 |
| `dependencies` | 工具解析、检查和能力事实记录 |
| `display` / `inspector` | 显示器与调试观察器 |
| `debug` / `core.ts` | 兼容旧集成入口，生产代码不依赖 |

建议先看 [架构图](ARCHITECTURE.md)，再按 `composition → ports → application/integration → backends` 阅读。

```text
src/
├── application/
│   ├── assembly/
│   │   ├── frames.ts
│   │   ├── maps.ts
│   │   ├── sources.ts
│   │   ├── stepping.ts
│   │   └── variables.ts
│   ├── inspection/
│   │   ├── descriptors.ts
│   │   ├── memory.ts
│   │   ├── paging.ts
│   │   └── requests.ts
│   ├── machine/
│   │   └── breakpoints.ts
│   ├── source/
│   │   ├── bindings.ts
│   │   ├── machineValues.ts
│   │   ├── values.ts
│   │   └── valuesModel.ts
│   ├── disassembly.ts
│   ├── format.ts
│   ├── release.ts
│   ├── runSession.ts
│   └── sessionResources.ts
├── backends/
│   ├── gdb/
│   │   ├── configure.ts
│   │   ├── connection.ts
│   │   ├── elf.ts
│   │   ├── memory.ts
│   │   ├── miClient.ts
│   │   ├── miParser.ts
│   │   ├── path.ts
│   │   ├── qemuBackend.ts
│   │   ├── registers.ts
│   │   ├── sourceAdapter.ts
│   │   ├── sourceBreakpoints.ts
│   │   ├── sourceVariables.ts
│   │   └── values.ts
│   ├── iced/
│   │   └── decoder.ts
│   ├── nasm/
│   │   ├── listing.ts
│   │   ├── sourceSyntax.ts
│   │   └── sources.ts
│   ├── qemu/
│   │   ├── arguments.ts
│   │   ├── cpuModels.ts
│   │   ├── monitor.ts
│   │   ├── rspBackend.ts
│   │   ├── rspBreakpoints.ts
│   │   ├── rspMemory.ts
│   │   ├── rspStopped.ts
│   │   ├── rspTarget.ts
│   │   ├── rspValidation.ts
│   │   └── virtualMachine.ts
│   └── rsp/
│       ├── client.ts
│       ├── codec.ts
│       └── registers.ts
├── composition/
│   ├── createAdapter.ts
│   ├── options.ts
│   └── sessionServices.ts
├── debug/
│   ├── adapter.ts
│   ├── cAdapter.ts
│   ├── disassembly.ts
│   ├── gdbRuntime.ts
│   ├── inspection.ts
│   ├── listing.ts
│   ├── machineBreakpoints.ts
│   ├── maps.ts
│   ├── mi.ts
│   ├── paging.ts
│   ├── rsp.ts
│   └── runtime.ts
├── dependencies/
│   ├── capabilities.ts
│   ├── doctor.ts
│   └── tools.ts
├── display/
│   ├── controller.ts
│   ├── frames.ts
│   ├── panel.ts
│   ├── qmp.ts
│   └── screen.ts
├── domain/
│   ├── source/
│   │   ├── expression.ts
│   │   └── map.ts
│   ├── x86/
│   │   ├── descriptors.ts
│   │   ├── stack.ts
│   │   └── state.ts
│   ├── capabilities.ts
│   ├── inspection.ts
│   ├── paging.ts
│   └── validation.ts
├── inspector/
│   ├── model.ts
│   ├── provider.ts
│   ├── snapshots.ts
│   ├── types.ts
│   └── validation.ts
├── integration/
│   ├── dap/
│   │   ├── assemblyAdapter.ts
│   │   ├── assemblyBreakpoints.ts
│   │   ├── assemblyViews.ts
│   │   ├── channel.ts
│   │   ├── inspectionRequests.ts
│   │   ├── machineRequests.ts
│   │   ├── protocol.ts
│   │   ├── sourceAdapter.ts
│   │   ├── sourceBreakpoints.ts
│   │   └── sourceViews.ts
│   └── vscode/
│       ├── build.ts
│       ├── dependencyReports.ts
│       ├── displaySession.ts
│       ├── examples.ts
│       ├── inspector.ts
│       ├── machineProfiles.ts
│       └── projects.ts
├── platform/
│   ├── host.ts
│   ├── ports.ts
│   └── processes.ts
├── ports/
│   ├── assembly.ts
│   ├── build.ts
│   ├── inspection.ts
│   ├── instructions.ts
│   ├── machine.ts
│   ├── presentation.ts
│   ├── session.ts
│   ├── source.ts
│   └── virtualMachine.ts
├── project/
│   ├── templates/
│   │   ├── boot.ts
│   │   └── protected.ts
│   ├── artifact.ts
│   ├── build.ts
│   ├── builder.ts
│   ├── config.ts
│   ├── create.ts
│   ├── diagnostics.ts
│   ├── iso.ts
│   ├── machineProfiles.ts
│   └── model.ts
├── core.ts
└── extension.ts
```

`schemas/qemu-asm.schema.json` 为项目 JSON 提供补全、字段说明与静态校验；运行前的语义和 CPU 型号校验仍由生产代码执行。`test/` 包含单元、架构边界、文件预算与宿主行为测试；`scripts/` 包含真实工具、VS Code 和独立安装包验证入口；`media/` 保存 Webview 资源；`docs/` 保存架构、验证与功能演示记录。
