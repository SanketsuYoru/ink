// Fairy Fork: 4.4.1-fairy.1
// 关键改动：
// 1. 引入 FlickerTracker 跟踪帧变化
// 2. 移除 outputHeight >= rows 时强制 clearTerminal
// 3. 微小变化（spinner）走 log-update 的增量更新路径
import process from 'node:process';
import React from 'react';
import throttle from 'lodash/throttle.js';
import ansiEscapes from 'ansi-escapes';
import originalIsCi from 'is-ci';
import autoBind from 'auto-bind';
import signalExit from 'signal-exit';
import patchConsole from 'patch-console';
import Yoga from 'yoga-wasm-web/auto';
import reconciler from './reconciler.js';
import render from './renderer.js';
import * as dom from './dom.js';
import logUpdate from './log-update.js';
import instances from './instances.js';
import App from './components/App.js';
import { FlickerTracker } from './flicker-tracker.js';

const isCi = process.env['CI'] === 'false' ? false : originalIsCi;
const noop = () => { };
export default class Ink {
    constructor(options) {
        Object.defineProperty(this, "options", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "log", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "throttledLog", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        // Fairy Fork: 添加 flickerTracker
        Object.defineProperty(this, "flickerTracker", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "isUnmounted", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "lastOutput", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "container", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "rootNode", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "fullStaticOutput", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "exitPromise", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "restoreConsole", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "unsubscribeResize", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "resized", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: () => {
                // Fairy Fork: resize 时重置 flicker tracker
                this.flickerTracker.reset();
                this.calculateLayout();
                this.onRender();
            }
        });
        Object.defineProperty(this, "resolveExitPromise", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: () => { }
        });
        Object.defineProperty(this, "rejectExitPromise", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: () => { }
        });
        Object.defineProperty(this, "unsubscribeExit", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: () => { }
        });
        Object.defineProperty(this, "calculateLayout", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: () => {
                const terminalWidth = this.options.stdout.columns || 80;
                this.rootNode.yogaNode.setWidth(terminalWidth);
                this.rootNode.yogaNode.calculateLayout(undefined, undefined, Yoga.DIRECTION_LTR);
            }
        });
        Object.defineProperty(this, "onRender", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: () => {
                if (this.isUnmounted) {
                    return;
                }
                const { output, outputHeight, staticOutput } = render(this.rootNode);
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
                // 原版: outputHeight >= stdout.rows 时强制 clearTerminal + 全屏重写
                // 新版: 仅在 viewport 实际变化（resize）时才清屏
                const terminalWidth = this.options.stdout.columns || 80;
                const terminalHeight = this.options.stdout.rows;

                const clearReason = this.flickerTracker.shouldClearScreen({
                    output,
                    outputHeight,
                    viewport: { width: terminalWidth, height: terminalHeight }
                });

                if (clearReason) {
                    // 真的需要清屏：resize 场景
                    this.options.stdout.write(
                        ansiEscapes.clearTerminal + this.fullStaticOutput + output
                    );
                    this.lastOutput = output;
                    return;
                }

                // Fairy Fork: 检查是否是 spinner 等微小变化（用于调试）
                this.flickerTracker.isOnlySpinnerChange(output);

                // To ensure static output is cleanly rendered before main output, clear main output first
                if (hasStaticOutput) {
                    this.log.clear();
                    this.options.stdout.write(staticOutput);
                    this.log(output);
                }
                if (!hasStaticOutput && output !== this.lastOutput) {
                    this.throttledLog(output);
                }
                this.lastOutput = output;
            }
        });
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
        this.isUnmounted = false;
        this.lastOutput = '';
        this.fullStaticOutput = '';
        this.container = reconciler.createContainer(this.rootNode, 
            0, null, false, null, 'id', () => { }, null);
        this.unsubscribeExit = signalExit(this.unmount, { alwaysLast: false });
        if (process.env['DEV'] === 'true') {
            reconciler.injectIntoDevTools({
                bundleType: 0,
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
    render(node) {
        const tree = (React.createElement(App, { stdin: this.options.stdin, stdout: this.options.stdout, stderr: this.options.stderr, writeToStdout: this.writeToStdout, writeToStderr: this.writeToStderr, exitOnCtrlC: this.options.exitOnCtrlC, onExit: this.unmount }, node));
        reconciler.updateContainer(tree, this.container, null, noop);
    }
    writeToStdout(data) {
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
        // Fairy Fork: 重置 flicker tracker
        this.flickerTracker.reset();
        this.log.clear();
        this.options.stdout.write(data);
        this.log(this.lastOutput);
    }
    writeToStderr(data) {
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
        // Fairy Fork: 重置 flicker tracker
        this.flickerTracker.reset();
        this.log.clear();
        this.options.stderr.write(data);
        this.log(this.lastOutput);
    }
    unmount(error) {
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
        if (isCi) {
            this.options.stdout.write(this.lastOutput + '\n');
        }
        else if (!this.options.debug) {
            this.log.done();
        }
        this.isUnmounted = true;
        reconciler.updateContainer(null, this.container, null, noop);
        instances.delete(this.options.stdout);
        if (error instanceof Error) {
            this.rejectExitPromise(error);
        }
        else {
            this.resolveExitPromise();
        }
    }
    async waitUntilExit() {
        if (!this.exitPromise) {
            this.exitPromise = new Promise((resolve, reject) => {
                this.resolveExitPromise = resolve;
                this.rejectExitPromise = reject;
            });
        }
        return this.exitPromise;
    }
    clear() {
        if (!isCi && !this.options.debug) {
            this.log.clear();
            // Fairy Fork: 重置 flicker tracker
            this.flickerTracker.reset();
        }
    }
    patchConsole() {
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
//# sourceMappingURL=ink.js.map