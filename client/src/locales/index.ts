import zh from "./zh";

type LocaleTree = typeof zh;

function getValue(path: string) {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object") {
      return undefined;
    }

    return (current as Record<string, unknown>)[segment];
  }, zh);
}

export function t(path: string, params?: Record<string, string | number>) {
  const value = getValue(path);
  if (typeof value !== "string") {
    return path;
  }

  if (!params) {
    return value;
  }

  return Object.entries(params).reduce((text, [key, replacement]) => {
    return text.replaceAll(`{${key}}`, String(replacement));
  }, value);
}

export type { LocaleTree };
