/**
 * @file ftw.js - 动态原子化 CSS 引擎 (Function-TailWind)
 * 这是一个运行时动态解析类名并生成、注入样式表的轻量级 CSS-in-JS 工具库包。
 * 支持 @ftw-keyframes 关键帧动画、@media/@supports 查询、@font-face 字体等 @规则。
 * 支持批量 CSS 注入、LRU 缓存、基于引用计数的 GC 调度等性能优化。
 * @version 8.0.0
 */

!(function () {
  // ==========================================
  // 1. 全局状态与核心注册表定义
  // ==========================================

  /** @type {Map<string, {regex: RegExp, generator: Function, idxOrder: Array<number|string>}>} 存储注册的工具类生成器 */
  let utilityRules = new Map();

  /** @type {Map<string, Array<{key: string, rule: Object}>>} 前缀到规则数组的映射，用于快速前缀匹配 */
  let utilityPrefixMap = new Map();

  /** @type {Map<string, string>} LRU 类名解析缓存（类名 → CSS 声明），上限可配置 */
  let classCache = new Map();

  /** @type {Map<string, Function>} LRU 模板编译缓存（模板签名 → 编译后函数），上限可配置 */
  let templateCache = new Map();

  /** @type {number} 类名解析缓存最大容量，默认 500 */
  let classCacheMaxSize = 500;

  /** @type {number} 模板编译缓存最大容量，默认 300 */
  let templateCacheMaxSize = 300;

  /** @type {Set<string>} 忽略解析的特殊类名集合（直接添加到元素中，不走动态 CSS 生成） */
  let ignoredClasses = new Set();

  /** @type {Set<string>} 已处理过的类名缓存，防止重复解析 */
  let processedClasses = new Set();

  /** @type {WeakSet<Element>} 已处理过的 DOM 元素缓存，避免重复扫描 */
  let processedElements = new WeakSet();

  /** @type {Map<string, string>} 存储已生成的类名与对应 CSS 属性字符串的映射 */
  let generatedStylesMap = new Map();

  /** @type {MutationObserver|null} 监听 DOM 树变动，用于动态响应新元素的 Class 变化 */
  let domObserver = null;

  /** @type {Set<string>} 已注册的原子类前缀集合 (例如: 'w', 'h', 'bg' 等) */
  let utilityPrefixes = new Set();

  /** @type {Map<string, string>} 关键帧动画名到已编译 CSS 内容的映射 */
  let keyframeRegistry = new Map();

  /** @type {Map<string, {types: string[], compiled: Function}>} 关键帧类型定义注册表（名称 → 类型参数与编译模板） */
  let keyframeTypeRegistry = new Map();

  /** @type {number} 关键帧样式插入索引计数器，用于保证动画定义顺序 */
  let keyframeInsertIndex = 0;

  /** @type {boolean} 是否已暂停样式处理 */
  let isPaused = false;

  /** @type {boolean} 是否已调度 requestIdleCallback 处理 */
  let isIdleCallbackScheduled = false;

  /** @type {boolean} 是否已调度 GC 任务 */
  let isGCScheduled = false;

  /** @type {boolean} 是否处于批量 CSS 注入模式（扫描期间为 true） */
  let isBatchMode = false;

  /** @type {Array<{cn: string, cv: string}>} 批量模式下积压的待注入样式队列 */
  let pendingStyles = [];

  /** @type {Map<string, number>} 类名引用计数表，用于 GC 判断 */
  let classRefCount = new Map();

  // 初始化动态样式表元素
  let styleElement = document.getElementById("ftw-styles");
  if (!styleElement) {
    styleElement = document.createElement("style");
    styleElement.id = "ftw-styles";
    document.head.appendChild(styleElement);
  }

  /** @type {CSSStyleSheet} 动态样式表的 CSSStyleSheet 实例 */
  let styleSheet = styleElement.sheet;

  /** @type {Map<string, {index: number, refCount: number, alias?: string}>} 类名到样式索引及引用计数的映射 */
  let classRegistry = new Map();

  /** @type {Map<string, {index: number, className: string}>} CSS 规则内容到索引及对应类名的映射（用于去重复） */
  let cssRegistry = new Map();

  // ==========================================
  // 2. 样式注入与批量刷新机制 (CSS Insertion & Batch Flush)
  // ==========================================

  /**
   * 将批量模式下积压的样式一次性写入样式表
   * 通过修改 textContent 而非逐条 insertRule，大幅减少样式表重排
   */
  function flushStyleBatch() {
    if (pendingStyles.length === 0) return;

    let batchRules = pendingStyles;
    let cssText = "";
    pendingStyles = [];
    isBatchMode = false;

    // 构建批量 CSS 文本
    for (let i = 0; i < batchRules.length; i++) {
      let item = batchRules[i];
      let escapedClass = window.CSS && CSS.escape
        ? CSS.escape(item.cn)
        : item.cn.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
      cssText += "." + escapedClass + "{" + item.cv + "}";
    }

    // 一次性追加到 textContent
    let existingText = styleElement.textContent || "";
    styleElement.textContent = existingText + cssText;

    // 修正占位索引（批量模式下 index 设为 -1，现在回填实际索引）
    let startIndex = styleSheet.cssRules.length - batchRules.length;
    for (let j = 0; j < batchRules.length; j++) {
      let registryEntry = classRegistry.get(batchRules[j].cn);
      if (registryEntry && registryEntry.index === -1) {
        registryEntry.index = startIndex + j;
      }
    }
  }

  /**
   * 插入一条 CSS 规则到样式表，支持指定索引位置（用于关键帧等 @规则）
   * @param {string} ruleText 完整的 CSS 规则文本
   * @param {boolean} [useKeyframeIndex] 是否使用关键帧专用索引计数器
   * @returns {number} 插入后的规则索引，失败返回 -1
   */
  function insertCSSRule(ruleText, useKeyframeIndex) {
    try {
      let insertAtIndex = useKeyframeIndex ? keyframeInsertIndex++ : styleSheet.cssRules.length;
      return styleSheet.insertRule(ruleText, insertAtIndex);
    } catch (err) {
      return -1;
    }
  }

  /**
   * 释放对某个类名样式规则的引用，若引用计数归零则彻底从样式表中移除
   * @param {string} className 要移除的类名
   */
  function removeStyleRule(className) {
    let registryInfo = classRegistry.get(className);
    if (!registryInfo) return;

    registryInfo.refCount--;
    if (registryInfo.refCount <= 0) {
      if (!registryInfo.alias) {
        styleSheet.deleteRule(registryInfo.index);
        // 从样式去重表中删除对应记录
        cssRegistry.forEach(function (value, key) {
          if (value.className === className) {
            cssRegistry.delete(key);
          }
        });
      }
      classRegistry.delete(className);
      generatedStylesMap.delete(className);
      classRefCount.delete(className);
    }
  }

  /**
   * 彻底的垃圾回收 (Garbage Collection)
   * 基于引用计数表（classRefCount）进行清理，不再依赖 DOM 全量扫描
   * 仅清除引用计数为 0 或不在引用计数表中的类名
   */
  function garbageCollectUnusedStyles() {
    let entries = classRegistry.entries();
    let entry = entries.next();
    let toRemove = [];

    while (!entry.done) {
      let className = entry.value[0];
      if (!classRefCount.has(className) || classRefCount.get(className) <= 0) {
        toRemove.push(className);
      }
      entry = entries.next();
    }

    for (let i = 0; i < toRemove.length; i++) {
      let clsName = toRemove[i];
      let registryInfo = classRegistry.get(clsName);
      if (registryInfo) {
        while (registryInfo.refCount > 0 && (removeStyleRule(clsName), registryInfo = classRegistry.get(clsName)));
      }
    }
  }

  /**
   * 调度 GC 任务，利用 requestIdleCallback 或 setTimeout 异步执行
   */
  function scheduleGC() {
    if (isGCScheduled) return;
    isGCScheduled = true;

    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(function () {
        isGCScheduled = false;
        garbageCollectUnusedStyles();
      });
    } else {
      setTimeout(function () {
        isGCScheduled = false;
        garbageCollectUnusedStyles();
      }, 50);
    }
  }

  // ==========================================
  // 3. 辅助工具函数
  // ==========================================

  /**
   * 在给定文本中寻找与指定位置 { 匹配的闭合 } 括号
   * @param {string} text 源文本
   * @param {number} openIndex 起始 { 的位置
   * @returns {string|null} 括号内的内容，失败返回 null
   */
  function findClosingCurlyBrace(text, openIndex) {
    if (text[openIndex] !== "{") return null;
    let depth = 1;
    let negativeLookBehindDepth = 0;
    let idx = openIndex + 1;
    for (; idx < text.length && (depth > 0 || negativeLookBehindDepth > 0); ) {
      let char = text[idx];
      let prevChar = text[idx - 1];
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

  /**
   * 分割以横杠分隔的后缀，同时保持中括号 [] 内的完整性
   * @param {string} s 待分割的字符串
   * @returns {string[]} 分割后的数组，中括号内容已去除括号
   */
  function splitSuffix(s) {
    if (!s) return [];
    let parts = [];
    let current = "";
    let inBracket = false;
    for (let i = 0; i < s.length; i++) {
      let ch = s[i];
      if (ch === "[") {
        inBracket = true;
        current += ch;
      } else if (ch === "]") {
        inBracket = false;
        current += ch;
      } else if (ch === "-" && !inBracket) {
        parts.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    if (current) parts.push(current);
    return parts.map(function (p) {
      if (p.charAt(0) === "[" && p.charAt(p.length - 1) === "]") {
        return p.slice(1, -1);
      }
      return p;
    });
  }

  /**
   * 提取类名中第一个 '-' 之前的基础前缀
   * @param {string} className 类名
   * @returns {string} 基础前缀
   */
  /**
   * 从类名中查找最长匹配的前缀规则集
   * 例如 "bg-red-10" 会依次尝试 "bg-red-10", "bg-red", "bg" 作为前缀
   * @param {string} className 类名
   * @returns {Array|null} 匹配的规则数组，未匹配返回 null
   */
  function findMatchingRules(className) {
    let parts = className.split("-");
    for (let i = parts.length; i >= 1; i--) {
      let prefix = parts.slice(0, i).join("-");
      let rules = utilityPrefixMap.get(prefix);
      if (rules) return rules;
    }
    return null;
  }

  /**
   * 根据 classPattern 和类型注解生成匹配正则
   * - 无类型注解（如 "bg-red"）：匹配 "^bg-red(?:-(...))?$"
   * - 有类型注解（如 "bg-red:num"）：匹配 "^bg-red-(<num>)(?:-...)*$"
   *   :num 在正则层面匹配数字（含浮点数、分数、百分数）
   * @param {string} basePrefix 基础前缀（classPattern 中 : 之前的部分）
   * @param {string[]} types 类型注解数组
   * @returns {RegExp} 匹配正则
   */
  function buildClassRegex(basePrefix, types) {
    let strSeg = "[\\w\\.\\/\\(\\)\\[\\]#%,\\-]+";
    let numSeg = "(?:\\[[^\\]]+\\]|[0-9(][0-9+\\*\\/.()%]*)";
    let escaped = basePrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    if (types.length === 0) {
      return new RegExp("^" + escaped + "(?:-(" + strSeg + "))?$");
    }

    let suffixParts = [];
    for (let i = 0; i < types.length; i++) {
      suffixParts.push(types[i] === "num" ? numSeg : strSeg);
    }

    let suffix = suffixParts.join("-");
    let rest = "(?:-" + strSeg + ")*";

    return new RegExp("^" + escaped + "-(" + suffix + rest + ")$");
  }

  /**
   * 安全计算中括号包裹的算术表达式
   * 只支持 + - * / ( ) . 及数字，用 Function 执行（比 eval 更安全）
   * @param {string} expr 表达式字符串
   * @returns {number} 计算结果，非法或异常时返回 NaN
   */
  function safeEval(expr) {
    var s = expr.replace(/\s/g, "");
    if (!/^[\d+\-*/().]+$/.test(s)) return NaN;
    try {
      return new Function("return (" + s + ")")();
    } catch (e) {
      return NaN;
    }
  }

  // ==========================================
  // 4. LRU 缓存辅助函数
  // ==========================================

  /**
   * 将类名解析结果写入 LRU 缓存（classCache），超出容量时淘汰最旧条目
   * @param {string} className 类名
   * @param {string|null} cssValue CSS 声明值
   */
  function cacheResolvedClass(className, cssValue) {
    if (classCache.size >= classCacheMaxSize) {
      let oldest = classCache.keys().next();
      if (!oldest.done) classCache.delete(oldest.value);
    }
    classCache.set(className, cssValue);
  }

  /**
   * 将模板编译结果写入 LRU 缓存（templateCache），超出容量时淘汰最旧条目
   * @param {string} cacheKey 缓存键
   * @param {Function} compiledFn 编译后的函数
   */
  function cacheTemplate(cacheKey, compiledFn) {
    if (templateCache.size >= templateCacheMaxSize) {
      let oldest = templateCache.keys().next();
      if (!oldest.done) templateCache.delete(oldest.value);
    }
    templateCache.set(cacheKey, compiledFn);
  }

  // ==========================================
  // 5. CSS 类名解析与值生成 (Class → CSS Resolution)
  // ==========================================

  /**
   * 将类名解析为其对应的 CSS 声明值
   * 优先检查关键帧动画注册表，再检查工具类注册表
   * 支持 LRU 缓存加速重复解析
   * @param {string} className 类名
   * @returns {string|null} CSS 声明字符串，未匹配返回 null
   */
  function resolveClassToCSS(className) {
    // 0. 检查 LRU 缓存
    if (classCache.has(className)) {
      let cachedCSS = classCache.get(className);
      // LRU 重排：先删除再插入，使其成为最新条目
      classCache.delete(className);
      classCache.set(className, cachedCSS);
      return cachedCSS;
    }

    let cssResult = null;

    // 1. 检查是否为已注册的关键帧动画
    if (keyframeRegistry.has(className)) {
      cssResult = "animation:" + className + " 1s";
      cacheResolvedClass(className, cssResult);
      return cssResult;
    }

    // 2. 检查关键帧类型定义（支持动态参数）
    for (let keyframeEntries = keyframeTypeRegistry.entries(), kfEntry = keyframeEntries.next(); !kfEntry.done; ) {
      let keyframeName = kfEntry.value[0];
      let typeDef = kfEntry.value[1];
      let typeRegex = new RegExp("^" + keyframeName + "-(\\[[^\\]]+\\]|[^-][\\w\\.\\/\\-]*)$");
      let typeMatch = className.match(typeRegex);

      if (typeMatch) {
        let suffix = typeMatch[1];
        let rawParams = splitSuffix(suffix);

        // 分割类型参数和动画参数
        let typeParams = rawParams.slice(0, typeDef.types.length);
        let animationParams = rawParams.slice(typeDef.types.length);

        let variantKey = keyframeName + "-" + typeParams.join("-");

        // 若该变体尚未编译，则动态生成并注入
        if (!keyframeRegistry.has(variantKey)) {
          let compiledCSS = processCSSBlock(typeDef.compiled(typeParams));
          insertCSSRule("@keyframes " + variantKey + "{" + compiledCSS + "}");
          keyframeRegistry.set(variantKey, compiledCSS);
        }

        cssResult = "animation:" + variantKey + " " + (animationParams.length > 0 ? animationParams.join(" ") : "1s");
        cacheResolvedClass(className, cssResult);
        return cssResult;
      }
      kfEntry = keyframeEntries.next();
    }

    // 3. 检查工具类注册表（通过多级前缀查找，最长前缀优先匹配）
    let prefixRules = findMatchingRules(className);

    if (prefixRules) {
      for (let i = 0; i < prefixRules.length; i++) {
        let ruleEntry = prefixRules[i];
        let matches = className.match(ruleEntry.rule.regex);
        if (!matches) continue;

        let rawParams = matches[1] ? splitSuffix(matches[1]) : [];
        let orderDef = ruleEntry.rule.idxOrder || [];
        let typesList = ruleEntry.key.split(":").slice(1).map(function (t) { return t === "num" ? "num" : "str"; });

        let processedParams = [];
        if (orderDef.length === 0) {
          processedParams = rawParams.map(function (val, idx) {
            let expectedType = idx < typesList.length ? typesList[idx] : "str";
            if (expectedType === "num") {
              val = safeEval(val);
              return Number(val);
            }
            return val;
          });
        } else {
          processedParams = orderDef.map(function (orderIdx, idx) {
            let rawVal = orderIdx < rawParams.length ? rawParams[orderIdx] : "";
            let expectedType = idx < typesList.length ? typesList[idx] : "str";
            if (expectedType === "num") {
              rawVal = safeEval(rawVal);
              return Number(rawVal);
            }
            return rawVal;
          });
        }

        // 如果期望数字但解析为 NaN，说明不是合法匹配
        let hasNaN = false;
        for (let j = 0; j < processedParams.length; j++) {
          let expectedType = j < typesList.length ? typesList[j] : "str";
          if (expectedType === "num" && Number.isNaN(processedParams[j])) {
            hasNaN = true;
            break;
          }
        }
        if (hasNaN) continue;

        // 执行生成器函数产生 CSS 样式值
        let cssDeclaration = ruleEntry.rule.generator.apply(null, processedParams);
        if (cssDeclaration) {
          cssResult = cssDeclaration.replace(/!imp/g, "!important");
          break;
        }
        break;
      }
    }

    cacheResolvedClass(className, cssResult);
    return cssResult;
  }

  /**
   * 处理 CSS 代码块，将其中引用的工具类名解析为实际的 CSS 声明
   * @param {string} cssBlock CSS 规则块内容（花括号内的部分）
   * @returns {string} 解析后的 CSS 规则块
   */
  function processCSSBlock(cssBlock) {
    if (!cssBlock) return "";

    let statements = cssBlock.split(";");
    let result = [];

    for (let i = 0; i < statements.length; i++) {
      let stmt = statements[i].trim();
      if (!stmt) continue;

      // 如果包含冒号，说明已经是原生 CSS 声明，直接保留
      if (stmt.indexOf(":") !== -1) {
        result.push(stmt);
        continue;
      }

      // 否则可能是工具类引用，尝试解析
      let tokens = stmt.split(/\s+/);
      let resolved = [];
      for (let j = 0; j < tokens.length; j++) {
        let token = tokens[j];
        if (!token) continue;
        if (token.indexOf(":") !== -1) {
          // 原生 CSS 声明
          resolved.push(token);
          continue;
        }
        // 尝试将类名解析为 CSS 声明
        let cssVal = resolveClassToCSS(token);
        resolved.push(cssVal ? cssVal.replace(/;+$/g, "") : token);
      }
      if (resolved.length > 0) {
        result.push(resolved.join(";"));
      }
    }

    return result.join(";");
  }

  /**
   * 处理单个类名，解析并生成其对应的样式规则
   * @param {string} rawClass 原始类名 (例如 "w-10", "!bg-red-500", "not-util:my-custom-class")
   * @param {Element} [targetElement] 携带该类名的目标 DOM 元素
   * @returns {boolean} 是否成功处理该类名
   */
  function processUtilityClass(rawClass, targetElement) {
    // 1. 处理不作为原子类解析的特殊跳过前缀 (not-util: / # 开头)
    let bypassClass = rawClass.indexOf("not-util:") === 0
      ? rawClass.slice(9)
      : rawClass.charAt(0) === "#"
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

    // 2. 匹配对应原子类的正则表达式生成器，处理排他类替换
    let matchedRuleKey = null;
    let prefixRules = findMatchingRules(rawClass);

    if (prefixRules) {
      for (let i = 0; i < prefixRules.length; i++) {
        if (prefixRules[i].rule.regex.test(rawClass)) {
          matchedRuleKey = prefixRules[i].key;
          break;
        }
      }
    }

    if (matchedRuleKey && targetElement && targetElement.classList) {
      let ruleDef = utilityRules.get(matchedRuleKey);
      for (let c = 0; c < targetElement.classList.length; c++) {
        let currentClass = targetElement.classList[c];
        if (currentClass !== rawClass && ruleDef.regex.test(currentClass)) {
          targetElement.classList.remove(currentClass);
          removeStyleRule(currentClass);
        }
      }
    }

    // 3. 解析修饰符（支持 ! 前缀，用于强制转为 !important）
    let isImportant = false;
    let baseClass = rawClass;
    for (let prefixIter = utilityPrefixes.values(), pfEntry = prefixIter.next(); !pfEntry.done; ) {
      let prefix = pfEntry.value;
      if (rawClass === "!" + prefix || rawClass.indexOf("!" + prefix + "-") === 0) {
        isImportant = true;
        baseClass = rawClass.slice(1); // 剥离 '!'
        break;
      }
      pfEntry = prefixIter.next();
    }

    // 4. 使用统一的 CSS 解析函数获取样式声明
    let cssDeclaration = resolveClassToCSS(baseClass);
    if (!cssDeclaration) return false;

    // 5. 处理 !important 修饰符
    if (isImportant) {
      let parts = cssDeclaration.split(";");
      let importantParts = [];
      for (let p = 0; p < parts.length; p++) {
        let trimmed = parts[p].trim();
        if (trimmed) {
          importantParts.push(trimmed + (trimmed.indexOf("!important") !== -1 ? "" : "!important"));
        }
      }
      cssDeclaration = importantParts.join(";");
    }

    generatedStylesMap.set(rawClass, cssDeclaration);

    // 6. 更新引用计数
    let currentRefCount = classRefCount.get(rawClass) || 0;
    classRefCount.set(rawClass, currentRefCount + 1);

    // 7. 注入样式规则或处理别名
    if (cssDeclaration.indexOf(":") !== -1) {
      // 检查是否已有该规则
      let existingClass = classRegistry.get(rawClass);
      if (existingClass) {
        existingClass.refCount++;
      } else {
        let existingCss = cssRegistry.get(cssDeclaration);
        if (existingCss) {
          classRegistry.set(rawClass, {
            index: existingCss.index,
            refCount: 1,
            alias: existingCss.className
          });
        } else if (isBatchMode) {
          // 批量模式：推入队列，设置占位索引
          pendingStyles.push({ cn: rawClass, cv: cssDeclaration });
          classRegistry.set(rawClass, { index: -1, refCount: 1 });
          cssRegistry.set(cssDeclaration, { index: -1, className: rawClass });
        } else {
          // 非批量模式：直接插入
          let escapedClass = window.CSS && CSS.escape
            ? CSS.escape(rawClass)
            : rawClass.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
          let ruleText = "." + escapedClass + "{" + cssDeclaration + "}";
          let newIndex = styleSheet.insertRule(ruleText, styleSheet.cssRules.length);
          classRegistry.set(rawClass, { index: newIndex, refCount: 1 });
          cssRegistry.set(cssDeclaration, { index: newIndex, className: rawClass });
        }
      }
    } else if (targetElement) {
      // 非 CSS 声明的别名类名
      targetElement.classList.remove(rawClass);
      let aliasClasses = cssDeclaration.split(/\s+/);
      for (let a = 0; a < aliasClasses.length; a++) {
        if (aliasClasses[a]) targetElement.classList.add(aliasClasses[a]);
      }
    }
    return true;
  }

  /**
   * 解析某个元素中的所有 Class，过滤并处理原子类
   * @param {Element} element DOM 元素
   */
  function processElementClasses(element) {
    if (!element.classList || !element.classList.length || (element.closest && element.closest("[ftw-ignore]"))) return;

    let hasAtomicClass = false;
    for (let i = 0; i < element.classList.length; i++) {
      let className = element.classList[i];
      if (!ignoredClasses.has(className)) {
        // 检查工具类前缀
        for (let prefixIter = utilityPrefixes.values(), pfEntry = prefixIter.next(); !pfEntry.done; ) {
          let prefix = pfEntry.value;
          if (className === prefix || className.indexOf(prefix + "-") === 0) {
            hasAtomicClass = true;
            break;
          }
          pfEntry = prefixIter.next();
        }
        if (hasAtomicClass) break;

        // 检查关键帧动画名称
        for (let kfIter = keyframeRegistry.keys(), kfEntry = kfIter.next(); !kfEntry.done; ) {
          let kfName = kfEntry.value;
          if (className === kfName || className.indexOf(kfName + "-") === 0) {
            hasAtomicClass = true;
            break;
          }
          kfEntry = kfIter.next();
        }
        if (hasAtomicClass) break;

        // 检查关键帧类型定义
        for (let kftIter = keyframeTypeRegistry.keys(), kftEntry = kftIter.next(); !kftEntry.done; ) {
          let typeName = kftEntry.value;
          if (className === typeName || className.indexOf(typeName + "-") === 0) {
            hasAtomicClass = true;
            break;
          }
          kftEntry = kftIter.next();
        }
        if (hasAtomicClass) break;
      }
    }

    if (hasAtomicClass) {
      if (!processedElements.has(element)) {
        processedElements.add(element);
      }
      for (let j = 0; j < element.classList.length; j++) {
        let cls = element.classList[j];
        if (!processedClasses.has(cls)) {
          processUtilityClass(cls, element);
        }
      }
    }
  }

  // ==========================================
  // 6. 模板表达式编译引擎 (Template Compiler)
  // ==========================================

  /** @type {Set<string>} JS 内置对象白名单，用于编译表达式时安全注入 */
  let JS_BUILT_INS = new Set([
    "Math", "Number", "String", "Array", "Object", "Boolean", "Date", "RegExp", "JSON",
    "Promise", "Symbol", "Map", "Set",
    "isNaN", "parseInt", "parseFloat",
    "typeof", "instanceof"
  ]);

  /** @type {RegExp} 安全表达式正则，防止代码注入 */
  let SAFE_EXPR_REGEX = /^[a-zA-Z0-9_\.\[\]\'\"\s\(\)\+\-\*\/\%\?\:\,\|\&\!\=\<\>]+$/;

  /**
   * 动态创建模板编译解析器（将大括号 {x} 解析为 JS 运算表达式）
   * 支持 LRU 缓存加速重复编译
   * @param {string} templateStr 包含 {x} 占位符的模板字符串
   * @param {string} [utilityName] 工具类名称（用于错误提示）
   * @param {Object} [contextMap] 上下文变量映射
   * @param {number[]} [numericIdxs] 需要转为数字类型的参数索引
   * @returns {Function} 编译后的执行函数
   */
  function compileTemplateExpression(templateStr, utilityName, contextMap, numericIdxs) {
    // 构建缓存键
    let cacheKey = templateStr + "|" + (utilityName || "") + "|" + JSON.stringify(contextMap || null) + "|" + JSON.stringify(numericIdxs || []);
    let cachedFn = templateCache.get(cacheKey);
    if (cachedFn) {
      // LRU 重排：先删除再插入
      templateCache.delete(cacheKey);
      templateCache.set(cacheKey, cachedFn);
      return cachedFn;
    }

    let match;
    let braceRegex = /(?<!\$)\{([^{}]*)\}/g;
    let placeholderBlocks = [];

    while ((match = braceRegex.exec(templateStr)) !== null) {
      placeholderBlocks.push({
        full: match[0],
        raw: match[1],
        start: match.index,
        end: match.index + match[0].length
      });
    }

    if (placeholderBlocks.length === 0) {
      let simpleFn = function () { return templateStr; };
      cacheTemplate(cacheKey, simpleFn);
      return simpleFn;
    }

    let expressionVarsMap = {};
    let customVarCount = 0;
    let expressionsMeta = [];

    for (let i = 0; i < placeholderBlocks.length; i++) {
      let rawExpr = placeholderBlocks[i].raw;
      let cleanExpr = rawExpr.replace(/\/\*[\s\S]*?\*\//g, "").trim();

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
      let equalsIdx = -1;
      let depth = 0;
      let inString = false;
      let stringChar = null;

      for (let idx = 0; idx < cleanExpr.length; idx++) {
        let char = cleanExpr[idx];
        if (inString) {
          if (char === "\\") { idx++; continue; }
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
        let variablePart = cleanExpr.slice(0, equalsIdx).trim();
        let expressionPart = cleanExpr.slice(equalsIdx + 1).trim();
        if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(variablePart)) {
          assignedVarName = variablePart;
          isAssignment = true;
          innerCode = expressionPart;
        }
      }

      if (!SAFE_EXPR_REGEX.test(innerCode)) {
        expressionsMeta.push({ type: "static", value: "" });
        continue;
      }

      let matchedVar;
      let varIdentifyRegex = /(?<![a-zA-Z0-9_\.])([a-zA-Z_][a-zA-Z0-9_]*)(?![a-zA-Z0-9_])/g;
      let uniqueVars = [];
      let seenVars = new Set();

      while ((matchedVar = varIdentifyRegex.exec(innerCode)) !== null) {
        let varName = matchedVar[1];
        if (!seenVars.has(varName)) {
          seenVars.add(varName);
          uniqueVars.push(varName);
        }
      }

      let varReplacementMap = {};
      for (let k = 0; k < uniqueVars.length; k++) {
        let currentVar = uniqueVars[k];
        if (!JS_BUILT_INS.has(currentVar)) {
          if (contextMap && contextMap[currentVar] !== undefined) {
            varReplacementMap[currentVar] = "__ctx_" + currentVar;
          } else if (currentVar !== "props") {
            if (expressionVarsMap[currentVar] === undefined) {
              expressionVarsMap[currentVar] = customVarCount++;
            }
            varReplacementMap[currentVar] = "__uvars[" + expressionVarsMap[currentVar] + "]";
          } else {
            varReplacementMap[currentVar] = "__props";
          }
        }
      }

      // 如果赋值变量名未被替换，也需要映射
      if (isAssignment && assignedVarName && !varReplacementMap[assignedVarName]) {
        if (contextMap && contextMap[assignedVarName] !== undefined) {
          varReplacementMap[assignedVarName] = "__ctx_" + assignedVarName;
        } else if (assignedVarName === "props") {
          varReplacementMap[assignedVarName] = "__props";
        } else {
          if (expressionVarsMap[assignedVarName] === undefined) {
            expressionVarsMap[assignedVarName] = customVarCount++;
          }
          varReplacementMap[assignedVarName] = "__uvars[" + expressionVarsMap[assignedVarName] + "]";
        }
      }

      let replacements = [];
      varIdentifyRegex.lastIndex = 0;
      while ((matchedVar = varIdentifyRegex.exec(innerCode)) !== null) {
        let cVar = matchedVar[1];
        if (varReplacementMap[cVar]) {
          replacements.push({
            pos: matchedVar.index,
            len: cVar.length,
            rep: varReplacementMap[cVar]
          });
        }
      }

      let compiledBody = innerCode;
      for (let r = replacements.length - 1; r >= 0; r--) {
        let rInfo = replacements[r];
        compiledBody = compiledBody.slice(0, rInfo.pos) + rInfo.rep + compiledBody.slice(rInfo.pos + rInfo.len);
      }

      if (isAssignment && assignedVarName && varReplacementMap[assignedVarName]) {
        compiledBody = "(" + varReplacementMap[assignedVarName] + " !== undefined ? " + varReplacementMap[assignedVarName] + " : (" + compiledBody + "))";
      }

      expressionsMeta.push({ type: "expr", expr: compiledBody, rawExpr: rawExpr });
    }

    let rawFragments = [];
    let lastSlicePos = 0;
    for (let f = 0; f < placeholderBlocks.length; f++) {
      rawFragments.push(templateStr.slice(lastSlicePos, placeholderBlocks[f].start));
      lastSlicePos = placeholderBlocks[f].end;
    }
    rawFragments.push(templateStr.slice(lastSlicePos));

    let compiledEvaluators = expressionsMeta.map(function (item) {
      if (item.type === "empty") return function () { return ""; };
      if (item.type === "number") return (function (val) { return function () { return String(val); }; })(item.value);
      if (item.type === "static") return (function (val) { return function () { return val; }; })(item.value);

      let systemParams = [];
      let systemGlobals = [];

      let builtInsArr = Array.from(JS_BUILT_INS);
      for (let g = 0; g < builtInsArr.length; g++) {
        systemGlobals.push(builtInsArr[g]);
      }

      for (let h = 0; h < systemGlobals.length; h++) {
        let globalObj = systemGlobals[h];
        if (typeof window !== "undefined" && window[globalObj] !== undefined) {
          systemParams.push({ name: globalObj, value: window[globalObj] });
        } else if (typeof global !== "undefined" && global[globalObj] !== undefined) {
          systemParams.push({ name: globalObj, value: global[globalObj] });
        } else if (typeof self !== "undefined" && self[globalObj] !== undefined) {
          systemParams.push({ name: globalObj, value: self[globalObj] });
        }
      }

      let paramNames = systemParams.map(function (p) { return p.name; });
      let paramValues = systemParams.map(function (p) { return p.value; });

      return function (ctxData, originalProps) {
        let currentNames = paramNames.slice();
        let currentValues = paramValues.slice();

        if (ctxData) {
          for (let key in ctxData) {
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
          return Function.apply(null, currentNames.concat(["return (" + item.expr + ")"])).apply(null, currentValues);
        } catch (err) {
          return "";
        }
      };
    });

    let compiledFn = function () {
      let args = Array.prototype.slice.call(arguments);
      let props = args;
      let hasNumericIdxs = numericIdxs && numericIdxs.length > 0;
      let convertedProps = hasNumericIdxs
        ? args.map(function (arg, idx) { return numericIdxs.indexOf(idx) !== -1 ? Number(arg) : arg; })
        : args;
      let finalCtx = {};

      if (contextMap) {
        for (let key in contextMap) {
          if (contextMap.hasOwnProperty(key)) {
            let mappedIdx = contextMap[key];
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

    cacheTemplate(cacheKey, compiledFn);
    return compiledFn;
  }

  // ==========================================
  // 7. @规则解析系统 (@ftw-keyframes, @media, @supports 等)
  // ==========================================

  /**
   * 解析 @ftw-keyframes 规则块
   * 支持两种形式：
   *   1. @ftw-keyframes name:type1,type2 { ... }  — 带类型参数的关键帧定义
   *   2. @ftw-keyframes name { ... }               — 纯关键帧定义
   * @param {string} cssText 完整的 CSS 文本
   * @param {number} keywordIndex @ftw-keyframes 关键字在文本中的起始位置
   * @returns {{length: number}|null} 解析结果，包含消耗的字符长度
   */
  function parseFTWKeyframes(cssText, keywordIndex) {
    let remainingText = cssText.slice(keywordIndex + 14); // 跳过 "@ftw-keyframes"

    // 跳过空白符到达名称起始位置
    let nameStart = 0;
    while (nameStart < remainingText.length && /\s/.test(remainingText[nameStart])) {
      nameStart++;
    }
    if (nameStart >= remainingText.length) return null;

    // 提取名称（可能包含类型声明 name:type1,type2）
    let nameEnd = nameStart;
    while (nameEnd < remainingText.length && remainingText[nameEnd] !== "{" && remainingText[nameEnd] !== ";") {
      nameEnd++;
    }

    let fullName = remainingText.slice(nameStart, nameEnd).trim();
    if (!fullName || remainingText[nameEnd] !== "{") return null;

    // 解析名称和类型参数
    let colonIndex = fullName.indexOf(":");
    let keyframeName = colonIndex !== -1 ? fullName.slice(0, colonIndex).trim() : fullName;
    let typeNames = colonIndex !== -1
      ? fullName.slice(colonIndex + 1).trim().split(",").map(function (t) { return t.trim(); })
      : [];

    let contentBlock = findClosingCurlyBrace(remainingText, nameEnd);
    if (contentBlock === null) return null;

    let totalLength = 14 + nameEnd + contentBlock.length + 2;

    if (typeNames.length > 0) {
      // 带类型参数的关键帧：保护 CSS {} 块后编译表达式模板
      let cssBlocks = [];
      let protectedContent = contentBlock.replace(
        /\{([^{}]*:[^{}]*)\}/g,
        function (match) {
          cssBlocks.push(match);
          return "\x00FTW_CSS_" + (cssBlocks.length - 1) + "\x00";
        }
      );

      let compiledExpr = compileTemplateExpression(protectedContent);

      keyframeTypeRegistry.set(keyframeName, {
        types: typeNames,
        compiled: function (params) {
          let output = compiledExpr(params);
          for (let i = 0; i < cssBlocks.length; i++) {
            output = output.replace("\x00FTW_CSS_" + i + "\x00", cssBlocks[i]);
          }
          return output;
        }
      });
      utilityPrefixes.add(keyframeName);
      return { length: totalLength };
    }

    // 纯关键帧定义：解析内部百分比帧并处理工具类引用
    let compiledCSS = "";
    let cursor = 0;
    while (cursor < contentBlock.length) {
      // 跳过空白
      while (cursor < contentBlock.length && /\s/.test(contentBlock[cursor])) {
        cursor++;
      }
      if (cursor >= contentBlock.length) break;

      // 提取帧选择器 (如 "0%", "100%", "from", "to")
      let selectorStart = cursor;
      while (cursor < contentBlock.length && contentBlock[cursor] !== "{") {
        cursor++;
      }
      let selector = contentBlock.slice(selectorStart, cursor).trim();
      if (!selector || contentBlock[cursor] !== "{") break;

      let frameContent = findClosingCurlyBrace(contentBlock, cursor);
      if (frameContent === null) break;

      compiledCSS += selector + "{" + processCSSBlock(frameContent) + "}";
      cursor = cursor + frameContent.length + 2;
    }

    insertCSSRule("@keyframes " + keyframeName + "{" + compiledCSS + "}");
    keyframeRegistry.set(keyframeName, compiledCSS);
    registerKeyframeAnimationUtility(keyframeName);
    return { length: totalLength };
  }

  /**
   * 为关键帧自动注册对应的动画工具类
   * @param {string} keyframeName 关键帧名称
   */
  function registerKeyframeAnimationUtility(keyframeName) {
    // 检查是否已存在同名工具类注册
    let alreadyExists = false;
    let entries = utilityRules.entries();
    let entry = entries.next();
    while (!entry.done) {
      let key = entry.value[0];
      if (key === keyframeName || key.indexOf(keyframeName + ":") === 0) {
        alreadyExists = true;
        break;
      }
      entry = entries.next();
    }
    if (alreadyExists) return;

    registerUtility(
      keyframeName,
      function () {
        let args = [];
        for (let i = 0; i < arguments.length; i++) {
          if (arguments[i] !== undefined && arguments[i] !== "" && arguments[i] !== null) {
            args.push(arguments[i]);
          }
        }
        return "animation:" + keyframeName + " " + (args.length === 0 ? "1s" : args.join(" ")) + ";";
      },
      [0, 1, 2, 3, 4, 5, 6]
    );
  }

  /**
   * 解析 @keyframes、@media、@supports、@font-face 等 @规则
   * @param {string} cssText 完整的 CSS 文本
   * @param {number} keywordIndex @规则关键字在文本中的起始位置
   * @param {string} ruleType @规则类型（如 "@keyframes", "@media" 等）
   * @param {string} [scopeSelector] 作用域选择器（用于 ftw-scoped）
   * @returns {{length: number}|null} 解析结果
   */
  function parseAtRule(cssText, keywordIndex, ruleType, scopeSelector) {
    let remainingText = cssText.slice(keywordIndex + ruleType.length);
    let cursor = 0;

    // 跳过空白符
    while (cursor < remainingText.length && /\s/.test(remainingText[cursor])) {
      cursor++;
    }
    if (cursor >= remainingText.length) return null;

    // 处理无参数 @规则（如 @font-face { ... } 直接以花括号开始）
    if (remainingText[cursor] === "{") {
      let innerBlock = findClosingCurlyBrace(remainingText, cursor);
      if (innerBlock === null) return null;
      insertCSSRule(ruleType + "{" + innerBlock + "}");
      return { length: ruleType.length + cursor + innerBlock.length + 2 };
    }

    // 提取 @规则参数
    let paramStart = cursor;
    while (cursor < remainingText.length && remainingText[cursor] !== "{") {
      cursor++;
    }
    if (cursor >= remainingText.length || remainingText[cursor] !== "{") return null;

    let ruleParams = remainingText.slice(paramStart, cursor).trim();
    innerBlock = findClosingCurlyBrace(remainingText, cursor);
    if (innerBlock === null) return null;

    let totalLength = ruleType.length + cursor + innerBlock.length + 2;

    if (ruleType === "@keyframes") {
      // 标准 @keyframes 规则
      insertCSSRule("@keyframes " + ruleParams + "{" + innerBlock + "}");
      keyframeRegistry.set(ruleParams, innerBlock);
      registerKeyframeAnimationUtility(ruleParams);
      return { length: totalLength };
    }

    if (ruleType === "@media" || ruleType === "@supports") {
      // 处理嵌套的 CSS 规则，支持 @apply 和工具类引用解析
      let processedInnerCSS = processNestedCSSRules(innerBlock, scopeSelector || "");
      insertCSSRule(ruleType + " " + ruleParams + "{" + processedInnerCSS + "}");
      return { length: totalLength };
    }

    // @font-face 及其他 @规则
    insertCSSRule(ruleType + " " + ruleParams + "{" + innerBlock + "}");
    return { length: totalLength };
  }

  /**
   * 解析 @import、@charset、@namespace 等简单 @规则
   * @param {string} cssText 完整的 CSS 文本
   * @param {number} keywordIndex @规则关键字起始位置
   * @param {string} ruleType @规则类型
   * @returns {{length: number}|null} 解析结果
   */
  function parseSimpleAtRule(cssText, keywordIndex, ruleType) {
    let remainingText = cssText.slice(keywordIndex + ruleType.length);
    let cursor = 0;

    while (cursor < remainingText.length && /\s/.test(remainingText[cursor])) {
      cursor++;
    }

    let semicolonIndex = remainingText.indexOf(";", cursor);
    if (semicolonIndex === -1) semicolonIndex = remainingText.length;

    let ruleText = ruleType + " " + remainingText.slice(cursor, semicolonIndex + 1).trim();
    if (ruleText.slice(-1) !== ";") ruleText += ";";

    insertCSSRule(ruleText, ruleType === "@import" || ruleType === "@charset");
    return { length: ruleType.length + semicolonIndex + 1 };
  }

  /**
   * 处理嵌套的 CSS 规则块（用于 @media/@supports 内部），
   * 解析 @apply 指令和工具类引用
   * @param {string} cssText CSS 规则块内容
   * @param {string} scopeSelector 作用域选择器
   * @returns {string} 处理后的 CSS 规则块
   */
  function processNestedCSSRules(cssText, scopeSelector) {
    let result = "";
    let cssRuleRegex = /([^{}]+?)\s*\{\s*([^{}]*?)\s*\}/g;
    let match;

    let isSimpleSelector = function (sel) {
      let cleanSel = sel.replace(/(["'])(?:(?=(\\?))\2.)*?\1/g, "");
      return !/:(?!is\(|where\(|not\(|has\()[\w-]|::|\[/.test(cleanSel);
    };

    while ((match = cssRuleRegex.exec(cssText)) !== null) {
      let selector = match[1].trim();
      let rulesBody = match[2].trim();

      // 处理 @apply 指令
      let applyRegex = /(@apply\s+([^;]+);?)/g;
      let appliedClasses = [];
      let filteredRulesBody = rulesBody;
      let applyMatch;

      while ((applyMatch = applyRegex.exec(rulesBody)) !== null) {
        let rawClasses = applyMatch[1].trim();
        let classTokens = rawClasses.split(/\s+/);
        for (let i = 0; i < classTokens.length; i++) {
          if (classTokens[i]) appliedClasses.push(classTokens[i]);
        }
        filteredRulesBody = filteredRulesBody.replace(applyMatch[0], "");
      }

      filteredRulesBody = filteredRulesBody.replace(/;?\s*$/, "").trim();

      // 将 @apply 类名解析为 CSS 声明并合并
      if (appliedClasses.length > 0 && isSimpleSelector(selector)) {
        for (let j = 0; j < appliedClasses.length; j++) {
          let cssVal = resolveClassToCSS(appliedClasses[j]);
          if (cssVal && cssVal.indexOf(":") !== -1) {
            filteredRulesBody = (filteredRulesBody ? filteredRulesBody + ";" : "") + cssVal.replace(/;+$/g, "");
          }
        }
      }

      // 处理剩余规则中的工具类引用
      if (filteredRulesBody) {
        filteredRulesBody = processCSSBlock(filteredRulesBody);
      }

      // 应用作用域选择器
      if (scopeSelector && filteredRulesBody) {
        selector = selector.split(",").map(function (sel) { return sel.trim() + scopeSelector; }).join(",");
      }

      if (filteredRulesBody) {
        result += selector + "{" + filteredRulesBody + "}";
      }
    }

    return result;
  }

  // ==========================================
  // 8. JSON / FSS (Style Sheet) 配置解析
  // ==========================================

  /**
   * 解析页面中引入的配置脚本 (支持从 data-ftw-processed 配置中获取 JSON)
   * 支持 AbortController 超时控制（5 秒）
   * @param {Element|string} targetScript
   */
  function parseScriptUtility(targetScript) {
    let rawText = null;
    if (typeof targetScript === "string") {
      rawText = targetScript;
    } else {
      if (!targetScript || targetScript.tagName !== "SCRIPT") return;
      if (targetScript.dataset.ftwProcessed) return;

      targetScript.dataset.ftwProcessed = "true";
      if (targetScript.src) {
        let abortController = new AbortController();
        let timeoutId = setTimeout(function () { abortController.abort(); }, 5000);

        fetch(targetScript.src, { signal: abortController.signal })
          .then(function (response) { return response.text(); })
          .then(function (text) {
            clearTimeout(timeoutId);
            if (text) {
              try {
                ftw.util(JSON.parse(text));
              } catch (e) {}
            }
          })
          .catch(function () {
            clearTimeout(timeoutId);
          });
        return;
      }
      rawText = targetScript.textContent.trim();
    }

    if (rawText) {
      try {
        let configJson = JSON.parse(rawText);
        ftw.util(configJson);
      } catch (err) {}
    }
  }

  /**
   * 解析含有自定义 @ftw-util 的 CSS 样式标签或外链样式表
   * 支持 @ftw-keyframes、@keyframes、@media、@supports、@font-face 等 @规则
   * 外链 fetch 支持 AbortController 超时控制（5 秒）
   * @param {Element} styleTag STYLE 标签或 LINK 样式表标签
   */
  function parseStyleRender(styleTag) {
    /**
     * 辅助解析：递归提取大括号 {} 内的代码块并转换为 ftw.util 工具注册
     * @param {string} text 源文本
     * @param {number} keywordIndex @ftw-util 关键字位置
     * @returns {{length: number}|null} 解析结果
     */
    function extractUtilityBlock(text, keywordIndex) {
      let remainingText = text.slice(keywordIndex + 9);
      let whitespaceOffset = 0;
      while (whitespaceOffset < remainingText.length && /\s/.test(remainingText[whitespaceOffset])) {
        whitespaceOffset++;
      }

      if (remainingText[whitespaceOffset] === "{") {
        let block = findClosingCurlyBrace(remainingText, whitespaceOffset);
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

          let utilityName = content.slice(startIdx, braceIdx).trim();
          if (!utilityName || utilityName.indexOf("{") !== -1 || utilityName.indexOf("}") !== -1) {
            scanIdx = braceIdx + 1;
            continue;
          }

          let innerBlock = findClosingCurlyBrace(content, braceIdx);
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
        let utilityName = remainingText.slice(whitespaceOffset, braceStart).trim();
        let block = findClosingCurlyBrace(remainingText, braceStart);
        if (block !== null && utilityName) {
          ftw.util(utilityName, block);
          return { length: braceStart + block.length + 2 };
        }
        return null;
      }
    }

    if (styleTag.dataset.ftwProcessed) return;
    styleTag.dataset.ftwProcessed = "true";

    let isScoped = styleTag.hasAttribute("ftw-scoped");
    let scopeSelector = isScoped ? "[ftw-scoped]" : "";

    if (styleTag.tagName === "STYLE") {
      (function processStyles(cssText) {
        // 清理注释，转换不规范的 !imp 简写
        let sanitizedText = cssText
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/!imp(?=\s|;|$|})/g, "!important");

        // 第一步：处理 @ftw-util 语法结构
        let utilKeywordIndex = sanitizedText.indexOf("@ftw-util");
        while (utilKeywordIndex !== -1) {
          let parsedObj = extractUtilityBlock(sanitizedText, utilKeywordIndex);
          if (parsedObj === null) break;
          sanitizedText = sanitizedText.slice(0, utilKeywordIndex) + sanitizedText.slice(utilKeywordIndex + 9 + parsedObj.length);
          utilKeywordIndex = sanitizedText.indexOf("@ftw-util");
        }

        // 第二步：处理 @规则（@ftw-keyframes, @keyframes, @media, @supports, @font-face, @import, @charset, @namespace）
        sanitizedText = processAtRules(sanitizedText, scopeSelector);

        // 第三步：解析一般的 CSS 选择器匹配和 @apply 别名混入
        let match;
        let cssRuleRegex = /([^{}]+?)\s*\{\s*([^{}]*?)\s*\}/g;
        let isSimpleSelector = function (sel) {
          let cleanSel = sel.replace(/(["'])(?:(?=(\\?))\2.)*?\1/g, "");
          return !/:(?!is\(|where\(|not\(|has\()[\w-]|::|\[/.test(cleanSel);
        };

        while ((match = cssRuleRegex.exec(sanitizedText)) !== null) {
          let selector = match[1].trim();
          let rulesBody = match[2].trim();
          let applyRegex = /(@apply\s+([^;]+);?)/g;
          let appliedClasses = [];
          let filteredRulesBody = rulesBody;

          let applyMatch;
          while ((applyMatch = applyRegex.exec(rulesBody)) !== null) {
            let rawClasses = applyMatch[1].trim();
            let classTokens = rawClasses.split(/\s+/);
            for (let i = 0; i < classTokens.length; i++) {
              if (classTokens[i]) appliedClasses.push(classTokens[i]);
            }
            filteredRulesBody = filteredRulesBody.replace(applyMatch[0], "");
          }

          filteredRulesBody = filteredRulesBody.replace(/;?\s*$/, "").trim();
          if (scopeSelector) {
            selector = selector.split(",").map(function (sel) { return sel.trim() + scopeSelector; }).join(",");
          }

          // 将 @apply 类名绑定并渲染到目标选择器
          if (appliedClasses.length > 0 && isSimpleSelector(selector)) {
            ftw(selector, appliedClasses.join(" "));
          }
          if (filteredRulesBody) {
            let bodyTokens = filteredRulesBody.split(/[;\s]+/);
            let filteredTokens = [];
            for (let j = 0; j < bodyTokens.length; j++) {
              if (bodyTokens[j]) filteredTokens.push(bodyTokens[j]);
            }
            if (filteredTokens.length > 0) {
              ftw.apply(null, [selector].concat(filteredTokens));
            }
          }
        }
      })(styleTag.textContent);
    } else if (styleTag.tagName === "LINK" && styleTag.rel === "stylesheet") {
      let abortController = new AbortController();
      let timeoutId = setTimeout(function () { abortController.abort(); }, 5000);

      fetch(styleTag.href, { signal: abortController.signal })
        .then(function (res) { return res.text(); })
        .then(function (css) {
          clearTimeout(timeoutId);
          let virtualStyle = document.createElement("style");
          if (isScoped) virtualStyle.setAttribute("ftw-scoped", "");
          virtualStyle.textContent = css;
          parseStyleRender(virtualStyle);
        })
        .catch(function () {
          clearTimeout(timeoutId);
        });
    }
  }

  /**
   * 处理 CSS 文本中的 @规则（@ftw-keyframes, @keyframes, @media, @supports 等）
   * 按优先级顺序逐个匹配并移除已处理的 @规则
   * @param {string} cssText CSS 文本
   * @param {string} scopeSelector 作用域选择器
   * @returns {string} 移除 @规则后的剩余 CSS 文本
   */
  function processAtRules(cssText, scopeSelector) {
    let atRuleTypes = [
      "@ftw-keyframes",
      "@keyframes",
      "@media",
      "@supports",
      "@font-face",
      "@import",
      "@charset",
      "@namespace"
    ];

    let sanitized = cssText;
    let hasChanges = true;
    let iterations = 100;
    let processedPositions = new Set();

    while (hasChanges && iterations-- > 0) {
      hasChanges = false;

      for (let i = 0; i < atRuleTypes.length; i++) {
        let ruleType = atRuleTypes[i];
        let ruleIndex = sanitized.indexOf(ruleType);

        // 跳过已处理的位置
        while (ruleIndex !== -1 && processedPositions.has(ruleIndex)) {
          ruleIndex = sanitized.indexOf(ruleType, ruleIndex + 1);
        }

        if (ruleIndex !== -1) {
          // 确保 @规则在合法位置（行首或前一个字符是空白/分号/花括号）
          let precedingChar = ruleIndex > 0 ? sanitized.slice(ruleIndex - 1, ruleIndex) : "";
          if (ruleIndex === 0 || /[\s;{}]/.test(precedingChar)) {
            let parsedResult;

            if (ruleType === "@ftw-keyframes") {
              parsedResult = parseFTWKeyframes(sanitized, ruleIndex);
            } else if (ruleType === "@import" || ruleType === "@charset" || ruleType === "@namespace") {
              parsedResult = parseSimpleAtRule(sanitized, ruleIndex, ruleType);
            } else {
              parsedResult = parseAtRule(sanitized, ruleIndex, ruleType, scopeSelector);
            }

            if (parsedResult && parsedResult.length > 0) {
              sanitized = sanitized.slice(0, ruleIndex) + sanitized.slice(ruleIndex + parsedResult.length);
              hasChanges = true;
              break;
            }
          }
          processedPositions.add(ruleIndex);
        }
      }
    }

    return sanitized;
  }

  // ==========================================
  // 9. 核心 API 实现 (ftw)
  // ==========================================

  /**
   * ftw 核心绑定函数：为选择器匹配的元素应用原子样式或 CSS 代码段
   * 支持 :nth 索引选择器（如 ".box:2" 仅匹配第 2 个元素）
   * @param {Element|string} target 目标 DOM 元素或 CSS 选择器
   * @param {...string} classNamesOrCssRules 类名列表或 CSS 样式段
   */
  function ftw(target, classNamesOrCssRules) {
    let classesToApply = [];
    let rawStyleStatements = [];
    let extraArgs = Array.prototype.slice.call(arguments, 1);

    for (let a = 0; a < extraArgs.length; a++) {
      let arg = extraArgs[a];
      if (typeof arg === "string") {
        arg.replace(/!imp(?=\s|;|$|})/g, "!important")
          .split(/[;\s]+/)
          .forEach(function (val) {
            if (val) {
              if (val.indexOf(":") !== -1) {
                rawStyleStatements.push(val);
              } else {
                classesToApply.push(val);
              }
            }
          });
      }
    }

    // 处理原生 CSS 声明的动态样式块注入
    if (rawStyleStatements.length) {
      if (target instanceof Element) {
        let uniqueIdClass =
          target.tagName.toLowerCase() +
          (target.id ? "#" + target.id : "") +
          (target.className ? "." + target.className.split(/\s+/).join(".") : "");

        document.head.appendChild(
          Object.assign(document.createElement("style"), {
            textContent: uniqueIdClass + "{" + rawStyleStatements.join(";") + ";}"
          })
        );
      } else if (typeof target === "string" && target) {
        let sanitizedTarget = target.replace(/(["'])(?:(?=(\\?))\2.)*?\1/g, "");
        if (!/:(?!is\(|where\(|not\(|has\()[\w-]|::|\[/.test(sanitizedTarget)) {
          document.head.appendChild(
            Object.assign(document.createElement("style"), {
              textContent: target + "{" + rawStyleStatements.join(";") + ";}"
            })
          );
        }
      }
    }

    // 处理原子类名的添加和触发样式分析
    if (target instanceof Element) {
      let element = target;
      let finalClasses = [];
      for (let b = 0; b < classesToApply.length; b++) {
        let argCls = classesToApply[b];
        if (typeof argCls === "string") {
          let clsTokens = argCls.split(/[;\s]+/);
          for (let c = 0; c < clsTokens.length; c++) {
            if (clsTokens[c]) finalClasses.push(clsTokens[c]);
          }
        }
      }
      for (let d = 0; d < finalClasses.length; d++) {
        element.classList.add(finalClasses[d]);
        processUtilityClass(finalClasses[d], element);
      }
      return;
    }

    if (typeof target !== "string" || !target) return;

    // 如果参数中包含花括号 {}，说明是以选择器整体声明的形式传入 (例如: ".box { color: red }")
    if (classesToApply.length === 0 && target.indexOf("{") !== -1) {
      let matches = target.match(/^(.+?)\s*\{(.+)\}$/s);
      if (matches) {
        let cleanSelector = matches[1].trim();
        let bodyContent = matches[2].trim();
        if (bodyContent) {
          let bodyTokens = bodyContent.split(/[;\s]+/);
          let filteredTokens = [];
          for (let e = 0; e < bodyTokens.length; e++) {
            if (bodyTokens[e]) filteredTokens.push(bodyTokens[e]);
          }
          return ftw.apply(null, [cleanSelector].concat(filteredTokens));
        }
      }
    }

    // 展平类名列表
    let flatClassesList = [];
    for (let f = 0; f < classesToApply.length; f++) {
      let argCls2 = classesToApply[f];
      if (typeof argCls2 === "string") {
        let clsTokens2 = argCls2.split(/[;\s]+/);
        for (let g = 0; g < clsTokens2.length; g++) {
          if (clsTokens2[g]) flatClassesList.push(clsTokens2[g]);
        }
      }
    }

    // 解析 :nth 索引选择器（如 ".box:2" 仅匹配第 2 个元素）
    let finalSelector = target;
    let nthIndex = -1;
    let lastColonIdx = target.lastIndexOf(":");
    if (lastColonIdx > 0) {
      let possibleNth = parseInt(target.slice(lastColonIdx + 1), 10);
      if (!isNaN(possibleNth) && possibleNth > 0) {
        finalSelector = target.slice(0, lastColonIdx);
        nthIndex = possibleNth - 1; // 转换为 0-based 索引
      }
    }

    let matchedElements = document.querySelectorAll(finalSelector);

    if (nthIndex >= 0) {
      // 仅对第 N 个元素应用
      if (nthIndex < matchedElements.length) {
        let nthEl = matchedElements[nthIndex];
        for (let h = 0; h < flatClassesList.length; h++) {
          nthEl.classList.add(flatClassesList[h]);
          processUtilityClass(flatClassesList[h], nthEl);
        }
      }
    } else {
      // 对所有匹配元素应用
      for (let i = 0; i < matchedElements.length; i++) {
        let el = matchedElements[i];
        for (let j = 0; j < flatClassesList.length; j++) {
          el.classList.add(flatClassesList[j]);
          processUtilityClass(flatClassesList[j], el);
        }
      }
    }
  }


  // ==========================================
  // 11. 闲置与异步执行调度系统 (Scheduler)
  // ==========================================

  /**
   * 采用 requestIdleCallback 分片执行 DOM 树节点上 class 样式的增量匹配和处理
   * 支持 setTimeout 降级方案
   */
  function scheduleIdleProcessing() {
    if (isIdleCallbackScheduled) return;
    isIdleCallbackScheduled = true;

    if (typeof requestIdleCallback === "function") {
      processedElements = new WeakSet();
      let allElements = document.getElementsByTagName("*");
      let totalElements = allElements.length;
      let index = 0;

      requestIdleCallback(
        function processChunk(deadline) {
          while (
            index < totalElements &&
            (deadline.timeRemaining() > 1 || deadline.didTimeout)
          ) {
            processElementClasses(allElements[index]);
            index++;
          }
          if (index < totalElements) {
            requestIdleCallback(processChunk, { timeout: 300 });
          } else {
            isIdleCallbackScheduled = false;
          }
        },
        { timeout: 300 }
      );
    } else {
      // setTimeout 降级方案
      setTimeout(function () {
        processedElements = new WeakSet();
        let allElements = document.getElementsByTagName("*");
        let totalElements = allElements.length;
        let index = 0;

        function processNextChunk() {
          let end = Math.min(index + 50, totalElements);
          for (; index < end; ) {
            processElementClasses(allElements[index]);
            index++;
          }
          if (index < totalElements) {
            setTimeout(processNextChunk, 0);
          } else {
            isIdleCallbackScheduled = false;
          }
        }

        processNextChunk();
      }, 0);
    }
  }

  /**
   * 注册一个新的原子工具类匹配规则
   * 同时维护 utilityPrefixMap 用于快速前缀查找，并清理相关缓存
   * @param {string} classPattern 匹配类名的基础模式（例如 "w:num"）
   * @param {Function} generatorFn 生成具体 CSS 的计算函数
   * @param {Array<number|string>} [paramOrder] 参数重排映射表
   */
  function registerUtility(classPattern, generatorFn, paramOrder) {
    let parts = classPattern.split(":");
    let basePrefix = parts[0];
    let types = parts.slice(1);
    let regexPattern = buildClassRegex(basePrefix, types);

    let ruleDef = {
      regex: regexPattern,
      generator: generatorFn,
      idxOrder: paramOrder || [],
      types: types
    };

    utilityRules.set(classPattern, ruleDef);
    utilityPrefixes.add(basePrefix);

    // 维护前缀到规则数组的映射（用于快速前缀查找）
    let prefixRules = utilityPrefixMap.get(basePrefix);
    if (!prefixRules) {
      prefixRules = [];
      utilityPrefixMap.set(basePrefix, prefixRules);
    }
    prefixRules.push({ key: classPattern, rule: ruleDef });

    // 清理 classCache 中匹配此前缀的缓存条目
    if (classCache.size > 0) {
      let cacheKeysToRemove = [];
      let cacheEntries = classCache.keys();
      let cacheEntry = cacheEntries.next();
      while (!cacheEntry.done) {
        let cachedKey = cacheEntry.value;
        if (cachedKey === basePrefix || cachedKey.indexOf(basePrefix + "-") === 0) {
          cacheKeysToRemove.push(cachedKey);
        }
        cacheEntry = cacheEntries.next();
      }
      for (let i = 0; i < cacheKeysToRemove.length; i++) {
        classCache.delete(cacheKeysToRemove[i]);
      }
    }

    // 清理 ignoredClasses 中匹配此前缀的条目
    if (ignoredClasses.size > 0) {
      let ignoredToRemove = [];
      let ignoredEntries = ignoredClasses.values();
      let ignoredEntry = ignoredEntries.next();
      while (!ignoredEntry.done) {
        let ignoredVal = ignoredEntry.value;
        if (ignoredVal === basePrefix || ignoredVal.indexOf(basePrefix + "-") === 0) {
          ignoredToRemove.push(ignoredVal);
        }
        ignoredEntry = ignoredEntries.next();
      }
      for (let j = 0; j < ignoredToRemove.length; j++) {
        ignoredClasses.delete(ignoredToRemove[j]);
      }
    }
  }

  /**
   * 触发扫描和渲染
   * 支持批量模式提升性能，支持 requestIdleCallback 和 setTimeout 降级
   * @param {string|Element|Array<Element>|null} [targets] 可选的作用域限定
   */
  function scanAndProcessDOM(targets) {
    // 扫描自定义脚本与样式表配置
    let scriptElements = document.querySelectorAll("script[ftw-utils]");
    for (let s = 0; s < scriptElements.length; s++) {
      parseScriptUtility(scriptElements[s]);
    }
    let styleElements = document.querySelectorAll('style[ftw-render],link[ftw-render][rel="stylesheet"]');
    for (let t = 0; t < styleElements.length; t++) {
      parseStyleRender(styleElements[t]);
    }

    // 执行样式垃圾回收（异步调度）
    scheduleGC();

    if (isPaused) return;

    // 开启批量 CSS 注入模式
    isBatchMode = true;
    pendingStyles = [];

    // 分析需要处理的节点范围
    let elementsList;
    if (arguments.length === 0 || targets === undefined) {
      elementsList = document.getElementsByTagName("*");
    } else if (typeof targets === "string") {
      elementsList = document.querySelectorAll(targets);
    } else if (targets instanceof Element) {
      elementsList = [targets];
    } else if (targets && typeof targets.forEach === "function") {
      elementsList = targets;
    } else {
      elementsList = document.getElementsByTagName("*");
    }

    // 收集所有需要处理的元素（包括后代）
    let elementsToProcess = [];
    let elementsSet = new Set();
    let listLength = elementsList.length || 0;

    for (let i = 0; i < listLength; i++) {
      let el = elementsList[i];
      if (el && el.nodeType === 1) {
        if (!elementsSet.has(el)) {
          elementsSet.add(el);
          elementsToProcess.push(el);
        }
        if (el.getElementsByTagName) {
          let children = el.getElementsByTagName("*");
          for (let j = 0; j < children.length; j++) {
            let child = children[j];
            if (!elementsSet.has(child)) {
              elementsSet.add(child);
              elementsToProcess.push(child);
            }
          }
        }
      }
    }

    let totalCount = elementsToProcess.length;
    let scanIdx = 0;

    if (typeof requestIdleCallback === "function") {
      // 利用 requestIdleCallback 异步分批解析，不卡顿首屏渲染
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
          } else {
            // 扫描完成，刷新批量写入的样式
            flushStyleBatch();
          }
        },
        { timeout: 300 }
      );
    } else {
      // setTimeout 降级方案：每次处理 100 个元素
      function processChunk() {
        let end = Math.min(scanIdx + 100, totalCount);
        for (; scanIdx < end; ) {
          processElementClasses(elementsToProcess[scanIdx]);
          scanIdx++;
        }
        if (scanIdx < totalCount) {
          if (typeof requestIdleCallback === "function") {
            requestIdleCallback(function () { processChunk(); }, { timeout: 300 });
          } else {
            setTimeout(processChunk, 0);
          }
        } else {
          flushStyleBatch();
        }
      }
      processChunk();
    }
  }

  // ==========================================
  // 12. 扩展 API: ftw.util - 规则高级注册工具
  // ==========================================
  ftw.util = function (configOrKey, valueGenerator, numParamsOrder) {
    /**
     * 将用户声明的上下文重映射提取为索引配置
     * @param {Array|Object} rawMapping 原始映射
     * @returns {Object|null} {varName: paramIndex} 映射对象
     */
    function parseContextMapping(rawMapping) {
      if (!rawMapping) return null;
      if (Array.isArray(rawMapping)) {
        let mapping = {};
        for (let i = 0; i < rawMapping.length; i++) {
          let name = rawMapping[i];
          if (typeof name === "string" && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
            mapping[name] = i;
          }
        }
        return mapping;
      }
      if (typeof rawMapping === "object" && rawMapping !== null) {
        let mapping = {};
        for (let name in rawMapping) {
          if (!rawMapping.hasOwnProperty(name)) continue;
          let parsedIdx = Number(name);
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
     * @param {*} definition 定义（函数、字符串模板、数组等）
     * @param {string} targetName 目标工具类名称
     * @returns {Function} 标准化后的生成器函数
     */
    function normalizeGenerator(definition, targetName) {
      if (typeof definition === "function") return definition;
      if (typeof definition === "string") {
        if (!/=>|function/.test(definition)) {
          let compiled = compileTemplateExpression(definition, targetName, null, []);
          return function () {
            return compiled.apply(null, arguments);
          };
        }
        try {
          return new Function("return " + definition)();
        } catch (err) {
          return function () { return ""; };
        }
      }

      if (Array.isArray(definition)) {
        let targetValue = definition[0];
        let secondParam = definition[1];
        let thirdParam = definition[2];

        let targetNumericIdxs = null;
        let targetContextMap = null;
        let targetCompiledTemplate = null;
        let targetFunc = null;

        if (typeof targetValue === "function") {
          targetFunc = targetValue;
          if (Array.isArray(secondParam)) {
            if (secondParam.every(function (v) { return typeof v === "number"; })) {
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
            if (secondParam.every(function (v) { return typeof v === "number"; })) {
              targetNumericIdxs = secondParam;
            } else {
              targetContextMap = parseContextMapping(secondParam);
            }
          } else if (typeof secondParam === "object" && secondParam !== null) {
            targetContextMap = parseContextMapping(secondParam);
          }

          if (Array.isArray(thirdParam) && thirdParam.every(function (v) { return typeof v === "number"; })) {
            targetNumericIdxs = thirdParam;
          }
        }

        if (targetCompiledTemplate) {
          let compiled = compileTemplateExpression(
            targetCompiledTemplate,
            targetName,
            targetContextMap,
            targetNumericIdxs || []
          );
          let wrapper = function () {
            return compiled.apply(null, arguments);
          };
          wrapper._numIdx = targetNumericIdxs || [];
          return wrapper;
        }

        if (targetFunc) {
          let wrapper = function () {
            return targetFunc.apply(null, arguments);
          };
          wrapper._numIdx = targetNumericIdxs || [];
          return wrapper;
        }
      }

      return function () { return String(definition); };
    }

    /**
     * 辅助解析：将外部传递的参数名数组转换为对应的索引位映射
     * @param {Array} paramNames 参数名数组
     * @param {Function} compiledFunc 编译后的函数
     * @returns {number[]} 索引映射数组
     */
    function mapParamNamesToIndices(paramNames, compiledFunc) {
      if (!Array.isArray(paramNames)) return [];
      let funcParams = (function getFunctionParameters(func) {
        let matches = func.toString().match(/^(?:function\s*\w*\s*)?\(([^)]*)\)|^\(([^)]*)\)\s*=>/);
        return matches
          ? (matches[1] || matches[2] || "").split(",").map(function (p) { return p.trim(); }).filter(Boolean)
          : [];
      })(compiledFunc);

      return paramNames
        .map(function (param) {
          if (typeof param === "number") return param;
          if (typeof param === "string") {
            let index = funcParams.indexOf(param);
            return index;
          }
          return -1;
        })
        .filter(function (idx) { return idx !== -1; });
    }

    // 核心注册入口：
    if (typeof configOrKey !== "object" || configOrKey === null) {
      if (typeof configOrKey === "string") {
        let normalizedGen = normalizeGenerator(valueGenerator, configOrKey);
        let numericIdxs = normalizedGen._numIdx || [];
        if (Array.isArray(numParamsOrder) && numParamsOrder.every(function (v) { return typeof v === "number"; })) {
          numericIdxs = numParamsOrder;
        }
        registerUtility(configOrKey, normalizedGen, mapParamNamesToIndices(numericIdxs, normalizedGen));
        scheduleIdleProcessing();
      }
    } else {
      for (let key in configOrKey) {
        if (!configOrKey.hasOwnProperty(key)) continue;
        let normalizedGen = normalizeGenerator(configOrKey[key], key);
        registerUtility(key, normalizedGen, mapParamNamesToIndices(normalizedGen._numIdx || [], normalizedGen));
      }
      scheduleIdleProcessing();
    }
  };

  // ==========================================
  // 13. API 接口扩展 (ftw.render / ftw.use / 缓存配置)
  // ==========================================

  /**
   * 手动触发扫描和渲染（支持限定作用域）
   * @param {Element|string} [targetElements] 可选的目标元素或选择器
   */
  ftw.render = function (targetElements) {
    scanAndProcessDOM(targetElements);
  };

  /**
   * 手动加载并处理 JSON 配置，同时触发扫描渲染
   * @param {Element|string} [targetElements] 可选的目标元素或选择器
   */
  ftw.use = function (targetElements) {
    scanAndProcessDOM(targetElements);
  };

  // 绑定全局变量
  window.ftw = ftw;

  /**
   * 类名解析缓存最大容量（属性访问器）
   * 赋值时校验：必须为正整数，否则拒绝赋值（静默忽略）
   * 读取时返回当前容量值
   */
  Object.defineProperty(ftw, "clsCache", {
    get: function () { return classCacheMaxSize; },
    set: function (val) {
      if (typeof val === "number" && val >= 0 && val === Math.floor(val)) {
        classCacheMaxSize = val;
      }
    },
    enumerable: true,
    configurable: false
  });

  /**
   * 模板编译缓存最大容量（属性访问器）
   * 赋值时校验：必须为正整数，否则拒绝赋值（静默忽略）
   * 读取时返回当前容量值
   */
  Object.defineProperty(ftw, "tplCache", {
    get: function () { return templateCacheMaxSize; },
    set: function (val) {
      if (typeof val === "number" && val >= 0 && val === Math.floor(val)) {
        templateCacheMaxSize = val;
      }
    },
    enumerable: true,
    configurable: false
  });

  // ==========================================
  // 13b. 调试 API (Debug APIs)
  // ==========================================

  /**
   * 清除类名解析缓存和模板编译缓存
   * - 无参数或 prefix 不是非空字符串：完全清空 classCache 和 templateCache
   * - 有字符串参数：遍历 classCache，删除所有以 prefix 开头的 key，并完全清空 templateCache
   * V8 优化：使用 for...of 迭代 classCache.keys()，避免 forEach 回调栈帧
   * @param {string} [prefix] 可选的前缀过滤器
   */
  ftw.clearCache = function (...args) {
    if (args.length === 0) {
      classCache.clear();
      templateCache.clear();
      return;
    }
    for (let i = 0; i < args.length; i++) {
      let prefix = args[i];
      if (typeof prefix !== "string" || prefix === "") {
        classCache.clear();
        templateCache.clear();
        return;
      }
      // 使用 for...of 直接迭代 Map.keys()，V8 可内联优化，无额外回调栈帧
      for (let _key of classCache.keys()) {
        if (_key.indexOf(prefix) === 0) {
          classCache.delete(_key);
        }
      }
    }
    templateCache.clear();
  };

  /**
   * 干跑解析 CSS，不操作 DOM、不注入样式表
   * 遍历所有参数，对每个参数根据是否包含 { 进行不同处理：
   * - 包含 { ：提取选择器和花括号内内容，递归解析内部后拼接
   * - 不包含 { ：按 /[;\s]+/ 拆分成 tokens，区分原生 CSS 声明与原子类名
   * 最终所有结果用空字符串拼接，块之间天然并列不加额外分隔
   * @param {...string} args 类名或选择器块
   * @returns {string} 解析后的 CSS 字符串（冻结）
   */
  ftw.css = function (...args) {
    let results = [];
    for (let i = 0; i < args.length; i++) {
      let arg = args[i];
      if (typeof arg !== "string" || arg === "") continue;
      // 普通类名或原生 CSS 声明
      let tokens = arg.split(/[;\s]+/);
      let tokenResults = [];
      for (let j = 0; j < tokens.length; j++) {
        let token = tokens[j];
        if (!token) continue;
        if (token.indexOf(":") !== -1 && token.indexOf("not-util:") !== 0) {
          // 原生 CSS 声明，保留（去除末尾多余分号）
          tokenResults.push(token.replace(/;+$/g, ""));
        } else {
          // 原子类名，调用 resolveClassToCSS 解析
          let cssVal = resolveClassToCSS(token);
          if (cssVal) {
            tokenResults.push(cssVal.replace(/;+$/g, ""));
          }
        }
      }
      if (tokenResults.length > 0) {
        results.push(tokenResults.join(""));
      }
    }
    let result = results.join("");
    return Object.freeze ? Object.freeze(result) : result;
  };

  /**
   * 内部函数：查询单个类名的结构化元数据
   * 遍历 utilityRules 进行正则匹配，提取 matched、ruleKey、params
   * CSS 优先取 classCache，若无则调用 resolveClassToCSS（会写入缓存，但 fromCache 以本次查询是否命中为准）
   * @param {string} className 类名
   * @returns {Object} 冻结的元数据对象 { matched, ruleKey, params, css, fromCache, refCount }
   */
  let _inspectSingle = function (className) {
    // 剥离 ! 前缀（重要修饰符，不影响类名匹配）
    let cleanName = className;
    if (cleanName.indexOf("!") === 0) {
      cleanName = cleanName.slice(1);
    }

    let matched = false;
    let ruleKey = null;
    let params = [];
    let css = null;
    let fromCache = false;
    let refCount = 0;

    // 1. 优先检查 classCache
    if (classCache.has(cleanName)) {
      css = classCache.get(cleanName);
      fromCache = true;
    }

    // 2. 遍历 utilityRules 进行正则匹配
    let utilEntries = utilityRules.entries();
    let utilEntry = utilEntries.next();
    while (!utilEntry.done) {
      let candidateKey = utilEntry.value[0];
      let ruleDef = utilEntry.value[1];
      let matchResult = cleanName.match(ruleDef.regex);
      if (matchResult) {
        matched = true;
        ruleKey = candidateKey;
        if (matchResult[1]) {
          params = splitSuffix(matchResult[1]);
        }
        break;
      }
      utilEntry = utilEntries.next();
    }

    // 3. 如果 utilityRules 未匹配，检查关键帧类型注册表
    if (!matched) {
      let kfEntries = keyframeTypeRegistry.entries();
      let kfEntry = kfEntries.next();
      while (!kfEntry.done) {
        let kfName = kfEntry.value[0];
        let typeRegex = new RegExp("^" + kfName + "-(\\[[^\\]]+\\]|[^-][\\w\\.\\/\\-]*)$");
        let kfMatch = cleanName.match(typeRegex);
        if (kfMatch) {
          matched = true;
          ruleKey = kfName;
          let suffix = kfMatch[1];
          params = splitSuffix(suffix);
          break;
        }
        kfEntry = kfEntries.next();
      }
    }

    // 4. 如果仍未匹配，检查关键帧注册表
    if (!matched && keyframeRegistry.has(cleanName)) {
      matched = true;
      ruleKey = cleanName;
    }

    // 5. 获取 CSS 值（如果缓存未命中则调用 resolveClassToCSS 解析并写入缓存）
    if (css === null) {
      css = resolveClassToCSS(cleanName);
    }

    // 6. 获取引用计数
    refCount = classRefCount.has(cleanName) ? classRefCount.get(cleanName) : 0;

    // 7. 构建结果：根据返回值类型决定显示 css 还是 class
    //    含 : 为 CSS 声明 → 显示 css；不含 : 为类名 → 显示 class
    //    均为 null 时不显示对应字段（不会出现 css:null 或 class:null）
    let result = {
      matched: matched,
      ruleKey: ruleKey,
      params: params,
      fromCache: fromCache,
      refCount: refCount
    };
    if (css !== null) {
      if (css.indexOf(":") !== -1) {
        result.css = css;
      } else {
        result.class = css;
      }
    }
    return Object.freeze(result);
  };

  /**
   * 结构化元数据查询接口
   * 1. 参数按 /[;\s]+/ 拆分，过滤掉所有含 : 的 token（原生 CSS 声明）
   * 2. 去重（Set）
   * 3. 长度 0 → null；长度 1 → 返回单对象；长度 > 1 → 返回 { [name]: _inspectSingle(name), ... } 并整体冻结
   * 严禁使用 Date.now() 或 performance.now()
   * @param {...string} args 类名列表
   * @returns {Object|null} 单个类名返回冻结对象，多个返回冻结的 { name: obj } 映射，0 个返回 null
   */
  ftw.inspect = function (...args) {
    let tokens = [];
    for (let i = 0; i < args.length; i++) {
      if (typeof args[i] !== "string") continue;
      let parts = args[i].split(/[;\s]+/);
      for (let j = 0; j < parts.length; j++) {
        let token = parts[j];
        // 过滤掉含 : 的 token（原生 CSS 声明）
        if (token && token.indexOf(":") === -1) {
          tokens.push(token);
        }
      }
    }

    // 去重
    let uniqueTokens = [];
    let seen = new Set();
    for (let k = 0; k < tokens.length; k++) {
      if (!seen.has(tokens[k])) {
        seen.add(tokens[k]);
        uniqueTokens.push(tokens[k]);
      }
    }

    if (uniqueTokens.length === 0) return null;
    if (uniqueTokens.length === 1) {
      return _inspectSingle(uniqueTokens[0]);
    }

    let result = {};
    for (let m = 0; m < uniqueTokens.length; m++) {
      result[uniqueTokens[m]] = _inspectSingle(uniqueTokens[m]);
    }
    return Object.freeze(result);
  };

  // ==========================================
  // 14. 监听器与初始化生命周期 (Lifecycle)
  // ==========================================
  if (!domObserver) {
    domObserver = new MutationObserver(function (mutations) {
      for (let i = 0; i < mutations.length; i++) {
        let mutation = mutations[i];
        if (mutation.type === "childList") {
          for (let j = 0; j < mutation.addedNodes.length; j++) {
            let node = mutation.addedNodes[j];
            // 自动拦截新加入文档流的 script[ftw-utils]
            if (node.matches && node.matches("script[ftw-utils]")) {
              parseScriptUtility(node);
            }
            if (node.querySelectorAll) {
              let subScripts = node.querySelectorAll("script[ftw-utils]");
              for (let k = 0; k < subScripts.length; k++) {
                parseScriptUtility(subScripts[k]);
              }
            }
            // 自动拦截新加入文档流的 style[ftw-render] / FSS link
            if (node.matches && (node.matches("style[ftw-render]") || node.matches('link[ftw-render][rel="stylesheet"]'))) {
              parseStyleRender(node);
            }
            if (node.querySelectorAll) {
              let subStyles = node.querySelectorAll('style[ftw-render], link[ftw-render][rel="stylesheet"]');
              for (let l = 0; l < subStyles.length; l++) {
                parseStyleRender(subStyles[l]);
              }
            }
            // 对新加入的元素执行原子样式分析
            if (node.nodeType === 1 && !isPaused) {
              processElementClasses(node);
              if (node.getElementsByTagName) {
                let childElements = node.getElementsByTagName("*");
                for (let m = 0; m < childElements.length; m++) {
                  processElementClasses(childElements[m]);
                }
              }
            }
          }
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
      }
    });
  }

  // 启动对整个 HTML 树的 Mutation 观察
  let rootElement = document.documentElement;
  domObserver.observe(rootElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class"]
  });

  // 文档加载就绪时执行首次全盘扫描
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      scanAndProcessDOM();
    });
  } else {
    scanAndProcessDOM();
  }

  // 挂载辅助性控制函数到全局 ftw 下
  isPaused = false;

  /**
   * 暂停样式处理
   */
  ftw.pause = function () {
    isPaused = true;
  };

  /**
   * 恢复样式处理，并触发 GC
   */
  ftw.resume = function () {
    isPaused = false;
    scheduleGC();
  };

  ftw.update = scanAndProcessDOM;

  /**
   * 一次性处理：恢复 → 扫描 → 暂停
   * @param {Element|string} [element] 可选的作用域限定
   */
  ftw.once = function (element) {
    ftw.resume();
    scanAndProcessDOM(element);
    ftw.pause();
  };

  /**
   * 调试输出：返回所有已生成样式的映射表
   * @returns {Array<{class: string, css: string}>} 调试信息数组
   */
  ftw.debug = function () {
    let debugMap = [];
    let entries = generatedStylesMap.entries();
    let entry = entries.next();
    while (!entry.done) {
      debugMap.push({
        class: entry.value[0],
        css: entry.value[1]
      });
      entry = entries.next();
    }
    return debugMap;
  };

  ftw.gc = garbageCollectUnusedStyles;

  /**
   * 忽略指定元素，不对其进行原子样式处理
   * @param {...string|Element} targets 选择器或 DOM 元素
   */
  ftw.ignore = function () {
    for (let i = 0; i < arguments.length; i++) {
      let target = arguments[i];
      if (typeof target === "string") {
        let elements = document.querySelectorAll(target);
        for (let j = 0; j < elements.length; j++) {
          elements[j].setAttribute("ftw-ignore", "");
        }
      } else if (target && target.nodeType === 1) {
        target.setAttribute("ftw-ignore", "");
      }
    }
  };

  /**
   * 取消忽略指定元素，重新进行原子样式处理
   * @param {...string|Element} targets 选择器或 DOM 元素
   */
  ftw.unignore = function () {
    for (let i = 0; i < arguments.length; i++) {
      let target = arguments[i];
      if (typeof target === "string") {
        let elements = document.querySelectorAll(target);
        for (let j = 0; j < elements.length; j++) {
          elements[j].removeAttribute("ftw-ignore");
          scanAndProcessDOM(elements[j]);
        }
      } else if (target && target.nodeType === 1) {
        target.removeAttribute("ftw-ignore");
        scanAndProcessDOM(target);
      }
    }
  };
})();