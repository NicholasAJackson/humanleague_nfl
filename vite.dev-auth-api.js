import { loadEnv } from 'vite';
import meHandler from './api/auth/me.js';
import loginHandler from './api/auth/login.js';
import logoutHandler from './api/auth/logout.js';
import configHandler from './api/auth/config.js';
import tradeValuesHandler from './api/trade-values.js';

/** Vite's Node `res` lacks Express-style `status` / `send` used by `send()` in `api/_db.js`. */
function patchRes(res) {
  if (typeof res.status !== 'function') {
    res.status = function status(code) {
      this.statusCode = code;
      return this;
    };
  }
  if (typeof res.send !== 'function') {
    res.send = function send(body) {
      this.end(body);
    };
  }
}

/**
 * During `npm run dev`, Vercel serverless does not run. Wire `/api/auth/*` so optional
 * site login works with `.env.local` (SITE_PASSWORD + AUTH_SECRET) like `vercel dev`.
 */
export function devAuthApiPlugin(mode) {
  return {
    name: 'dev-auth-api',
    enforce: 'pre',
    configureServer(server) {
      const env = loadEnv(mode, process.cwd(), '');
      for (const k of ['SITE_PASSWORD', 'AUTH_SECRET', 'DATABASE_URL', 'APP_USERS_ENABLED']) {
        if (k in env) process.env[k] = env[k];
      }

      server.middlewares.use(async (req, res, next) => {
        const path = (req.url || '').split('?')[0];
        if (path === '/api/trade-values' && req.method === 'GET') {
          patchRes(res);
          try {
            await tradeValuesHandler(req, res);
          } catch (err) {
            console.error('[dev-auth-api] trade-values', err);
            if (!res.headersSent) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ error: 'Server error' }));
            }
          }
          return;
        }
        if (!path.startsWith('/api/auth/')) return next();

        patchRes(res);

        try {
          if (path === '/api/auth/config' && req.method === 'GET') {
            await configHandler(req, res);
            return;
          }
          if (path === '/api/auth/me' && req.method === 'GET') {
            await meHandler(req, res);
            return;
          }
          if (path === '/api/auth/login' && req.method === 'POST') {
            await loginHandler(req, res);
            return;
          }
          if (path === '/api/auth/logout' && req.method === 'POST') {
            await logoutHandler(req, res);
            return;
          }
        } catch (err) {
          console.error('[dev-auth-api]', err);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ error: 'Server error' }));
          }
          return;
        }

        if (!res.headersSent) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: 'Not found' }));
        }
      });
    },
  };
}
