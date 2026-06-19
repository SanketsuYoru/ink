// Fairy Fork: FlickerTracker - 跟踪帧变化，决定是否需要清屏
// 参考 Claude-Code 的 frame.ts 设计思路

export class FlickerTracker {
	constructor() {
		this.previousOutput = '';
		this.previousViewport = null;
		this.previousOutputHeight = 0;
		this.changeCount = 0;
	}

	// Fairy Fork 关键改动：仅在 viewport 实际变化时才返回需要清屏
	shouldClearScreen(current) {
		const { viewport, outputHeight } = current;

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

		// ⭐ 移除原版中 outputHeight >= rows 的强制 clearTerminal 逻辑
		// 这是 FairyX CLI 表格闪烁的根本原因

		this.previousViewport = viewport;
		this.previousOutputHeight = outputHeight;
		return undefined;
	}

	// 检测是否是仅 spinner 等微小变化
	isOnlySpinnerChange(currentOutput) {
		if (this.previousOutput === '') {
			this.previousOutput = currentOutput;
			return false;
		}

		const prevLines = this.previousOutput.split('\n');
		const currLines = currentOutput.split('\n');

		if (Math.abs(prevLines.length - currLines.length) > 2) {
			this.previousOutput = currentOutput;
			return false;
		}

		const maxLen = Math.max(prevLines.length, currLines.length);
		let diffLines = 0;

		for (let i = 0; i < maxLen; i++) {
			const prev = prevLines[i] ?? '';
			const curr = currLines[i] ?? '';
			if (prev !== curr) {
				diffLines++;
				if (diffLines > 3) {
					this.previousOutput = currentOutput;
					return false;
				}
			}
		}

		const isSpinnerChange = diffLines > 0 && diffLines <= 3;
		this.previousOutput = currentOutput;
		return isSpinnerChange;
	}

	reset() {
		this.previousOutput = '';
		this.previousViewport = null;
		this.previousOutputHeight = 0;
		this.changeCount = 0;
	}

	getChangeCount() {
		return this.changeCount;
	}
}