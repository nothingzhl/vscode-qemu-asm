# 配置参考

插件使用两类配置：VS Code 设置负责工具和工作区位置，项目内的 `qemu-asm.json` 负责构建方式、引导介质和调试符号。首次使用可先按[快速开始](QUICKSTART.md)生成最小项目。

## VS Code 设置

设置可按工作区文件夹保存。多工作区下，命令会先选择项目所属的工作区。

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `qemuAsm.nasmPath` | `nasm` | NASM 可执行文件；外部构建无需插件内置 NASM |
| `qemuAsm.qemuPath` | `qemu-system-i386` | QEMU 可执行文件 |
| `qemuAsm.gdbPath` | `gdb` | 仅 C/ELF 源码调试需要的 GDB |
| `qemuAsm.projectDirectory` | `.` | 包含 `qemu-asm.json` 的项目目录 |
| `qemuAsm.displayMode` | `auto` | `auto` 创建模拟显示器；`off` 不分配 QMP 显示资源 |
| `qemuAsm.qemuArgs` | `[]` | 仅接受 `-m`、`-cpu`、`-smp` 的选项/值对 |

例如工作区 `.vscode/settings.json`：

```json
{
  "qemuAsm.projectDirectory": "kernel",
  "qemuAsm.qemuPath": "/opt/qemu/bin/qemu-system-i386",
  "qemuAsm.qemuArgs": ["-m", "32M", "-cpu", "qemu32", "-smp", "1"],
  "qemuAsm.displayMode": "auto"
}
```

`projectDirectory` 和设置里带分隔符的相对工具路径以**所选工作区文件夹**为基准；绝对路径直接使用，裸工具名从 PATH 查找。工具路径只填写可执行文件，不包含参数或外层引号。不展开 `~`、环境变量或 `${workspaceFolder}`。Windows 请用 `C:\Tools\qemu-system-i386.exe` 这样的完整路径，不能用 `C:tool.exe` 盘符相对路径；在 JSON 中反斜杠须写为 `\\`。

工具运行于扩展宿主。WSL、容器或 SSH 窗口内的 PATH 和文件系统与本地窗口不同，详见[环境排错](TROUBLESHOOTING.md#工具找不到或路径不对)。

## 单扇区 NASM 项目

项目根目录的 `qemu-asm.json`：

```json
{
  "source": "boot.asm",
  "image": "build/boot.img"
}
```

`source`、`image` 相对项目目录解析。内置 NASM 构建使用 `-f bin`，单扇区产物要求恰好 512 字节，结尾为 `55 aa`。源码映射要求显式 `BITS 16` 和唯一的 `ORG 0x7c00`，其他限制见[调试范围](DEBUGGING.md#支持范围)。

镜像必须在项目内，不可覆盖源码或配置。构建器检查实际文件身份和目录链接，防止别名覆盖；输出目录不能通过符号链接跳出项目。构建失败、取消或超时后不会运行旧镜像。

## 二阶段 NASM 项目

```json
{
  "source": "boot.asm",
  "image": "build/boot.img",
  "stages": [
    { "source": "stage2.asm", "loadAddress": 32768, "lba": 1 }
  ]
}
```

构建器独立汇编每个源文件，生成 1.44 MB raw 软盘镜像。引导扇区在 LBA 0，各阶段按 `lba` 写入并补零到 512 字节边界。

- 最多 8 个阶段；补齐后的磁盘范围必须位于 LBA 1..17，合计最多 8704 字节且不重叠。
- 每阶段 `loadAddress` 必须与其 `ORG` 一致；补齐后的内存范围位于 `0x8000..0x9ffff`，彼此不重叠。
- `loadAddress` 描述预期加载地址，**不会代替客体读盘**。内置引导程序只把首阶段从 LBA 1 加载到 `0x8000`，使用该加载器时保留这两个值。
- 构建器向引导文件传入首阶段扇区数 `STAGE2_SECTORS`。增加阶段或改变布局时，需自行修改加载器；纯 `BITS 32` 阶段要求加载器先进入相应保护模式。

已有多阶段工程无需采用内置模板，但必须满足磁盘布局和源码映射边界。

## 外部构建与 C 源码调试

项目可沿用自己的编译器、链接器和加载器：

```json
{
  "image": "build/os.iso",
  "boot": { "type": "iso" },
  "build": {
    "command": "make",
    "args": ["debug"],
    "cwd": ".",
    "timeout": 120000
  },
  "debug": {
    "elf": "build/kernel.elf",
    "gdbPath": "gdb",
    "entry": "kernel_main",
    "sourceMap": { "/original/build": "." }
  }
}
```

| 字段 | 规则 |
| --- | --- |
| `boot.type` | `floppy`（默认）或 `iso`；ISO 使用 BIOS El Torito 光盘引导 |
| `build` | 命令对象表示构建后启动；`false` 表示直接使用已有产物；省略时保持内置 NASM 构建 |
| `build.command` | 单个可执行文件，不解释 shell 语法；裸命令查 PATH，带路径时相对项目根解析 |
| `build.args` | 参数数组，默认 `[]`，最多 256 项 |
| `build.cwd` | 默认项目目录；实际目录必须在项目内，不能通过链接跳出 |
| `build.timeout` | 毫秒，默认 120000，范围 100..1800000 |
| `debug.elf` | 符号文件路径，相对项目根；要求带 DWARF 的小端 i386 ELF32 `ET_EXEC` |
| `debug.gdbPath` | 项目级 GDB，覆盖 `qemuAsm.gdbPath`；带路径时相对项目根 |
| `debug.entry` | 函数符号或 32 位 `0x` 地址；省略时使用 ELF 入口 |
| `debug.sourceMap` | 构建时源码目录到当前目录的映射；目标目录相对项目根 |

仅需外部构建并运行时，可省略 `debug`。外部构建或已有产物模式不能同时配置 NASM `stages`，也不会额外调用 NASM。ISO 要求显式配置外部构建或 `build: false`，内置 NASM 构建只生成软盘镜像。

镜像必须是项目内普通文件，不能与 ELF、配置或已声明源码指向同一文件；目录不能通过符号链接跳出项目。

- `floppy`：512..1474560 字节、按 512 字节对齐，首扇区末尾为 `55 aa`。
- `iso`：按 2048 字节对齐，包含 ISO9660 卷描述符和有效的默认 BIOS x86 El Torito 引导项；仅 UEFI 的 ISO 不支持。不再应用软盘容量和首扇区签名规则。

外部构建产物由工程管理，插件不预先删除镜像、ELF 或其他产物。构建失败、超时或取消会阻止本次启动，即使磁盘上仍有旧镜像。构建成功后再检查镜像；插件不通过时间戳推断产物是否更新，构建系统负责让镜像与符号匹配。

### 使用已有产物

先在项目自己的环境完成构建，再明确选择：

```json
{
  "image": "build/os.iso",
  "boot": { "type": "iso" },
  "build": false,
  "debug": {
    "elf": "build/kernel.elf",
    "entry": "kernel_main"
  }
}
```

此模式的构建、运行、调试及重启都只验证并使用已有文件，不执行编译，也不要求 NASM 或构建器；修改源码后必须自行重建。只运行镜像可省略 `debug`；外部构建、已有产物和 ISO 项目若要源码调试，必须配置 `debug.elf`。

项目的 BIOS 引导器（例如 ISO 内的 GRUB）负责装载内核到 ELF 链接地址，插件不实现 Multiboot 加载器，也不执行 GDB `load`。ELF64、PIE/ET_DYN、未链接目标文件和缺失调试节的 ELF 会被拒绝。硬盘、`-kernel`、UEFI 和远程 attach 尚未提供。

## 保存调试启动项

直接执行开始调试命令即可，无需创建 `launch.json`。需要保存启动项时，把以下内容加入已有 `.vscode/launch.json` 的 `configurations` 数组；插件不会覆盖该文件：

```json
{
  "type": "qemu-asm",
  "request": "launch",
  "name": "OS 开发：32 位内核调试",
  "stopOnEntry": true
}
```

NASM 默认停在 `0x7c00`；C 项目停在配置入口或 ELF 入口。设为 `false` 时继续运行，用户断点仍然生效。

## 进程和执行边界

外部工具执行与项目创建要求 Workspace Trust，且只支持文件系统工作区。参数按数组传递，不经 shell；Windows `.cmd/.bat` 构建脚本须显式配置解释器和参数。

QEMU 固定使用 TCG、串口 stdout 和无网络配置；按 `boot.type` 使用只读 raw 软盘或 ISO 光盘，不依赖 KVM；画面通过 QMP 显示。额外参数只允许内存、CPU 类型和 CPU 数量，调试要求单 CPU。构建命令不应自行脱离进程组或启动长期后台服务。停止、失败、取消和退出只清理插件拥有的资源；原生平台执行范围见[兼容性](COMPATIBILITY.md)。
