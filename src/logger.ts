// ============================================================
// logger.ts — Colored console logger
// ============================================================

import chalk from "chalk";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function timestamp(): string {
  return new Date().toISOString().replace("T", " ").substring(0, 19);
}

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[currentLevel];
}

export const logger = {
  debug: (msg: string, ...args: unknown[]) => {
    if (shouldLog("debug")) {
      console.log(chalk.gray(`[${timestamp()}] [DEBUG] ${msg}`), ...args);
    }
  },

  info: (msg: string, ...args: unknown[]) => {
    if (shouldLog("info")) {
      console.log(chalk.cyan(`[${timestamp()}] [INFO]  ${msg}`), ...args);
    }
  },

  warn: (msg: string, ...args: unknown[]) => {
    if (shouldLog("warn")) {
      console.warn(chalk.yellow(`[${timestamp()}] [WARN]  ${msg}`), ...args);
    }
  },

  error: (msg: string, ...args: unknown[]) => {
    if (shouldLog("error")) {
      console.error(chalk.red(`[${timestamp()}] [ERROR] ${msg}`), ...args);
    }
  },

  alert: (msg: string) => {
    console.log(chalk.bgYellow.black.bold(`\n${"═".repeat(60)}`));
    console.log(chalk.bgYellow.black.bold(` 🚨 GOLD ALERT  ${timestamp()}`));
    console.log(chalk.bgYellow.black.bold(`${"═".repeat(60)}`));
    console.log(chalk.yellow.bold(msg));
    console.log(chalk.bgYellow.black.bold(`${"═".repeat(60)}\n`));
  },
};
