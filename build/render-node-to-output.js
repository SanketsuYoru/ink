import widestLine from 'widest-line';
import indentString from 'indent-string';
// eslint-disable-next-line n/file-extension-in-import
import Yoga from 'yoga-wasm-web/auto';
import wrapText from './wrap-text.js';
import getMaxWidth from './get-max-width.js';
import squashTextNodes from './squash-text-nodes.js';
import renderBorder from './render-border.js';
// If parent container is `<Box>`, text nodes will be treated as separate nodes in
// the tree and will have their own coordinates in the layout.
// To ensure text nodes are aligned correctly, take X and Y of the first text node
// and use it as offset for the rest of the nodes
// Only first node is taken into account, because other text nodes can't have margin or padding,
// so their coordinates will be relative to the first node anyway
const applyPaddingToText = (node, text) => {
    const yogaNode = node.childNodes[0]?.yogaNode;
    if (yogaNode) {
        const offsetX = yogaNode.getComputedLeft();
        const offsetY = yogaNode.getComputedTop();
        text = '\n'.repeat(offsetY) + indentString(text, offsetX);
    }
    return text;
};

// Render children of a scroll container with viewport culling.
// scrollTopY..scrollBottomY are the visible window in CHILD-LOCAL Yoga coords.
// Children entirely outside this window are skipped.
function renderScrolledChildren(node, output, offsetX, offsetY, transformers, skipStaticElements, scrollTopY, scrollBottomY) {
    for (const childNode of node.childNodes) {
        const childElem = childNode;
        const cy = childElem.yogaNode;
        if (cy) {
            const childTop = cy.getComputedTop();
            const childHeight = cy.getComputedHeight();
            // Cull children entirely outside the visible window
            if (childTop + childHeight <= scrollTopY || childTop >= scrollBottomY) {
                continue;
            }
        }
        renderNodeToOutput(childElem, output, {
            offsetX,
            offsetY,
            transformers,
            skipStaticElements
        });
    }
}

// After nodes are laid out, render each to output object, which later gets rendered to terminal
const renderNodeToOutput = (node, output, options) => {
    const { offsetX = 0, offsetY = 0, transformers = [], skipStaticElements } = options;
    if (skipStaticElements && node.internal_static) {
        return;
    }
    const { yogaNode } = node;
    if (yogaNode) {
        if (yogaNode.getDisplay() === Yoga.DISPLAY_NONE) {
            return;
        }
        // Left and top positions in Yoga are relative to their parent node
        const x = offsetX + yogaNode.getComputedLeft();
        const y = offsetY + yogaNode.getComputedTop();
        // Transformers are functions that transform final text output of each component
        // See Output class for logic that applies transformers
        let newTransformers = transformers;
        if (typeof node.internal_transform === 'function') {
            newTransformers = [node.internal_transform, ...transformers];
        }
        if (node.nodeName === 'ink-text') {
            let text = squashTextNodes(node);
            if (text.length > 0) {
                const currentWidth = widestLine(text);
                const maxWidth = getMaxWidth(yogaNode);
                if (currentWidth > maxWidth) {
                    const textWrap = node.style.textWrap ?? 'wrap';
                    text = wrapText(text, maxWidth, textWrap);
                }
                text = applyPaddingToText(node, text);
                output.write(x, y, text, { transformers: newTransformers });
            }
            return;
        }
        let clipped = false;
        if (node.nodeName === 'ink-box') {
            renderBorder(x, y, node, output);

            const overflowX = node.style.overflowX ?? node.style.overflow;
            const overflowY = node.style.overflowY ?? node.style.overflow;
            const clipHorizontally = overflowX === 'hidden' || overflowX === 'scroll';
            const clipVertically = overflowY === 'hidden' || overflowY === 'scroll';
            const isScrollY = overflowY === 'scroll';

            let x1, x2, y1, y2;
            if (clipHorizontally) {
                x1 = x + yogaNode.getComputedBorder(Yoga.EDGE_LEFT);
                x2 = x + yogaNode.getComputedWidth() - yogaNode.getComputedBorder(Yoga.EDGE_RIGHT);
            }
            if (clipVertically) {
                y1 = y + yogaNode.getComputedBorder(Yoga.EDGE_TOP);
                y2 = y + yogaNode.getComputedHeight() - yogaNode.getComputedBorder(Yoga.EDGE_BOTTOM);
            }
            if (clipHorizontally || clipVertically) {
                output.clip({ x1, x2, y1, y2 });
                clipped = true;
            }

            if (isScrollY) {
                // Scroll container rendering.
                // Structure: <Box overflowY="scroll"> ← scroll container
                //              <Box flexShrink={0}>   ← content wrapper
                //                {spacers + items}
                //              </Box>
                //            </Box>
                const content = node.childNodes.find(c => c.yogaNode);
                const contentYoga = content?.yogaNode;
                if (content && contentYoga) {
                    const padTop = yogaNode.getComputedPadding(Yoga.EDGE_TOP);
                    const padBottom = yogaNode.getComputedPadding(Yoga.EDGE_BOTTOM);
                    const innerHeight = Math.max(1,
                        (y2 ?? y + yogaNode.getComputedHeight()) -
                            (y1 ?? y) -
                            padTop -
                            padBottom);

                    // Drain pendingScrollDelta
                    let scrollTop = node.scrollTop ?? 0;
                    const pending = node.pendingScrollDelta;
                    if (pending !== undefined && pending !== 0) {
                        scrollTop += pending;
                        node.pendingScrollDelta = undefined;
                    }

                    const scrollHeight = contentYoga.getComputedHeight();
                    const maxScroll = Math.max(0, scrollHeight - innerHeight);
                    scrollTop = Math.max(0, Math.min(scrollTop, maxScroll));
                    node.scrollTop = scrollTop;
                    node.scrollHeight = scrollHeight;
                    node.scrollViewportHeight = innerHeight;
                    node.scrollViewportTop = (y1 ?? y) + padTop;

                    // Content position with scroll offset applied
                    const contentX = x + contentYoga.getComputedLeft();
                    const contentY = y + contentYoga.getComputedTop() - scrollTop;

                    // Render children with culling
                    renderScrolledChildren(content, output, contentX, contentY, newTransformers, skipStaticElements, scrollTop, scrollTop + innerHeight);
                }
            } else {
                // Non-scroll: render all children normally
                for (const childNode of node.childNodes) {
                    renderNodeToOutput(childNode, output, {
                        offsetX: x,
                        offsetY: y,
                        transformers: newTransformers,
                        skipStaticElements
                    });
                }
            }

            if (clipped) {
                output.unclip();
            }
        }
        if (node.nodeName === 'ink-root') {
            for (const childNode of node.childNodes) {
                renderNodeToOutput(childNode, output, {
                    offsetX: x,
                    offsetY: y,
                    transformers: newTransformers,
                    skipStaticElements
                });
            }
        }
    }
};
export default renderNodeToOutput;
//# sourceMappingURL=render-node-to-output.js.map
