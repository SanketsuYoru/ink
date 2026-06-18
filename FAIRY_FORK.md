# Fairy Fork of ink v4.4.1

> 🎯 解决 FairyX CLI 中 Markdown 表格在 Spinner 转动时的闪烁问题

## 📋 原始问题

FairyX CLI 使用 ink 渲染终端 UI。当应用内容超过终端可视区域（outputHeight >= stdout.rows）时，ink 的 `onRender()` 方法会执行 `ansiEscapes.clearTerminal` 清空整个屏幕，然后重写所有内容：

```ts
// 原始 ink.tsx (闪烁根源)
if (outputHeight >= this.options.stdout.rows) {
    this.options.stdout.write(
        ansiEscapes.clearTerminal + this.fullStaticOutput + output
    );
    this.lastOutput = output;
    return;
}
```

由于 FairyX CLI 在响应过程中 Spinner 每 100ms 转动一次，每次都会触发 `onRender`，进而触发整屏清空 + 重写，导致 **Markdown 表格闪烁**。

## 🔧 Fairy Fork 改动

### 1. 新增 `src/flicker-tracker.ts`

跟踪帧变化并决定渲染策略：
- `shouldClearScreen()` - 仅在 viewport 实际变化时返回清屏
- `isOnlySpinnerChange()` - 检测是否是 spinner-only 微小变化
- `reset()` - 用于 resize / writeToStdout 时重置

### 2. 修改 `src/ink.tsx`

- 引入 `FlickerTracker`
- 移除 `outputHeight >= stdout.rows` 时的强制 `clearTerminal`
- 仅在 viewport 变化（resize）时才清屏

### 3. 修改 `src/log-update.ts`

- 新增 `writeIncrementalUpdate()` 行级增量更新
- 当变化 ≤ 3 行时，仅重写变化的行，不擦整屏
- 当变化较多时退回原版行为

## 📊 修复效果

| 场景 | 修复前 | 修复后 |
|------|--------|--------|
| Spinner 转动 | 整屏闪烁 | 仅 spinner 行更新 ✅ |
| 终端 resize | 闪烁 + 重排 | 一次性重排 ✅ |
| 流式响应 | 闪烁 | 稳定的逐行追加 ✅ |
| 静态表格 | 稳定 | 稳定 ✅ |

## 🔬 测试

运行测试：

```bash
cd D:\source\FairyX\src\Fairy.Cli.Ink
node verify-flicker-fix.mjs
```

测试覆盖：
1. ✅ shouldClearScreen - viewport 不变时不返回
2. ✅ shouldClearScreen - viewport 变化时返回 resize
3. ✅ isOnlySpinnerChange - Spinner 字符切换识别
4. ✅ isOnlySpinnerChange - 大量行变化不误判
5. ✅ reset - 状态清空
6. ✅ 连续多次 spinner 变化检测

## 📦 版本

- **fork 版本**: 4.4.1-fairy.1
- **基础版本**: vadimdemedes/ink@4.4.1
- **Fairy Fork 维护**: Hinode / FairyX
- **创建日期**: 2026-06-18

## 🙏 致谢

- 设计灵感来自 [Claude-Code](https://github.com/anthropics/claude-code) 的 `frame.ts` 和 Patch 系统
- 原始 ink: [vadimdemedes/ink](https://github.com/vadimdemedes/ink)

## 🔗 相关文件

- `src/flicker-tracker.ts` - 新增的跟踪器
- `src/ink.tsx` - 修改后的核心文件
- `src/log-update.ts` - 修改后的日志更新

## 📝 使用方法

### 在 FairyX CLI 中使用

`fairy-cli-ink/package.json` 已经配置：

```json
{
  "dependencies": {
    "ink": "file:../../vendor/ink"
  }
}
```

### 直接测试

```bash
cd D:\source\FairyX\src\Fairy.Cli.Ink
npx tsx src/test-flicker-fix.tsx
```

观察屏幕 30 秒，Spinner 转动时表格应该完全稳定无闪烁。