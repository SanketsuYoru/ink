/**
 * Flicker Tracker - 闪烁追踪器
 *
 * 借鉴自 Claude-Code 的 frame.ts 设计理念。
 * 核心目标：智能判断当前帧变化是否仅为 Spinner 等微小动画变化，
 * 如果是，则跳过整屏 clearTerminal 操作，使用增量更新，避免闪烁。
 *
 * Fairy Fork 增强：
 * - 1) 移除 outputHeight >= rows 时强制 clearTerminal 的逻辑
 * - 2) 引入"微小变化检测"，仅 spinner 变化时使用增量更新
 * - 3) 提供 row-level diff 用于按行更新而非整屏重写
 */

export type FlickerReason = 'resize' | 'offscreen' | 'clear' | 'spinner-only';

export type FrameInfo = {
	output: string;
	outputHeight: number;
	viewport: { width: number; height: number };
};

export type LineChange = {
	type: 'unchanged' | 'changed' | 'added' | 'removed';
	lineIndex: number;
	content: string;
};

/**
 * FlickerTracker - 跟踪帧变化并决定渲染策略
 *
 * Fairy Fork 关键改造：
 * - 默认情况下输出高度 >= viewport.height 时不再无脑 clearTerminal
 * - 仅当确实发生 resize 或者结构性变化时才使用 clear
 * - 微小变化（spinner 字符切换等）走增量更新路径
 */
export class FlickerTracker {
	private previousOutput: string = '';
	private previousViewport: { width: number; height: number } | null = null;
	private previousOutputHeight: number = 0;
	private changeCount: number = 0;

	/**
	 * 决定当前帧是否需要清屏
	 *
	 * Fairy Fork 关键改造：
	 * - 原版 ink: 只要 outputHeight >= rows 就清屏
	 * - 新版: 仅在 viewport 实际变化时清屏（resize 场景）
	 *
	 * @returns FlickerReason | undefined - undefined 表示不需要清屏
	 */
	shouldClearScreen(current: FrameInfo): FlickerReason | undefined {
		const { viewport, outputHeight } = current;

		// 检查 viewport 是否变化（终端 resize）
		if (this.previousViewport) {
			const didResize =
				viewport.height !== this.previousViewport.height ||
				viewport.width !== this.previousViewport.width;

			if (didResize) {
				this.previousViewport = viewport;
				this.previousOutputHeight = outputHeight;
				return 'resize';
			}
		}

		// ✨ Fairy Fork: 移除 outputHeight >= rows 时的强制 clearTerminal
		// 原因：当应用输出高度超过终端可视区域时，scrollback 的内容
		// 会自然滚动到上方，不需要每次都 clearTerminal + 重写全部内容
		// 这样 Spinner 每 100ms 更新时不会触发整屏闪烁

		this.previousViewport = viewport;
		this.previousOutputHeight = outputHeight;

		return undefined;
	}

	/**
	 * 检测当前变化是否仅为 Spinner 等微小动画变化
	 *
	 * Fairy Fork 关键改造：
	 * - 当仅有 spinner 字符变化时，不应该触发 clearTerminal
	 * - 这种情况使用增量更新（log-update）即可
	 *
	 * 启发式算法：
	 * 1. 行数相同
	 * 2. 绝大部分行内容完全一致
	 * 3. 仅 1-3 行的字符有差异（spinner 字符差异）
	 */
	isOnlySpinnerChange(currentOutput: string): boolean {
		if (this.previousOutput === '') {
			this.previousOutput = currentOutput;
			return false;
		}

		const prevLines = this.previousOutput.split('\n');
		const currLines = currentOutput.split('\n');

		// 行数差异太大 → 不是微小变化
		if (Math.abs(prevLines.length - currLines.length) > 2) {
			this.previousOutput = currentOutput;
			return false;
		}

		// 统计变化的行数
		const maxLen = Math.max(prevLines.length, currLines.length);
		let diffLines = 0;

		for (let i = 0; i < maxLen; i++) {
			const prev = prevLines[i] ?? '';
			const curr = currLines[i] ?? '';
			if (prev !== curr) {
				diffLines++;
				// 超过 3 行有差异 → 不是微小变化
				if (diffLines > 3) {
					this.previousOutput = currentOutput;
					return false;
				}
			}
		}

		// 1-3 行差异，且总行数变化 <= 2 → 判定为微小变化
		const isSpinnerChange = diffLines > 0 && diffLines <= 3;

		this.previousOutput = currentOutput;
		return isSpinnerChange;
	}

	/**
	 * 计算行级 diff，用于增量更新
	 *
	 * Fairy Fork 增强功能：
	 * - 找出哪些行发生了变化
	 * - 支持按行重写而不是整屏擦除
	 */
	computeLineDiff(currentOutput: string): LineChange[] {
		const prevLines = this.previousOutput === '' ? [] : this.previousOutput.split('\n');
		const currLines = currentOutput.split('\n');
		const changes: LineChange[] = [];

		const maxLen = Math.max(prevLines.length, currLines.length);

		for (let i = 0; i < maxLen; i++) {
			const prev = prevLines[i];
			const curr = currLines[i];

			if (prev === undefined) {
				changes.push({ type: 'added', lineIndex: i, content: curr ?? '' });
			} else if (curr === undefined) {
				changes.push({ type: 'removed', lineIndex: i, content: prev });
			} else if (prev !== curr) {
				changes.push({ type: 'changed', lineIndex: i, content: curr });
			} else {
				changes.push({ type: 'unchanged', lineIndex: i, content: curr });
			}
		}

		this.changeCount = changes.filter(c => c.type !== 'unchanged').length;
		return changes;
	}

	/**
	 * 重置 tracker 状态（用于重新挂载）
	 */
	reset(): void {
		this.previousOutput = '';
		this.previousViewport = null;
		this.previousOutputHeight = 0;
		this.changeCount = 0;
	}

	/**
	 * 获取本次更新的变化数量（用于调试）
	 */
	getChangeCount(): number {
		return this.changeCount;
	}
}