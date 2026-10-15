# 0.2.0 右侧模拟显示器验证

日期：2026-10-15。环境：Linux x64、Node.js 22.23.3、NASM 2.16.03、QEMU 10.0.13 TCG，官方 VS Code 1.96.4 / 1.142.0 与 Xvfb。

## 实际结果

- `npm ci`、`npm run check`、`npm run compile` 通过。
- 0.2.0 VSIX打包通过，包含显示器脚本与样式；VSCode 1.96.4 CLI实际安装成功，列表确认为`nothingzhl.vscode-qemu-asm@0.2.0`。
- 单元测试共53项，52项通过，1项大小写不敏感文件系统测试在Linux跳过。包含QMP握手/请求匹配/断开超时、PPM→PNG像素及CRC、截图排队、键码限制、取消与会话清理。
- `npm run test:integration`、`npm run test:debug` 通过，原有引导与断点/寄存器/堆栈功能未回归。
- `npm run test:display` 真实QEMU通过：`-S`尚未执行BIOS即可截图；文字模式720×400；发送Enter被BIOS接收后切图形模式13h；逐像素确认640×400画面包含128000红色像素和128000绿色像素。运行与暂停均可截图，截图不改变CPU运行状态。
- 两版VSCode的全部5个宿主阶段通过：普通命令、受限工作区、多工作区、调试、显示器。
- 两版真实界面验证：左侧源码、第二列显示器；PNG实际加载；GUI开启键盘输入后发送q，真实客体串口回显确认；停止释放连接与临时目录，停止轮询并保留最后画面；关闭重开恢复；调试断点/单步与屏幕同时工作。

## 实际界面截图

![实际 VS Code 与 QEMU 屏幕](images/display-live.png)

截图来自正在运行的官方VSCode 1.142.0 Electron工作台。通过CDP读取实际Webview DOM、确认PNG加载与键盘客体回显后，调用工作台Page.captureScreenshot保存完整窗口。没有界面模拟、画面合成或图像后处理。截图时QEMU运行，截图完成后验证进程清理。

截图工具仅依赖Node.js 22与既有测试依赖：

```sh
# Linux需要Xvfb或已有显示会话；也可指定已安装的VSCode路径
xvfb-run -a npm run test:display:ui
```

可设置`VSCODE_EXECUTABLE_PATH`、`VSCODE_VERSION`、`NASM_PATH`、`QEMU_PATH`，以及`QEMU_ASM_DISPLAY_SCREENSHOT`指定图片输出路径。该工具使用独立用户目录，启动仅监听127.0.0.1的临时CDP端口，并在结束后关闭测试会话。

独立交付日志：qemu-asm-display-unit.log、qemu-asm-display-integration.log、qemu-asm-display-host-min.log、qemu-asm-display-host-current.log、qemu-asm-display-ui-min.log、qemu-asm-display-ui-current.log。最低版本界面截图另有qemu-asm-display-min.png。

## 已验证边界

显示器使用QEMU真实VGA屏幕截图，约5FPS，支持BIOS文字和图形模式。输入默认关闭，需开启并聚焦屏幕；键码白名单、Workspace Trust和独立会话所有权均有检查。停止/重启清理只针对本插件资源。

本次确认的是Linux真实宿主和图形输出；macOS/Windows原生结果尚未取得。CI已在三平台×两版VSCode中加入真实显示器集成与宿主测试。当前不转发鼠标、音频或输入法组合文字；并未增加保护模式/64位内核调试能力。
