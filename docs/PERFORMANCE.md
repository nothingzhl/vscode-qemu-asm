# 性能测量与回归检查

> 测量记录范围：本页优化结果来自 2026-10-15 的性能整理，基线、候选和方法见下文；不是当前工作区的重新测量结果。后续回归使用本文命令重新执行。

本轮优化了静止显示画面的重复编码，以及观察器内存历史的淘汰操作。它们减少了这些场景的扩展侧 CPU 消耗；持续变化的显示画面会增加哈希成本。本页不把局部测量换算成整个插件的加速或内存下降承诺。

## 先运行一次

开发依赖使用 Node.js 22。前两项不需要 VS Code、QEMU 或 NASM；真实显示项需要 NASM 和 QEMU。

```bash
npm ci
npm run compile
node --expose-gc scripts/performance/run.cjs --enforce --output artifacts/performance/modules.json
node --expose-gc scripts/performance/resources.cjs --enforce --output artifacts/performance/resources.json
node --expose-gc scripts/performance/real-display.cjs --enforce --output artifacts/performance/real-display.json
```

工具路径通过 `NASM_PATH`、`QEMU_PATH` 指定，含空格路径也作为完整可执行文件路径处理。客体使用 TCG，不要求 KVM。输出目录自动创建。

| 入口 | 实际执行的场景 | 范围 |
| --- | --- | --- |
| [run.cjs](../scripts/performance/run.cjs) | 640×400 PNG 编码、摘要计算、100 次静止/变化截图流水线、5,000 次 256 字节观察器快照 | 调用真实生产模块；QMP 使用本地替身，截图文件真实读写 |
| [resources.cjs](../scripts/performance/resources.cjs) | 100 次显示资源创建/截图/释放；100 次内存历史创建、滚动填充和清空 | 检查临时目录释放及保留内存；不启动 100 台虚拟机 |
| [real-display.cjs](../scripts/performance/real-display.cjs) | NASM 构建静止 VGA 客体，启动真实 QEMU，经 QMP 连续截图 75 次并清理 | 包括真实进程、协议、截图文件和编码；扩展与 QEMU 的用量分别记录 |

每组先预热一次，再测耗时和 Node 进程 CPU。记录测量前、测量后及批次结束时的 heap、RSS、external 和 ArrayBuffer 内存；前后各进行两次显式 GC。`observed` 是批次结束的采样，`processPeakRssBytes` 才是进程级峰值。Node 的堆、Buffer、内存分配器保留页和 QEMU 客体分配是不同指标，不能相加后称为插件堆占用。

## 2026-10-15 的本地结果

环境：Linux x64、Node.js 22.23.3、NASM 2.16.03、QEMU 10.0.13。基线是 `acb05af`，候选是本轮改动；五轮交替执行基线与候选，以下为中位数。云端共享 CPU 未隔离，因此同时报告 CPU 与墙钟耗时，不把微小差异当成回归结论。原始样本和方法保存在 [performance-baseline.json](performance-baseline.json)。

| 场景 | 每次耗时：改动前 → 后 | 扩展侧批次 CPU：改动前 → 后 |
| --- | --- | --- |
| 静止截图，本地 QMP 替身，100 次 | 2.991 → 0.961 ms | 268.0 → 90.0 ms |
| 持续变化截图，本地 QMP 替身，100 次 | 3.070 → 3.530 ms | 293.6 → 337.3 ms |
| 真实 QEMU 静止画面，75 次 | 5.160 → 3.258 ms | 291.4 → 114.4 ms |
| 观察器快照，含历史淘汰，5,000 次 | 0.565 → 0.086 ms | 2,898.9 → 494.8 ms |

静止截图的 PNG 对象从每次重新生成变成相同画面复用。真实 QEMU 测量偶尔遇到 VGA 光标变化，因此候选批次生成 1–2 个不同 PNG，基线每批生成 76 个（含一次预热）。面板对复用对象跳过 base64 编码和重复 Webview 消息；关闭后重新打开仍重放最后画面，显式刷新也会重发，以便重试图片解码或消息传输失败。

代价也明确：640×400 的 SHA-256 单次约 0.47 ms。持续变化场景增加约 15% 的这部分 CPU；按当前每轮结束后等待 200 ms 的轮询机制，额外成本约每秒 2.2 CPU ms。哈希覆盖整个 PPM，元数据变化会保守地重新编码，不冒险返回错误像素。尺寸变化、无效文件以及销毁期间的迟到读取均有测试。

观察器此前每淘汰一个字节都重新创建 Map 迭代器，反复扫描删除槽。本轮每批淘汰复用一个迭代器，同时每字节只构造一次地址键；历史仍只保留最多 4,096 字节，不增加旁路缓存。

内存结果应分开看：模块基准的进程峰值 RSS 中位数从 143.0 MiB 到 150.0 MiB，真实显示基准从 91.45 MiB 到 87.75 MiB，不能据此宣布整体 RSS 降低。100 次显示资源周期结束后的保留增量约为 heap 465 KiB、ArrayBuffer 8 KiB；100 次观察器历史周期约为 heap 20 KiB、ArrayBuffer 0。释放测试还检查截图目录消失，销毁后不保留最后 PNG，也不让旧读取重新填充缓存。

## CI 怎样判定

[Performance 工作流](../.github/workflows/performance.yml) 在 Linux / Node.js 22 上运行相同入口，并上传 JSON。它检查严重回退和资源保留，不把本地中位数当成所有机器的硬性速度要求。

| 检查 | 保守门槛 |
| --- | --- |
| 模块基准 | 每次平均耗时小于 200 ms；每组保留 heap / ArrayBuffer 各小于 20 MiB |
| 真实显示基准 | 每次平均耗时小于 300 ms；保留 heap / ArrayBuffer 各小于 20 MiB |
| 100 次资源周期 | 每组保留 heap / ArrayBuffer 各小于 8 MiB |

这些宽松门槛用于避免共享 runner 的抖动误报，不能证明不存在小幅性能退化，也不能证明所有内存泄漏已排除。帧复用、历史上限、淘汰顺序、无效快照不污染历史、释放等待和面板重放由行为测试单独检查。强制预算模式要求 `--expose-gc`，避免把未回收的临时对象当成资源保留。

## 复查与限制

比较两个版本时，应使用相同 Node、工具、输入、迭代次数和机器，在干净的独立工作目录分别编译。基线版本没有基准入口时，可将当前 `scripts/performance/` 复制过去后运行；本轮先后交替运行五组，取中位数。先看同场景 CPU 与保留内存，再结合耗时和 RSS；不要仅比较一轮数字。

本轮额外通过 VS Code 1.96.4 / 1.142.0 的显示及观察器宿主场景，检查真实 Webview、调试和资源清理。这是行为验证，没有测量完整 Electron/扩展宿主的堆。当前基准也未覆盖 Windows/macOS 性能、GDB 大型 DWARF 符号、长期多小时会话、4K 动画、宿主启动耗时或端到端按键延迟。后续应按复现出的热点新增场景，再决定优化；不缓存跨暂停状态的寄存器或内存来换取表面速度。
