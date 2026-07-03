export function parseStrictPositiveIntegerEnv(
  name,
  defaultValue,
  env = globalThis.process.env
) {
  const rawValue = env[name];
  if (rawValue === undefined) {
    return defaultValue;
  }

  const trimmedValue = rawValue.trim();
  if (!/^[1-9]\d*$/.test(trimmedValue)) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return Number(trimmedValue);
}
