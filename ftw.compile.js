#!/usr/bin/env node
/**
 * FTW Compile-Time — 编译时 CSS 工具类处理器
 * 单文件整合版
 *
 * 编译管线:
 *   .fss (@ftw-keyframes + @ftw-util + CSS)
 *   + .rule 规则文件 (可选)
 *   + .html 元素文件 (可选)
 *   = 编译后 CSS + 编译后 HTML
 *
 * 用法:
 *   node ftw-compile.js -f styles.fss -ht index.html -c out.css -ho out.html
 *   node ftw-compile.js -f styles.fss -i "p:4 mx:auto flex"
 *   node ftw-compile.js -f styles.fss -ht index.html -d
 *   node ftw-compile.js -f styles.fss -r rules.json -ht index.html -w
 */
"use strict";

const fs = require('fs');
const path = require('path');

// ══════════════════════════════════════════════════════════════
//  1. 工具函数
// ══════════════════════════════════════════════════════════════

function extractBlock(source, pos) {
  if (source[pos] !== '{') return null;
  let depth = 1, cssDepth = 0, i = pos + 1;
  for (; i < source.length && depth > 0; i++) {
    const ch = source[i], prev = source[i - 1];
    if (ch === '{' && prev !== '-') depth++;
    else if (ch === '{' && prev === '-') cssDepth++;
    else if (ch === '}' && cssDepth > 0) cssDepth--;
    else if (ch === '}' && depth > 0) depth--;
  }
  return depth === 0 ? source.slice(pos + 1, i - 1) : null;
}

function skipWS(source, pos) {
  while (pos < source.length && /\s/.test(source[pos])) pos++;
  return pos;
}

function escapeCSSClass(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

function indent(text, spaces) {
  const prefix = ' '.repeat(spaces);
  return text.split('\n').map(l => l ? prefix + l : l).join('\n');
}

/** 将多属性 CSS 按 ; 拆分为独立行，每行加缩进 */
function normalizeCSSOutput(css, indentSpaces) {
  const sp = ' '.repeat(indentSpaces || 2);
  return css.split(';').map(p => p.trim()).filter(Boolean).map(p => sp + p + ';').join('\n');
}

// ══════════════════════════════════════════════════════════════
//  2. FSS / Rule 解析器
// ══════════════════════════════════════════════════════════════

function parseFSS(source, filePath) {
  const keyframes = new Map();
  const utilsByBase = new Map();
  const cssSelectors = new Set();
  const cssRules = [];
  const warnings = [];
  const cleaned = source.replace(/\/\*[\s\S]*?\*\//g, '');

  let pos = 0;
  while (pos < cleaned.length) {
    pos = skipWS(cleaned, pos);
    if (pos >= cleaned.length) break;
    const remaining = cleaned.slice(pos);

    // @ftw-keyframes
    if (remaining.startsWith('@ftw-keyframes')) {
      const start = pos + 15;
      let ns = skipWS(cleaned, start);
      while (ns < cleaned.length && cleaned[ns] !== '{' && cleaned[ns] !== ';') ns++;
      const name = cleaned.slice(start, ns).trim();
      if (cleaned[ns] === '{') {
        const body = extractBlock(cleaned, ns);
        if (body !== null) { keyframes.set(name, body); pos = ns + body.length + 2; }
        else { warnings.push(`[${filePath}] @ftw-keyframes "${name}": 无法解析块`); pos = ns + 1; }
      } else { pos = ns + 1; }
      continue;
    }

    // @ftw-util
    if (remaining.startsWith('@ftw-util')) {
      const start = pos + 10;
      let ns = skipWS(cleaned, start);
      let bp = -1;
      for (let i = ns; i < cleaned.length; i++) {
        if (cleaned[i] === '{' || cleaned[i] === ';') { bp = i; break; }
      }
      if (bp === -1) { warnings.push(`[${filePath}] @ftw-util: 无法找到定义块`); break; }

      const signature = cleaned.slice(ns, bp).trim();
      const ci = signature.indexOf(':');
      const baseName = ci !== -1 ? signature.slice(0, ci).trim() : signature;
      const typeStr = ci !== -1 ? signature.slice(ci + 1).trim() : '';
      const types = typeStr ? typeStr.split(':').map(t => t.trim()) : [];

      let template = '';
      if (cleaned[bp] === '{') {
        const body = extractBlock(cleaned, bp);
        if (body !== null) { template = body.trim(); pos = bp + body.length + 2; }
        else { warnings.push(`[${filePath}] @ftw-util "${signature}": 无法解析CSS块`); pos = bp + 1; continue; }
      } else { template = ''; pos = bp + 1; }

      if (!utilsByBase.has(baseName)) utilsByBase.set(baseName, []);
      const entry = { types, template, paramCount: types.length, signature };
      const list = utilsByBase.get(baseName);
      const idx = list.findIndex(e => e.paramCount < entry.paramCount);
      if (idx === -1) list.push(entry); else list.splice(idx, 0, entry);
      continue;
    }

    // 普通 CSS
    let selEnd = pos;
    while (selEnd < cleaned.length && cleaned[selEnd] !== '{') selEnd++;
    if (selEnd >= cleaned.length) break;
    const selector = cleaned.slice(pos, selEnd).trim();
    if (!selector) { pos++; continue; }

    if (selector.startsWith('@')) {
      if (cleaned[selEnd] === '{') {
        const body = extractBlock(cleaned, selEnd);
        if (body !== null) { cssRules.push({ type: 'at-rule', selector, body: body.trim() }); pos = selEnd + body.length + 2; }
        else pos = selEnd + 1;
      } else pos = selEnd + 1;
      continue;
    }

    if (cleaned[selEnd] === '{') {
      const body = extractBlock(cleaned, selEnd);
      if (body !== null) {
        for (const sel of selector.split(',')) {
          const m = sel.trim().match(/\.([a-zA-Z_][\w-]*)/g);
          if (m) for (const c of m) cssSelectors.add(c.slice(1));
        }
        const applyRefs = [];
        const re = /@apply\s+([^;]+);?/g; let m2;
        while ((m2 = re.exec(body)) !== null) {
          applyRefs.push(...m2[1].trim().split(/\s+/).filter(Boolean));
        }
        cssRules.push({ type: 'rule', selector, body: body.trim(), applyRefs });
        pos = selEnd + body.length + 2;
      } else pos = selEnd + 1;
    } else pos++;
  }

  return { keyframes, utilsByBase, cssSelectors, cssRules, warnings };
}

function parseRuleRules(source, filePath) {
  const utilsByBase = new Map();
  const customValidators = {};
  const warnings = [];
  try {
    const data = typeof source === 'string' ? JSON.parse(source) : source;
    // 顶层 $validators 字段 → 注册自定义验证器
    if (data.$validators && typeof data.$validators === 'object') {
      for (const [name, v] of Object.entries(data.$validators)) {
        if (typeof v === 'string') {
          try { customValidators[name] = new Function('return ' + v)(); } catch(e) { warnings.push(`[${filePath}] $validators.${name}: 解析失败`); }
        } else if (typeof v === 'function') {
          customValidators[name] = v;
        }
      }
    }
    for (const [signature, def] of Object.entries(data)) {
      if (signature === '$validators') continue;  // 跳过元字段
      const ci = signature.indexOf(':');
      const baseName = ci !== -1 ? signature.slice(0, ci).trim() : signature;
      const typeStr = ci !== -1 ? signature.slice(ci + 1).trim() : '';
      const types = typeStr ? typeStr.split(':').map(t => t.trim()) : [];
      let template = '';
      let entryValidators = null;
      if (typeof def === 'function') template = def;
      else if (Array.isArray(def)) template = '';
      else if (typeof def === 'object' && def !== null) {
        const fnRaw = def.fn || def.handler || '';
        if (fnRaw && typeof fnRaw === 'string') {
          try {
            const fn = new Function('return ' + fnRaw)();
            template = typeof fn === 'function' ? fn : fnRaw;
          } catch(e) { template = fnRaw; }
        } else {
          template = def.template || def.css || '';
        }
        if (def.types && types.length === 0) { types.length = 0; types.push(...def.types); }
        // 提取条目级自定义验证器
        if (def.validators && typeof def.validators === 'object') {
          entryValidators = {};
          for (const [k, v] of Object.entries(def.validators)) {
            if (typeof v === 'string') {
              try { entryValidators[k] = new Function('return ' + v)(); } catch(e) { entryValidators[k] = v; }
            } else if (typeof v === 'function') {
              entryValidators[k] = v;
            }
          }
        }
      } else if (typeof def === 'string') {
        // 检测字符串是否为箭头函数 / 普通函数表达式
        const trimmed = def.trim();
        if (/^(\([^)]*\)|[a-zA-Z_]\w*)\s*=>/.test(trimmed) || /^(async\s+)?function\s*\(/.test(trimmed)) {
          try {
            const fn = new Function('return ' + trimmed)();
            template = typeof fn === 'function' ? fn : trimmed;
          } catch(e) { template = trimmed; }
        } else {
          template = trimmed;
        }
      }

      // 自动检测函数参数个数，覆盖 types 推断的 paramCount
      let fnParamCount = null;
      if (typeof template === 'function') {
        fnParamCount = template.length;
        // 如果 types 不够，用 str 补齐
        while (types.length < fnParamCount) types.push('str');
      }

      if (!utilsByBase.has(baseName)) utilsByBase.set(baseName, []);
      const entry = { types, template, paramCount: fnParamCount !== null ? fnParamCount : types.length, signature, validators: entryValidators };
      const list = utilsByBase.get(baseName);
      const idx = list.findIndex(e => e.paramCount < entry.paramCount);
      if (idx === -1) list.push(entry); else list.splice(idx, 0, entry);
    }
  } catch (e) { warnings.push(`[${filePath}] 规则解析失败: ${e.message}`); }
  return { utilsByBase, warnings, customValidators };
}

// ══════════════════════════════════════════════════════════════
//  3. 类名 → CSS 解析器
// ══════════════════════════════════════════════════════════════

const SAFE_GLOBALS = new Set([
  'Math','Number','String','Array','Object','Boolean','Date','RegExp',
  'JSON','Promise','Symbol','Map','Set','isNaN','parseInt','parseFloat',
  'typeof','instanceof','undefined','NaN','Infinity'
]);

// ── 性能缓存 ──
const classCache = new Map();       // className → resolveResult
const templateCache = new Map();    // templateKey::paramsKey → cssString

function cacheKeyForTemplate(template, params, types) {
  const tk = typeof template === 'function' ? 'fn:' + template.toString() : template;
  return `${tk}::${types.join(',')}::${params.join(',')}`;
}

// ── 增强参数验证器 ──
const BUILTIN_VALIDATORS = {
  num: (v) => !isNaN(Number(v)) && isFinite(Number(v)),
  int: (v) => /^[+-]?\d+$/.test(v),
  str: (v) => true,
  color: (v) => /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v) || /^(rgb|hsl|oklch|lab|rgba|hsla)/.test(v),
  hex: (v) => /^[0-9a-fA-F]+$/.test(v),
  size: (v) => /^\d+(\.\d+)?/.test(v) || /^(auto|100%|0|inherit|initial|unset|revert|none|normal|fit-content|max-content|min-content)$/.test(v),
  length: (v) => /^\d+(\.\d+)?(px|em|rem|%|vh|vw|vmin|vmax|ch|ex|cm|mm|in|pt|pc)?$/.test(v) || /^(auto|0|inherit|initial|unset|revert)$/.test(v),
  angle: (v) => /^-?\d+(\.\d+)?(deg|rad|grad|turn)$/.test(v),
  time: (v) => /^\d+(\.\d+)?(s|ms)$/.test(v),
  pct: (v) => /^\d+(\.\d+)?%$/.test(v),
  url: (v) => /^https?:\/\/.+/.test(v) || /^\/.*/.test(v) || /^data:/.test(v),
  bool: (v) => v === 'true' || v === 'false' || v === '0' || v === '1',
};

/** 注册自定义验证器 */
function registerValidator(name, fn) {
  if (typeof fn === 'string') {
    try { fn = new Function('return ' + fn)(); } catch(e) { return false; }
  }
  if (typeof fn === 'function') { BUILTIN_VALIDATORS[name] = fn; return true; }
  return false;
}

function safeEval(expr, params) {
  const argNames = [], argValues = [];
  for (let i = 0; i < params.length; i++) { argNames.push(`__p${i}`); argValues.push(params[i]); }
  const globalNames = [], globalValues = [];
  for (const name of SAFE_GLOBALS) {
    try { const v = globalThis[name]; if (v !== undefined) { globalNames.push(name); globalValues.push(v); } } catch(e){}
  }
  try {
    return new Function(...[...globalNames, ...argNames, '__uvars'], `return (${expr});`)
      (...[...globalValues, ...argValues, params]);
  } catch(e) { return undefined; }
}

/** 执行模板：字符串走模板替换，函数走调用求值（带缓存） */
function execTemplate(template, params, types = []) {
  const key = cacheKeyForTemplate(template, params, types);
  if (templateCache.has(key)) return templateCache.get(key);
  let result;
  if (typeof template === 'function') {
    try {
      const fnLen = template.length;
      // 智能展参:
      //   fnLen === 0          → 只传 types (如 () => ...)
      //   fnLen >= paramsLen   → 展开为独立参数，不足补 undefined (如 (color,e,c) => ...)
      //   fnLen <  paramsLen   → 传数组保持兼容 (如 (params) => ...)
      if (fnLen === 0) {
        result = template(types);
      } else if (fnLen >= params.length) {
        const args = [...params];
        while (args.length < fnLen) args.push(undefined);
        result = template(...args, types);
      } else {
        result = template(params, types);
      }
    } catch(e) { result = ''; }
  } else {
    result = compileTemplateUncached(template, params, types);
  }
  templateCache.set(key, result);
  return result;
}

function compileTemplate(template, params, types = []) {
  const key = cacheKeyForTemplate(template, params, types);
  if (templateCache.has(key)) return templateCache.get(key);
  const result = compileTemplateUncached(template, params, types);
  templateCache.set(key, result);
  return result;
}

function compileTemplateUncached(template, params, types = []) {
  return template.replace(/(?<!\$)\{([^{}]*)\}/g, (match, expr) => {
    const t = expr.trim();
    if (!t) return '';
    if (/^\d+$/.test(t)) {
      const idx = parseInt(t, 10);
      return idx < params.length ? params[idx] : '';
    }
    const am = t.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)$/);
    if (am) { const v = safeEval(am[2], params); return v !== undefined ? String(v) : ''; }
    const v = safeEval(t, params);
    return v !== undefined ? String(v) : '';
  });
}

function normalizeCSS(css, important) {
  let r = css.trim();
  if (r.endsWith(';')) r = r.slice(0, -1);
  // 始终将 !imp 简写替换为 !important
  r = r.replace(/!imp\b/g, '!important');
  if (important) {
    return r.split(';').map(p => p.trim()).filter(Boolean).map(p => {
      if (p.includes('!important')) return p;
      const ci = p.indexOf(':');
      return ci === -1 ? p + ' !important' : p.slice(0, ci + 1) + ' ' + p.slice(ci + 1).trim() + ' !important';
    }).join(';') + ';';
  }
  return r + ';';
}

function validateParams(params, types, customValidators) {
  for (let i = 0; i < params.length && i < types.length; i++) {
    const t = types[i], v = params[i];
    // 自定义验证器优先
    if (customValidators && customValidators[t]) {
      try { if (!customValidators[t](v)) return false; } catch(e) { return false; }
      continue;
    }
    // 内置验证器
    const vfn = BUILTIN_VALIDATORS[t];
    if (vfn) { if (!vfn(v)) return false; }
    else if (t !== 'str') { if (v !== t) return false; }
  }
  return true;
}

function findBestVariant(variants, paramCount, params, customValidators) {
  if (!variants || variants.length === 0) return null;
  for (const v of variants) { if (v.paramCount === paramCount && validateParams(params, v.types, customValidators)) return v; }
  let best = null;
  for (const v of variants) {
    if (v.paramCount >= paramCount && validateParams(params, v.types, customValidators)) {
      if (!best || v.paramCount < best.paramCount) best = v;
    }
  }
  if (!best) {
    for (const v of variants) { if (v.paramCount === paramCount) return v; }
    for (const v of variants) {
      if (v.paramCount >= paramCount) { if (!best || v.paramCount < best.paramCount) best = v; }
    }
    if (!best && variants.length > 0) best = variants[0];
  }
  return best;
}

function parseColonParams(raw) {
  return raw.map(p => p.startsWith('[') && p.endsWith(']') ? p.slice(1, -1) : p);
}

function parseDashParams(raw) {
  return raw.map(p => p.startsWith('[') && p.endsWith(']') ? p.slice(1, -1) : p);
}

/** 用工具类名反查 CSS，如果是函数模板就走执行（带缓存） */
function resolveClass(className, utilsByBase, keyframes, customValidators) {
  // 缓存检查
  if (classCache.has(className)) return classCache.get(className);

  let actual = className, imp = false;
  if (className.startsWith('!')) { imp = true; actual = className.slice(1); }
  if (actual.startsWith('not-util:')) {
    const r = { css: null, matched: true, ruleKey: 'not-util', params: [] };
    classCache.set(className, r);
    return r;
  }

  const _make = (css, rk, params) => {
    const r = { css: css ? normalizeCSS(css, imp) : null, matched: true, ruleKey: rk, params };
    classCache.set(className, r);
    return r;
  };

  if (keyframes && keyframes.has(actual)) {
    return _make(`animation: ${actual} 1s`, actual, []);
  }
  if (keyframes) {
    for (const [name] of keyframes) {
      if (actual === name || actual.startsWith(name + '-')) {
        const suffix = actual.slice(name.length + 1);
        const ap = suffix ? suffix.split('-').filter(Boolean) : [];
        return _make(`animation: ${name} ${ap.length > 0 ? ap.join(' ') : '1s'}`, name, ap);
      }
    }
  }

  if (utilsByBase && utilsByBase.has(actual)) {
    const variants = utilsByBase.get(actual);
    const np = variants.find(v => v.paramCount === 0);
    if (np && np.template) return _make(execTemplate(np.template, [], np.types), actual, []);
    if (np) return _make(null, actual, []);
  }

  const ci = actual.indexOf(':');
  if (ci !== -1) {
    const bn = actual.slice(0, ci);
    const raw = actual.slice(ci + 1).split(':');
    if (utilsByBase && utilsByBase.has(bn)) {
      const variants = utilsByBase.get(bn);
      const params = parseColonParams(raw);
      const best = findBestVariant(variants, params.length, params, customValidators);
      if (best) {
        if (best.template) {
          const css = execTemplate(best.template, params, best.types);
          if (css) return _make(css, bn, params);
        }
        return _make(null, bn, params);
      }
    }
  }

  // ── 方括号语法: bg-[blue-e]-[500-1]-[red] → base=bg, params=[blue-e,500-1,red] ──
  const bracketRe = /-\[([^\]]+)\]/;
  if (bracketRe.test(actual)) {
    const firstBracket = actual.search(bracketRe);
    const bn = actual.slice(0, firstBracket);
    const bracketPart = actual.slice(firstBracket);
    const paramRe = /\[([^\]]+)\]/g;
    const params = [];
    let pm;
    while ((pm = paramRe.exec(bracketPart)) !== null) params.push(pm[1]);
    if (utilsByBase && utilsByBase.has(bn) && params.length > 0) {
      const variants = utilsByBase.get(bn);
      const best = findBestVariant(variants, params.length, params, customValidators);
      if (best) {
        if (best.template) {
          const css = execTemplate(best.template, params, best.types);
          if (css) return _make(css, bn, params);
        }
        return _make(null, bn, params);
      }
    }
  }

  const parts = actual.split('-');
  for (let len = parts.length; len >= 1; len--) {
    const cand = parts.slice(0, len).join('-');
    if (utilsByBase && utilsByBase.has(cand)) {
      const variants = utilsByBase.get(cand);
      const params = parseDashParams(parts.slice(len));
      const best = findBestVariant(variants, params.length, params, customValidators);
      if (best) {
        if (best.template) {
          const css = execTemplate(best.template, params, best.types);
          if (css) return _make(css, cand, params);
        }
        return _make(null, cand, params);
      }
    }
  }

  const r = { css: null, matched: false, ruleKey: null, params: [] };
  classCache.set(className, r);
  return r;
}

function expandApply(body, utilsByBase, keyframes, customValidators) {
  let expanded = body.replace(/@apply\s+([^;]+);?/g, (match, classList) => {
    const allProps = [];
    for (const cls of classList.trim().split(/\s+/).filter(Boolean)) {
      const r = resolveClass(cls, utilsByBase, keyframes, customValidators);
      if (r.css) {
        for (const prop of r.css.replace(/;+$/, '').split(';')) {
          const p = prop.trim();
          if (p) allProps.push(p);
        }
      }
    }
    return allProps.join(';\n') + (allProps.length > 0 ? ';' : '');
  });
  if (expanded !== body) return expanded;

  // 裸类名列表语法: body 中没有 CSS 属性 (property:value) 时，视为类名列表
  // 如: h1 { bg-[blue-500] text-[gray-800] px-4 py-2 rounded }
  if (!/[{}]/.test(body) && !/[\w-]+\s*:/.test(body)) {
    const allProps = [];
    const tokens = body.trim().split(/\s+/).filter(Boolean);
    for (const cls of tokens) {
      const r = resolveClass(cls, utilsByBase, keyframes, customValidators);
      if (r.css) {
        for (const prop of r.css.replace(/;+$/, '').split(';')) {
          const p = prop.trim();
          if (p) allProps.push(p);
        }
      }
    }
    if (allProps.length > 0) return allProps.join(';\n') + ';';
  }

  return body;
}

// ══════════════════════════════════════════════════════════════
//  4. HTML 处理器
// ══════════════════════════════════════════════════════════════

function parseHTMLClasses(html) {
  const re = /class\s*=\s*["']([^"']*)["']/gi, all = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    for (const c of m[1].split(/\s+/).filter(Boolean)) { if (!all.includes(c)) all.push(c); }
  }
  return all;
}

function analyzeHTML(html, utilsByBase, keyframes, customValidators) {
  const all = parseHTMLClasses(html), matched = new Map(), unmatched = [];
  for (const c of all) {
    const r = resolveClass(c, utilsByBase, keyframes, customValidators);
    r.matched ? matched.set(c, r) : unmatched.push(c);
  }
  return { matched, unmatched, allClasses: all };
}

/**
 * 编译 HTML — 处理 class 属性中的工具类名
 * 模式:
 *   preserve (推荐) — 保留所有 class 不变，CSS 进编译文件，运行时靠 ftw-map 跳过已编译
 *   strip — 匹配的类名从 class 中移除，CSS 进编译文件
 *   keep — 保留所有 class，不做任何修改
 *   remove-unmatched — 移除未匹配的类名
 */
function compileHTML(html, utilsByBase, keyframes, opts = {}) {
  const mode = opts.mode || 'preserve';
  const customValidators = opts.customValidators || null;
  let result = html;
  const used = new Set(), unused = [];
  const re = /class\s*=\s*["']([^"']*)["']/gi;
  const replacements = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const full = m[0], list = m[1].split(/\s+/).filter(Boolean), idx = m.index;
    const resList = [], unmList = [];
    for (const c of list) {
      const r = resolveClass(c, utilsByBase, keyframes, customValidators);
      if (r.matched) { resList.push(c); used.add(c); }
      else unmList.push(c);
    }
    replacements.push({ idx, full, list, resList, unmList });
  }

  // preserve 模式: 不删除任何类名，仅做分析
  if (mode === 'preserve' || mode === 'keep') return { html: result, usedClasses: used, unusedClasses: unused };

  for (let i = replacements.length - 1; i >= 0; i--) {
    const r = replacements[i];
    let newAttr = '';
    if (mode === 'strip') {
      if (r.unmList.length > 0) newAttr = `class="${r.unmList.join(' ')}"`;
    } else if (mode === 'remove-unmatched') {
      if (r.resList.length > 0) newAttr = `class="${r.resList.join(' ')}"`;
    }
    if (newAttr) result = result.slice(0, r.idx) + newAttr + result.slice(r.idx + r.full.length);
    else result = result.slice(0, r.idx) + result.slice(r.idx + r.full.length);
  }
  return { html: result, usedClasses: used, unusedClasses: unused };
}

// ══════════════════════════════════════════════════════════════
//  5. 主编译器
// ══════════════════════════════════════════════════════════════

class FTWCompiler {
  constructor(opts = {}) {
    this.opts = { mode: 'preserve', verbose: false, debug: false, ...opts };
    this.keyframes = new Map();
    this.utilsByBase = new Map();
    this.cssSelectors = new Set();
    this.cssRules = [];
    this.warnings = [];
    this.customValidators = {};
    this.compiledCSS = '';
    this.mapData = {};          // className → ".className{css}"
    this.usedClasses = new Set();
    this.unmatchedClasses = [];
  }

  /** 注册自定义验证器 */
  registerValidator(name, fn) {
    if (typeof fn === 'string') {
      try { this.customValidators[name] = new Function('return ' + fn)(); return true; } catch(e) { return false; }
    }
    if (typeof fn === 'function') { this.customValidators[name] = fn; return true; }
    return false;
  }

  loadFSS(filePath) {
    const src = fs.readFileSync(filePath, 'utf-8');
    const { keyframes, utilsByBase, cssSelectors, cssRules, warnings } = parseFSS(src, filePath);
    for (const [n, b] of keyframes) {
      if (this.keyframes.has(n)) this.warnings.push(`[${filePath}] @ftw-keyframes "${n}" 重复定义`);
      this.keyframes.set(n, b);
    }
    for (const [bn, vars] of utilsByBase) {
      if (this.utilsByBase.has(bn)) {
        const ex = this.utilsByBase.get(bn);
        for (const v of vars) {
          const di = ex.findIndex(e => e.paramCount === v.paramCount);
          if (di !== -1) { ex[di] = v; this.warnings.push(`[${filePath}] @ftw-util "${v.signature}" 覆盖同参数版本`); }
          else ex.push(v);
        }
        ex.sort((a, b) => b.paramCount - a.paramCount);
      } else this.utilsByBase.set(bn, vars);
    }
    for (const s of cssSelectors) this.cssSelectors.add(s);
    this.cssRules.push(...cssRules);
    this.warnings.push(...warnings);
    if (this.opts.verbose) {
      let tu = 0; for (const [, v] of utilsByBase) tu += v.length;
      console.log(`[FTW] 加载 FSS: ${filePath}\n  - 关键帧: ${keyframes.size} 个\n  - 工具类变体: ${tu} 个\n  - CSS 选择器: ${cssSelectors.size} 个\n  - CSS 规则: ${cssRules.length} 条`);
    }
  }

  loadRule(filePath) {
    const src = fs.readFileSync(filePath, 'utf-8');
    const { utilsByBase, warnings, customValidators } = parseRuleRules(src, filePath);
    // 合并自定义验证器
    if (customValidators) Object.assign(this.customValidators, customValidators);
    for (const [bn, vars] of utilsByBase) {
      if (this.utilsByBase.has(bn)) {
        const ex = this.utilsByBase.get(bn);
        for (const v of vars) {
          const di = ex.findIndex(e => e.paramCount === v.paramCount);
          if (di !== -1) ex[di] = v; else ex.push(v);
        }
        ex.sort((a, b) => b.paramCount - a.paramCount);
      } else this.utilsByBase.set(bn, vars);
    }
    this.warnings.push(...warnings);
    if (this.opts.verbose) {
      let tu = 0; for (const [, v] of utilsByBase) tu += v.length;
      console.log(`[FTW] 加载 Rule: ${filePath}\n  - 工具类变体: ${tu} 个`);
    }
  }

  compile(htmlFiles = []) {
    const required = new Set();
    if (htmlFiles.length > 0) {
      for (const hf of htmlFiles) {
        const html = fs.readFileSync(hf, 'utf-8');
        const { matched, unmatched } = analyzeHTML(html, this.utilsByBase, this.keyframes, this.customValidators);
        for (const [c] of matched) { required.add(c); this.usedClasses.add(c); }
        for (const c of unmatched) { if (!this.cssSelectors.has(c)) this.unmatchedClasses.push(c); }
        if (this.opts.verbose) console.log(`[FTW] 分析 HTML: ${hf}\n  - 匹配: ${matched.size} 个\n  - 未匹配: ${this.unmatchedClasses.length} 个`);
      }
    } else {
      if (this.opts.verbose) console.log('[FTW] 无 HTML 文件，仅编译无参数工具类 + CSS 规则');
      for (const [bn, vars] of this.utilsByBase) {
        for (const v of vars) {
          if (v.template && v.paramCount === 0) { required.add(bn); this.usedClasses.add(bn); }
        }
      }
    }

    const parts = [];
    for (const [name, body] of this.keyframes) parts.push(`@keyframes ${name} {\n${indent(body, 2)}\n}`);

    const compiled = new Map();
    for (const c of required) {
      const r = resolveClass(c, this.utilsByBase, this.keyframes, this.customValidators);
      if (r.matched && r.css) compiled.set(c, r.css);
    }
    const cssToClasses = new Map();
    for (const [c, css] of compiled) {
      if (!cssToClasses.has(css)) cssToClasses.set(css, []);
      cssToClasses.get(css).push(c);
    }
    for (const [css, classes] of cssToClasses) {
      const selector = classes.map(c => '.' + escapeCSSClass(c)).join(',\n  ');
      const rule = `${selector} {\n${normalizeCSSOutput(css, 2)}\n}`;
      parts.push(rule);
      for (const c of classes) {
        this.mapData[c] = rule;
      }
    }

    for (const rule of this.cssRules) {
      const eb = expandApply(rule.body, this.utilsByBase, this.keyframes, this.customValidators);
      parts.push(`${rule.selector} {\n${normalizeCSSOutput(eb, 2)}\n}`);
    }

    this.compiledCSS = parts.join('\n\n');
    return this.compiledCSS;
  }

  processHTML(hf, inlineCSS = null) {
    const html = fs.readFileSync(hf, 'utf-8');
    const r = compileHTML(html, this.utilsByBase, this.keyframes, {
      mode: this.opts.mode,
      customValidators: this.customValidators
    });
    let result = r.html;
    // 内联模式: 将编译后的 CSS 以 <style> 标签注入到 </head> 之前
    if (inlineCSS) {
      const styleTag = `<style>\n/* FTW compiled */\n${inlineCSS}\n</style>`;
      if (result.includes('</head>')) {
        result = result.replace('</head>', `  ${styleTag}\n</head>`);
      } else if (result.includes('<body')) {
        result = result.replace('<body', `${styleTag}\n<body`);
      } else {
        result = styleTag + '\n' + result;
      }
    }
    for (const c of r.unusedClasses) {
      if (!this.cssSelectors.has(c) && !this.unmatchedClasses.includes(c)) this.unmatchedClasses.push(c);
    }
    return result;
  }

  /** 生成 ftw-map.json 内容 */
  generateMap() {
    return this.mapData;
  }

  writeMap(mapPath) {
    if (!mapPath) return null;
    const d = path.dirname(mapPath);
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    const json = JSON.stringify(this.mapData, null, 2);
    fs.writeFileSync(mapPath, json);
    if (this.opts.verbose) console.log(`[FTW] Map → ${mapPath}`);
    return mapPath;
  }

  writeOutput(cssPath, htmlOutputs = [], mapPath = null) {
    if (cssPath) {
      const d = path.dirname(cssPath);
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(cssPath,
        `/* Generated by FTW Compile-Time | ${new Date().toISOString()} | Keyframes: ${this.keyframes.size} | Utils: ${this.usedClasses.size} */\n\n` + this.compiledCSS);
      if (this.opts.verbose) console.log(`[FTW] CSS → ${cssPath}`);
    }
    for (const { inputPath, outputPath, html } of htmlOutputs) {
      if (outputPath) {
        const d = path.dirname(outputPath);
        if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(outputPath, html);
        if (this.opts.verbose) console.log(`[FTW] HTML → ${outputPath}`);
      }
    }
    if (mapPath) this.writeMap(mapPath);
    if (this.warnings.length > 0) { console.warn('\n[FTW] 警告:'); for (const w of this.warnings) console.warn(`  ⚠ ${w}`); }
    const uniq = [...new Set(this.unmatchedClasses)];
    if (uniq.length > 0) { console.warn(`\n[FTW] 未匹配类名 (${uniq.length} 个):`); for (const c of uniq) console.warn(`  ? .${c}`); }
  }

  debug() {
    const r = [];
    for (const c of this.usedClasses) {
      const x = resolveClass(c, this.utilsByBase, this.keyframes, this.customValidators);
      r.push({ class: c, css: x.css || '(无)', matched: x.matched, ruleKey: x.ruleKey, params: x.params });
    }
    return r;
  }

  inspect(classes) {
    const r = {};
    for (const c of classes) {
      const x = resolveClass(c, this.utilsByBase, this.keyframes, this.customValidators);
      r[c] = { matched: x.matched, css: x.css || null, ruleKey: x.ruleKey, params: x.params,
        hasRule: this.utilsByBase.has(x.ruleKey) || this.keyframes.has(x.ruleKey), isCSSSelector: this.cssSelectors.has(c) };
    }
    return r;
  }

  stats() {
    let tu = 0; for (const [, v] of this.utilsByBase) tu += v.length;
    return { keyframes: this.keyframes.size, utils: tu, cssRules: this.cssRules.length,
      cssSelectors: this.cssSelectors.size, compiledClasses: this.usedClasses.size,
      unmatchedClasses: this.unmatchedClasses.length, warnings: this.warnings.length,
      mapEntries: Object.keys(this.mapData).length };
  }
}

// ══════════════════════════════════════════════════════════════
//  6. CLI
// ══════════════════════════════════════════════════════════════

function parseArgs(args) {
  const o = { fssFiles: [], ruleFiles: [], htmlFiles: [], cssOutput: null, htmlOutputs: [],
    outputDir: null, mapOutput: null, mode: 'preserve', inline: false, debug: false, inspect: null, verbose: false, watch: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      // 文件名 (短别名)
      case '-f': if (args[i+1]) o.fssFiles.push(args[++i]); break;
      case '-r': if (args[i+1]) o.ruleFiles.push(args[++i]); break;
      case '-ht': if (args[i+1]) o.htmlFiles.push(args[++i]); break;
      case '-c': if (args[i+1]) o.cssOutput = args[++i]; break;
      case '-ho': if (args[i+1]) o.htmlOutputs.push(args[++i]); break;
      case '-o': if (args[i+1]) o.outputDir = args[++i]; break;
      case '-m': if (args[i+1]) o.mode = args[++i]; break;
      case '-map': if (args[i+1]) o.mapOutput = args[++i]; break;
      case '-d': o.debug = true; break;
      case '-i': if (args[i+1]) o.inspect = args[++i].split(/[\s,]+/).filter(Boolean); break;
      case '-v': o.verbose = true; break;
      case '-in': o.inline = true; break;
      case '-w': o.watch = true; break;
      case '-h': o.help = true; break;
      // 长别名 (兼容)
      case '-fss': case '--fss': if (args[i+1]) o.fssFiles.push(args[++i]); break;
      case '-rule': case '--rule': if (args[i+1]) o.ruleFiles.push(args[++i]); break;
      case '-html': case '--html': if (args[i+1]) o.htmlFiles.push(args[++i]); break;
      case '-css': case '--css': if (args[i+1]) o.cssOutput = args[++i]; break;
      case '-html-out': case '-html-output': case '--html-out': case '--html-output': if (args[i+1]) o.htmlOutputs.push(args[++i]); break;
      case '-output': case '--output': if (args[i+1]) o.outputDir = args[++i]; break;
      case '-mode': case '--mode': if (args[i+1]) o.mode = args[++i]; break;
      case '-debug': case '--debug': o.debug = true; break;
      case '-inspect': case '--inspect': if (args[i+1]) o.inspect = args[++i].split(/[\s,]+/).filter(Boolean); break;
      case '-verbose': case '--verbose': o.verbose = true; break;
      case '-watch': case '--watch': o.watch = true; break;
      case '-inline': case '--inline': o.inline = true; break;
      case '-help': case '--help': o.help = true; break;
      default:
        // 自动检测文件类型
        if (a.endsWith('.fss')) o.fssFiles.push(a);
        else if (a.endsWith('.json')) o.ruleFiles.push(a);
        else if (a.endsWith('.html')||a.endsWith('.htm')) o.htmlFiles.push(a);
    }
  }
  return o;
}

function showHelp() {
  console.log(`
FTW Compile-Time — 编译时 CSS 工具类处理器

用法:  ftw -f <file.fss> [选项]

选项:
  -f <file>         .fss 样式文件 (可多次指定)
  -r <file>         .rule 规则文件, 可选 (可多次指定)
  -ht <file>        .html 输入文件, 可选 (可多次指定)
  -c <file>         输出 CSS 文件路径
  -ho, -html-output <file>  输出 HTML 文件路径 (与 -ht 一一对应)
  -o <dir>          输出目录
  -map <file>       输出 ftw-map.json 映射文件
  -m <mode>         preserve (默认) | strip | keep | remove-unmatched
  -in, -inline      CSS 内联模式，编译后的 CSS 以 <style> 标签注入 HTML
  -d                ftw.debug: 输出所有类名→CSS 映射
  -i <classes>      ftw.inspect: 检查指定类名的解析结果
  -v                详细输出
  -w                监听文件变化
  -h                显示帮助

编译管线:  .fss (@ftw-keyframes + @ftw-util + CSS) + .rule (可选) + .html (可选) = CSS + HTML + ftw-map.json

HTML 处理:
  preserve (默认) — 保留所有 class 不变，仅生成 CSS + 映射文件，运行时靠 ftw.js 跳过已编译类名
  strip — 匹配到的工具类名从元素 class 中删除，CSS 写入编译文件
  keep — 保留所有 class 属性不变
  remove-unmatched — 移除未匹配的类名

示例:
  ftw -f styles.fss -ht index.html -c out.css -ho out.html -map ftw-map.json
  ftw -f styles.fss -ht index.html -in -ho out.html
  ftw -f styles.fss -i "p:4 mx:auto flex"
  ftw -f styles.fss -ht index.html -d
  ftw -f styles.fss -r rules.json -ht index.html -o dist/ -w
`);
}

function run(opts) {
  const c = new FTWCompiler({ mode: opts.mode, verbose: opts.verbose, debug: opts.debug });
  for (const f of opts.fssFiles) { if (!fs.existsSync(f)) { console.error(`[FTW] 文件不存在: ${f}`); process.exit(1); } c.loadFSS(f); }
  for (const f of opts.ruleFiles) { if (!fs.existsSync(f)) { console.error(`[FTW] 文件不存在: ${f}`); process.exit(1); } c.loadRule(f); }

  const hp = opts.htmlFiles.filter(f => fs.existsSync(f));
  c.compile(hp);

  const ho = [];
  for (let i = 0; i < hp.length; i++) {
    const ch = c.processHTML(hp[i], opts.inline ? c.compiledCSS : null);
    let op;
    if (opts.htmlOutputs[i]) op = opts.htmlOutputs[i];
    else if (opts.outputDir) op = path.join(opts.outputDir, path.basename(hp[i]).replace(/\.html?$/, '.compiled.html'));
    else op = hp[i].replace(/\.html?$/, '.compiled.html');
    ho.push({ inputPath: hp[i], outputPath: op, html: ch });
  }

  let cp = opts.cssOutput;
  if (opts.inline) {
    cp = null;  // 内联模式不输出独立 CSS 文件
  } else {
    if (!cp && opts.outputDir) cp = path.join(opts.outputDir, path.basename(opts.fssFiles[0], '.fss') + '.compiled.css');
    else if (!cp) cp = path.join(path.dirname(opts.fssFiles[0]), path.basename(opts.fssFiles[0], '.fss') + '.compiled.css');
  }

  c.writeOutput(cp, ho, opts.mapOutput);

  const s = c.stats();
  console.log(`\n[FTW] 编译完成! | 关键帧:${s.keyframes} | 工具类:${s.utils} | CSS规则:${s.cssRules} | 编译类名:${s.compiledClasses} | 映射:${s.mapEntries} | 未匹配:${s.unmatchedClasses} | 警告:${s.warnings}`);
  if (opts.inline) {
    console.log('  CSS  (内联到 HTML)');
  } else {
    console.log(`  CSS  → ${cp}`);
  }
  for (const h of ho) console.log(`  HTML → ${h.outputPath}`);
  if (opts.mapOutput) console.log(`  Map  → ${opts.mapOutput}`);

  if (opts.debug) {
    const di = c.debug();
    console.log(`\n[FTW.debug] 类名→CSS 映射 (${di.length} 条):\n${'─'.repeat(60)}`);
    for (const item of di) {
      console.log(`  .${item.class}\n    → ${item.css}`);
      if (item.ruleKey && item.ruleKey !== item.class) console.log(`    (规则: ${item.ruleKey}, 参数: [${item.params.join(', ')}])`);
    }
    console.log('─'.repeat(60));
  }

  if (opts.inspect) {
    const ir = c.inspect(opts.inspect);
    console.log(`\n[FTW.inspect] 类名检查:\n${'─'.repeat(60)}`);
    for (const [cls, info] of Object.entries(ir)) {
      console.log(`  ${info.matched ? '✓' : '✗'} .${cls}\n    匹配: ${info.matched}\n    CSS:  ${info.css || '(无)'}\n    规则: ${info.ruleKey || '(无)'}\n    参数: [${info.params.join(', ')}]\n    已注册: ${info.hasRule}\n`);
    }
    console.log('─'.repeat(60));
  }
}

function watchMode(opts) {
  const files = [...opts.fssFiles, ...opts.ruleFiles, ...opts.htmlFiles].filter(f => fs.existsSync(f));
  console.log(`[FTW] 监听 ${files.length} 个文件... (Ctrl+C 退出)\n`);
  run(opts);
  const timers = new Map();
  for (const f of files) {
    fs.watch(f, (ev) => {
      if (ev === 'change') {
        if (timers.has(f)) clearTimeout(timers.get(f));
        timers.set(f, setTimeout(() => { console.log(`\n[FTW] 文件变化: ${f}`); run(opts); timers.delete(f); }, 300));
      }
    });
  }
}

// ── 入口 ──
const opts = parseArgs(process.argv.slice(2));
if (opts.help) { showHelp(); process.exit(0); }
if (opts.fssFiles.length === 0) { console.error('[FTW] 错误: 至少需要指定 -f <文件>。 -h 查看帮助'); process.exit(1); }
opts.watch ? watchMode(opts) : run(opts);