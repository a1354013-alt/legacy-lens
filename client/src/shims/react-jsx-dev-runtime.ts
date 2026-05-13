// @ts-expect-error React 19 exposes this runtime only as a CommonJS file in this toolchain.
import runtime from "../../../node_modules/react/jsx-dev-runtime.js";

type JsxDevRuntimeModule = {
  Fragment: symbol;
  jsxDEV: (...args: unknown[]) => unknown;
};

const resolvedRuntime = runtime as JsxDevRuntimeModule;

export const Fragment = resolvedRuntime.Fragment;
export const jsxDEV = resolvedRuntime.jsxDEV;
