FTW – Function TailWind

一个极轻量的运行时原子 CSS 引擎，让你像写 Tailwind 一样写类名，却无需任何构建工具。

✨ 特性

· ⚡️ 极致轻量 – 压缩后仅 ~5KB，无任何依赖，对性能敏感的项目极度友好。
· 🧩 完全自定义 – 通过简单的正则 + 函数，完全控制类名到 CSS 的映射规则。
· 🔄 动态解析 – 自动监听 DOM 变化，实时处理新增元素的类名，无需手动刷新。
· 📦 零配置起步 – 只需引入脚本，即可通过 ftw.util() 注册你的设计系统。
· 🎨 Tailwind 风格 – 支持 grid-cols-3、gap-4 这类参数化类名，写法优雅自然。

🔧 安装

使用 jsDelivr CDN（推荐）

```html
<script src="https://cdn.jsdelivr.net/gh/monkey2582/Function-TailWind@1.0.0/ftw.min.js"></script>
```

或者下载到本地

```bash
# 如果已发布到 npm（可选）
npm install ftw
```

或者直接下载 ftw.min.js 文件放在项目中。

🚀 快速开始

```html
<!DOCTYPE html>
<html>
<head>
  <script src="https://cdn.jsdelivr.net/gh/monkey2582/Function-TailWind@1.0.0/ftw.min.js"></script>
  <script>
    // 注册规则：将类名 "text-颜色-浓度" 映射为 CSS 颜色
    ftw.util({
      'text-(\\w+)-(\\d+)': (color, shade) => `color: ${color}; opacity: ${shade/100};`,
      'grid-cols-(\\d+)': (n) => `grid-template-columns: repeat(${n}, minmax(0, 1fr));`,
      'w-(\\d+)/(\\d+)': (a, b) => `width: ${(a/b)*100}%;`
    });
  </script>
</head>
<body>
  <div class="grid-cols-3 text-blue-500 w-1/2">
    内容会自动应用样式
  </div>
</body>
</html>
```

💡 库会自动扫描页面上的所有元素，匹配注册的类名并动态生成对应的 CSS 规则。

📚 API

ftw.util(config)

注册或批量注册规则。

参数：

· config – 对象，键为类名匹配模式（支持正则字符串），值为 CSS 生成器（函数或字符串模板）。

示例：

```js
// 单个规则，使用函数
ftw.util({
  'p-(\\d+)': (n) => `padding: ${n * 0.25}rem;`
});

// 使用字符串模板（{0} 会被第一个参数替换）
ftw.util({
  'm-(\\d+)': 'margin: {0}rem;'
});

// 批量注册
ftw.util({
  'text-red': 'color: red;',
  'bg-blue': 'background: blue;'
});
```

ftw.render(selector)

强制渲染指定元素（或带有 ftw-render 属性的元素）。

ftw.util.dynamic(ruleName, regex, generator)

单个规则注册的底层方法。

📖 与同类库对比

特性 FTW Twind UnoCSS
体积 (gzipped) ~5KB ~12KB ~17KB
是否需要预设 否，完全自定义 是（内置 Tailwind） 是（需加载预设）
学习成本 低（只需懂正则） 中（需熟悉 Tailwind） 中
运行时 DOM 监听 ✅ ✅ ✅
适合极度定制化设计系统 ✅ ❌ 部分支持

🤝 贡献

欢迎提交 Issue 和 Pull Request！请确保代码风格一致，并通过测试。

📄 许可证

MIT © 2025 Monkey2582
