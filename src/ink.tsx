import process from 'node:process';
import React, {type ReactNode} from 'react';
import throttle from 'lodash/throttle.js';
import {type DebouncedFunc} from 'lodash';
import ansiEscapes from 'ansi-escapes';
import originalIsCi from 'is-ci';
import autoBind from 'auto-bind';
import signalExit from 'signal-exit';
import patchConsole from 'patch-console';
import {type FiberRoot} from 'react-reconciler';
// eslint-disable-next-line n/file-extension-in-import
import Yoga from 'yoga-wasm-web/auto';
import reconciler from './reconciler.js';
import render from './renderer.js';
import * as dom from './dom.js';
import logUpdate, {type LogUpdate} from './log-update.js';
import instances from './instances.js';
import App from './components/App.js';
import {FlickerTracker, type FrameInfo} from './flicker-tracker.js';

const isCi = process.env['CI'] === 'false' ? false : originalIsCi;
const noop = () => {};

export type Options = {
	stdout: NodeJS.WriteStream;
	stdin: NodeJS.ReadStream;
	stderr: NodeJS.WriteStream;
	debug: boolean;
	exitOnCtrlC: boolean;
	patchConsole: boolean;
	waitUntilExit?: () => Promise<void>;
};

/**
 * Ink v4.4.1-fairy.1
 *
 * Fairy Fork 关键改动：
 * - 引入 FlickerTracker 跟踪帧变化
 * - 移除 outputHeight >= rows 时的强制 clearTerminal
 * - 微小变化（如 spinner）走增量更新路径，不擦整屏
 *
 * 解决问题：FairyX CLI 中 Spinner 每 100ms 转动时，整屏 clear+重写
 * 导致 Markdown 表格闪烁。
 */
export default class Ink {
	private readonly options: Options;
	private readonly log: LogUpdate;
	private readonly throttledLog: LogUpdate | DebouncedFunc<LogUpdate>;
	private readonly flickerTracker: FlickerTracker;
	// Ignore last render after unmounting a tree to prevent empty output before exit
	private isUnmounted: boolean;
	private lastOutput: string;
	private readonly container: FiberRoot;
	private readonly rootNode: dom.DOMElement;
	// This variable is used only in debug mode to store full static output
	// so that it's rerendered every time, not just new static parts, like in non-debug mode
	private fullStaticOutput: string;
	private exitPromise?: Promise<void>;
	private restoreConsole?: () => void;
	private readonly unsubscribeResize?: () => void;

	constructor(options: Options) {
		autoBind(this);

		this.options = options;
		this.rootNode = dom.createNode('ink-root');
		this.rootNode.onComputeLayout = this.calculateLayout;

		this.rootNode.onRender = options.debug
			? this.onRender
			: throttle(this.onRender, 32, {
					leading: true,
					trailing: true
			  });

		this.rootNode.onImmediateRender = this.onRender;
		this.log = logUpdate.create(options.stdout);
		this.throttledLog = options.debug
			? this.log
			: throttle(this.log, undefined, {
					leading: true,
					trailing: true
			  });

		// Fairy Fork: 初始化 flicker tracker
		this.flickerTracker = new FlickerTracker();

		// Ignore last render after unmounting a tree to prevent empty output before exit
		this.isUnmounted = false;

		// Store last output to only rerender when needed
		this.lastOutput = '';

		// This variable is used only in debug mode to store full static output
		// so that it's rerendered every time, not just new static parts, like in non-debug mode
		this.fullStaticOutput = '';

		// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
		this.container = reconciler.createContainer(
			this.rootNode,
			// Legacy mode
			0,
			null,
			false,
			null,
			'id',
			() => {},
			null
		);

		// Unmount when process exits
		this.unsubscribeExit = signalExit(this.unmount, {alwaysLast: false});

		if (process.env['DEV'] === 'true') {
			reconciler.injectIntoDevTools({
				bundleType: 0,
				// Reporting React DOM's version, not Ink's
				// See https://github.com/facebook/react/issues/16666#issuecomment-532639905
				version: '16.13.1',
				rendererPackageName: 'ink'
			});
		}

		if (options.patchConsole) {
			this.patchConsole();
		}

		if (!isCi) {
			options.stdout.on('resize', this.resized);

			this.unsubscribeResize = () => {
				options.stdout.off('resize', this.resized);
			};
		}
	}

	resized = () => {
		this.calculateLayout();
		// Fairy Fork: 终端 resize 时重置 flicker tracker，因为 viewport 变了
		this.flickerTracker.reset();
		this.onRender();
	};

	resolveExitPromise: () => void = () => {};
	rejectExitPromise: (reason?: Error) => void = () => {};
	unsubscribeExit: () => void = () => {};

	calculateLayout = () => {
		// The 'columns' property can be undefined or 0 when not using a TTY.
		// In that case we fall back to 80.
		const terminalWidth = this.options.stdout.columns || 80;

		this.rootNode.yogaNode!.setWidth(terminalWidth);

		this.rootNode.yogaNode!.calculateLayout(
			undefined,
			undefined,
			Yoga.DIRECTION_LTR
		);
	};

	onRender: () => void = () => {
		if (this.isUnmounted) {
			return;
		}

		const {output, outputHeight, staticOutput} = render(this.rootNode);

		// If <Static> output isn't empty, it means new children have been added to it
		const hasStaticOutput = staticOutput && staticOutput !== '\n';

		if (this.options.debug) {
			if (hasStaticOutput) {
				this.fullStaticOutput += staticOutput;
			}

			this.options.stdout.write(this.fullStaticOutput + output);
			return;
		}

		if (isCi) {
			if (hasStaticOutput) {
				this.options.stdout.write(staticOutput);
			}

			this.lastOutput = output;
			return;
		}

		if (hasStaticOutput) {
			this.fullStaticOutput += staticOutput;
		}

		// ⭐ Fairy Fork 核心改动 ⭐
		// 原版 ink 在 outputHeight >= stdout.rows 时会强制 clearTerminal + 全屏重写
		// 这是 Markdown 表格闪烁的根源（Spinner 每 100ms 触发此路径）
		//
		// 新逻辑：
		// 1. 通过 FlickerTracker.shouldClearScreen 判断是否真的需要清屏
		// 2. 只有 viewport 实际变化（resize）时才清屏
		// 3. 其余情况走 log-update 路径（增量更新）

		const terminalWidth = this.options.stdout.columns || 80;
		const terminalHeight = this.options.stdout.rows;

		const frameInfo: FrameInfo = {
			output,
			outputHeight,
			viewport: { width: terminalWidth, height: terminalHeight }
		};

		const clearReason = this.flickerTracker.shouldClearScreen(frameInfo);

		if (clearReason) {
			// 真的需要清屏：resize 或 viewport 变化
			this.options.stdout.write(
				ansiEscapes.clearTerminal + this.fullStaticOutput + output
			);
			this.lastOutput = output;
			return;
		}

		// Fairy Fork: 检查是否是 spinner 等微小变化
		const isSpinnerChange = this.flickerTracker.isOnlySpinnerChange(output);

		// To ensure static output is cleanly rendered before main output, clear main output first
		if (hasStaticOutput) {
			this.log.clear();
			this.options.stdout.write(staticOutput);
			this.log(output);
		}

		if (!hasStaticOutput && output !== this.lastOutput) {
			// Fairy Fork: spinner 变化时也走 throttledLog，但 log-update
			// 内部会自动检测并使用增量更新（≤3 行变化时）
			this.throttledLog(output);
		}

		this.lastOutput = output;

		// Fairy Fork: 暴露调试信息到 process.env（可选）
		if (process.env['INK_FLICKER_DEBUG'] === 'true') {
			process.env['INK_LAST_FLICKER_REASON'] = clearReason ?? 'none';
			process.env['INK_LAST_CHANGE_TYPE'] = isSpinnerChange ? 'spinner-only' : 'full';
			process.env['INK_LAST_CHANGE_COUNT'] = String(this.flickerTracker.getChangeCount());
		}
	};

	render(node: ReactNode): void {
		const tree = (
			<App
				stdin={this.options.stdin}
				stdout={this.options.stdout}
				stderr={this.options.stderr}
				writeToStdout={this.writeToStdout}
				writeToStderr={this.writeToStderr}
				exitOnCtrlC={this.options.exitOnCtrlC}
				onExit={this.unmount}
			>
				{node}
			</App>
		);

		reconciler.updateContainer(tree, this.container, null, noop);
	}

	writeToStdout(data: string): void {
		if (this.isUnmounted) {
			return;
		}

		if (this.options.debug) {
			this.options.stdout.write(data + this.fullStaticOutput + this.lastOutput);
			return;
		}

		if (isCi) {
			this.options.stdout.write(data);
			return;
		}

		// Fairy Fork: writeToStdout 时重置 flicker tracker，因为可能引入了外部内容
		this.flickerTracker.reset();
		this.log.clear();
		this.options.stdout.write(data);
		this.log(this.lastOutput);
	}

	writeToStderr(data: string): void {
		if (this.isUnmounted) {
			return;
		}

		if (this.options.debug) {
			this.options.stderr.write(data);
			this.options.stdout.write(this.fullStaticOutput + this.lastOutput);
			return;
		}

		if (isCi) {
			this.options.stderr.write(data);
			return;
		}

		this.flickerTracker.reset();
		this.log.clear();
		this.options.stderr.write(data);
		this.log(this.lastOutput);
	}

	// eslint-disable-next-line @typescript-eslint/ban-types
	unmount(error?: Error | number | null): void {
		if (this.isUnmounted) {
			return;
		}

		this.calculateLayout();
		this.onRender();
		this.unsubscribeExit();

		if (typeof this.restoreConsole === 'function') {
			this.restoreConsole();
		}

		if (typeof this.unsubscribeResize === 'function') {
			this.unsubscribeResize();
		}

		// CIs don't handle erasing ansi escapes well, so it's better to
		// only render last frame of non-static output
		if (isCi) {
			this.options.stdout.write(this.lastOutput + '\n');
		} else if (!this.options.debug) {
			this.log.done();
		}

		this.isUnmounted = true;

		reconciler.updateContainer(null, this.container, null, noop);
		instances.delete(this.options.stdout);

		if (error instanceof Error) {
			this.rejectExitPromise(error);
		} else {
			this.resolveExitPromise();
		}
	}

	async waitUntilExit(): Promise<void> {
		if (!this.exitPromise) {
			this.exitPromise = new Promise((resolve, reject) => {
				this.resolveExitPromise = resolve;
				this.rejectExitPromise = reject;
			});
		}

		return this.exitPromise;
	}

	clear(): void {
		if (!isCi && !this.options.debug) {
			this.log.clear();
			this.flickerTracker.reset();
		}
	}

	patchConsole(): void {
		if (this.options.debug) {
			return;
		}

		this.restoreConsole = patchConsole((stream, data) => {
			if (stream === 'stdout') {
				this.writeToStdout(data);
			}

			if (stream === 'stderr') {
				const isReactMessage = data.startsWith('The above error occurred');

				if (!isReactMessage) {
					this.writeToStderr(data);
				}
			}
		});
	}
}