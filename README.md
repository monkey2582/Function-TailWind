FTW - Function-TailWind

*原子化 CSS 库*

![Lincense-MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![version-7.0.0](https://img.shields.io/badge/version-7.0.0-blue)

FTW 是一个轻量级、高性能的原子化 CSS 工具库，补齐 Tailwind CSS 短板，更灵活、更精简。它允许你通过注册自定义工具类或使用内置工具，直接在 HTML 元素上应用样式，无需编写传统 CSS 文件。FTW 可搭配 Tailwind 使用，也可完全独立运行。

---

特性

· 🪶 极轻 – 核心压缩后 < 15KB，无外部依赖
· ⚡ 高性能 – 基于 MutatonObserver 自动处理 DOM 变化，支持手动暂停/恢复
· 🧩 灵活注册 – 通过 JavaScript 或 CSS @ftw-util 自定义工具类，支持参数和逻辑
· 📦 按需生成 – 仅生成实际使用的样式，垃圾回收未使用类
· 🛠️ 开发者友好 – 调试输出、忽略元素、手动更新等实用 API
· 🔗 无缝集成 – 支持 @apply 语法，兼容 Tailwind 生态

---

快速开始

安装

CDN (推荐)：

```html
<script src="https://cdn.jsdelivr.net/gh/monkey2582/Function-TailWind@main/ftw.min.js"></script>
```

ES Module：

```javascript
import ftw from 'ftw';
```

使用示例

在 HTML 中直接使用工具类：

```html
<div class="text-blue bg-gray-100 p-4 m-2 fs-16 shadow-sm">
  欢迎使用 ftw！
</div>
```

注册自定义工具（在 <script> 中）：

```javascript
ftw.util({
  'text:str': (color) => `color:${color};`,
  'm:num': (size) => `margin:${size * 4}px;`,
  'fs:num': (size) => `font-size:${size}px;`,
  'shadow:str': (type) => {
    const shadows = {
      sm: '0 1px 2px rgba(0,0,0,0.1)',
      lg: '0 10px 15px rgba(0,0,0,0.1)',
    };
    return `box-shadow:${shadows[type] || 'none'};`;
  },
});
```

现在上面 div 的样式会自动生效。

---

核心概念

工具类命名规则

格式：基础名:类型1:类型2:...

· str – 字符串参数（如颜色名、尺寸关键字）
· num – 数字参数（自动转为 Number）

示例：

· text:str → 匹配 text-red、text-blue
· m:num → 匹配 m-4、m-8
· rounded:str:num → 匹配 rounded-lg-4

参数提取与类型转换

类名中的参数按顺序提取，num 类型自动转为数字，方便运算。

⚠️ 重要：在 @ftw-util 表达式中，必须使用 props[0]、props[1] 访问参数，不能使用 {0}（{0} 是数字字面量，不代表参数值）。

---

API 文档

1. 注册工具类 ftw.util

方式一：JavaScript 对象（推荐复杂逻辑）

```javascript
ftw.util({
  // 无参数
  'reset': () => 'margin:0;padding:0;',
  // 单字符串参数
  'bg:str': (color) => `background:${color};`,
  // 单数字参数（可运算）
  'p:num': (pad) => `padding:${pad * 4}px;`,
  // 多参数混合
  'border:str:num': (style, width) => `border:${width}px ${style} black;`,
  // 条件逻辑
  'flex:str': (dir) => {
    const direction = dir === 'row' ? 'row' : 'column';
    return `display:flex;flex-direction:${direction};`;
  },
  // 支持 !important
  'text:str': (color) => `color:${color} !important;`,
});
```

方式二：CSS @ftw-util（批量定义）

在 <style ftw-render> 或外部 CSS 中：

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

@ftw-util bg {
  background: {props[0]} !imp;   /* !imp 转为 !important */
}
```

参数索引映射（idxOrder）：
当生成器参数顺序与类名参数顺序不一致时，可指定顺序：

```javascript
ftw.util({
  'bg:str:num': (opacity, color) => 
    `background:rgba(${color}, ${opacity/100});`,
}, { idxOrder: [1, 0] });
// 类名 bg-red-50 → 参数 [red, 50] 映射为生成器的 (opacity=50, color=red)
```

---

2. 应用工具类 ftw()

手动将工具类应用到元素或选择器：

```javascript
// 单个元素
const el = document.querySelector('.my-div');
ftw(el, 'text-red', 'm-4', 'p-2');

// 选择器匹配的所有元素
ftw('.button', 'bg-blue', 'text-white', 'rounded');

// 直接写 CSS 规则块
ftw('.card', `
  background: white;
  box-shadow: 0 2px 4px rgba(0,0,0,0.1);
`);
```

---

3. 渲染样式表 ftw.render

解析 <style ftw-render> 或 <link ftw-render> 中的 @ftw-util、@apply 等语法：

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
ftw.render('style#my-style');
ftw.render(document.querySelector('style'));
```

---

4. 加载工具脚本 ftw.use

加载 <script ftw-utils> 中的注册代码：

```html
<script ftw-utils>
{
  "text:str": (c) => `color:${c};`,
  "m:num": (s) => `margin:${s*4}px;`
}
</script>
```

手动加载：

```javascript
ftw.use('script[ftw-utils]');
ftw.use(document.querySelector('script'));
```

---

5. DOM 扫描与更新

· 自动处理：默认使用 MutationObserver 监听 DOM 变化。
· 手动更新：

```javascript
ftw.update();                    // 重新扫描整个文档
ftw.update('.container');        // 扫描指定子树
```

· 暂停/恢复：

```javascript
ftw.pause();    // 暂停自动处理
ftw.resume();   // 恢复并立即扫描
```

· 一次性扫描：ftw.once(); – 扫描一次后自动暂停（适合静态页面）。

---

6. 垃圾回收 ftw.gc

移除所有未在 DOM 中使用的工具类对应的 CSS 规则，释放内存：

```javascript
ftw.gc();
```

---

7. 调试工具 ftw.debug

在控制台打印所有已注册且正在使用的工具类及生成的 CSS：

```javascript
ftw.debug();
```

---

8. 忽略 / 取消忽略元素

让 ftw 跳过特定元素及其子元素：

```javascript
ftw.ignore(document.getElementById('no-ftw'));
ftw.ignore('.static-content');   // 选择器

ftw.unignore('.static-content');
```

---

高级用法

@apply 指令

在 CSS 规则中复用工具类：

```css
.btn-primary {
  bg-blue text-white rounded p-2;
}
```

!important 支持

· 类名后加 !imp：text-red!imp
· 在 @ftw-util 值中使用 !imp

动画（@keyframes）支持

ftw 支持标准 @keyframes 和自定义 @ftw-keyframes，并可通过工具类应用动画。

```css
@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

@ftw-keyframes bounce:num {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY({props[0]}px); }
}
```

然后在元素上使用动画名称作为类名（如 fadeIn）即可应用。

动态注册动画工具：也可以通过 ftw.util 注册返回 animation: name 1s; 的工具。

---

完整示例

注册工具（script.js）：

```javascript
ftw.util({
  'fs:num': (size) => `font-size:${size}px;`,
  'text:str': (color) => `color:${color};`,
  'bg:str': (bg) => `background:${bg};`,
  'p:num': (pad) => `padding:${pad}px;`,
  'm:num': (mar) => `margin:${mar}px;`,
});
```

HTML：

```html
<div class="fs-16 text-blue bg-gray-100 p-4 m-2 shadow-sm">
  博客内容
</div>
```

使用 @ftw-util 动态工具（可选）：

```css
<style ftw-render>
@ftw-util shadow:str {
  box-shadow: {props[0] === 'sm' ? '0 1px 2px rgba(0,0,0,0.1)' :
               props[0] === 'lg' ? '0 10px 15px rgba(0,0,0,0.1)' :
               '0 4px 6px rgba(0,0,0,0.1)'};
}
</style>
```

---

**常见问题**

**Q：** 注册工具后不生效？  
- **A：** 确认 ftw 已加载，注册代码在 DOM 加载后执行，或调用 ftw.update() 强制刷新。

**Q：** 如何让工具类支持 !important？  
- **A：** 在类名后加 !imp（如 text-red!imp），或在生成器中直接写 !important。

**Q：** @ftw-util 中为什么必须用 props[0]？  
- **A：** 因为 {0} 是数字字面量，不会替换为参数值；props[0] 才是真正的参数变量。

**Q：** 如何提升大型页面性能？  
- **A：** 使用 ftw.pause() 在批量操作前暂停自动处理，完成后 resume()。对静态区域使用 ftw.ignore()。

**Q：** 能否动态卸载工具类？  
- **A:** 目前不支持直接卸载，但可通过 ftw.gc() 清理未使用的类，并重新注册覆盖。

**Q：** 如何处理动画工具？  
- **A：** 你可以注册一个 @keyframes 就像普通 CSS 那样定义，或者在 FSS 中定义 @ftw-keyframes，然后在元素上直接使用动画名称作为类名（ftw 会自动识别并生成 animation 样式）。

**Q：** @ftw-keyframes 和普通 @keyframes 有什么区别？  
- **A：** @ftw-keyframes 相当于一个工具，你可以通过:num，:str加载名字后面定义传参类型，就像使用普通 ftw-util 一样使用大括号语法，并且可以使用动画名称作为类名执行对应的动画效果，而普通 @keyframes 则完全没有这些能力。

---

贡献与许可

· 贡献：欢迎提交 Issue 和 PR，请遵循项目编码规范。  
· 许可：本项目使用 [MIT](LICENSE) 开源协议。
