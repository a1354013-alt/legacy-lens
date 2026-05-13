declare module "../../../node_modules/react/jsx-runtime.js" {
  const runtime: {
    Fragment: symbol;
    jsx: (...args: unknown[]) => unknown;
    jsxs: (...args: unknown[]) => unknown;
  };

  export default runtime;
}

declare module "../../../node_modules/react/jsx-dev-runtime.js" {
  const runtime: {
    Fragment: symbol;
    jsxDEV: (...args: unknown[]) => unknown;
  };

  export default runtime;
}
