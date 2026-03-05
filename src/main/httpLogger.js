// httpLogger.js — PDVix — Interceptors globais do Axios
const axios   = require('axios');
const { httpLog } = require('./logger');

let reqCounter = 0;

function setupHttpLogger() {

  // ── REQUEST ────────────────────────────────────────────────────────────────
  axios.interceptors.request.use(
    (config) => {
      config._reqId    = ++reqCounter;
      config._startAt  = Date.now();

      httpLog.info('REQUEST', {
        id:      config._reqId,
        method:  config.method?.toUpperCase(),
        url:     config.url,
        params:  config.params  ?? null,
        body:    config.data    ?? null,
        headers: sanitizarHeaders(config.headers),
      });

      return config;
    },
    (err) => {
        const ms = Date.now() - (err.config?._startAt ?? 0);

        httpLog.error('RESPONSE_ERROR', {
          id:      err.config?._reqId,
          url:     err.config?.url,
          method:  err.config?.method?.toUpperCase(),
          ms,
          code:    err.code,
          status:  err.response?.status ?? null,
          // garante que sempre tenta logar o body, mesmo que seja string/html
          body:    err.response?.data !== undefined
                    ? truncar(err.response.data)
                    : '(sem corpo na resposta)',
          message: err.message,
        });

        return Promise.reject(err);
      }
  );

  // ── RESPONSE ───────────────────────────────────────────────────────────────
  axios.interceptors.response.use(
    (res) => {
      const ms = Date.now() - (res.config._startAt ?? 0);

      httpLog.info('RESPONSE', {
        id:       res.config._reqId,
        status:   res.status,
        statusTxt: res.statusText,
        url:      res.config.url,
        ms,
        body:     truncar(res.data),
      });

      return res;
    },
    (err) => {
        const ms = Date.now() - (err.config?._startAt ?? 0);

        httpLog.error('RESPONSE_ERROR', {
          id:      err.config?._reqId,
          url:     err.config?.url,
          method:  err.config?.method?.toUpperCase(),
          ms,
          code:    err.code,
          status:  err.response?.status ?? null,
          // garante que sempre tenta logar o body, mesmo que seja string/html
          body:    err.response?.data !== undefined
                    ? truncar(err.response.data)
                    : '(sem corpo na resposta)',
          message: err.message,
        });

        return Promise.reject(err);
      }
  );

  httpLog.info('HTTP logger ativo.');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Remove tokens/senhas dos headers antes de logar */
function sanitizarHeaders(headers = {}) {
  const copia = { ...headers };
  for (const k of ['authorization', 'Authorization', 'x-api-key', 'cookie']) {
    if (copia[k]) copia[k] = '***';
  }
  return copia;
}

/** Evita logar bodies gigantes */
function truncar(data, limite = 2000) {
  if (!data) return null;
  const txt = typeof data === 'string' ? data : JSON.stringify(data);
  return txt.length > limite ? txt.slice(0, limite) + `… [+${txt.length - limite} chars]` : data;
}

module.exports = { setupHttpLogger };