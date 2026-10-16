# 接入真实 OS 工程：DreamOS

本例使用 [dreamos82/Dreamos](https://github.com/dreamos82/Dreamos) 的固定提交 `85393cbcdeb9ca0bafb84e9631c2c7f21be76141`。它是已有的 32 位 C/汇编内核工程，使用 Make 和 GRUB Legacy / Multiboot ISO 引导。接入保留上游内核源码、链接地址和加载器，通过附加构建配方及 `qemu-asm.json` 使用插件。

上游 README 与源码头的 GPL 版本表述存在差异；使用或分发上游代码时应核对相应文件的许可证。本仓库只保存接入配方，不复制或重新授权其内核代码。

## 环境与工具

本接入配方在 Linux 上使用 GCC（可生成 i386 代码）、GNU binutils、Make、NASM、Bash、sed、tar、Git 和 `genisoimage`；运行与调试还需要 QEMU 和支持 i386 的 GNU GDB。构建不链接宿主 32 位 libc。上游已携带 GRUB Legacy `stage2_eltorito` 和初始文件系统，不需要 `grub-mkrescue` 或 mtools。

ISO 脚本调用 `genisoimage`。若系统只有 xorriso，应由开发者显式提供兼容的 `xorriso -as mkisofs` 包装器；插件不会替换系统工具或修改 PATH。具体工具版本与包装器使用情况见[本次验证记录](OS_PROJECT_VALIDATION.md)。

`examples/dreamos` 是供开发者使用的接入配方，不随插件自动下载 OS，也不是插件创建项目命令提供的模板。

## 准备固定版本

以下命令由开发者主动执行，需要网络访问；插件不会自动下载工程或安装工具。在本插件源码仓库根目录执行：

```sh
git clone https://github.com/dreamos82/Dreamos.git /tmp/dreamos-upstream
git -C /tmp/dreamos-upstream checkout --detach 85393cbcdeb9ca0bafb84e9631c2c7f21be76141
node scripts/os-project/prepare.cjs /tmp/dreamos-upstream /tmp/dreamos-toolkit
```

目标目录必须不存在，脚本拒绝覆盖已有目录。它检查上游 HEAD，使用 `git archive` 导出固定提交（不带本地修改或构建产物），然后复制 [构建配方](../examples/dreamos/qemu-toolkit.mk) 和 [项目配置](../examples/dreamos/qemu-asm.json)。需要长期开发时，将目标路径改为自己的新工程目录。

## 构建边界

附加的 `qemu-toolkit.mk` 包含上游 Makefile，执行上游构建链，并作以下兼容处理：

- 使用宿主 GCC 的 `-fcommon -fno-pie -no-pie`，适配旧工程的公共符号和静态链接需求。
- 保留帧指针，便于调试展开。
- 上游 ISO 脚本预期根目录 `dreamos.img`，而构建生成 `generated/dreamos.img`；配方复制到其预期路径。
- 将工作副本中 GRUB 菜单等待时间设为零，并显式用 Bash 执行未带可执行权限的上游 ISO 脚本。

这些调整发生在导出的工作副本中，不修改上游仓库。构建时先独立运行：

```sh
make -C /tmp/dreamos-toolkit -f qemu-toolkit.mk toolkit-iso
```

产物为 `dreamos.iso`，调试符号为 `generated/kernel.bin`（ELF 文件，扩展名不影响识别）。两者必须来自同一次有效构建。

## 在 VS Code 中调试

打开并信任 `/tmp/dreamos-toolkit`，在扩展宿主中配置 QEMU 和支持 i386 的 GNU GDB。先执行 **QEMU Assembly: 检查环境**，再执行 **QEMU Assembly: 开始引导调试**。

项目配置使用 `boot.type: "iso"`，通过 Make 生成 ISO；调试入口是实际内核函数 `main_loop`。默认停在该入口，GRUB 负责装载内核，插件使用 ELF/DWARF 定位源码。

暂停后检查源码行、调用栈和变量，再查看寄存器、反汇编、虚拟/物理内存及 GDT/IDT。页表观察是否适用取决于当前 CPU 分页状态；不应把未开启分页误认为插件失败。修改 C 源码后重启，配置的 Make 命令会重新运行；确认断点和变量对应本次产物。

若希望完全手动构建，把 `build` 改为 `false`；此后插件不再调用 Make，重启前须自行重建。完整字段与 BIOS ISO 边界见[配置参考](CONFIGURATION.md#外部构建与-c-源码调试)，断点或源码映射问题见[排错](TROUBLESHOOTING.md#断点为空心或不命中)。

本次 Linux 真实调试、VS Code 宿主与独立安装包的实际结果见[验证记录](OS_PROJECT_VALIDATION.md)。

## 复用到其他工程

第二个已接入工程为 [Tilck](TILCK_VALIDATION.md)，使用 CMake、musl 工具链和高虚拟地址分页内核，保留上游构建与链接布局。它与本例使用同一套外部构建、ISO、ELF 和源码映射能力；具体执行范围见其验证记录。

为自己的工程提供构建命令、可引导 ISO、带 DWARF 的 i386 ELF32，以及合适的入口即可；不需要采用 DreamOS 的目录布局。插件当前不支持 ELF64、PIE、UEFI-only ISO、动态符号重定位或多 CPU。构建配方能运行、协议测试通过和 VS Code 界面验收是不同证据范围，实际执行结果须查看对应验证记录。
