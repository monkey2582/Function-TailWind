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
  const ftw: FTW;
}

/**
 * Generator for a utility: can be a function, string expression, or array definition.
 * - **Function**: `(arg1, arg2, ...) => "css:value;"`
 * - **String**: Template with `{0}`, `{1}` placeholders, e.g. `"font-size:{0}px;"`
 * - **Array**: `[ generator, (number[] | Record<string,number>)?, number[]? ]`
 *   - First element: function or string.
 *   - Second (optional): numeric indices array for type conversion, or a context mapping.
 *   - Third (optional): numeric indices for arguments that should be parsed as numbers.
 */
type FTWGenerator =
  | string
  | ((...args: any[]) => string)
  | [
      string | ((...args: any[]) => string),
      (number[] | Record<string, number>)?,
      number[]?
    ];

/**
 * Result of `ftw.inspect` for a single class.
 */
interface FTWInspectResult {
  /** Whether the class matched a registered utility or keyframe. */
  matched: boolean;
  /** The rule key that matched (e.g., `"w:num"` or keyframe name). */
  ruleKey: string | null;
  /** Parsed parameters from the class name. */
  params: string[];
  /** The generated CSS declaration (or `null` if none). */
  css: string | null;
  /** Whether the CSS came from the cache. */
  fromCache: boolean;
  /** Current reference count for this class. */
  refCount: number;
}

/**
 * The main `ftw` object, callable as a function to apply classes or styles.
 */
interface FTW {
  /**
   * Apply a list of class names or CSS declarations to the given element(s).
   * @param target - A DOM element or a CSS selector string.
   * @param classes - One or more class names or CSS rules (e.g. `"bg-red-500"`, `"color:red;"`).
   */
  (target: Element, ...classes: string[]): void;
  (target: string, ...classes: string[]): void;

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
  util(name: string, generator: FTWGenerator, idxOrder?: number[]): void;
  util(utils: Record<string, FTWGenerator>): void;

  /**
   * Manually trigger processing of `<style>` / `<link>` elements with `ftw-render`.
   * @param target - Optional selector, element, or list of elements to limit processing.
   */
  render(target?: string | Element | NodeList | Array<Element>): void;

  /**
   * Manually trigger processing of `<script>` elements with `ftw-utils`.
   * @param target - Optional selector, element, or list of elements to limit processing.
   */
  use(target?: string | Element | NodeList | Array<Element>): void;

  /**
   * Manually trigger a full re‑scan of all elements to apply utilities.
   * @param target - Optional selector, element, or list of elements to limit processing.
   */
  update(target?: string | Element | NodeList | Array<Element>): void;

  /** Pause the MutationObserver that automatically applies utilities to new/updated elements. */
  pause(): void;

  /** Resume the MutationObserver. */
  resume(): void;

  /**
   * Perform a one‑time update: resume, scan, and pause again.
   * @param target - Optional selector, element, or list of elements to limit processing.
   */
  once(target?: string | Element | NodeList | Array<Element>): void;

  /**
   * Get debugging information for all registered generated styles.
   * @returns Array of objects with `class` and `css` properties.
   */
  debug(): Array<{ class: string; css: string }>;

  /** Run garbage collection to remove unused utility styles. */
  gc(): void;

  /**
   * Mark elements to be ignored by the automatic processing (adds `ftw-ignore` attribute).
   * @param targets - CSS selectors or DOM elements.
   */
  ignore(...targets: (string | Element)[]): void;

  /**
   * Remove the `ftw-ignore` attribute and reprocess the elements.
   * @param targets - CSS selectors or DOM elements.
   */
  unignore(...targets: (string | Element)[]): void;

  /**
   * Clear the class and template caches.
   * @param prefix - If provided, only clear cache entries whose keys start with this string.
   */
  clearCache(prefix?: string): void;

  /**
   * “Dry‑run” CSS generation without touching the DOM.
   * @param args - Class names or selector blocks (e.g., `".box { bg-red-500 }"`).
   * @returns The generated CSS string.
   */
  css(...args: string[]): string;

  /**
   * Inspect a list of class names and return structured metadata.
   * @param args - Class names to inspect.
   * @returns If one class is given, an `FTWInspectResult` object; if multiple, a mapping
   *          `{ [className]: FTWInspectResult }`; if none, `null`.
   */
  inspect(...args: string[]): FTWInspectResult | { [className: string]: FTWInspectResult } | null;

  /**
   * Maximum number of entries in the class‑name resolution cache.
   * Defaults to 500. Setting to a non‑integer or negative value is silently ignored.
   */
  clsCache: number;

  /**
   * Maximum number of entries in the template compilation cache.
   * Defaults to 300. Setting to a non‑integer or negative value is silently ignored.
   */
  tplCache: number;
}

export {};