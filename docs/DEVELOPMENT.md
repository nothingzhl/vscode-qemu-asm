# 开发、测试与打包

本页面向修改插件源码和维护 CI 的开发者。仅安装 VSIX 的用户无需此处的 Node/npm、测试工具和录制依赖，先读[快速开始](QUICKSTART.md)。代码变更遵循 [AGENTS.md](../AGENTS.md)；模块边界见[架构图](ARCHITECTURE.md)与[代码结构](STRUCTURE.md)。

## 从源码运行

开发环境使用 Node.js 22.12 或更新的 22.x（CI 使用 Node 22）。首次检出仓库后运行：

```sh
npm ci
npm run check
npm run compile
npm test
```

在 VS Code 打开仓库，按 F5 启动扩展开发宿主。在新窗口打开并信任一个临时项目，按[快速开始](QUICKSTART.md)验证实际命令。运行客体需要 NASM/QEMU；C 集成还需要支持 i386 的 GCC、GNU binutils 和 GDB，编译器由测试项目使用，不是安装插件的统一前提。

## 分层验证

| 层次 | 入口 | 能证明什么 |
| --- | --- | --- |
| 类型与单元 | `npm run check`、`npm test` | 契约、状态机、解析、路径、异常与取消、资源清理、架构边界 |
| 真实 NASM/QEMU | 下表的 `test:*` 脚本 | 实际镜像、协议、机器状态与进程生命周期 |
| VS Code 宿主 | `npm run test:host` | 命令、信任边界、DAP、视图和会话接入 |
| 独立安装包 | `test:vsix:*` | 安装后的产品与生产依赖能否脱离源码目录工作 |

替身测试不能证明真实后端兼容，路径模拟不能证明原生平台通过；VS Code 宿主测试也不能替代独立安装包测试。版本样本、执行结果与 CI 的关系见[兼容性](COMPATIBILITY.md)。

### 真实工具回归

| 命令 | 场景 |
| --- | --- |
| `npm run test:integration` | 引导构建、串口标记、停止和错误产物失效 |
| `npm run test:debug` | RSP 调试、寄存器、源码映射、步进与模式校验 |
| `npm run test:stage` | 阶段布局、补零、镜像失效与二阶段引导 |
| `npm run test:protected` | 多文件断点、实模式到保护模式、EBP 链 |
| `npm run test:display` | QMP、文字/图形截图、键盘与清理 |
| `npm run test:inspection` | 内存、段缓存、描述符、读取边界 |
| `npm run test:machine` | 数据断点、反汇编、地址断点与共存 |
| `npm run test:paging` | 物理访问恢复、非恒等映射、页表与跨页边界 |
| `npm run test:c-machine` | 外部 GCC 客体的机器级调试 |
| `npm run test:c-source` | ELF/DWARF、GDB 源码步进、变量、帧与分页 |
| `npm run test:os-project` | 固定版本 DreamOS 的原生构建/启动基线、ISO 源码调试、分页、重启与失败阻断 |
| `npm run test:os-project:host` | 同一真实工程的 VS Code 调试接入 |
| `npm run test:dependencies` | 统一工具解析、按需依赖、能力证据与会话隔离 |
| `npm run test:profiles` | 实际 RAM/CPU 配置、NASM/C 启动与重启、显示资源、无效 CPU 和清理 |

真实 OS 接入测试须先按[接入指南](OS_PROJECT.md)准备固定提交，并设置 `DREAMOS_SOURCE`；宿主测试另设置 `VSCODE_EXECUTABLE_PATH`，不会自动下载上游 OS。

脚本在含空格/逗号的临时目录生成客体，结束后清理。支持用 `NASM_PATH`、`QEMU_PATH`、`GDB_PATH` 指定工具；C 测试另可使用 `CC`、`LD`、`OBJCOPY`、`NM`。平台和工具组合没有实际运行时不要记为通过。

### VS Code 宿主

Linux 无桌面环境时使用 Xvfb；已有桌面会话的 Windows/macOS 可直接运行：

```sh
xvfb-run -a npm run test:host
```

脚本默认下载 VS Code stable；`VSCODE_VERSION=1.96.4` 选择声明支持范围内的旧版本，`VSCODE_EXECUTABLE_PATH` 指向已有可执行文件。每阶段使用独立临时用户配置。

可通过 `QEMU_ASM_HOST_PHASES` 选择 `trusted,untrusted,resources,debug,display,protected,inspection,machine,paging,c-source,dependencies,machine-profiles` 的子集，例如：

```sh
QEMU_ASM_HOST_PHASES=debug,machine-profiles xvfb-run -a npm run test:host
```

新启动方案的真实配置编辑器与选择器截图可执行 `xvfb-run -a npm run test:profiles:ui`，输出目录通过 `QEMU_ASM_PROFILES_SCREENSHOT_DIRECTORY` 指定。

这是 POSIX shell 写法；PowerShell 用 `$env:QEMU_ASM_HOST_PHASES = 'debug,machine-profiles'` 后运行命令。`machine-profiles` 阶段验证方案命令、项目 JSON 编辑器和 Schema、按项目记忆、启动项覆盖与重启。界面交互、截图与录屏依赖独立的 UI 脚本和工具，见[各阶段历史记录](README.md#历史验证记录)及[录屏复现](demos/README.md#重新录制)。

## 打包与独立安装验证

先执行类型、单元和本次改动相关的真实集成，再生成 VSIX：

```sh
npx @vscode/vsce@4.0.0 package --out ../vscode-qemu-asm.vsix
```

VSCE 会将 README 相对链接转换为 GitHub 链接。分支交付可加 `--githubBranch <分支或提交>`；主 CI 使用当次 `GITHUB_SHA`，避免新文档链接指向默认分支而失效。

保留生产依赖，**不要添加 `--no-dependencies`**；iced-x86 的 JS 和 WebAssembly 必须进入安装包。`dist/` 是生成目录，重命名或删除生产模块后应清理旧输出再编译，避免陈旧文件进入 VSIX。

把 VSIX 安装到仓库外的独立扩展目录，例如使用 VS Code CLI：

```sh
code --extensions-dir /tmp/qemu-asm-installed --install-extension ../vscode-qemu-asm.vsix --force
```

将 `QEMU_ASM_VSIX_EXTENSION` 指向该目录内实际的扩展文件夹（其中含 `package.json`，不是 `.vsix` 文件），分别运行：

```sh
npm run test:vsix:dependencies
npm run test:vsix:machine
npm run test:vsix:paging
npm run test:vsix:c-source
npm run test:vsix:profiles
```

Linux 无桌面时加 `xvfb-run -a`。测试会把输入复制到仓库外，并从安装目录加载产品和 WASM。打包不是 Marketplace 发布；仓库维护规则禁止自动发布。

## 覆盖率、性能和 CI

| 命令 | 输出与用途 |
| --- | --- |
| `npm run docs:check` | 全仓 Markdown 内部链接/标题锚点，当前指南的 JSON、命令和配置键检查 |
| `npm run test:coverage` | 单元/契约测试及 `artifacts/coverage/` 下的 HTML、LCOV、JSON |
| `npm run test:ci` | 一次编译后执行 15 组真实后端脚本（真实 OS 工程由独立 CI 任务验收），逐项日志及结果位于 `artifacts/integration/` |
| `npm run test:compatibility` | 用当前选择的真实工具运行版本兼容场景，结果位于 `artifacts/compatibility/` |
| `npm run test:performance` | 显示编码、静止/变化画面、观察器耗时和保留内存 |
| `npm run test:performance:resources` | 100 次资源生命周期及内存历史清理 |
| `npm run test:performance:display` | 实际 QEMU 客体显示流水线 |

覆盖统计使用 V8 与源码映射，包含未加载的生产文件；纯类型声明、模板字符串数据和兼容导出排除，不隐藏普通业务模块。当前门槛为行/语句 80%、分支 80%、函数 85%，配置在 `.c8rc.json`。VS Code 宿主入口在 Node 单元统计中可能未执行，实际宿主测试另行验收；覆盖率不能代替这些测试。缺少 NASM 时仅相关的可选真实汇编案例跳过，完整工具验收放在独立 CI 层。

性能命令显式使用 `--expose-gc`，输出耗时、CPU、heap、Buffer 与 RSS，宽松阈值用于捕获严重回退。对比方法、原始样本和优化代价见[性能说明](PERFORMANCE.md)。这些报告不把 QEMU/GDB 客体进程的内存算作扩展模块本身的内存。

主 CI 按质量检查、Linux 完整后端、原生平台冒烟、宿主、打包与独立安装分层；`CI result` 要求所有主层成功。性能与旧工具矩阵分别由独立工作流执行和上传结果，失败不会被 `continue-on-error` 隐藏。历史远端失败日志在当前环境不可读取，工作流调整和本地实测不等同于承诺 GitHub 所有组合已绿。

启动方案的校验、优先级和参数覆盖有独立单元测试；真实工具入口 `test:profiles` 验证机器的实际 RAM 与 CPU，而不是只比对参数。旧工具矩阵也执行相同的 NASM 方案场景，独立安装包执行 `test:vsix:profiles`，避免只在源码开发环境中可用。配置支持与执行结果分开记录，不能从 Schema 补全推定所有 CPU 或版本可用。

覆盖率用于找出未覆盖的分支，仍应通过独立行为断言验证失败、取消和清理。性能测试应区分扩展进程、解码器与外部 QEMU/GDB，记录输入规模和工具版本，方法见[性能](PERFORMANCE.md)。多版本用同一组真实协议和功能测试验收，不能只比较版本字符串。

CI 定义位于 [GitHub Actions 工作流](../.github/workflows/ci.yml)。远端通过与否以对应提交的 Actions 结果为准；本地重现结果、计划矩阵和历史通过结果应分别记录。原始历史材料保留在[验证索引](README.md#历史验证记录)。

## CI 下载缓存

PR 更新运行完整检查；`push` 只对 `main` 自动执行，避免同一功能分支的 push 和 PR 各下载、测试一遍。其他分支需要在创建 PR 前验证时，可手动触发工作流。测试矩阵和最终门禁保持原有范围。

| 缓存 | 范围与失效规则 |
| --- | --- |
| npm | 继续使用 `setup-node` 的 lockfile 缓存；每次执行 `npm ci --prefer-offline`，不缓存项目 `node_modules` |
| VS Code | 只保存当前平台、架构、精确版本的发行目录，并区分 test-electron 版本；不缓存用户配置、日志、测试工作区或扩展安装目录 |
| Linux 工具 | 缓存 `.deb` 下载文件，按宿主镜像、包集合与安装配方隔离；apt 每次刷新索引并安装/校验，旧包不会强制覆盖当前版本 |
| Ubuntu 版本矩阵 | 每个发行版单独缓存 Ubuntu 基础镜像和 `.deb`；每次 pull 检查当前镜像清单，再从容器原生 apt 安装并记录实际工具版本 |
| macOS / Windows 工具 | 缓存 Homebrew 下载目录和 Chocolatey 安装包下载目录；每次仍通过原生包管理器安装，不恢复已安装目录、注册表或系统库 |
| actionlint / VSCE | 分别缓存固定版本的检查器可执行文件和隔离的 npm 工具下载目录；版本变更产生新缓存 |

系统工具的下载缓存按周生成新键，并可复用上周的下载文件；包管理器负责检查所需版本和校验和。发行版兼容测试仍使用当次仓库的工具组合，精确版本以报告为准。缓存未命中时执行正常下载和安装，缓存本身不作为测试通过的证据。VS Code 与原生工具下载准备成功后即保存缓存，后续测试失败不会丢失这些已准备资源。

`stable` 每次先从官方发布列表解析成具体版本，再查找 VS Code 缓存；命中后所有宿主/安装包入口使用同一准备好的 `VSCODE_EXECUTABLE_PATH`，不再各自重新解析或下载。版本查询带有有限重试，查询失败会明确失败，不悄悄退回缓存里的旧版本。固定版本命中完整缓存时无需访问版本服务。

GitHub 缓存有分支作用域、容量和淘汰规则。首次运行、版本升级或缓存被淘汰时仍需下载；实际命中结果见 Actions 缓存步骤与作业摘要。首次冷缓存与后续热缓存耗时须分别观察，不从配置推断加速比例。

本轮本地验证（2026-10-16，Linux x64）：真实 VS Code 1.96.4 冷启动下载约 142.5 MB，热启动直接复用完整发行目录；缓存宿主上的 DreamOS 调试通过。Ubuntu 22.04 容器工具包冷启动下载 97.4 MB，复用下载目录后 apt 报告 `Need to get 0 B/97.4 MB`，两次真实兼容测试均通过；基础镜像归档保存/载入通过。缓存单元测试覆盖固定版本离线命中、stable 升级失效、查询失败及无效响应。这些本地结果不代表 GitHub 缓存命中耗时或 macOS/Windows 缓存已实测；远端结果以相应 PR 检查为准。
