/**
 * PM2 process manager config — for Path A non-Docker EC2 / Lightsail deploys.
 *
 * Usage on the box:
 *   npm ci --omit=dev
 *   pm2 start ecosystem.config.cjs --env production
 *   pm2 save
 *   pm2 startup    # one-time: install systemd hook so PM2 survives reboot
 *
 * Reload (zero-ish downtime, ~1-3s):
 *   pm2 reload knowl-api
 *
 * Logs:
 *   pm2 logs knowl-api
 *   pm2 monit
 *
 * Note: `.cjs` extension because package.json has `"type": "module"` — PM2
 * config files must be CommonJS so PM2's loader can require() them.
 */
module.exports = {
  apps: [{
    name: 'knowl-api',
    script: 'server/index.js',
    cwd: __dirname,
    // Single-instance: 'cluster' mode would break in-process state
    // (pendingConfirms Map, token-budget cache, cron jobs running N times).
    // The whole Path A design is single-instance — see docs/project-state.md §10.
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    // PM2 will SIGTERM the process; better-sqlite3 closes cleanly within
    // a few hundred ms, and tini-style signal handling isn't needed here.
    kill_timeout: 5000,
    wait_ready: false,
    env: {
      NODE_ENV: 'production',
      PORT: 3001,
      // Everything else (GEMINI_API_KEY, SENTRY_DSN, etc.) loads from
      // /etc/knowl/env via the systemd unit OR `pm2 start --env-from-file`.
      // Do NOT bake secrets into this file.
    },
    out_file: '/var/log/knowl/out.log',
    error_file: '/var/log/knowl/err.log',
    merge_logs: true,
    time: true,
  }],
};
