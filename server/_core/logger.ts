/**
 * Structured Logger with multiple log levels
 * Supports JSON output for production and colored console for development
 */

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogContext {
  [key: string]: unknown;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const getLogLevel = (): LogLevel => {
  const envLevel = process.env.LOG_LEVEL?.toLowerCase();
  if (envLevel && envLevel in LOG_LEVELS) {
    return envLevel as LogLevel;
  }
  return process.env.NODE_ENV === "production" ? "info" : "debug";
};

const currentLogLevel = getLogLevel();

const formatTimestamp = (): string => new Date().toISOString();

const colorize = (level: LogLevel, message: string): string => {
  if (process.env.NODE_ENV === "production") {
    return message;
  }

  const colors: Record<LogLevel, string> = {
    debug: "\x1b[36m", // cyan
    info: "\x1b[32m",  // green
    warn: "\x1b[33m",  // yellow
    error: "\x1b[31m", // red
  };

  const reset = "\x1b[0m";
  return `${colors[level]}${message}${reset}`;
};

const formatLog = (
  level: LogLevel,
  message: string,
  context?: LogContext
): string | object => {
  const forceJson =
    Boolean(context) &&
    typeof context === "object" &&
    (Object.prototype.hasOwnProperty.call(context, "action") ||
      Object.prototype.hasOwnProperty.call(context, "status") ||
      Object.prototype.hasOwnProperty.call(context, "projectId"));

  const baseLog = {
    timestamp: formatTimestamp(),
    level,
    message,
    ...(forceJson && context ? context : {}),
    ...(!forceJson && context && Object.keys(context).length > 0 ? { context } : {}),
  };

  if (forceJson || process.env.NODE_ENV === "production" || process.env.LOG_FORMAT === "json") {
    return baseLog;
  }

  const contextStr = context && Object.keys(context).length > 0
    ? ` ${JSON.stringify(context)}`
    : "";

  return `${colorize(level, `[${level.toUpperCase()}]`)} ${formatTimestamp()} - ${message}${contextStr}`;
};

const logAtLevel = (level: LogLevel, message: string, context?: LogContext) => {
  if (LOG_LEVELS[level] < LOG_LEVELS[currentLogLevel]) {
    return;
  }

  const formatted = formatLog(level, message, context);

  if (level === "error") {
    console.error(formatted);
  } else if (level === "warn") {
    console.warn(typeof formatted === "string" ? formatted : JSON.stringify(formatted));
  } else {
    console.log(typeof formatted === "string" ? formatted : JSON.stringify(formatted));
  }
};

export const logger = {
  debug: (message: string, context?: LogContext) => logAtLevel("debug", message, context),
  info: (message: string, context?: LogContext) => logAtLevel("info", message, context),
  warn: (message: string, context?: LogContext) => logAtLevel("warn", message, context),
  error: (message: string, context?: LogContext) => logAtLevel("error", message, context),
  
  /**
   * Create a child logger with prefixed context
   */
  child: (defaultContext: LogContext) => ({
    debug: (message: string, context?: LogContext) => 
      logAtLevel("debug", message, { ...defaultContext, ...context }),
    info: (message: string, context?: LogContext) => 
      logAtLevel("info", message, { ...defaultContext, ...context }),
    warn: (message: string, context?: LogContext) => 
      logAtLevel("warn", message, { ...defaultContext, ...context }),
    error: (message: string, context?: LogContext) => 
      logAtLevel("error", message, { ...defaultContext, ...context }),
  }),
};

export type { LogLevel, LogContext };
