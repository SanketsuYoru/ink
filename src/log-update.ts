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
				previousLineCount = currentLines.length;
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
	 */
	const writeIncrementalUpdate = (currentLines: string[], diffLines: number[]) => {
		// 找到第一个变化行
		const firstDiffLine = diffLines[0]!;

		// ANSI 序列：将光标从当前行向上移动到 firstDiffLine
		// \x1b[<n>F 光标向上移动到行首
		const moveToFirstDiff = '\x1b[' + (previousLineCount - firstDiffLine) + 'F';

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

		// 移动光标回到底部
		const lastDiffLine = diffLines[diffLines.length - 1]!;
		const movesToBottom = previousLineCount - lastDiffLine - 1;
		if (movesToBottom > 0) {
			incremental += '\x1b[' + movesToBottom + 'E';
		}

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