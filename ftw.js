/**
 * @file ftw.js - 动态原子化 CSS 引擎 (Function-TailWind)
 * 这是一个运行时动态解析类名并生成、注入样式表的轻量级 CSS-in-JS 工具库包。
 * @version 5.0.0
 */

!(function () {
  // ==========================================
  // 1. 全局状态与核心注册表定义
  // ==========================================

  /** @type {Map<string, {regex: RegExp, generator: Function, idxOrder: Array<number|string>}>} 存储注册的工具类生成器 */
  const utilityRules = new Map();

  /** @type {Set<string>} 忽略解析的特殊类名集合（直接添加到元素中，不走动态 CSS 生成） */
  const ignoredClasses = new Set();

  /** @type {Set<string>} 已处理过的类名缓存，防止重复解析 */
  const processedClasses = new Set();

  /** @type {WeakSet<Element>} 已处理过的 DOM 元素缓存，避免重复扫描 */
  let processedElements = new WeakSet();

  /** @type {Map<string, string>} 存储已生成的类名与对应 CSS 属性字符串的映射 */
  const generatedStylesMap = new Map();

  /** @type {MutationObserver|null} 监听 DOM 树变动，用于动态响应新元素的 Class 变化 */
  let domObserver = null;

  /** @type {boolean} 是否已调度 requestAnimationFrame 重置 processedElements 状态 */
  let isRafScheduled = false;

  // 初始化动态样式表元素
  let styleElement = document.getElementById("ftw-styles");
  if (!styleElement) {
    styleElement = document.createElement("style");
    styleElement.id = "ftw-styles";
    document.head.appendChild(styleElement);
  }

  /** @type {CSSStyleSheet} 动态样式表的 CSSStyleSheet 实例 */
  const styleSheet = styleElement.sheet;

  /** @type {Map<string, {index: number, refCount: number, alias: string}>} 类名到样式索引及引用计数的映射 */
  const classRegistry = new Map();

  /** @type {Map<string, {index: number, className: string}>} CSS 规则到索引及对应类名的映射（用于去重复） */
  const cssRegistry = new Map();

  /** @type {Set<string>} 已注册的原子类前缀集合 (例如: 'w', 'h', 'bg' 等) */
  const utilityPrefixes = new Set();

  // ==========================================
  // 2. 样式注入与垃圾回收机制 (CSS Insertion & GC)
  // ==========================================

  /**
   * 向全局 StyleSheet 中插入一条 CSS 规则
   * @param {string} className 类名
   * @param {string} cssDeclarationValue 具体的 CSS 声明 (例如 "color: red;")
   */
  function insertStyleRule(className, cssDeclarationValue) {
    const existingClass = classRegistry.get(className);
    if (existingClass) {
      existingClass.refCount++;
      return;
    }

    const existingCss = cssRegistry.get(cssDeclarationValue);
    if (existingCss) {
      classRegistry.set(className, {
        index: existingCss.index,
        refCount: 1,
        alias: existingCss.className
      });
      return;
    }

    // 转义类名以支持特殊字符 (如带有括号、斜杠、小数点的类名)
    const escapedClass = window.CSS && CSS.escape 
      ? CSS.escape(className) 
      : className.replace(/[^a-zA-Z0-9_-]/g, "\\$&");

    const ruleText = `.${escapedClass}{${cssDeclarationValue}}`;
    const newIndex = styleSheet.insertRule(ruleText, styleSheet.cssRules.length);

    classRegistry.set(className, { index: newIndex, refCount: 1 });
    cssRegistry.set(cssDeclarationValue, { index: newIndex, className });
  }

  /**
   * 释放对某个类名样式规则的引用，若引用计数归零则彻底从样式表中移除
   * @param {string} className 要移除的类名
   */
  function removeStyleRule(className) {
    const registryInfo = classRegistry.get(className);
    if (!registryInfo) return;

    registryInfo.refCount--;
    if (registryInfo.refCount <= 0) {
      if (!registryInfo.alias) {
        styleSheet.deleteRule(registryInfo.index);
        // 从样式去重表中删除对应记录
        cssRegistry.forEach((value, key) => {
          if (value.index === registryInfo.index) {
            cssRegistry.delete(key);
          }
        });
      }
      classRegistry.delete(className);
      generatedStylesMap.delete(className);
    }
  }

  /**
   * 彻底的垃圾回收 (Garbage Collection)
   * 扫描页面中所有的 DOM 节点，找出目前没有任何节点在使用的 ftw 样式规则，并从样式表中清除
   */
  function garbageCollectUnusedStyles() {
    const activeClassesInDOM = new Set();
    document.querySelectorAll("*").forEach(el => {
      if (el.classList) {
        el.classList.forEach(cls => activeClassesInDOM.add(cls));
      }
    });

    for (const [registeredClass, registryInfo] of classRegistry) {
      if (!activeClassesInDOM.has(registeredClass)) {
        // 如果 DOM 中已无该类名，将引用计数扣减至 0 触发物理移除
        while (registryInfo.refCount > 0) {
          removeStyleRule(registeredClass);
        }
      }
    }
  }

  // ==========================================
  // 3. 类名解析与原子样式生成核心 (Parsing & Generation)
  // ==========================================

  /**
   * 处理单个类名，解析并生成其对应的样式规则
   * @param {string} rawClass 原始类名 (例如 "w-10", "!bg-red-500", "not-util:my-custom-class")
   * @param {Element} [targetElement] 携带该类名的目标 DOM 元素
   * @returns {boolean} 是否成功处理该类名
   */
  function processUtilityClass(rawClass, targetElement) {
    // 1. 处理不作为原子类解析的特殊跳过前缀 (not-util: / # 开头)
    const bypassClass = rawClass.startsWith("not-util:")
      ? rawClass.slice(9)
      : rawClass.startsWith("#")
      ? rawClass.slice(1)
      : null;

    if (bypassClass) {
      if (targetElement) {
        targetElement.classList.add(bypassClass);
        ignoredClasses.add(bypassClass);
      }
      return true;
    }

    if (ignoredClasses.has(rawClass)) return true;

    // 2. 匹配对应原子类的正则表达式生成器
    let matchedRuleKey = null;
    for (const [key, rule] of utilityRules) {
      if (rule.regex.test(rawClass)) {
        matchedRuleKey = key;
        break;
      }
    }

    // 3. 处理排他类（如果该元素已有同类型规则，则移除旧的引用，替换为新的）
    if (matchedRuleKey && targetElement && targetElement.classList) {
      const ruleDef = utilityRules.get(matchedRuleKey);
      for (const currentClass of Array.from(targetElement.classList)) {
        if (currentClass !== rawClass && ruleDef.regex.test(currentClass)) {
          targetElement.classList.remove(currentClass);
          removeStyleRule(currentClass);
        }
      }
    }

    // 4. 解析修饰符（支持 ! 前缀，用于强制转为 !important）
    let isImportant = false;
    let baseClass = rawClass;
    for (const prefix of utilityPrefixes) {
      if (rawClass === "!" + prefix || rawClass.startsWith("!" + prefix + "-")) {
        isImportant = true;
        baseClass = rawClass.slice(1); // 剥离 '!'
        break;
      }
    }

    // 5. 正式提取参数并生成样式
    for (const [ruleKey, ruleDef] of utilityRules) {
      const matches = baseClass.match(ruleDef.regex);
      if (!matches) continue;
      
      // 分割中括号内容
      function splitSuffix(s) {
       if (!s) return [];
       const parts = [];
       let current = '';
       let inBracket = false;
       for (let i = 0; i < s.length; i++) {
         const ch = s[i];
         if (ch === '[') {
            inBracket = true;
            current += ch;
         } else if (ch === ']') {
            inBracket = false;
            current += ch;
         } else if (ch === '-' && !inBracket) {
            parts.push(current);
            current = '';
         } else {
            current += ch;
         }
       }
      if (current) parts.push(current);
      return parts.map(p => {
         if (p.startsWith('[') && p.endsWith(']')) {
             return p.slice(1, -1);
         }
         return p;
       });
      }
      // 提取横杠分隔的数值或字符串参数
      const rawParams = matches[1] ? splitSuffix(matches[1]) : [];
      const orderDef = ruleDef.idxOrder || [];
      const typesList = ruleKey.split(":").slice(1).map(t => (t === "num" ? "num" : "str"));

      let processedParams = [];
      if (orderDef.length === 0) {
        processedParams = rawParams.map((val, idx) => {
          const expectedType = idx < typesList.length ? typesList[idx] : "str";
          return expectedType === "num" ? Number(val) : val;
        });
      } else {
        processedParams = orderDef.map((orderIdx, idx) => {
          const rawVal = orderIdx < rawParams.length ? rawParams[orderIdx] : "";
          const expectedType = idx < typesList.length ? typesList[idx] : "str";
          return expectedType === "num" ? Number(rawVal) : rawVal;
        });
      }

      // 如果期望数字但解析为 NaN，说明不是合法匹配
      if (
        processedParams.some(
          (val, idx) => (idx < typesList.length ? typesList[idx] : "str") === "num" && Number.isNaN(val)
        )
      ) {
        continue;
      }

      // 执行生成器函数产生 CSS 样式值
      let cssDeclaration = ruleDef.generator(...processedParams);
      if (cssDeclaration) {
        // 全量替换 !imp → !important
        cssDeclaration = cssDeclaration.replace(/!imp/g, '!important');
        if (isImportant) {
          // 如果带有 '!' 前缀，所有 CSS 规则追加 !important
          cssDeclaration = cssDeclaration
            .split(";")
            .map(part => {
              const trimmed = part.trim();
              return trimmed ? trimmed + (trimmed.includes("!important") ? "" : "!important") : "";
            })
            .filter(Boolean)
            .join(";");
        }
        generatedStylesMap.set(rawClass, cssDeclaration);
      }

      if (!cssDeclaration) return false;

      // 如果生成的代码段中带有冒号 ':' 说明是具体的 CSS 属性（如 color:red），插入样式表。
      // 如果是一串其他类名，说明是别名（Alias），直接应用这些类名并从元素中卸载当前的别名。
      if (cssDeclaration.includes(":")) {
        insertStyleRule(rawClass, cssDeclaration);
      } else if (targetElement) {
        targetElement.classList.remove(rawClass);
        cssDeclaration.split(/\s+/).filter(Boolean).forEach(cls => targetElement.classList.add(cls));
      }
      return true;
    }

    return false;
  }

  /**
   * 解析某个元素中的所有 Class，过滤并处理原子类
   * @param {Element} element DOM 元素
   */
  function processElementClasses(element) {
    if (!element.classList || !element.classList.length || element?.closest("[ftw-ignore]")) return;

    let hasAtomicClass = false;
    for (const className of element.classList) {
      if (!ignoredClasses.has(className)) {
        for (const prefix of utilityPrefixes) {
          if (className === prefix || className.startsWith(prefix + "-")) {
            hasAtomicClass = true;
            break;
          }
        }
        if (hasAtomicClass) break;
      }
    }

    if (hasAtomicClass) {
      if (!processedElements.has(element)) {
        processedElements.add(element);
      }
      element.classList.forEach(className => {
        if (!processedClasses.has(className)) {
          processUtilityClass(className, element);
        }
      });
    }
  }

  /**
   * 重置已处理元素的 WeakSet 缓存
   */
  function resetProcessedCache() {
    processedElements = new WeakSet();
    isRafScheduled = false;
  }

  // ==========================================
  // 4. JSON / FSS (Style Sheet) 特效配置解析
  // ==========================================

  /**
   * 解析页面中引入的配置脚本 (支持从 data-ftw-processed 配置中获取 JSON)
   * @param {Element|string} targetScript
   */
  async function parseScriptUtility(targetScript) {
    let rawText = null;
    if (typeof targetScript === "string") {
      rawText = targetScript;
    } else {
      if (!targetScript || targetScript.tagName !== "SCRIPT") return;
      if (targetScript.dataset.ftwProcessed) return;

      targetScript.dataset.ftwProcessed = "true";
      if (targetScript.src) {
        try {
          const response = await fetch(targetScript.src);
          rawText = await response.text();
        } catch (err) {
          console.error(`ftw-utils: 加载外部配置失败: ${targetScript.src}`, err);
          return;
        }
      } else {
        rawText = targetScript.textContent.trim();
      }
    }

    if (rawText) {
      try {
        const configJson = JSON.parse(rawText);
        ftw.util(configJson);
      } catch (err) {
        console.error("ftw-utils: 配置 JSON 解析失败", err);
      }
    }
  }

  /**
   * 解析含有自定义 @ftw-util 的 CSS 样式标签或外链样式表
   * @param {Element} styleTag STYLE 标签或 LINK 样式表标签
   */
  function parseStyleRender(styleTag) {
    /**
     * 辅助解析：递归提取大括号 {} 内的代码块并转换为 ftw.util 工具注册
     */
    function extractUtilityBlock(text, keywordIndex) {
      const remainingText = text.slice(keywordIndex + 9);
      let whitespaceOffset = 0;
      while (whitespaceOffset < remainingText.length && /\s/.test(remainingText[whitespaceOffset])) {
        whitespaceOffset++;
      }

      if (remainingText[whitespaceOffset] === "{") {
        const block = findClosingCurlyBrace(remainingText, whitespaceOffset);
        if (block === null) return null;

        let content = block;
        let scanIdx = 0;
        while (scanIdx < content.length) {
          while (scanIdx < content.length && /\s/.test(content[scanIdx])) {
            scanIdx++;
          }
          if (scanIdx >= content.length) break;

          let startIdx = scanIdx;
          let braceIdx = -1;
          for (; scanIdx < content.length; ) {
            if (content[scanIdx] === "{" && scanIdx > 0 && content[scanIdx - 1] !== "-") {
              braceIdx = scanIdx;
              break;
            }
            scanIdx++;
          }
          if (braceIdx === -1) break;

          const utilityName = content.slice(startIdx, braceIdx).trim();
          if (!utilityName || utilityName.includes("{") || utilityName.includes("}")) {
            scanIdx = braceIdx + 1;
            continue;
          }

          const innerBlock = findClosingCurlyBrace(content, braceIdx);
          if (innerBlock !== null) {
            ftw.util(utilityName, innerBlock);
            scanIdx = braceIdx + innerBlock.length + 2;
          } else {
            scanIdx = braceIdx + 1;
          }
        }
        return { length: whitespaceOffset + block.length + 2 };
      } else {
        let braceStart = whitespaceOffset;
        while (braceStart < remainingText.length && remainingText[braceStart] !== "{") {
          braceStart++;
        }
        const utilityName = remainingText.slice(whitespaceOffset, braceStart).trim();
        const block = findClosingCurlyBrace(remainingText, braceStart);
        if (block !== null && utilityName) {
          ftw.util(utilityName, block);
          return { length: braceStart + block.length + 2 };
        }
        return null;
      }
    }

    /**
     * 辅助解析：寻找闭合的 } 括号并捕获其内容
     */
    function findClosingCurlyBrace(text, openIndex) {
      if (text[openIndex] !== "{") return null;
      let depth = 1;
      let negativeLookBehindDepth = 0;
      let idx = openIndex + 1;
      for (; idx < text.length && (depth > 0 || negativeLookBehindDepth > 0); ) {
        const char = text[idx];
        const prevChar = text[idx - 1];
        if (char === "{" && prevChar !== "-") {
          depth++;
        } else if (char === "{" && prevChar === "-") {
          negativeLookBehindDepth++;
        } else if (char === "}" && negativeLookBehindDepth > 0) {
          negativeLookBehindDepth--;
        } else if (char === "}" && depth > 0) {
          depth--;
        }
        idx++;
      }
      return depth === 0 && negativeLookBehindDepth === 0 ? text.slice(openIndex + 1, idx - 1) : null;
    }

    if (styleTag.dataset.ftwProcessed) return;
    styleTag.dataset.ftwProcessed = "true";

    const isScoped = styleTag.hasAttribute("ftw-scoped");
    const scopeSelector = isScoped ? "[ftw-scoped]" : "";

    if (styleTag.tagName === "STYLE") {
      (function processStyles(cssText) {
        // 清理注释，转换不规范的 !imp 简写
        let sanitizedText = cssText
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/!imp(?=\s|;|$|})/g, "!important");

        // 处理 @ftw-util 语法结构
        let utilKeywordIndex = sanitizedText.indexOf("@ftw-util");
        while (utilKeywordIndex !== -1) {
          const parsedObj = extractUtilityBlock(sanitizedText, utilKeywordIndex);
          if (parsedObj === null) break;
          sanitizedText = sanitizedText.slice(0, utilKeywordIndex) + sanitizedText.slice(utilKeywordIndex + 9 + parsedObj.length);
          utilKeywordIndex = sanitizedText.indexOf("@ftw-util");
        }

        // 解析一般的 CSS 选择器匹配和 @apply 别名混入
        let match;
        const cssRuleRegex = /([^{}]+?)\s*\{\s*([^{}]*?)\s*\}/g;
        const isSimpleSelector = sel => {
          const cleanSel = sel.replace(/(["'])(?:(?=(\\?))\2.)*?\1/g, "");
          return !/:(?!is\(|where\(|not\(|has\()[\w-]|::|\[/.test(cleanSel);
        };

        while ((match = cssRuleRegex.exec(sanitizedText)) !== null) {
          let selector = match[1].trim();
          let rulesBody = match[2].trim();
          const applyRegex = /(@apply\s+([^;]+);?)/g;
          let appliedClasses = [];
          let filteredRulesBody = rulesBody;

          let applyMatch;
          while ((applyMatch = applyRegex.exec(rulesBody)) !== null) {
            const rawClasses = applyMatch[1].trim();
            appliedClasses.push(...rawClasses.split(/\s+/).filter(Boolean));
            filteredRulesBody = filteredRulesBody.replace(applyMatch[0], "");
          }

          filteredRulesBody = filteredRulesBody.replace(/;?\s*$/, "").trim();
          if (scopeSelector) {
            selector = selector.split(",").map(sel => `${sel.trim()}${scopeSelector}`).join(",");
          }

          // 将 @apply 类名绑定并渲染到目标选择器
          if (appliedClasses.length > 0 && isSimpleSelector(selector)) {
            ftw(selector, ...appliedClasses);
          }
          if (filteredRulesBody) {
            ftw(selector, ...filteredRulesBody.split(/[;\s]+/).filter(Boolean));
          }
        }
      })(styleTag.textContent);
    } else if (styleTag.tagName === "LINK" && styleTag.rel === "stylesheet") {
      fetch(styleTag.href)
        .then(res => res.text())
        .then(css => {
          const virtualStyle = document.createElement("style");
          if (isScoped) virtualStyle.setAttribute("ftw-scoped", "");
          virtualStyle.textContent = css;
          parseStyleRender(virtualStyle);
        })
        .catch(err => console.warn(`ftw: 无法从 ${styleTag.href} 加载 CSS 样式, 错误: ${err}`));
    }
  }

  // ==========================================
  // 5. 核心 API 实现 (ftw / b)
  // ==========================================

  /**
   * ftw 核心绑定函数：为选择器匹配的元素应用原子样式或 CSS 代码段
   * @param {Element|string} target 目标 DOM 元素或 CSS 选择器
   * @param {...string} classNamesOrCssRules 类名列表或 CSS 样式段
   */
  function ftw(target, ...classNamesOrCssRules) {
    let classesToApply = [];
    let rawStyleStatements = [];

    classNamesOrCssRules.forEach(arg => {
      if (typeof arg === "string") {
        arg.replace(/!imp(?=\s|;|$|})/g, "!important")
          .split(/[;\s]+/)
          .filter(Boolean)
          .forEach(val => {
            if (val.includes(":")) {
              rawStyleStatements.push(val);
            } else {
              classesToApply.push(val);
            }
          });
      }
    });

    // 处理原生 CSS 声明的动态样式块注入
    if (rawStyleStatements.length) {
      if (target instanceof Element) {
        const uniqueIdClass =
          target.tagName.toLowerCase() +
          (target.id ? "#" + target.id : "") +
          (target.className ? "." + target.className.split(/\s+/).join(".") : "");

        document.head.appendChild(
          Object.assign(document.createElement("style"), {
            textContent: `${uniqueIdClass}{${rawStyleStatements.join(";")};}`
          })
        );
      } else if (typeof target === "string" && target) {
        const sanitizedTarget = target.replace(/(["'])(?:(?=(\\?))\2.)*?\1/g, "");
        if (/: (?!is\(|where\(|not\(|has\()[\w-]|::|\[/.test(sanitizedTarget)) {
          console.error(`ftw: 复杂选择器 "${target}" 不支持内联 CSS`);
        } else {
          document.head.appendChild(
            Object.assign(document.createElement("style"), {
              textContent: `${target}{${rawStyleStatements.join(";")};}`
            })
          );
        }
      }
    }

    // 处理原子类名的添加和触发样式分析
    if (target instanceof Element) {
      const element = target;
      let finalClasses = [];
      classesToApply.forEach(arg => {
        if (typeof arg === "string") {
          arg.split(/[;\s]+/).forEach(cls => cls && finalClasses.push(cls));
        }
      });
      finalClasses.forEach(cls => {
        element.classList.add(cls);
        processUtilityClass(cls, element);
      });
      return;
    }

    if (typeof target !== "string" || !target) return;

    // 如果参数中包含花括号 {}，说明是以选择器整体声明的形式传入 (例如: ".box { color: red }")
    if (classesToApply.length === 0 && target.includes("{")) {
      const matches = target.match(/^(.+?)\s*\{(.+)\}$/s);
      if (matches) {
        const cleanSelector = matches[1].trim();
        const bodyContent = matches[2].trim();
        if (bodyContent) {
          return ftw(cleanSelector, ...bodyContent.split(/[;\s]+/).filter(Boolean));
        }
      }
    }

    let flatClassesList = [];
    classesToApply.forEach(arg => {
      if (typeof arg === "string") {
        arg.split(/[;\s]+/).forEach(cls => cls && flatClassesList.push(cls));
      }
    });

    document.querySelectorAll(target).forEach(el => {
      flatClassesList.forEach(cls => {
        el.classList.add(cls);
        processUtilityClass(cls, el);
      });
    });
  }

  // ==========================================
  // 6. 默认恢复/重置底层样式表注入 (CSS Resets)
  // ==========================================
  (function injectRecoveryStyle() {
    const style = document.createElement("style");
    style.textContent =
      ".ftw-recovery,.ftw-recovery *{font-family:revert;font-size:revert;line-height:revert;margin:revert}" +
      '.ftw-recovery button,.ftw-recovery input,.ftw-recovery select,.ftw-recovery textarea,.ftw-recovery optgroup,.ftw-recovery [type="button"],.ftw-recovery [type="reset"],.ftw-recovery [type="submit"],.ftw-recovery-this:is(button,input,select,textarea,optgroup,[type="button"],[type="reset"],[type="submit"]){-webkit-appearance:revert;background-color:revert;background-image:revert;border:revert;padding:revert}' +
      ".ftw-recovery a,.ftw-recovery-this:is(a){color:revert;text-decoration:revert}" +
      ".ftw-recovery h1,.ftw-recovery h2,.ftw-recovery h3,.ftw-recovery h4,.ftw-recovery h5,.ftw-recovery h6,.ftw-recovery p,.ftw-recovery ol,.ftw-recovery ul,.ftw-recovery pre,.ftw-recovery blockquote,.ftw-recovery figure,.ftw-recovery dl,.ftw-recovery dd,.ftw-recovery-this:is(h1,h2,h3,h4,h5,h6,p,ol,ul,pre,blockquote,figure,dl,dd){margin:revert}" +
      ".ftw-recovery img,.ftw-recovery svg,.ftw-recovery video,.ftw-recovery canvas,.ftw-recovery audio,.ftw-recovery iframe,.ftw-recovery embed,.ftw-recovery object,.ftw-recovery-this:is(img,svg,video,canvas,audio,iframe,embed,object){display:revert;vertical-align:revert}";
    document.documentElement.prepend(style);
  })();

  // ==========================================
  // 7. 闲置与异步执行调度系统 (Scheduler)
  // ==========================================
  let isPaused = false;
  let isIdleCallbackScheduled = false;

  /**
   * 采用 requestIdleCallback 分片执行 DOM 树节点上 class 样式的增量匹配和处理
   */
  function scheduleIdleProcessing() {
    if (isIdleCallbackScheduled) return;
    isIdleCallbackScheduled = true;

    requestIdleCallback(() => {
      processedElements = new WeakSet();
      const allElements = Array.from(document.querySelectorAll("*"));
      let index = 0;

      requestIdleCallback(
        function processChunk(deadline) {
          while (
            index < allElements.length &&
            (deadline.timeRemaining() > 1 || deadline.didTimeout)
          ) {
            processElementClasses(allElements[index]);
            index++;
          }
          if (index < allElements.length) {
            requestIdleCallback(processChunk, { timeout: 300 });
          } else {
            isIdleCallbackScheduled = false;
          }
        },
        { timeout: 300 }
      );
    });
  }

  /**
   * 注册一个新的原子工具类匹配规则
   * @param {string} classPattern 匹配类名的基础模式（例如 "w:num"）
   * @param {Function} generatorFn 生成具体 CSS 的计算函数
   * @param {Array<number|string>} [paramOrder] 参数重排映射表
   */
  function registerUtility(classPattern, generatorFn, paramOrder) {
    const basePrefix = classPattern.split(":")[0];
    const regexPattern = new RegExp(`^${basePrefix}(?:-([\\w\\.\\/\\(\\)\\[\\]#%,\\-]+))?$`);
    utilityRules.set(classPattern, {
      regex: regexPattern,
      generator: generatorFn,
      idxOrder: paramOrder || []
    });
    utilityPrefixes.add(basePrefix);
  }

  /**
   * 触发扫描和渲染
   * @param {string|Element|Array<Element>|null} [targets]
   */
  function scanAndProcessDOM(targets) {
    // 扫描自定义脚本与样式表配置
    document.querySelectorAll("script[ftw-utils]").forEach(el => parseScriptUtility(el));
    document.querySelectorAll('style[ftw-render],link[ftw-render][rel="stylesheet"]').forEach(el => parseStyleRender(el));
    
    // 执行样式垃圾回收
    garbageCollectUnusedStyles();

    if (isPaused) return;

    // 分析需要处理的节点范围
    let elementsList;
    if (arguments.length === 0 || targets === undefined) {
      elementsList = Array.from(document.querySelectorAll("*"));
    } else if (typeof targets === "string") {
      elementsList = Array.from(document.querySelectorAll(targets));
    } else if (targets instanceof Element) {
      elementsList = [targets];
    } else if (targets && typeof targets.forEach === "function") {
      elementsList = Array.from(targets);
    } else {
      elementsList = Array.from(document.querySelectorAll("*"));
    }

    const elementsToProcess = [];
    const elementsSet = new Set();

    for (let i = 0; i < elementsList.length; i++) {
      const el = elementsList[i];
      if (el && el.nodeType === 1) {
        if (!elementsSet.has(el)) {
          elementsSet.add(el);
          elementsToProcess.push(el);
        }
        if (el.querySelectorAll) {
          const children = el.querySelectorAll("*");
          for (let j = 0; j < children.length; j++) {
            const child = children[j];
            if (!elementsSet.has(child)) {
              elementsSet.add(child);
              elementsToProcess.push(child);
            }
          }
        }
      }
    }

    const totalCount = elementsToProcess.length;
    let scanIdx = 0;

    // 依然利用 requestIdleCallback 异步分批解析，不卡顿首屏渲染
    requestIdleCallback(
      function runScan(deadline) {
        while (
          scanIdx < totalCount &&
          (deadline.timeRemaining() > 1 || deadline.didTimeout)
        ) {
          processElementClasses(elementsToProcess[scanIdx]);
          scanIdx++;
        }
        if (scanIdx < totalCount) {
          requestIdleCallback(runScan, { timeout: 300 });
        }
      },
      { timeout: 300 }
    );
  }

  // ==========================================
  // 8. 扩展 API: ftw.util - 规则高级注册工具
  // ==========================================
  ftw.util = function (configOrKey, valueGenerator, numParamsOrder) {
    const JS_BUILT_INS = new Set([
        "Math","Number","String","Array","Object","Boolean","Date","RegExp","JSON",
        "Promise","Symbol","Map","Set",
        "isNaN","parseInt","parseFloat",
        "typeof","instanceof"
    ]);
    
    const SAFE_EXPR_REGEX = /^[a-zA-Z0-9_\.\[\]\'\"\s\(\)\+\-\*\/\%\?\:\,\|\&\!\=\<\>]+$/;

    /**
     * 动态创建模板编译解析器（将大括号 {x} 解析为 JS 运算表达式）
     */
    function compileTemplateExpression(templateStr, utilityName, contextMap, numericIdxs) {
      let match;
      const braceRegex = /(?<!\$)\{([^{}]*)\}/g;
      const placeholderBlocks = [];

      while ((match = braceRegex.exec(templateStr)) !== null) {
        placeholderBlocks.push({
          full: match[0],
          raw: match[1],
          start: match.index,
          end: match.index + match[0].length
        });
      }

      if (placeholderBlocks.length === 0) {
        return () => templateStr;
      }

      const expressionVarsMap = {};
      let customVarCount = 0;
      const expressionsMeta = [];

      for (let i = 0; i < placeholderBlocks.length; i++) {
        const rawExpr = placeholderBlocks[i].raw;
        const cleanExpr = rawExpr.replace(/\/\*[\s\S]*?\*\//g, "").trim();

        if (!cleanExpr) {
          expressionsMeta.push({ type: "empty" });
          continue;
        }

        if (/^\d+$/.test(cleanExpr)) {
          expressionsMeta.push({ type: "number", value: Number(cleanExpr) });
          continue;
        }

        let assignedVarName = null;
        let isAssignment = false;
        let evaluatedSubExpr = null;
        let equalsIdx = -1;
        let depth = 0;
        let inString = false;
        let stringChar = null;

        for (let idx = 0; idx < cleanExpr.length; idx++) {
          const char = cleanExpr[idx];
          if (inString) {
            if (char === "\\") {
              idx++;
              continue;
            }
            if (char === stringChar) inString = false;
          } else if (char === '"' || char === "'") {
            inString = true;
            stringChar = char;
          } else if (char === "(" || char === "[" || char === "{") {
            depth++;
          } else if (char === ")" || char === "]" || char === "}") {
            depth--;
          } else if (depth === 0 && char === "=") {
            if (idx > 0 && (cleanExpr[idx - 1] === "!" || cleanExpr[idx - 1] === "=")) continue;
            if (idx + 1 < cleanExpr.length && cleanExpr[idx + 1] === "=") continue;
            if (idx > 0 && (cleanExpr[idx - 1] === ">" || cleanExpr[idx - 1] === "<")) continue;
            equalsIdx = idx;
            break;
          }
        }

        let innerCode = cleanExpr;
        if (equalsIdx !== -1) {
          const variablePart = cleanExpr.slice(0, equalsIdx).trim();
          const expressionPart = cleanExpr.slice(equalsIdx + 1).trim();
          if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(variablePart)) {
            assignedVarName = variablePart;
            evaluatedSubExpr = expressionPart;
            isAssignment = true;
            innerCode = expressionPart;
          }
        }

        if (!SAFE_EXPR_REGEX.test(innerCode)) {
          console.warn(`ftw.util: 工具 "${utilityName}" 的表达式包含非法字符: "${rawExpr}"`);
          expressionsMeta.push({ type: "static", value: "" });
          continue;
        }

        let matchedVar;
        const varIdentifyRegex = /(?<![a-zA-Z0-9_\.])([a-zA-Z_][a-zA-Z0-9_]*)(?![a-zA-Z0-9_])/g;
        const uniqueVars = [];
        const seenVars = new Set();

        while ((matchedVar = varIdentifyRegex.exec(innerCode)) !== null) {
          const varName = matchedVar[1];
          if (!seenVars.has(varName)) {
            seenVars.add(varName);
            uniqueVars.push(varName);
          }
        }

        const varReplacementMap = {};
        for (let k = 0; k < uniqueVars.length; k++) {
          const currentVar = uniqueVars[k];
          if (!JS_BUILT_INS.has(currentVar)) {
            if (contextMap && contextMap[currentVar] !== undefined) {
              varReplacementMap[currentVar] = "__ctx_" + currentVar;
            } else if (currentVar !== "props") {
              if (expressionVarsMap[currentVar] === undefined) {
                expressionVarsMap[currentVar] = customVarCount++;
              }
              varReplacementMap[currentVar] = `__uvars[${expressionVarsMap[currentVar]}]`;
            } else {
              varReplacementMap[currentVar] = "__props";
            }
          }
        }

        if (isAssignment && assignedVarName) {
          if (!varReplacementMap[assignedVarName]) {
            if (contextMap && contextMap[assignedVarName] !== undefined) {
              varReplacementMap[assignedVarName] = "__ctx_" + assignedVarName;
            } else if (assignedVarName === "props") {
              varReplacementMap[assignedVarName] = "__props";
            } else {
              if (expressionVarsMap[assignedVarName] === undefined) {
                expressionVarsMap[assignedVarName] = customVarCount++;
              }
              varReplacementMap[assignedVarName] = `__uvars[${expressionVarsMap[assignedVarName]}]`;
            }
          }
        }

        let replacements = [];
        varIdentifyRegex.lastIndex = 0;
        while ((matchedVar = varIdentifyRegex.exec(innerCode)) !== null) {
          const currentVar = matchedVar[1];
          if (varReplacementMap[currentVar]) {
            replacements.push({
              pos: matchedVar.index,
              len: currentVar.length,
              rep: varReplacementMap[currentVar]
            });
          }
        }

        let compiledBody = innerCode;
        for (let r = replacements.length - 1; r >= 0; r--) {
          const rInfo = replacements[r];
          compiledBody = compiledBody.slice(0, rInfo.pos) + rInfo.rep + compiledBody.slice(rInfo.pos + rInfo.len);
        }

        if (isAssignment && assignedVarName && varReplacementMap[assignedVarName]) {
          compiledBody = `(${varReplacementMap[assignedVarName]} !== undefined ? ${varReplacementMap[assignedVarName]} : (${compiledBody}))`;
        }

        expressionsMeta.push({ type: "expr", expr: compiledBody, rawExpr });
      }

      const rawFragments = [];
      let lastSlicePos = 0;
      for (let f = 0; f < placeholderBlocks.length; f++) {
        rawFragments.push(templateStr.slice(lastSlicePos, placeholderBlocks[f].start));
        lastSlicePos = placeholderBlocks[f].end;
      }
      rawFragments.push(templateStr.slice(lastSlicePos));

      const compiledEvaluators = expressionsMeta.map(item => {
        if (item.type === "empty") return () => "";
        if (item.type === "number") return () => String(item.value);
        if (item.type === "static") return () => item.value;

        const systemParams = [];
        const systemGlobals = [...JS_BUILT_INS];

        for (let g = 0; g < systemGlobals.length; g++) {
          const globalObj = systemGlobals[g];
          if (typeof window !== "undefined" && window[globalObj] !== undefined) {
            systemParams.push({ name: globalObj, value: window[globalObj] });
          } else if (typeof global !== "undefined" && global[globalObj] !== undefined) {
            systemParams.push({ name: globalObj, value: global[globalObj] });
          } else if (typeof self !== "undefined" && self[globalObj] !== undefined) {
            systemParams.push({ name: globalObj, value: self[globalObj] });
          }
        }

        const paramNames = systemParams.map(item => item.name);
        const paramValues = systemParams.map(item => item.value);

        return function (ctxData, originalProps) {
          const currentNames = paramNames.slice();
          const currentValues = paramValues.slice();

          if (ctxData) {
            for (const key in ctxData) {
              if (ctxData.hasOwnProperty(key)) {
                currentNames.push("__ctx_" + key);
                currentValues.push(ctxData[key]);
              }
            }
          }

          currentNames.push("__props");
          currentValues.push(originalProps);
          currentNames.push("__uvars");
          currentValues.push(originalProps);

          try {
            return new Function(...currentNames, `return (${item.expr})`)(...currentValues);
          } catch (err) {
            console.warn(
              `ftw.util: 工具 "${utilityName}" 的表达式编译运行失败: "${item.rawExpr}"`,
              "错误原因:",
              err
            );
            return "";
          }
        };
      });

      return function (...args) {
        const props = args;
        const convertedProps = args.map((arg, idx) => (numericIdxs.includes(idx) ? Number(arg) : arg));
        const finalCtx = {};

        if (contextMap) {
          for (const key in contextMap) {
            if (contextMap.hasOwnProperty(key)) {
              const mappedIdx = contextMap[key];
              finalCtx[key] = convertedProps[mappedIdx] !== undefined ? convertedProps[mappedIdx] : undefined;
            }
          }
        }

        let finalCSSResult = rawFragments[0];
        for (let eIdx = 0; eIdx < compiledEvaluators.length; eIdx++) {
          finalCSSResult += compiledEvaluators[eIdx](finalCtx, props);
          finalCSSResult += rawFragments[eIdx + 1];
        }
        return finalCSSResult;
      };
    }

    /**
     * 将用户声明的上下文重映射提取为索引配置
     */
    function parseContextMapping(rawMapping) {
      if (!rawMapping) return null;
      if (Array.isArray(rawMapping)) {
        const mapping = {};
        rawMapping.forEach((name, index) => {
          if (typeof name === "string" && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
            mapping[name] = index;
          }
        });
        return mapping;
      }
      if (typeof rawMapping === "object" && rawMapping !== null) {
        const mapping = {};
        for (const name in rawMapping) {
          if (!rawMapping.hasOwnProperty(name)) continue;
          const parsedIdx = Number(name);
          if (!isNaN(parsedIdx) && typeof rawMapping[name] === "string" && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(rawMapping[name])) {
            mapping[rawMapping[name]] = parsedIdx;
          }
        }
        return mapping;
      }
      return null;
    }

    /**
     * 将各种定义（字符串模板、自定义函数等）编译转换成标准的可执行函数
     */
    function normalizeGenerator(definition, targetName) {
      if (typeof definition === "function") return definition;
      if (typeof definition === "string") {
        if (!/=>|function/.test(definition)) {
          const compiled = compileTemplateExpression(definition, targetName, null, []);
          return function (...args) {
            return compiled.apply(null, args);
          };
        }
        try {
          return new Function("return " + definition)();
        } catch (err) {
          console.warn(`ftw.util: 工具 "${targetName}" 函数字符串形式解析失败`, err);
          return () => "";
        }
      }

      if (Array.isArray(definition)) {
        const targetValue = definition[0];
        const secondParam = definition[1];
        const thirdParam = definition[2];

        let targetNumericIdxs = null;
        let targetContextMap = null;
        let targetCompiledTemplate = null;
        let targetFunc = null;

        if (typeof targetValue === "function") {
          targetFunc = targetValue;
          if (Array.isArray(secondParam)) {
            if (secondParam.every(v => typeof v === "number")) {
              targetNumericIdxs = secondParam;
            } else {
              targetContextMap = parseContextMapping(secondParam);
            }
          } else if (typeof secondParam === "object" && secondParam !== null) {
            targetContextMap = parseContextMapping(secondParam);
          }
        } else if (typeof targetValue === "string") {
          targetCompiledTemplate = targetValue;
          if (Array.isArray(secondParam)) {
            if (secondParam.every(v => typeof v === "number")) {
              targetNumericIdxs = secondParam;
            } else {
              targetContextMap = parseContextMapping(secondParam);
            }
          } else if (typeof secondParam === "object" && secondParam !== null) {
            targetContextMap = parseContextMapping(secondParam);
          }

          if (Array.isArray(thirdParam) && thirdParam.every(v => typeof v === "number")) {
            targetNumericIdxs = thirdParam;
          }
        }

        if (targetCompiledTemplate) {
          const compiled = compileTemplateExpression(
            targetCompiledTemplate,
            targetName,
            targetContextMap,
            targetNumericIdxs || []
          );
          const wrapper = function (...args) {
            return compiled.apply(null, args);
          };
          wrapper._numIdx = targetNumericIdxs || [];
          return wrapper;
        }

        if (targetFunc) {
          const wrapper = function (...args) {
            return targetFunc.apply(null, args);
          };
          wrapper._numIdx = targetNumericIdxs || [];
          return wrapper;
        }
      }

      return () => String(definition);
    }

    /**
     * 辅助解析：将外部传递的参数名数组转换为对应的索引位映射
     */
    function mapParamNamesToIndices(paramNames, compiledFunc) {
      if (!Array.isArray(paramNames)) return [];
      const funcParams = (function getFunctionParameters(func) {
        const matches = func.toString().match(/^(?:function\s*\w*\s*)?\(([^)]*)\)|^\(([^)]*)\)\s*=>/);
        return matches
          ? (matches[1] || matches[2] || "").split(",").map(p => p.trim()).filter(Boolean)
          : [];
      })(compiledFunc);

      return paramNames
        .map(param => {
          if (typeof param === "number") return param;
          if (typeof param === "string") {
            const index = funcParams.indexOf(param);
            if (index === -1) {
              console.warn(`ftw.util: 参数名 "${param}" 无效，已忽略`);
            }
            return index;
          }
          return -1;
        })
        .filter(idx => idx !== -1);
    }

    // 核心注册入口：
    if (typeof configOrKey !== "object" || configOrKey === null) {
      if (typeof configOrKey === "string") {
        const normalizedGen = normalizeGenerator(valueGenerator, configOrKey);
        let numericIdxs = normalizedGen._numIdx || [];
        if (Array.isArray(numParamsOrder) && numParamsOrder.every(v => typeof v === "number")) {
          numericIdxs = numParamsOrder;
        }
        registerUtility(configOrKey, normalizedGen, mapParamNamesToIndices(numericIdxs, normalizedGen));
        scheduleIdleProcessing();
      }
    } else {
      for (const key in configOrKey) {
        if (!configOrKey.hasOwnProperty(key)) continue;
        const normalizedGen = normalizeGenerator(configOrKey[key], key);
        registerUtility(key, normalizedGen, mapParamNamesToIndices(normalizedGen._numIdx || [], normalizedGen));
      }
      scheduleIdleProcessing();
    }
  };

  // ==========================================
  // 9. API 接口扩展 (ftw.render / ftw.use)
  // ==========================================

  /**
   * 手动对页面中带有 ftw-scoped 或指定名称的选择器进行 FSS 语法分析并渲染
   * @param {Element|string} targetElements
   */
  ftw.render = function (targetElements) {
    if (typeof targetElements === "string" || targetElements instanceof Element) {
      if (targetElements instanceof Element) {
        parseStyleRender(targetElements);
      } else {
        targetElements
          .split(/[,\s]+/)
          .map(t => t.trim())
          .filter(t => t !== "")
          .forEach(selector => {
            const parts = selector.split(":");
            const querySelector = parts[0].trim();
            const indexValue = parts[1] ? parseInt(parts[1].trim(), 10) : null;
            let matchedList = [];

            if (querySelector.startsWith(".")) {
              matchedList = Array.from(document.querySelectorAll("." + querySelector.slice(1)));
            } else if (querySelector.startsWith("#")) {
              const el = document.getElementById(querySelector.slice(1));
              if (el) matchedList = [el];
            } else {
              matchedList = Array.from(document.querySelectorAll(querySelector));
            }

            if (matchedList.length !== 0) {
              if (indexValue !== null) {
                const actualIndex = indexValue - 1;
                if (actualIndex < 0 || actualIndex >= matchedList.length) {
                  console.warn(`ftw.render: 元素 ${querySelector} 只有 ${matchedList.length} 个，无法取第 ${indexValue} 个`);
                  return;
                }
                parseStyleRender(matchedList[actualIndex]);
              } else {
                matchedList.forEach(el => parseStyleRender(el));
              }
            } else {
              console.warn("ftw.render: 未找到元素 ", querySelector);
            }
          });
      }
    } else {
      console.error("ftw.render: 参数类型错误，仅支持传入 Element 实例或选择器字符串");
    }
  };

  /**
   * 手动加载并处理指定 Script 元素下的 JSON 配置
   * @param {Element|string} targetScripts
   */
  ftw.use = function (targetScripts) {
    if (typeof targetScripts === "string" || targetScripts instanceof Element) {
      if (targetScripts instanceof Element) {
        parseScriptUtility(targetScripts);
      } else {
        targetScripts
          .split(/[,\s]+/)
          .map(t => t.trim())
          .filter(t => t !== "")
          .forEach(selector => {
            const parts = selector.split(":");
            const querySelector = parts[0].trim();
            const indexValue = parts[1] ? parseInt(parts[1].trim(), 10) : null;
            let matchedList = [];

            if (querySelector.startsWith(".")) {
              matchedList = Array.from(document.querySelectorAll("." + querySelector.slice(1)));
            } else if (querySelector.startsWith("#")) {
              const el = document.getElementById(querySelector.slice(1));
              if (el) matchedList = [el];
            } else {
              matchedList = Array.from(document.querySelectorAll(querySelector));
            }

            if (matchedList.length !== 0) {
              if (indexValue !== null) {
                const actualIndex = indexValue - 1;
                if (actualIndex < 0 || actualIndex >= matchedList.length) {
                  console.warn(`ftw.use: 元素 ${querySelector} 只有 ${matchedList.length} 个，无法取第 ${indexValue} 个`);
                  return;
                }
                parseScriptUtility(matchedList[actualIndex]);
              } else {
                matchedList.forEach(el => parseScriptUtility(el));
              }
            } else {
              console.warn("ftw.use: 未找到元素 ", querySelector);
            }
          });
      }
    } else {
      console.error("ftw.use: 参数类型错误，仅支持传入 Element 实例或选择器字符串");
    }
  };

  // 绑定全局变量
  window.ftw = ftw;

  // ==========================================
  // 10. 监听器与初始化生命周期 (Lifecycle)
  // ==========================================
  if (!domObserver) {
    domObserver = new MutationObserver(mutations => {
      const addedElements = [];
      mutations.forEach(mutation => {
        if (mutation.type === "childList") {
          mutation.addedNodes.forEach(node => {
            addedElements.push(node);
            // 自动拦截新加入文档流的 script[ftw-utils]
            if (node.matches && node.matches("script[ftw-utils]")) {
              parseScriptUtility(node);
            }
            if (node.querySelectorAll) {
              node.querySelectorAll("script[ftw-utils]").forEach(subScript => parseScriptUtility(subScript));
            }
            // 自动拦截新加入文档流的 style[ftw-render] / FSS link
            if (node.matches && (node.matches("style[ftw-render]") || node.matches('link[ftw-render][rel="stylesheet"]'))) {
              parseStyleRender(node);
            }
            if (node.querySelectorAll) {
              node.querySelectorAll('style[ftw-render], link[ftw-render][rel="stylesheet"]').forEach(subStyle => {
                parseStyleRender(subStyle);
              });
            }
          });
        }
        // 如果侦测到元素的 class 属性发生改变，立即运行原子分析
        if (
          mutation.type === "attributes" &&
          mutation.attributeName === "class" &&
          mutation.target.nodeType === 1
        ) {
          if (!isPaused) {
            processElementClasses(mutation.target);
          }
        }
      });

      if (addedElements.length > 0) {
        addedElements.forEach(node => {
          if (node.nodeType === 1) {
            if (node.hasAttribute("class") && !isPaused) {
              processElementClasses(node);
            }
            if (node.querySelectorAll) {
              node.querySelectorAll("[class]").forEach(child => {
                if (!isPaused) processElementClasses(child);
              });
            }
          }
        });

        if (!isRafScheduled) {
          isRafScheduled = true;
          requestAnimationFrame(resetProcessedCache);
        }
      }
    });
  }

  // 启动对整个 HTML 树的 Mutation 观察
  const rootElement = document.documentElement;
  domObserver.observe(rootElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class"]
  });

  // 文档加载就绪时执行首次全盘扫描
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      setTimeout(scanAndProcessDOM);
    });
  } else {
    setTimeout(scanAndProcessDOM);
  }

  // 挂载辅助性控制函数到全局 ftw 下
  isPaused = false;

  ftw.pause = function () {
    isPaused = true;
  };

  ftw.resume = function () {
    isPaused = false;
    garbageCollectUnusedStyles();
  };

  ftw.update = scanAndProcessDOM;

  ftw.once = function (element) {
    ftw.resume();
    scanAndProcessDOM(element);
    ftw.pause();
  };

  ftw.debug = function () {
    console.table(
      Array.from(generatedStylesMap.entries()).map(([cls, css]) => ({
        class: cls,
        css: css
      }))
    );
  };

  ftw.gc = garbageCollectUnusedStyles;

  ftw.ignore = function (...targets) {
    for (const target of targets) {
      if (typeof target === "string") {
        document.querySelectorAll(target).forEach(el => el.setAttribute("ftw-ignore", ""));
      } else if (target && target.nodeType === 1) {
        target.setAttribute("ftw-ignore", "");
      }
    }
  };

  ftw.unignore = function (...targets) {
    for (const target of targets) {
      if (typeof target === "string") {
        document.querySelectorAll(target).forEach(el => {
          el.removeAttribute("ftw-ignore");
          scanAndProcessDOM(el);
        });
      } else if (target && target.nodeType === 1) {
        target.removeAttribute("ftw-ignore");
        scanAndProcessDOM(target);
      }
    }
  };
})();