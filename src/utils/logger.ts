/**
 * Structured logger using Winston.
 * Tags all messages with agent role for swarm debugging.
 */

import winston from "winston";

const { combine, timestamp, printf, colorize, errors } = winston.format;

const logFormat = printf(({ level, message, timestamp, agent, ...meta }) => {
  const agentTag = agent ? `[${agent}]` : "[system]";
  const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : "";
  return `${timestamp} ${level} ${agentTag} ${message}${metaStr}`;
});

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? "info",
  format: combine(
    errors({ stack: true }),
    timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" }),
    logFormat
  ),
  transports: [
    new winston.transports.Console({
      format: combine(colorize(), logFormat),
    }),
  ],
});

/** Create a child logger tagged with an agent role */
export function agentLogger(agent: string) {
  return logger.child({ agent });
}
