// Fairy Fork: 增强的 log-update，支持行级增量更新
// 解决 Spinner 转动时整屏擦除导致的 Markdown 表格闪烁问题
import ansiEscapes from 'ansi-escapes';
import cliCursor from 'cli-cursor';
const create = (stream, { showCursor = false } = {}) => {
    let previousLineCount = 0;
    let previousOutput = '';
    let previousLines = [];
    let hasHiddenCursor = false;
    const render = (str) => {
        if (!showCursor && !hasHiddenCursor) {
            cliCursor.hide();
            hasHiddenCursor = true;
        }
        const output = str + '\n';
        if (output === previousOutput) {
            return;
        }
        previousOutput = output;
        const currentLines = str.split('\n');

        // Fairy Fork: 行数相同时尝试按行 diff
        const useIncrementalUpdate =
            previousLines.length === currentLines.length && previousLines.length > 0;

        if (useIncrementalUpdate) {
            const diffLines = [];
            for (let i = 0; i < currentLines.length; i++) {
                if (previousLines[i] !== currentLines[i]) {
                    diffLines.push(i);
                }
            }

            // Fairy Fork: 仅当变化 ≤ 3 行时使用增量更新
            if (diffLines.length > 0 && diffLines.length <= 3) {
                writeIncrementalUpdate(currentLines, diffLines, previousLineCount);
                previousLines = currentLines;
                // ✨ FIX 3: 保持与整屏擦除分支（第 45 行）一致的语义
                // previousLineCount 应该是 "光标当前行号" = "split 后的元素数" = N + 1
                // 原来用 currentLines.length (= N) 会导致下一帧的 moveUpCount 算少 1
                previousLineCount = output.split('\n').length;
                return;
            }
        }

        // 原版行为：整屏擦除 + 重写
        stream.write(ansiEscapes.eraseLines(previousLineCount) + output);
        previousLineCount = output.split('\n').length;
        previousLines = currentLines;
    };

    // Fairy Fork: 按行增量更新
    // ✨ FIX 1: 修正 moveToFirstDiff 的差 1 bug
    // ✨ FIX 2: 用绝对定位把光标强制重置到底部行首
    const writeIncrementalUpdate = (currentLines, diffLines, prevLineCount) => {
        const firstDiffLine = diffLines[0];
        // 光标当前位置：Terminal 第 prevLineCount 行的行首（Ink 追加 \n 后）
        // 目标位置：Terminal 第 (firstDiffLine + 1) 行的行首
        // 距离 = prevLineCount - (firstDiffLine + 1) = prevLineCount - firstDiffLine - 1
        const moveUpCount = Math.max(0, prevLineCount - firstDiffLine - 1);
        const moveToFirstDiff = '\x1b[' + moveUpCount + 'F';

        let incremental = moveToFirstDiff;

        for (let i = 0; i < diffLines.length; i++) {
            const lineIndex = diffLines[i];
            const isLast = i === diffLines.length - 1;

            // 清除整行 + 重写
            incremental += '\x1b[2K\r' + currentLines[lineIndex];

            // 移动到下一个变化行
            if (!isLast) {
                const nextDiffLine = diffLines[i + 1];
                const downMoves = nextDiffLine - lineIndex;
                if (downMoves > 0) {
                    incremental += '\x1b[' + downMoves + 'E';
                }
            }
        }

        // 绝对定位：CUP（Cursor Position）把光标强制重置到 (prevLineCount, 1)
        // 不再依赖相对距离计算（之前的算法在边界条件下算错）
        incremental += '\x1b[' + prevLineCount + ';1H';

        stream.write(incremental);
    };

    render.clear = () => {
        stream.write(ansiEscapes.eraseLines(previousLineCount));
        previousOutput = '';
        previousLineCount = 0;
        previousLines = [];
    };
    render.done = () => {
        previousOutput = '';
        previousLineCount = 0;
        previousLines = [];
        if (!showCursor) {
            cliCursor.show();
            hasHiddenCursor = false;
        }
    };
    return render;
};
const logUpdate = { create };
export default logUpdate;
//# sourceMappingURL=log-update.js.map