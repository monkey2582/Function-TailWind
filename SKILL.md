---
name: ftw-skill
description: 指导 AI 使用 ftw 原子化 CSS 库的全部功能，包括工具注册（ftw.util）、动态应用类、渲染、更新、垃圾回收等，支持 @ftw-util 语法。
---

# ftw 原子化 CSS 库完整技能指南

## 概述

`ftw` 是一个轻量级、高性能的原子化 CSS 工具库，类似于 Tailwind 但更加灵活，可搭配 TailWind 使用。它允许你通过 **注册自定义工具类** 或 **使用内置工具**，将样式直接绑定到 HTML 元素的 class 上，无需编写传统 CSS 文件。

本技能涵盖 ftw 的 **全部核心功能**，指导 AI 根据用户需求，正确使用以下 API：

- **`ftw.util`** – 注册自定义工具类（支持 `str`/`num` 参数、生成器函数或 CSS `@ftw-util` 语法）
- **`ftw()`** – 直接应用工具类到元素或选择器
- **`ftw.render`** – 解析并应用 `<style ftw-render>` 或 `<link ftw-render>` 中的 CSS
- **`ftw.use`** – 加载并执行 `<script ftw-utils>` 中的工具注册代码
- **`ftw.update`** – 手动重新扫描 DOM 并应用新类
- **`ftw.pause` / `ftw.resume`** – 暂停/恢复自动类处理（用于性能优化）
- **`ftw.once`** – 一次性扫描并处理，之后暂停
- **`ftw.gc`** – 垃圾回收未使用的工具类
- **`ftw.debug`** – 输出所有已生成的工具类与 CSS
- **`ftw.ignore` / `ftw.unignore`** – 忽略或取消忽略特定元素

同时支持在 CSS 中使用 **`@ftw-util`** 批量注册工具，以及 **`@apply`** 复用工具类。

---

## 快速开始

在页面中引入 `ftw.min.js` 后，全局对象 `ftw` 即可使用：

```html
<script src="./ftw.min.js"></script>
```

ftw 会自动监听 DOM 变化，处理带有工具类名的元素。你也可以手动调用 API 进行控制。

---

核心概念

工具类命名规则

· 工具由 基础名 和可选的 参数类型声明 组成，格式：基础名:类型1:类型2:...
· 类型声明：
  · str – 字符串参数（如颜色名、尺寸关键字）
  · num – 数字参数（如像素值、比例），会自动转为 Number
· 示例：
  · text:str → 匹配 text-red、text-blue 等
  · m:num → 匹配 m-4、m-8 等
  · rounded:str:num → 匹配 rounded-lg-4（两个参数）

参数提取与类型转换

· 从类名中提取参数，例如 text-red → 参数 "red"
· 声明为 num 的参数会自动转为数字，便于运算

props[0] 与 {0} 的区别（⚠️ 关键）

· props[0] – 真正的 JavaScript 变量，代表第一个参数值，可参与运算（如 props[0] * 2）
· {0} – 数字字面量，会被直接替换为数字 0，不能用于参数运算（{0*5} 永远为 0）

结论：在 @ftw-util 表达式中，始终使用 props[0]、props[1] 等访问参数。

---

一、注册自定义工具类（ftw.util）

方式一：使用 ftw.util 对象（适用于复杂逻辑）

```javascript
ftw.util({
  // 无参数工具
  'reset': () => 'margin:0;padding:0;',

  // 单参数（字符串）
  'text:str': (color) => `color:${color};`,

  // 单参数（数字），可运算
  'm:num': (size) => `margin:${size * 4}px;`,

  // 多参数（混合）
  'rounded:str:num': (radius, size) => `border-radius:${radius}-${size}px;`,

  // 条件逻辑
  'flex:str': (direction) => {
    const dir = direction === 'row' ? 'row' : 'column';
    return `display:flex;flex-direction:${dir};`;
  },

  // 使用 !important
  'bg:str': (color) => `background:${color} !important;`,
});
```

特点：

· 生成器函数参数直接对应类名中的参数（按顺序）
· 函数体内可使用任意 JavaScript，返回 CSS 字符串
· 支持多个样式属性

方式二：使用 CSS @ftw-util 语法（适合批量定义）

在 <style> 或 <link> 中编写：

```css
@ftw-util text {
  color: {props[0]};
}

@ftw-util m {
  margin: calc({props[0] * 4}px);
}

@ftw-util rounded {
  border-radius: {props[0] - props[1] + 'px'};
}

@ftw-util p {
  padding: {props[0] > 10 ? props[0] + 'px' : '10px'};
}

@ftw-util bg {
  background: {props[0]} !imp;  /* !imp 会被替换为 !important */
}
```

关键点：

· 大括号内是 JavaScript 表达式，通过 props[0] 访问参数
· 支持运算、三元、字符串拼接等
· !imp 会被转换为 !important

参数索引映射（idxOrder）

如果生成器函数的参数顺序与类名中的顺序不同，可指定 idxOrder（仅对象方式）：

```javascript
ftw.util({
  // 工具名 `bg:str:num` 预期类名如 `bg-red-50`（color=red, opacity=50）
  // 但生成器期望 (opacity, color)
  'bg:str:num': (opacity, color) => `background:rgba(${color}, ${opacity/100});`,
}, { idxOrder: [1, 0] }); // 将类名第1个参数映射到生成器第0个参数
```

---

二、应用工具类到元素（ftw()）

ftw 本身是一个函数，可以手动将工具类应用到元素或选择器。

基本用法

```javascript
// 应用到单个元素
const el = document.querySelector('.my-div');
ftw(el, 'text-red', 'm-4', 'p-2');

// 应用到选择器匹配的所有元素
ftw('.button', 'bg-blue', 'text-white', 'rounded');

// 也支持 CSS 规则块（带大括号）
ftw('.card', `
  background: white;
  box-shadow: 0 2px 4px rgba(0,0,0,0.1);
`);
```

参数说明：

· 第一个参数：元素、选择器字符串或元素数组
· 后续参数：工具类名（字符串）或 CSS 声明（如 'background:red;'）
· 如果传入 CSS 规则块，ftw 会将其作为内联样式注入（自动生成类名）

---

三、渲染样式表（ftw.render）

处理带有 ftw-render 属性的 <style> 或 <link> 元素，解析其中的 @ftw-util、@apply 等语法。

```html
<style ftw-render>
  @ftw-util shadow-sm {
    box-shadow: 0 1px 2px rgba(0,0,0,0.1);
  }

  .btn {
    bg-blue text-white rounded p-2;
  }
</style>
```

手动调用：

```javascript
ftw.render('style#my-style');   // 按选择器
ftw.render(document.querySelector('style')); // 传入元素
```

支持的语法：

· @ftw-util – 注册工具类
· @apply – 在 CSS 规则中复用工具类（相当于将类展开）
· 支持 !imp 简写

---

四、加载工具注册脚本（ftw.use）

加载包含 ftw.util 注册代码的脚本（<script ftw-utils>）。

```html
<script ftw-utils>
{
  "text:str": (c) => `color:${c};`,
  "m:num": (s) => `margin:${s*4}px;`
}
</script>
```

手动调用：

```javascript
ftw.use('script[ftw-utils]');
ftw.use(document.querySelector('script'));
```

注意： 脚本内容可以是 JSON 对象（自动解析）或 JavaScript 代码（直接执行）。

---

五、DOM 扫描与更新

自动处理

ftw 默认使用 MutationObserver 监听 DOM 变化，自动为新增元素应用工具类。你可以通过 ftw.pause() / ftw.resume() 控制。

手动更新

```javascript
ftw.update();          // 重新扫描整个文档
ftw.update('.container'); // 只扫描匹配选择器的子树
```

暂停与恢复

```javascript
ftw.pause();   // 停止自动处理
ftw.resume();  // 恢复自动处理，并立即扫描当前 DOM
```

一次性扫描

```javascript
ftw.once();    // 扫描一次后自动暂停（适用于静态页面）
```

---

六、垃圾回收（ftw.gc）

移除所有未在 DOM 中使用的工具类对应的 CSS 规则，释放内存。

```javascript
ftw.gc();
```

通常在动态页面中，当大量类被替换后调用，以清理无用样式。

---

七、调试工具（ftw.debug）

在控制台打印所有已注册且正在使用的工具类及其生成的 CSS。

```javascript
ftw.debug();
// 输出表格：class -> css
```

---

八、忽略 / 取消忽略元素（ftw.ignore / ftw.unignore）

让 ftw 跳过特定元素及其子元素，不处理其中的工具类。

```javascript
// 忽略单个元素
ftw.ignore(document.getElementById('no-ftw'));

// 忽略匹配选择器的所有元素
ftw.ignore('.static-content');

// 取消忽略
ftw.unignore('.static-content');
```

---

九、高级 CSS 特性

@apply 指令

在 CSS 规则中引用工具类，将类展开为对应的样式属性。

```css
.btn-primary {
   bg-blue text-white rounded p-2;
}
```

!important 支持

· 在类名后加 !imp 使整条样式提升为 !important，例如 text-red!imp
· 在 @ftw-util 生成的值中使用 !imp 后缀

动画（@keyframes）支持

ftw 支持标准 @keyframes 和自定义 @ftw-keyframes，并可通过工具类应用动画。

```css
@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

@ftw-keyframes bounce {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-20px); }
}
```

然后在元素上使用动画名称作为类名（如 fadeIn）即可应用。
动态注册动画工具：也可以通过 ftw.util 注册返回 animation: name 1s; 的工具。

---

十、完整示例：综合应用

需求

为一个博客页面注册工具类，并应用样式。

步骤

1. 注册工具类（使用 ftw.util）

```javascript
ftw.util({
  'fs:num': (size) => `font-size:${size}px;`,
  'text:str': (color) => `color:${color};`,
  'bg:str': (bg) => `background:${bg};`,
  'p:num': (pad) => `padding:${pad}px;`,
  'm:num': (mar) => `margin:${mar}px;`,
});
```

2. 在 HTML 中使用

```html
<div class="fs-16 text-blue bg-gray-100 p-4 m-2">
  博客内容
</div>
```

3. 如果需要响应式或复杂逻辑，使用 @ftw-util

```css
<style ftw-render>
@ftw-util shadow:str {
  box-shadow: {props[0] === 'sm' ? '0 1px 2px rgba(0,0,0,0.1)' :
              props[0] === 'lg' ? '0 10px 15px rgba(0,0,0,0.1)' :
              '0 4px 6px rgba(0,0,0,0.1)'};
}
</style>
```

4. 手动应用类到动态元素

```javascript
const newDiv = document.createElement('div');
newDiv.className = 'fs-20 text-red';
document.body.appendChild(newDiv);
ftw.update(); // 或自动处理
```

---

**常见问题**

**Q：** 工具注册后不生效？  
- **A：** 确保 ftw.min.js 已加载，且注册代码在 DOM 加载后执行（或在 ftw.update() 之前）。如果使用 <script ftw-utils>，需用 ftw.use() 加载。

**Q：** 如何让工具类支持 !important？  
- **A：** 在类名后加 !imp（如 text-red!imp），或在生成器中直接写 !important。

**Q：** @ftw-util 中的表达式为什么必须用 props[0]？  
- **A：** 因为 {0} 是数字字面量，不会替换为参数值，而 props[0] 才是真正的参数变量。

**Q：** 如何提高性能？  
- **A：** 使用 ftw.pause() 在批量操作前暂停自动处理，操作完成后 ftw.resume()。对于静态区域，可使用 ftw.ignore() 跳过处理。

**Q：** 能否动态卸载工具？  
- **A：** 目前不支持直接卸载，但可通过 ftw.gc() 清理未使用的类，并重新注册覆盖。

**Q：** 如何处理动画工具？  
- **A：** 你可以注册一个 @keyframes 就像普通 CSS 那样定义，或者在 FSS 中定义 @ftw-keyframes，然后在元素上直接使用动画名称作为类名（ftw 会自动识别并生成 animation 样式）。

**Q：** @ftw-keyframes 和普通 @keyframes 有什么区别？  
- **A:** @ftw-keyframes 相当于一个工具，你可以通过:num，:str加载名字后面定义传参类型，就像使用普通 ftw-util 一样使用大括号语法，并且可以使用动画名称作为类名执行对应的动画效果，而普通 @keyframes 则完全没有这些能力。

---

通过遵循本指南，AI 可以为用户提供 ftw 全功能的代码生成、配置和调试支持，实现高效、灵活的原子化样式管理。