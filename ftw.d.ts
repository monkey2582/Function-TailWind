/**
 * ftw 压缩版的 TypeScript 类型声明
 * 全局命名空间（通过 <script> 标签加载）
 */

interface FtwUtilsConfig {
  [prefix: string]: string | Function | [generator: Function | string, numIdx?: number[], paramMap?: Record<string, number>];
}
type FtwGenerator = (...args: (string | number)[]) => string;
interface Ftw {
  util(keyOrConfig: string | FtwUtilsConfig, value?: string | FtwGenerator | [FtwGenerator | string, number[], Record<string, number>], numIdx?: number[]): void;
  render(selector: string | Element): void;
  use(input: string | Element): void;
  pause(): void;
  resume(): void;
  update(target?: string | Element): void;
  once(target?: string | Element): void;
  ignore(...selectors: (string | Element)[]): void;
  unignore(...selectors: (string | Element)[]): void;
}
declare global {
  var ftw: Ftw;
}
export {};