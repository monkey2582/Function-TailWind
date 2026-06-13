export as namespace ftw;
export = ftw;

declare const ftw: {
  util: {
    (defs: Record<string, string | ((...args: (string|number)[]) => string) | [string|((...args: (string|number)[]) => string), string[]]>): void;
    (name: string, gen: string | ((...args: (string|number)[]) => string), args?: string[]): void;
  };
  render: (target: string | Element) => void;
  use: (target: string | Element) => void;
};

declare global {
  interface Window { ftw: typeof ftw; }
}