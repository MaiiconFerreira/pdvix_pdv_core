// logger.js — PDVix Electron — Sistema de logs centralizado
const winston = require('winston');
require('winston-daily-rotate-file');
const path    = require('path');
const fs      = require('fs');
const { app } = require('electron');

// ─── Diretórios ───────────────────────────────────────────────────────────────
const baseLogDir = path.join(app.getPath('userData'), 'logs');
const httpLogDir = path.join(baseLogDir, 'http');
const dbLogDir   = path.join(baseLogDir, 'database');
const appLogDir  = path.join(baseLogDir, 'app');

for (const dir of [baseLogDir, httpLogDir, dbLogDir, appLogDir]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ─── Formatos ─────────────────────────────────────────────────────────────────
const jsonFmt = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.json()
);

const consoleFmt = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const extra = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    return `[${timestamp}] ${level}: ${message}${extra}`;
  })
);

// ─── Factory ──────────────────────────────────────────────────────────────────
function criarLogger(nome, logDir, consoleLevel = 'warn') {
  return winston.createLogger({
    level: 'debug',
    transports: [
      new winston.transports.DailyRotateFile({
        dirname:       logDir,
        filename:      `${nome}-%DATE%.log`,
        datePattern:   'YYYY-MM-DD',
        maxFiles:      '14d',       // apaga logs com mais de 14 dias
        maxSize:       '20m',       // rotaciona se passar de 20 MB
        zippedArchive: true,
        format:        jsonFmt,
      }),
      new winston.transports.Console({
        level:  consoleLevel,
        format: consoleFmt,
      }),
    ],
  });
}

// ─── Instâncias exportadas ────────────────────────────────────────────────────
const logger  = criarLogger('app',      appLogDir, 'info');   // uso geral
const httpLog = criarLogger('http',     httpLogDir, 'debug'); // axios
const dbLog   = criarLogger('database', dbLogDir,  'warn');   // sqlite

module.exports = { logger, httpLog, dbLog };