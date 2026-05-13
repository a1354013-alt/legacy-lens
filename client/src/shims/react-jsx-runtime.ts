// @ts-expect-error React 19 exposes this runtime only as a CommonJS file in this toolchain.
import runtime from "../../../node_modules/react/jsx-runtime.js";

type JsxRuntimeModule = {
  Fragment: symbol;
  jsx: (...args: unknown[]) => unknown;
  jsxs: (...args: unknown[]) => unknown;
};

const resolvedRuntime = runtime as JsxRuntimeModule;

export const Fragment = resolvedRuntime.Fragment;
export const jsx = resolvedRuntime.jsx;
export const jsxs = resolvedRuntime.jsxs;
