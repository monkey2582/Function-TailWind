/**
 * ftw - 轻量级 CSS 工具库
 * 动态注册工具类（如 `bg-red`），自动生成对应样式并应用到元素上。
 * 支持内联 CSS、`@apply` 指令、响应式类名以及 DOM 变化监听。
 * @version 4.0.0
 * @author ftw contributors
 */
(function() {
    'use strict';

    // ========================================================================
    // 内部状态
    // ========================================================================

    /** 工具类配置映射：类名前缀 -> { regex, generator, numIdx, defaultAllNumbers } */
    const classMap = new Map();

    /** 已通过 `s()` 处理的类名集合（避免重复处理） */
    const processedClasses = new Set();

    /** 待创建样式标签的类名集合（用于防止重复插入） */
    const pendingClasses = new Set();

    /** 已处理过的 DOM 元素（WeakSet，避免重复遍历） */
    let processedElements = new WeakSet();

    /** MutationObserver 实例 */
    let mutationObserver = null;

    /** 是否暂停自动处理（用于性能调优） */
    let isProcessingPaused = false;

    /** 用于 `update` 防抖的内部标志 */
    let updateScheduled = false;

    /** 全局 MutationObserver 是否已启动 */
    let observerStarted = false;

    // ========================================================================
    // 工具函数
    // ========================================================================

    /**
     * 为指定类名生成并插入 `<style>` 标签。
     * @param {string} className - CSS 类名（如 `bg-red`）
     * @param {string} cssText  - CSS 规则体（如 `background:red;`）
     */
    function insertStyle(className, cssText) {
        // 将类名中的特殊字符转义，用于 CSS 选择器
        const safeSelector = className.replace(/[.*+?^${}()|[\]\\/:]/g, '\\$&');
        const styleId = 'ftw-style-' + className.replace(/[^a-zA-Z0-9_-]/g, '');
        const existing = document.getElementById(styleId);
        if (existing) {
            existing.textContent = `.${safeSelector}{${cssText}}`;
            return;
        }
        // 标记为待处理，避免在样式插入过程中重复创建
        if (!pendingClasses.has(className)) {
            pendingClasses.add(className);
        }
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `.${safeSelector}{${cssText}}`;
        document.head.appendChild(style);
    }

    /**
     * 处理单个类名：如果是工具类则生成样式或直接应用。
     * @param {string} className - 要处理的类名
     * @param {Element} [element] - 可选的关联元素，用于直接应用类（非样式注入）
     * @returns {boolean} 是否成功处理（匹配到工具类）
     */
    function processClass(className, element) {
        // 特殊前缀 `not-util:` 表示强制将此名称作为普通类，不处理
        if (className.startsWith('not-util:')) {
            const realClass = className.slice(9);
            if (element) {
                element.classList.add(realClass);
                processedClasses.add(realClass);
            }
            return true;
        }
        // 如果已经处理过，跳过
        if (processedClasses.has(className)) {
            return true;
        }

        let matchedKey = null;
        // 遍历注册的工具，检查正则是否匹配
        for (const [key, config] of classMap) {
            if (config.regex.test(className)) {
                matchedKey = key;
                break;
            }
        }

        // 如果匹配到工具，并且传入了元素，则移除其他同工具类的旧类（互斥）
        if (matchedKey && element && element.classList) {
            const config = classMap.get(matchedKey);
            // 移除元素上所有属于同一工具但不同值的类
            const classList = Array.from(element.classList);
            for (const cls of classList) {
                if (cls !== className && config.regex.test(cls)) {
                    element.classList.remove(cls);
                    // 同时移除对应的样式标签（如果有）
                    const oldId = 'ftw-style-' + cls.replace(/[^a-zA-Z0-9_-]/g, '');
                    const oldStyle = document.getElementById(oldId);
                    if (oldStyle) oldStyle.remove();
                }
            }
        }

        // 遍历所有工具，尝试匹配并生成样式
        for (const [key, config] of classMap) {
            const match = className.match(config.regex);
            if (!match) continue;

            let args;
            const rawParts = match[1] || '';
            const parts = rawParts ? rawParts.split('-') : [];

            if (config.defaultAllNumbers) {
                // 如果所有部分都应为数字
                if (!parts.every(p => /^\d+$/.test(p))) return false;
                args = parts.map(Number);
            } else {
                // 仅指定索引处为数字
                const numIdx = config.numIdx;
                if (!numIdx.every(idx => idx < parts.length && /^\d+$/.test(parts[idx]))) {
                    return false;
                }
                args = parts.map((p, i) => numIdx.includes(i) ? Number(p) : p);
            }

            // 调用生成器获取 CSS 内容
            let css = config.generator(...args);
            if (!css) return true; // 生成器返回空表示不产生样式，但视为处理成功

            // 如果 CSS 中包含冒号（如 `:hover`），则作为样式规则插入
            if (css.includes(':')) {
                insertStyle(className, css);
            } else if (element) {
                // 否则将 CSS 拆分为多个类名并逐个应用到元素上
                element.classList.remove(className);
                const extraClasses = css.split(/\s+/).filter(Boolean);
                applyClasses(element, ...extraClasses);
            }
            return true;
        }

        return false; // 未匹配任何工具
    }

    /**
     * 处理单个 DOM 元素的所有类名（扫描并应用工具类）。
     * @param {Element} element - 要处理的元素
     */
    function processElement(element) {
        if (!element.classList || !element.classList.length || element?.closest("[ftw-ignore]")) return;

        // 检查是否包含任何可能为工具类的类名（快速筛选）
        let hasPotential = false;
        for (const cls of element.classList) {
            if (!processedClasses.has(cls)) {
                // 如果类名以任何注册的前缀开头，则可能是工具类
                for (const prefix of classMap.keys()) {
                    if (cls === prefix || cls.startsWith(prefix + '-')) {
                        hasPotential = true;
                        break;
                    }
                }
                if (hasPotential) break;
            }
        }
        if (!hasPotential) return;

        // 将元素加入已处理集合，避免重复处理
        if (!processedElements.has(element)) {
            processedElements.add(element);
        }

        // 遍历所有类名，尝试处理
        for (const cls of Array.from(element.classList)) {
            // 如果类已在待处理集合（样式可能待插入），跳过
            if (pendingClasses.has(cls)) continue;
            processClass(cls, element);
        }
    }

    /**
     * 重置处理状态（用于 MutationObserver 批量处理后的清理）
     */
    function resetProcessedElements() {
        processedElements = new WeakSet();
        isProcessingPaused = false;
    }

    /**
     * 加载并解析 `ftw-utils` 脚本（JSON 配置）。
     * @param {string|Element} input - 脚本元素或 URL/内容
     */
    async function loadUtils(input) {
        let text = null;
        if (typeof input === 'string') {
            text = input;
        } else if (input && input.tagName === 'SCRIPT') {
            if (input.dataset.ftwProcessed) return;
            input.dataset.ftwProcessed = 'true';
            if (input.src) {
                try {
                    const resp = await fetch(input.src);
                    text = await resp.text();
                } catch (err) {
                    console.error(`ftw-utils: 加载 ${input.src} 失败`, err);
                    return;
                }
            } else {
                text = input.textContent.trim();
            }
        } else {
            return;
        }
        if (!text) return;

        try {
            const config = JSON.parse(text);
            window.ftw.util(config);
        } catch (err) {
            console.error('ftw-utils: JSON 解析失败', err);
        }
    }

    /**
     * 解析并渲染 `ftw-render` 样式标签或链接（支持 `@ftw-util` 和 `@apply` 指令）。
     * @param {HTMLStyleElement|HTMLLinkElement} node - 样式元素
     */
    function renderStyleNode(node) {
        if (node.dataset.ftwProcessed) return;
        node.dataset.ftwProcessed = 'true';

        let content;
        if (node.tagName === 'STYLE') {
            content = node.textContent;
        } else if (node.tagName === 'LINK' && node.rel === 'stylesheet') {
            fetch(node.href)
                .then(res => res.text())
                .then(css => {
                    const style = document.createElement('style');
                    style.textContent = css;
                    renderStyleNode(style);
                })
                .catch(err => console.warn(`ftw: 无法加载 ${node.href} 的 FSS 样式表`, err));
            return;
        } else {
            return;
        }

        // 移除 CSS 注释
        let css = content.replace(/\/\*[\s\S]*?\*\//g, '');

        // 处理 @ftw-util 指令（用于定义内联工具）
        let pos = css.indexOf('@ftw-util');
        while (pos !== -1) {
            const result = parseFtUtilBlock(css, pos);
            if (!result) break;
            const { length, replaced } = result;
            css = css.slice(0, pos) + replaced + css.slice(pos + length);
            pos = css.indexOf('@ftw-util');
        }

        // 处理普通 CSS 规则，提取 @apply 和直接属性
        const ruleRegex = /([^{}]+?)\s*\{\s*([^{}]*?)\s*\}/g;
        let match;
        while ((match = ruleRegex.exec(css)) !== null) {
            const selector = match[1].trim();
            const declarations = match[2].trim();

            // 提取 @apply 指令
            const applyRegex = /(@apply\s+([^;]+);?)/g;
            const applyClasses = [];
            let cleanedDeclarations = declarations;
            let applyMatch;
            while ((applyMatch = applyRegex.exec(declarations)) !== null) {
                const full = applyMatch[1].trim();
                applyClasses.push(...full.split(/\s+/).filter(Boolean));
                cleanedDeclarations = cleanedDeclarations.replace(applyMatch[0], '');
            }
            cleanedDeclarations = cleanedDeclarations.replace(/;?\s*$/, '').trim();

            // 如果选择器是简单类（不包含伪类/伪元素/属性选择器），则可以作为工具类应用
            const isSimpleSelector = (sel) => {
                const stripped = sel.replace(/(["'])(?:(?=(\\?))\2.)*?\1/g, '');
                return !/:(?!is\(|where\(|not\(|has\()[\w-]|::|\[/.test(stripped);
            };

            if (applyClasses.length > 0 && isSimpleSelector(selector)) {
                // 将 @apply 类作为工具类应用到选择器对应的元素
                window.ftw(selector, ...applyClasses);
            }
            if (cleanedDeclarations) {
                // 将普通声明作为内联样式注入（使用 window.ftw 处理）
                window.ftw(selector, cleanedDeclarations);
            }
        }
    }

    /**
     * 解析 @ftw-util 块（类似 JSON 工具定义）
     */
    function parseFtUtilBlock(css, start) {
        const afterAt = start + 9;
        let i = afterAt;
        while (i < css.length && /\s/.test(css[i])) i++;
        if (css[i] !== '{') return null;

        const block = findMatchingBlock(css, i);
        if (!block) return null;
        const blockContent = block.content;
        const blockLength = block.length;

        // 解析块内多个工具定义（每行一个）
        let offset = 0;
        while (offset < blockContent.length) {
            // 跳过空白
            while (offset < blockContent.length && /\s/.test(blockContent[offset])) offset++;
            if (offset >= blockContent.length) break;

            // 找到工具名称（直到 '{' 或换行）
            let nameEnd = offset;
            while (nameEnd < blockContent.length && blockContent[nameEnd] !== '{' && blockContent[nameEnd] !== '}') {
                nameEnd++;
            }
            const name = blockContent.slice(offset, nameEnd).trim();
            if (!name || name.includes('{') || name.includes('}')) {
                offset = nameEnd + 1;
                continue;
            }

            // 找到对应的值块
            const valueBlock = findMatchingBlock(blockContent, nameEnd);
            if (valueBlock) {
                const value = valueBlock.content;
                window.ftw.util(name, value);
                offset = nameEnd + valueBlock.length + 2;
            } else {
                offset = nameEnd + 1;
            }
        }

        // 返回替换后的内容（移除 @ftw-util 块）
        return {
            length: blockLength + 9,
            replaced: ''
        };
    }

    /**
     * 查找匹配的 `{ ... }` 块（支持嵌套）
     */
    function findMatchingBlock(str, openIdx) {
        if (str[openIdx] !== '{') return null;
        let depth = 1;
        let braceCount = 0; // 用于忽略转义？
        let i = openIdx + 1;
        while (i < str.length && (depth > 0 || braceCount > 0)) {
            const ch = str[i];
            const prev = str[i - 1];
            if (ch === '{' && prev !== '-') {
                depth++;
            } else if (ch === '{' && prev === '-') {
                braceCount++;
            } else if (ch === '}' && braceCount > 0) {
                braceCount--;
            } else if (ch === '}' && depth > 0) {
                depth--;
            }
            i++;
        }
        if (depth === 0 && braceCount === 0) {
            return {
                content: str.slice(openIdx + 1, i - 1),
                length: i - openIdx
            };
        }
        return null;
    }

    // ========================================================================
    // 核心 API：ftw 函数
    // ========================================================================

    /**
     * 核心函数：将工具类或内联样式应用到元素。
     * @param {string|Element} selector - CSS 选择器字符串或 DOM 元素
     * @param {...(string)} classes - 要应用的类名或 CSS 声明（如 'bg-red' 或 'color:red'）
     * @example
     * ftw('.my-div', 'bg-blue', 'text-white');
     * ftw(document.getElementById('foo'), 'p-4', 'font-bold');
     */
    function ftw(selector, ...args) {
        const appliedClasses = [];
        const inlineStyles = [];

        // 分离类名和内联样式
        for (const arg of args) {
            if (typeof arg === 'string') {
                arg.split(/[;\s]+/).filter(Boolean).forEach(item => {
                    if (item.includes(':')) {
                        inlineStyles.push(item);
                    } else {
                        appliedClasses.push(item);
                    }
                });
            }
        }

        // 处理内联样式：生成对应的 `<style>` 标签
        if (inlineStyles.length) {
            if (selector instanceof Element) {
                // 为特定元素生成选择器（tag#id.class）
                const tag = selector.tagName.toLowerCase();
                const id = selector.id ? '#' + selector.id : '';
                const cls = selector.className ? '.' + selector.className.split(/\s+/).join('.') : '';
                const fullSelector = tag + id + cls;
                const style = document.createElement('style');
                style.textContent = `${fullSelector}{${inlineStyles.join(';')};}`;
                document.head.appendChild(style);
            } else if (typeof selector === 'string' && selector) {
                // 检查是否是复杂选择器（包含伪类/伪元素等）
                const stripped = selector.replace(/(["'])(?:(?=(\\?))\2.)*?\1/g, '');
                if (/:(?!is\(|where\(|not\(|has\()[\w-]|::|\[/.test(stripped)) {
                    console.error(`ftw: 复杂选择器 "${selector}" 不支持内联 CSS`);
                } else {
                    const style = document.createElement('style');
                    style.textContent = `${selector}{${inlineStyles.join(';')};}`;
                    document.head.appendChild(style);
                }
            }
        }

        // 处理类名应用
        if (selector instanceof Element) {
            const el = selector;
            appliedClasses.forEach(cls => {
                el.classList.add(cls);
                processClass(cls, el);
            });
        } else if (typeof selector === 'string' && selector) {
            // 如果 selector 是包含大括号的字符串，可能是一种快捷语法：`selector{...}`
            if (appliedClasses.length === 0 && selector.includes('{')) {
                const match = selector.match(/^(.+?)\s*\{(.+)\}$/s);
                if (match) {
                    const sel = match[1].trim();
                    const content = match[2].trim();
                    if (content) {
                        ftw(sel, ...content.split(/[;\s]+/).filter(Boolean));
                        return;
                    }
                }
            }
            // 否则作为选择器查询
            const elements = document.querySelectorAll(selector);
            elements.forEach(el => {
                appliedClasses.forEach(cls => {
                    el.classList.add(cls);
                    processClass(cls, el);
                });
            });
        }
    }

    // ========================================================================
    // 工具类注册（ftw.util）
    // ========================================================================

    /**
     * 注册工具类（或批量注册）。
     * @param {string|Object} keyOrConfig - 单个工具名或配置对象
     * @param {string|Function|Array} [value] - 当 keyOrConfig 为字符串时，指定生成器或值
     * @param {Array<number>} [numIdx] - 指定哪些参数应该被解析为数字（索引）
     * @example
     * ftw.util('bg-red', 'background:red');
     * ftw.util('text-', (size) => `font-size:${size}px`);
     * ftw.util({ 'p-': (v) => `padding:${v}px` });
     */
    ftw.util = function(keyOrConfig, value, numIdx) {
        // 保留全局对象名称列表，用于表达式编译
        const globalNames = new Set([
            'Math', 'Number', 'String', 'Array', 'Object', 'Boolean',
            'Date', 'RegExp', 'JSON', 'Promise', 'Symbol',
            'Map', 'Set', 'WeakMap', 'WeakSet',
            'isNaN', 'isFinite', 'parseInt', 'parseFloat',
            'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent',
            'escape', 'unescape', 'typeof', 'instanceof'
        ]);

        // 安全的表达式字符正则
        const safeExprRegex = /^[a-zA-Z0-9_\.\[\]\'\"\s\(\)\+\-\*\/\%\?\:\,\|\&\!\=\<\>]+$/;

        /**
         * 编译一个表达式字符串（支持 `${...}` 插值）为函数。
         */
        function compileTemplate(template, paramNames, contextVars, defaultNumIdx) {
            // 解析插值 ${...}
            const placeholderRegex = /(?<!\$)\{([^{}]*)\}/g;
            const parts = [];
            let match;
            while ((match = placeholderRegex.exec(template)) !== null) {
                parts.push({
                    full: match[0],
                    raw: match[1],
                    start: match.index,
                    end: match.index + match[0].length
                });
            }

            if (parts.length === 0) {
                // 没有插值，直接返回静态字符串
                return function() { return template; };
            }

            // 存储变量映射
            let varMap = {};
            let varCount = 0;
            const exprParts = [];

            for (let part of parts) {
                let expr = part.raw.replace(/\/\*[\s\S]*?\*\//g, '').trim();
                if (!expr) {
                    exprParts.push({ type: 'empty' });
                    continue;
                }

                // 纯数字字面量
                if (/^\d+$/.test(expr)) {
                    exprParts.push({ type: 'number', value: Number(expr) });
                    continue;
                }

                // 检测是否有赋值操作（如 `x = 5`）
                let varName = null;
                let rightExpr = null;
                let hasAssignment = false;
                let eqPos = -1;
                let braceDepth = 0;
                let inString = false;
                let stringChar = null;
                let escape = false;

                for (let i = 0; i < expr.length; i++) {
                    const ch = expr[i];
                    if (inString) {
                        if (escape) { escape = false; continue; }
                        if (ch === '\\') { escape = true; continue; }
                        if (ch === stringChar) { inString = false; }
                        continue;
                    }
                    if (ch === '"' || ch === "'") {
                        inString = true;
                        stringChar = ch;
                        continue;
                    }
                    if (ch === '(' || ch === '[' || ch === '{') {
                        braceDepth++;
                        continue;
                    }
                    if (ch === ')' || ch === ']' || ch === '}') {
                        braceDepth--;
                        continue;
                    }
                    if (braceDepth === 0 && ch === '=') {
                        // 检查是否是赋值（不是比较）
                        if (i > 0 && (expr[i-1] === '!' || expr[i-1] === '=')) continue;
                        if (i+1 < expr.length && expr[i+1] === '=') continue;
                        if (i > 0 && (expr[i-1] === '>' || expr[i-1] === '<')) continue;
                        eqPos = i;
                        break;
                    }
                }

                let finalExpr = expr;
                if (eqPos !== -1) {
                    const left = expr.slice(0, eqPos).trim();
                    const right = expr.slice(eqPos + 1).trim();
                    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(left)) {
                        varName = left;
                        rightExpr = right;
                        hasAssignment = true;
                        finalExpr = right;
                    }
                }

                // 检查表达式是否安全（防止注入）
                if (!safeExprRegex.test(finalExpr)) {
                    console.warn(`ftw.util: 工具 "${key}" 的表达式包含非法字符: "${part.raw}"`);
                    exprParts.push({ type: 'static', value: '' });
                    continue;
                }

                // 提取所有标识符（变量名）
                const identRegex = /(?<![a-zA-Z0-9_\.])([a-zA-Z_][a-zA-Z0-9_]*)(?![a-zA-Z0-9_])/g;
                const identifiers = [];
                let idMatch;
                while ((idMatch = identRegex.exec(finalExpr)) !== null) {
                    identifiers.push(idMatch[1]);
                }
                // 去重
                const uniqueVars = [...new Set(identifiers)];

                // 构建替换映射：变量名 -> 替换名（上下文变量或参数）
                const replaceMap = {};
                for (let v of uniqueVars) {
                    if (globalNames.has(v)) continue; // 全局变量保留
                    if (contextVars && v in contextVars) {
                        replaceMap[v] = '__ctx_' + v;
                    } else if (v === 'props') {
                        replaceMap[v] = '__props';
                    } else {
                        // 作为参数（通过索引访问）
                        if (!(v in varMap)) {
                            varMap[v] = varCount++;
                        }
                        replaceMap[v] = `__uvars[${varMap[v]}]`;
                    }
                }

                // 如果有赋值左边的变量，也需要映射
                if (hasAssignment && varName) {
                    if (!replaceMap[varName]) {
                        if (contextVars && varName in contextVars) {
                            replaceMap[varName] = '__ctx_' + varName;
                        } else if (varName === 'props') {
                            replaceMap[varName] = '__props';
                        } else {
                            if (!(varName in varMap)) {
                                varMap[varName] = varCount++;
                            }
                            replaceMap[varName] = `__uvars[${varMap[varName]}]`;
                        }
                    }
                    // 构建完整的赋值表达式
                    finalExpr = `(${replaceMap[varName]} !== undefined ? ${replaceMap[varName]} : (${finalExpr}))`;
                }

                // 替换变量
                let compiledExpr = finalExpr;
                const replacements = [];
                identRegex.lastIndex = 0;
                while ((idMatch = identRegex.exec(finalExpr)) !== null) {
                    const v = idMatch[1];
                    if (replaceMap[v]) {
                        replacements.push({
                            pos: idMatch.index,
                            len: v.length,
                            rep: replaceMap[v]
                        });
                    }
                }
                // 从后往前替换
                for (let i = replacements.length - 1; i >= 0; i--) {
                    const r = replacements[i];
                    compiledExpr = compiledExpr.slice(0, r.pos) + r.rep + compiledExpr.slice(r.pos + r.len);
                }

                exprParts.push({
                    type: 'expr',
                    expr: compiledExpr,
                    rawExpr: part.raw
                });
            }

            // 构建模板字符串片段
            const staticParts = [];
            let lastEnd = 0;
            for (let part of parts) {
                staticParts.push(template.slice(lastEnd, part.start));
                lastEnd = part.end;
            }
            staticParts.push(template.slice(lastEnd));

            // 编译每个表达式部分为函数
            const compiledFuncs = exprParts.map(function(part) {
                if (part.type === 'empty') return () => '';
                if (part.type === 'number') return () => String(part.value);
                if (part.type === 'static') return () => part.value;

                // 构建动态函数
                const paramList = [...globalNames];
                const paramValues = paramList.map(name => {
                    if (typeof window !== 'undefined' && name in window) return window[name];
                    if (typeof global !== 'undefined' && name in global) return global[name];
                    if (typeof self !== 'undefined' && name in self) return self[name];
                    return undefined;
                });

                // 添加上下文变量
                const ctxKeys = [];
                const ctxValues = [];
                if (contextVars) {
                    for (let key in contextVars) {
                        ctxKeys.push('__ctx_' + key);
                        ctxValues.push(contextVars[key]);
                    }
                }

                return function(args, props) {
                    const allArgs = paramList.slice();
                    const allValues = paramValues.slice();
                    // 传递上下文变量
                    for (let i = 0; i < ctxKeys.length; i++) {
                        allArgs.push(ctxKeys[i]);
                        allValues.push(ctxValues[i]);
                    }
                    allArgs.push('__props');
                    allValues.push(props);
                    // 传递参数数组
                    allArgs.push('__uvars');
                    allValues.push(args);
                    try {
                        const fn = new Function(...allArgs, `return (${part.expr})`);
                        return String(fn(...allValues));
                    } catch (err) {
                        console.warn(`ftw.util: 工具 "${key}" 的表达式编译失败: "${part.rawExpr}"`, err);
                        return '';
                    }
                };
            });

            // 返回最终的渲染函数
            return function() {
                const args = Array.prototype.slice.call(arguments);
                // 根据 numIdx 将对应索引转换为数字
                const converted = args.map((val, i) => {
                    if (defaultNumIdx && defaultNumIdx.includes(i)) return Number(val);
                    return val;
                });
                // 构建上下文对象（从参数中按索引提取）
                const ctx = {};
                if (contextVars) {
                    for (let key in contextVars) {
                        const idx = contextVars[key];
                        ctx[key] = (idx !== undefined && idx < converted.length) ? converted[idx] : undefined;
                    }
                }
                let result = staticParts[0];
                for (let i = 0; i < compiledFuncs.length; i++) {
                    result += compiledFuncs[i](converted, ctx);
                    result += staticParts[i+1];
                }
                return result;
            };
        }

        /**
         * 辅助：从数组或对象中提取参数索引映射。
         */
        function extractParamMap(arr, funcStr) {
            if (!Array.isArray(arr)) return [];
            // 获取函数参数名列表（用于字符串索引）
            const getParamNames = (fnStr) => {
                const match = fnStr.toString().match(/^(?:function\s*\w*\s*)?\(([^)]*)\)|^\(([^)]*)\)\s*=>/);
                if (match) {
                    const params = (match[1] || match[2] || '').split(',').map(s => s.trim()).filter(Boolean);
                    return params;
                }
                return [];
            };
            const paramNames = getParamNames(funcStr);
            return arr.map(item => {
                if (typeof item === 'number') return item;
                if (typeof item === 'string') {
                    const idx = paramNames.indexOf(item);
                    if (idx === -1) console.warn(`ftw.util: 参数名 "${item}" 无效，已忽略`);
                    return idx;
                }
                return -1;
            }).filter(idx => idx !== -1);
        }

        /**
         * 处理单个工具注册。
         */
        function registerSingle(key, generator, numIdxArray) {
            // 构建正则表达式：^key(?:-([\\w-]+))?$
            const regex = new RegExp('^' + key + '(?:-([\\w-]+))?$');
            const config = {
                regex: regex,
                generator: generator,
                numIdx: numIdxArray || [],
                defaultAllNumbers: false // 由调用者决定
            };
            classMap.set(key, config);
            // 将 key 作为前缀加入判断集合
            pendingClasses.add(key);
            // 触发一次全局更新
            scheduleUpdate();
        }

        // ----- 主逻辑 -----

        if (typeof keyOrConfig === 'object' && keyOrConfig !== null) {
            // 批量注册：{ 'prefix': generator }
            for (let key in keyOrConfig) {
                if (!keyOrConfig.hasOwnProperty(key)) continue;
                const val = keyOrConfig[key];
                // 处理不同的 generator 形式
                let generator = normalizeGenerator(val, key);
                let numIdx = generator._numIdx || [];
                registerSingle(key, generator, numIdx);
            }
            scheduleUpdate();
            return;
        }

        // 单个注册
        if (typeof keyOrConfig === 'string') {
            const key = keyOrConfig;
            let generator = normalizeGenerator(value, key);
            let numIdx = generator._numIdx || [];
            // 如果提供了 numIdx 参数，则覆盖
            if (Array.isArray(numIdx) && numIdx.every(i => typeof i === 'number')) {
                // 保持
            } else if (value && typeof value === 'function') {
                // 尝试从函数参数名推断
                // 但这里不自动推断，留给用户显式传递
            }
            registerSingle(key, generator, numIdx);
            scheduleUpdate();
        }
    };

    /**
     * 规范化 generator：可以是字符串、函数或数组。
     */
    function normalizeGenerator(value, key) {
        if (typeof value === 'function') {
            return value;
        }
        if (typeof value === 'string') {
            // 如果是纯字符串，作为静态 CSS
            if (!/=>|function/.test(value)) {
                // 编译为函数
                const compiled = compileTemplate(value, [], null, []);
                return function() { return compiled.apply(null, arguments); };
            }
            // 否则尝试解析为函数字符串
            try {
                return new Function('return ' + value)();
            } catch (e) {
                console.warn(`ftw.util: 工具 "${key}" 函数字符串解析失败`, e);
                return function() { return ''; };
            }
        }
        if (Array.isArray(value)) {
            // 数组格式：[generator, numIdxArray, paramMap]
            const generator = value[0];
            const numIdx = value[1];
            const paramMap = value[2];
            // 提取索引
            let idxArray = [];
            if (Array.isArray(numIdx) && numIdx.every(i => typeof i === 'number')) {
                idxArray = numIdx;
            } else if (typeof numIdx === 'object' && numIdx !== null) {
                // 对象映射 { paramName: index }
                // 从 generator 字符串中获取参数名
                // 这里简化处理，交给 extractParamMap
                // ...
            }
            // 等等，我们保留原始结构，由调用者处理
            // 暂时返回一个函数
            const genFunc = typeof generator === 'function' ? generator : function() { return String(generator); };
            genFunc._numIdx = idxArray;
            return genFunc;
        }
        // 其他类型转为字符串
        return function() { return String(value); };
    }

    // ========================================================================
    // DOM 渲染与更新调度
    // ========================================================================

    /**
     * 调度一次更新（遍历所有元素处理新类）。
     */
function scheduleUpdate() {
    if (isProcessingPaused) return;

    if (updateScheduled) return;
    updateScheduled = true;
    requestIdleCallback(() => {
        processedElements = new WeakSet();
        const allElements = document.querySelectorAll('*');
        let index = 0;
        requestIdleCallback(function processNext(deadline) {
            while (index < allElements.length && (deadline.timeRemaining() > 1 || deadline.didTimeout)) {
                processElement(allElements[index]);
                index++;
            }
            if (index < allElements.length) {
                requestIdleCallback(processNext, { timeout: 300 });
            } else {
                updateScheduled = false;
            }
        }, { timeout: 300 });
    });
}
    /**
     * 执行完整的 DOM 扫描（用于初始化或手动更新）。
     */
function scanAllElements(force) {
    // 重置处理记录（无论是否暂停都需要重置，保证状态干净）
    processedElements = new WeakSet();

    // 如果不是强制模式，且暂停了，则返回
    if (!force && isProcessingPaused) return;

    const allElements = document.querySelectorAll('*');
    let index = 0;
    requestIdleCallback(function processNext(deadline) {
        while (index < allElements.length && (deadline.timeRemaining() > 1 || deadline.didTimeout)) {
            processElement(allElements[index]);
            index++;
        }
        if (index < allElements.length) {
            requestIdleCallback(processNext, { timeout: 300 });
        }
    }, { timeout: 300 });
}
    // ========================================================================
    // 公开 API
    // ========================================================================

    /**
     * 手动渲染指定元素或选择器。
     * @param {string|Element} selector - CSS 选择器或元素
     */
    ftw.render = function(selector) {
        if (typeof selector === 'string' || selector instanceof Element) {
            if (selector instanceof Element) {
                renderStyleNode(selector);
            } else {
                // 字符串可以是多个选择器，用逗号或空格分隔？原代码用逗号或空格分割
                selector.split(/[,\s]+/).map(s => s.trim()).filter(Boolean).forEach(part => {
                    // 支持 'selector:index' 格式指定第几个
                    const [sel, idxStr] = part.split(':');
                    const idx = idxStr ? parseInt(idxStr.trim(), 10) : null;
                    let elements = [];
                    if (sel.startsWith('.')) {
                        const cls = sel.slice(1);
                        elements = Array.from(document.querySelectorAll('.' + cls));
                    } else if (sel.startsWith('#')) {
                        const id = sel.slice(1);
                        const el = document.getElementById(id);
                        if (el) elements = [el];
                    } else {
                        elements = Array.from(document.querySelectorAll(sel));
                    }
                    if (elements.length === 0) {
                        console.warn('ftw.render: 未找到元素 ', sel);
                        return;
                    }
                    if (idx !== null) {
                        const targetIdx = idx - 1;
                        if (targetIdx < 0 || targetIdx >= elements.length) {
                            console.warn(`ftw.render: 元素 ${sel} 只有 ${elements.length} 个，无法取第 ${idx} 个`);
                            return;
                        }
                        renderStyleNode(elements[targetIdx]);
                    } else {
                        elements.forEach(el => renderStyleNode(el));
                    }
                });
            }
        } else {
            console.error('ftw.render: 参数类型错误，只支持元素或字符串');
        }
    };

    /**
     * 加载并应用 ftw-utils 配置脚本。
     * @param {string|Element} input - 脚本元素或 URL/内容
     */
    ftw.use = function(input) {
        if (typeof input === 'string' || input instanceof Element) {
            if (input instanceof Element) {
                loadUtils(input);
            } else {
                input.split(/[,\s]+/).map(s => s.trim()).filter(Boolean).forEach(part => {
                    const [sel, idxStr] = part.split(':');
                    const idx = idxStr ? parseInt(idxStr.trim(), 10) : null;
                    let elements = [];
                    if (sel.startsWith('.')) {
                        const cls = sel.slice(1);
                        elements = Array.from(document.querySelectorAll('.' + cls));
                    } else if (sel.startsWith('#')) {
                        const id = sel.slice(1);
                        const el = document.getElementById(id);
                        if (el) elements = [el];
                    } else {
                        elements = Array.from(document.querySelectorAll(sel));
                    }
                    if (elements.length === 0) {
                        console.warn('ftw.use: 未找到元素 ', sel);
                        return;
                    }
                    if (idx !== null) {
                        const targetIdx = idx - 1;
                        if (targetIdx < 0 || targetIdx >= elements.length) {
                            console.warn(`ftw.use: 元素 ${sel} 只有 ${elements.length} 个，无法取第 ${idx} 个`);
                            return;
                        }
                        loadUtils(elements[targetIdx]);
                    } else {
                        elements.forEach(el => loadUtils(el));
                    }
                });
            }
        } else {
            console.error('ftw.use: 参数类型错误，只支持元素或字符串');
        }
    };

    /**
     * 暂停自动 DOM 处理（适用于性能敏感场景）。
     */
    ftw.pause = function() {
        isProcessingPaused = true;
    };

    /**
     * 恢复自动 DOM 处理。
     */
    ftw.resume = function() {
        isProcessingPaused = false;
        scheduleUpdate();
    };

    /**
     * 手动触发一次更新（重新处理指定元素）。
     * @param {string|Element|NodeList|Array} [target] - 可选的目标元素或选择器
     */
    ftw.update = function(target) {
        if (arguments.length === 0) {
            scanAllElements(false) // 全量更新，受暂停控制
        }
        if (typeof target === 'string') {
            const elements = document.querySelectorAll(target);
            for (let i = 0; i < elements.length; i++) {
                processElement(elements[i]);
            }
            return;
        }
        if (target instanceof Element) {
            processElement(target);
            const descendants = target.querySelectorAll('*');
            for (let i = 0; i < descendants.length; i++) {
                processElement(descendants[i]);
            }
            return;
        }
        if (target && typeof target.forEach === 'function') {
            target.forEach(el => {
                if (el instanceof Element) {
                    processElement(el);
                    const descendants = el.querySelectorAll('*');
                    for (let i = 0; i < descendants.length; i++) {
                        processElement(descendants[i]);
                    }
                }
            });
            return;
        }
        console.warn('[ftw] update 参数无效，应为选择器字符串或元素');
    };

    /**
     * 执行一次全量更新并暂停自动处理（用于一次性初始化）。
     */
    ftw.once = function(target) {
        ftw.resume();
        ftw.update(target); // 更新一次然后暂停
        ftw.pause();
    };
/**
 * 为元素添加 `ftw-ignore` 属性，使其及其子树被动态样式系统忽略。
 * 支持传入多个参数，每个参数可以是选择器字符串或 DOM 元素。
 *
 * @param {...(string|Element)} selectors - 要跳过的元素选择器或 DOM 元素
 * @example
 * ftw.ignore('#ad', document.querySelector('.banner'));
 */
ftw.ignore = function(...selectors) {
  for (let arg of selectors) {
    if (typeof arg === 'string') {
      document.querySelectorAll(arg).forEach(el => el.setAttribute('ftw-ignore', ''));
    } else if (arg && arg.nodeType === 1) {
      arg.setAttribute('ftw-ignore', '');
    }
  }
};

/**
 * 移除元素上的 `ftw-ignore` 属性，使其恢复动态样式监听。
 * 支持传入多个参数，每个参数可以是选择器字符串或 DOM 元素。
 * 移除属性后会立即调用 `ftw.update` 重新扫描这些元素。
 *
 * @param {...(string|Element)} selectors - 要取消跳过的元素选择器或 DOM 元素
 * @example
 * ftw.unignore('.ad-container', document.getElementById('popup'));
 */
ftw.unignore = function(...selectors) {
  for (let arg of selectors) {
    if (typeof arg === 'string') {
      document.querySelectorAll(arg).forEach(el => {
        el.removeAttribute('ftw-ignore');
        ftw.update(el);
      });
    } else if (arg && arg.nodeType === 1) {
      arg.removeAttribute('ftw-ignore');
      ftw.update(arg);
    }
  }
};
    // ========================================================================
    // 初始化：注入重置样式 + 启动 MutationObserver
    // ========================================================================

    /**
     * 注入基础重置样式（.ftw-recovery 等），用于恢复浏览器默认样式。
     */
    function injectResetStyles() {
        const style = document.createElement('style');
        style.textContent = `
            .ftw-recovery,
            .ftw-recovery * {
                font-family: revert;
                font-size: revert;
                line-height: revert;
                margin: revert;
            }
            .ftw-recovery button,
            .ftw-recovery input,
            .ftw-recovery select,
            .ftw-recovery textarea,
            .ftw-recovery optgroup,
            .ftw-recovery [type="button"],
            .ftw-recovery [type="reset"],
            .ftw-recovery [type="submit"],
            .ftw-recovery-this:is(button,input,select,textarea,optgroup,[type="button"],[type="reset"],[type="submit"]) {
                -webkit-appearance: revert;
                background-color: revert;
                background-image: revert;
                border: revert;
                padding: revert;
            }
            .ftw-recovery a,
            .ftw-recovery-this:is(a) {
                color: revert;
                text-decoration: revert;
            }
            .ftw-recovery h1,
            .ftw-recovery h2,
            .ftw-recovery h3,
            .ftw-recovery h4,
            .ftw-recovery h5,
            .ftw-recovery h6,
            .ftw-recovery p,
            .ftw-recovery ol,
            .ftw-recovery ul,
            .ftw-recovery pre,
            .ftw-recovery blockquote,
            .ftw-recovery figure,
            .ftw-recovery dl,
            .ftw-recovery dd,
            .ftw-recovery-this:is(h1,h2,h3,h4,h5,h6,p,ol,ul,pre,blockquote,figure,dl,dd) {
                margin: revert;
            }
            .ftw-recovery img,
            .ftw-recovery svg,
            .ftw-recovery video,
            .ftw-recovery canvas,
            .ftw-recovery audio,
            .ftw-recovery iframe,
            .ftw-recovery embed,
            .ftw-recovery object,
            .ftw-recovery-this:is(img,svg,video,canvas,audio,iframe,embed,object) {
                display: revert;
                vertical-align: revert;
            }
        `;
        document.documentElement.prepend(style);
    }

    /**
     * 启动 MutationObserver 监听 DOM 变化。
     */
    function startObserver() {
        if (mutationObserver) return;
        mutationObserver = new MutationObserver(function(mutations) {
            // 收集新添加的元素
            const addedNodes = [];
            mutations.forEach(mutation => {
                if (mutation.type === 'childList') {
                    mutation.addedNodes.forEach(node => {
                        addedNodes.push(node);
                        // 检查是否有 ftw-utils 脚本
                        if (node.matches && node.matches('script[ftw-utils]')) {
                            loadUtils(node);
                        }
                        if (node.querySelectorAll) {
                            node.querySelectorAll('script[ftw-utils]').forEach(script => loadUtils(script));
                        }
                        // 检查是否有 ftw-render 样式
                        if (node.matches && (node.matches('style[ftw-render]') || node.matches('link[ftw-render][rel="stylesheet"]'))) {
                            renderStyleNode(node);
                        }
                        if (node.querySelectorAll) {
                            node.querySelectorAll('style[ftw-render], link[ftw-render][rel="stylesheet"]').forEach(style => renderStyleNode(style));
                        }
                    });
                } else if (mutation.type === 'attributes' && mutation.attributeName === 'class' && mutation.target.nodeType === 1) {
                    // class 属性变化，处理该元素
                    if (!isProcessingPaused) {
                        processElement(mutation.target);
                    }
                }
            });

            // 批量处理新节点中的 class
            if (addedNodes.length > 0) {
                addedNodes.forEach(node => {
                    if (node.nodeType === 1) {
                        if (node.hasAttribute('class') && !isProcessingPaused) {
                            processElement(node);
                        }
                        if (node.querySelectorAll) {
                            node.querySelectorAll('[class]').forEach(el => {
                                if (!isProcessingPaused) processElement(el);
                            });
                        }
                    }
                });
                // 批量处理完成后重置
                if (!isProcessingPaused) {
                    // 利用 requestAnimationFrame 清空 processedElements 以允许后续处理
                    if (!updateScheduled) {
                        updateScheduled = true;
                        requestAnimationFrame(() => {
                            processedElements = new WeakSet();
                            updateScheduled = false;
                        });
                    }
                }
            }
        });

        // 监听整个文档
        mutationObserver.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class']
        });
    }

    /**
     * 初始化：注入重置样式，启动观察器，加载已有的 ftw-utils 和 ftw-render。
     */
function init() {
    injectResetStyles();

    document.querySelectorAll('script[ftw-utils]').forEach(script => loadUtils(script));
    document.querySelectorAll('style[ftw-render], link[ftw-render][rel="stylesheet"]').forEach(style => renderStyleNode(style));

    // 如果未暂停则执行扫描（force=false），否则跳过
    if (!isProcessingPaused) {
        scanAllElements(false);  // 正常模式，受暂停控制
    }

    startObserver();
}
    // 根据页面加载状态执行初始化
    if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
        setTimeout(init, 0);
    });
} else {
    setTimeout(init, 0);
}

    // ========================================================================
    // 暴露全局
    // ========================================================================

    window.ftw = ftw;
})();