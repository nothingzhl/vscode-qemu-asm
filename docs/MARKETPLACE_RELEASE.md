# 首次 Marketplace 发布

Publisher ID 为 `nothingzhl`，扩展 ID 为 `nothingzhl.vscode-qemu-asm`，显示名称为 QEMU Assembly Toolkit。上传前须在 Marketplace 管理页确认当前账号拥有该 Publisher；同名 GitHub 账号不能证明所有权。

## 发布包

候选版本为 `0.9.0`，与 manifest、锁文件和 CHANGELOG 保持一致。首次发布不需要为了打包而提升版本；若 Marketplace 已有该版本，必须先提高版本号再重新打包和验证。

```sh
npm ci
npm run check
npm run compile
npm run docs:check
npx @vscode/vsce@4.0.0 package --out ../vscode-qemu-asm-0.9.0.vsix
```

包内应包含编译后的 `dist/`、`media/`、JSON Schema、README、CHANGELOG、许可证与 iced-x86 的 JS/WASM 和依赖许可证。源码、测试、CI、上游 OS 工程、构建日志和本地工具不进入包。README 的截图和文档链接由 vsce 转换为公开仓库 URL；相应文件必须已进入指定 Git 分支或提交。

`package.json` 的 `private: true` 阻止意外发布到 npm，不阻止生成 VSIX 或上传 Marketplace。

## 上传

1. 源码许可证为 Apache-2.0；检查实际 VSIX 的 manifest 和文件清单。iced-x86 保留其 MIT 许可证。
2. 在 VS Code 中从 VSIX 安装同一份候选包，验证环境检查和一次实际调试。
3. 登录 [Marketplace 管理页](https://marketplace.visualstudio.com/manage)，选择 `nothingzhl`。
4. 选择 **New extension → Visual Studio Code**，上传候选 VSIX，等待平台验证。
5. 验证商店页面、截图、文档链接及安装结果，再在仓库记录对应提交和 VSIX SHA-256。

页面手动上传无需 PAT。后续更新上传新版本；用户会通过同一扩展 ID 收到更新。不要将发布凭据提交到仓库或发到聊天中。
