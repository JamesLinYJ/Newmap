# 桌面端 UI 设计系统

桌面 Renderer 只有一种视觉语言和一种可选的液体玻璃材质。页面样式可以负责布局，但不得自行创建新的颜色、阴影层级、焦点状态或玻璃配方。

## 事实源

- `app/styles/glass.css` 维护语义 token 与唯一的权威玻璃材质。
- `app/styles/ui-system.css` 在业务样式之后加载，并按固定顺序导入基础、页面、内容与浮层模块。
- `shared/components/LiquidGlassLayer.tsx` 只挂载一个 SVG 滤镜，位移图来自 `assets/liquid-glass/panel.png`。
- `scripts/generate-liquid-glass-maps.mjs` 只生成这一张贴图，并主动删除旧的 `bar`、`chip` 与 `strong` 贴图。

## 材质边界

液体玻璃只用于账号菜单、Dialog、Popover 等短暂浮动的 chrome。时间线、设置、工具、表格、日志、卡片和侧栏等密集或可滚动内容必须使用稳定实色表面，从而保证文字可读性，并避免多层 `backdrop-filter` 叠加。

旧的 `variant="panel|strong|chip|bar"` 暂时保留用于源码兼容，但所有值都会落到同一材质。新代码不得用 variant 表达层级；层级应通过间距、边框、表面与排版 token 表达。

## 新增或修改页面

1. 复用 `--ui-*` token，不得新增平行的调色板或阴影标尺。
2. 内容容器只使用 `--ui-surface`、`--ui-surface-raised` 或 `--ui-surface-muted`。
3. `--ui-accent` 仅用于激活态、焦点与主操作。
4. 保留 `:focus-visible`、减少动态效果、增强对比度与强制色彩模式。
5. 创建新浮层前，优先复用现有共享控件与 Radix primitive。

视觉改动合并前运行 `npm run test:desktop`、`npm run lint:desktop` 与 `npm run build:desktop`。当多个位移贴图或滤镜定义重新出现时，视觉系统架构测试会直接失败。
