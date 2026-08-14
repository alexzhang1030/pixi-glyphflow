# pixi-glyphflow

面向 PixiJS v8 的高性能批量文字渲染系统。核心目标是让一个 `TextLayer` 承载海量标签，共享字形图集、塑形与布局结果，并通过增量 GPU 上传服务 WebGL2 与 WebGPU。

状态：架构与基准研究阶段。

## 设计资料

- [项目资料地图](.agents/docs/README.md)
- [性能文字渲染蓝图](.agents/docs/pixi-glyphflow-blueprint.md)
- [pixi-heatmap 工程参考快照](.agents/docs/references/pixi-heatmap/README.md)

## 当前执行点

从 M0 基线实验室开始：以相同 fixture 对照 PixiJS 8.19 的 `Text`、`BitmapText` 与 `HTMLText`，记录 cold/warm timing、draw call、texture memory、update cost 和 visual output。
