import {type Writable} from 'node:stream';
import ansiEscapes from 'ansi-escapes';
import cliCursor from 'cli-cursor';

export type LogUpdate = {
	clear: () => void;
	done: () => void;
	(str: string): void;
};

/**
 * Fairy Fork: 增强的 log-update
 *
 * 关键改动：
 * 1. 提供按行 diff 更新能力（updateLine / updateLines）
 * 2. 当输出变化很小时（spinner 等），仅重写变化的几行
 * 3. 避免整屏 eraseLines 导致的闪烁
 */
const create = (stream: Writable, {showCursor = false} = {}): LogUpdate => {
	let previousLineCount = 0;
	let previousOutput = '';
	let previousLines: string[] = [];
	let hasHiddenCursor = false;

	const render = (str: string) => {
		if (!showCursor && !hasHiddenCursor) {
			cliCursor.hide();
			hasHiddenCursor = true;
		}

		const output = str + '\n';

		// Fairy Fork: 内容完全没变 → 直接返回，避免任何写入
		if (output === previousOutput) {
			return;
		}

		previousOutput = output;

		// Fairy Fork: 如果行数和上一帧一致，尝试按行 diff
		const currentLines = str.split('\n');
		const useIncrementalUpdate =
			previousLines.length === currentLines.length && previousLines.length > 0;

		if (useIncrementalUpdate) {
			// 计算哪些行有变化
			const diffLines: number[] = [];
			for (let i = 0; i < currentLines.length; i++) {
				if (previousLines[i] !== currentLines[i]) {
					diffLines.push(i);
				}
			}

			// Fairy Fork: 仅当变化的行数较少（≤ 3 行）时使用增量更新
			// 否则退回原来的整屏擦除+重写策略
			if (diffLines.length > 0 && diffLines.length <= 3) {
				writeIncrementalUpdate(currentLines, diffLines);
				previousLines = currentLines;
				// ✨ FIX 3: 保持与整屏擦除分支（第 66 行）一致的语义
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

	/**
	 * Fairy Fork: 按行增量更新
	 *
	 * 思路：光标移动到第一个变化行 → 重写该行 → 移动到下一个变化行 → ...
	 * 这样避免了一次性擦除所有行造成的闪烁
	 *
	 * ⚠️ 关键不变量（修复后）：
	 * - 调用本函数之前，光标必须位于 Terminal 第 previousLineCount 行的行首
	 * - previousLineCount = "split 后的元素数" = "实际显示行数 + 1"
	 *   （因为 Ink 输出末尾追加了 \n，所以光标在最后一行的下一行行首）
	 * - 调用本函数之后，光标必须回到 Terminal 第 previousLineCount 行的行首
	 *   （这样下一帧的 writeIncrementalUpdate 才能基于正确位置开始）
	 *
	 * 修复历史：
	 * - v1：使用 (prevLineCount - firstDiffLine) 计算向上行数，**差 1 bug**：
	 *   Ink 渲染后光标在第 N+1 行，目标是第 i+1 行（i = 0-based），
	 *   距离应为 N - i = (prevLineCount - 1) - firstDiffLine。
	 *   旧代码算成 N + 1 - i = prevLineCount - firstDiffLine，**多减了 1**。
	 *   后果：每次输入都会把光标多向上推 1 行，输入框"上移"留下旧痕迹。
	 * - v2（本版本）：
	 *   1) 修正 moveToFirstDiff 的差 1 bug
	 *   2) 在末尾使用绝对定位 \x1b[{row};1H 强制把光标重置到底部行首，
	 *      这样无论 prevLineCount 怎么算都能保证下一帧的起点正确
	 */
	const writeIncrementalUpdate = (currentLines: string[], diffLines: number[]) => {
		// 找到第一个变化行
		const firstDiffLine = diffLines[0]!;

		// ✨ FIX 1: 修正差 1 bug
		// 光标当前位置：Terminal 第 previousLineCount 行的行首（Ink 追加 \n 后）
		// 目标位置：Terminal 第 (firstDiffLine + 1) 行的行首
		// 距离 = previousLineCount - (firstDiffLine + 1) = previousLineCount - firstDiffLine - 1
		// Math.max 防止 prevLineCount 为 0 时的负数
		const moveUpCount = Math.max(0, previousLineCount - firstDiffLine - 1);
		// ANSI 序列：将光标向上移动 moveUpCount 行到行首
		// \x1b[<n>F 光标向上移动 n 行到行首（CPL, Cursor Previous Line）
		const moveToFirstDiff = '\x1b[' + moveUpCount + 'F';

		// 准备增量输出：每个变化行单独处理
		let incremental = moveToFirstDiff;

		for (let i = 0; i < diffLines.length; i++) {
			const lineIndex = diffLines[i]!;
			const isLast = i === diffLines.length - 1;

			// \x1b[2K: 清除整行
			// \r: 光标回到行首
			incremental += '\x1b[2K\r' + currentLines[lineIndex];

			// 如果不是最后一个变化行，移动到下一个变化行
			if (!isLast) {
				const nextDiffLine = diffLines[i + 1]!;
				const downMoves = nextDiffLine - lineIndex;
				if (downMoves > 0) {
					incremental += '\x1b[' + downMoves + 'E'; // 光标下移行首
				}
			}
		}

		// ✨ FIX 2: 用绝对定位把光标强制重置到底部行首
		// 不再依赖 movesToBottom 算相对距离（之前的算法在某些边界条件下算错）
		// 无论之前光标在什么位置，最终都强制移动到 (previousLineCount, 1)
		// \x1b[<row>;<col>H = CUP, Cursor Position（1-based）
		// previousLineCount 是 split 后的元素数 = "实际显示行数 + 1" = "底部下一行的行号"
		incremental += '\x1b[' + previousLineCount + ';1H';

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

const logUpdate = {create};
export default logUpdate;