/**
 * Type declarations for the `ftw` library (Fast Tailwind-like Utilities).
 * The library is exposed globally as `window.ftw` and is available as the
 * global variable `ftw`.
 *
 * @example
 * // Add classes to an element
 * const el = document.getElementById('my-div');
 * ftw(el, 'bg-red-500', 'text-white');
 *
 * // Register a custom utility
 * ftw.util('my-util', (size) => `font-size:${size}px;`);
 *
 * // Apply utilities to a selector
 * ftw.render('.my-element');
 *
 * // Pause automatic class processing
 * ftw.pause();
 */

declare global {
  const ftw: Ftw;
}

/** Generator for a utility: can be a function, string expression, or array definition. */
type FtwGenerator =
  | string
  | ((...args: any[]) => string)
  | [string | ((...args: any[]) => string), (number[] | Record<string, number>)?, number[]?];

/**
 * The main `ftw` object, callable as a function to apply classes or styles.
 */
interface Ftw {
  /**
   * Apply a list of class names or CSS declarations to the given element(s).
   * @param element - A DOM element or a CSS selector string.
   * @param classes - One or more class names or CSS rules (e.g. `"bg-red-500"`, `"color:red;"`).
   */
  (element: Element, ...classes: string[]): void;
  (selector: string, ...classes: string[]): void;

  /**
   * Register custom utilities.
   * @param name - The utility name (e.g., `"my-util"`).
   * @param generator - A function, string expression, or array definition that produces CSS.
   * @param idxOrder - Optional index order mapping for arguments.
   *
   * @example
   * ftw.util('my-util', (size) => `font-size:${size}px;`);
   * ftw.util('my-util', 'font-size: {0}px;');
   * ftw.util({ 'my-util': (size) => `font-size:${size}px;` });
   */
  util(name: string, generator: FtwGenerator, idxOrder?: number[]): void;
  util(utils: Record<string, FtwGenerator>): void;

  /**
   * Process `<style>` or `<link>` elements marked with `ftw-render` attribute.
   * @param selector - A CSS selector or the element itself.
   */
  render(selector: string | Element): void;

  /**
   * Process `<script>` elements marked with `ftw-utils` attribute.
   * @param selector - A CSS selector or the element itself.
   */
  use(selector: string | Element): void;

  /** Pause the MutationObserver that automatically applies utilities to new/updated elements. */
  pause(): void;

  /** Resume the MutationObserver. */
  resume(): void;

  /** Manually trigger a full re‑scan of all elements and apply utilities. */
  update(): void;

  /**
   * Run a one‑time update: resume, scan, and pause again.
   * @param selector - Optional selector to limit the scan.
   */
  once(selector?: string | Element | NodeList): void;

  /** Log all registered classes and their generated CSS to the console. */
  debug(): void;

  /** Run garbage collection to remove unused utility styles. */
  gc(): void;

  /**
   * Exclude elements from automatic processing by adding `ftw-ignore` attribute.
   * @param targets - CSS selectors or Element instances.
   */
  ignore(...targets: (string | Element)[]): void;

  /**
   * Remove `ftw-ignore` from elements and reprocess them.
   * @param targets - CSS selectors or Element instances.
   */
  unignore(...targets: (string | Element)[]): void;
}

export {};