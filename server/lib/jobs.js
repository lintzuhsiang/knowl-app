/**
 * Scheduled background jobs (cron).
 *
 *   - Daily 03:00 — snapshot SQLite to BACKUP_DIR; optional S3 upload; rotate
 *   - Daily 04:00 — delete expired sessions
 *   - Daily 04:15 — delete agent_traces older than retention window
 *   - Weekly Sunday 05:00 — VACUUM the database to reclaim space
 *
 * All jobs are idempotent and skip silently on error so a transient failure
 * doesn't stop subsequent jobs. Failures log to console (→ CloudWatch).
 *
 * Env knobs:
 *   BACKUP_DIR              defaults to ./backups
 *   BACKUP_RETENTION_DAYS   defaults to 7 (local copies; older deleted)
 *   TRACE_RETENTION_DAYS    defaults to 90
 *   S3_BACKUP_BUCKET        if set, uploads each snapshot via aws-sdk
 *   S3_BACKUP_PREFIX        defaults to "backups/"
 *   DISABLE_JOBS            set to "1" to skip starting any cron (tests / dev)
 */

import cron from 'node-cron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
  backupDb, deleteExpiredSessions, deleteOldAgentTraces,
  deleteOldResolvedSuggestions, deleteExpiredEmailTokens, vacuumDb,
} from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = process.env.BACKUP_DIR
  || path.join(__dirname, '..', '..', 'backups');
const BACKUP_RETENTION_DAYS = parseInt(process.env.BACKUP_RETENTION_DAYS || '7', 10);
const TRACE_RETENTION_DAYS  = parseInt(process.env.TRACE_RETENTION_DAYS  || '90', 10);

function log(msg, level = 'info') {
  const ts = new Date().toISOString();
  if (level === 'error') console.error(`[jobs ${ts}] ${msg}`);
  else                   console.log (`[jobs ${ts}] ${msg}`);
}

function ensureBackupDir() {
  try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); }
  catch (e) { log(`failed to create backup dir: ${e.message}`, 'error'); }
}

function rotateLocalBackups() {
  try {
    const cutoff = Date.now() - BACKUP_RETENTION_DAYS * 86400000;
    const entries = fs.readdirSync(BACKUP_DIR);
    for (const name of entries) {
      if (!name.startsWith('knowl-') || !name.endsWith('.db')) continue;
      const full = path.join(BACKUP_DIR, name);
      const stat = fs.statSync(full);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(full);
        log(`rotated old backup: ${name}`);
      }
    }
  } catch (e) {
    log(`backup rotation failed: ${e.message}`, 'error');
  }
}

/**
 * Optional S3 upload. Only loads aws-sdk when env var is set so the package
 * stays out of the dependency tree for hobby / Path-A deployments.
 *
 * Set:
 *   S3_BACKUP_BUCKET=knowl-backups
 *   S3_BACKUP_PREFIX=backups/    (optional)
 *   AWS_REGION=us-east-1
 *   AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY  (or IAM role)
 *
 * Then `npm install @aws-sdk/client-s3` and this block activates.
 */
async function uploadToS3(localPath, key) {
  if (!process.env.S3_BACKUP_BUCKET) return;
  try {
    // Dynamic import — keeps aws-sdk optional
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
    const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
    const Body = fs.readFileSync(localPath);
    await s3.send(new PutObjectCommand({
      Bucket: process.env.S3_BACKUP_BUCKET,
      Key: (process.env.S3_BACKUP_PREFIX || 'backups/') + key,
      Body,
      // StorageClass omitted; lifecycle rule on bucket handles cold tier transitions
    }));
    log(`uploaded backup to s3://${process.env.S3_BACKUP_BUCKET}/${key}`);
  } catch (e) {
    log(`S3 upload failed: ${e.message}`, 'error');
  }
}

// ─── Job implementations ─────────────────────────────────────────────────────

async function runBackup() {
  ensureBackupDir();
  const stamp = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const fileName = `knowl-${stamp}.db`;
  const dest = path.join(BACKUP_DIR, fileName);
  try {
    await backupDb(dest);
    log(`backup written: ${dest}`);
    await uploadToS3(dest, fileName);
    rotateLocalBackups();
  } catch (e) {
    log(`backup failed: ${e.message}`, 'error');
  }
}

function runSessionCleanup() {
  try {
    const n = deleteExpiredSessions();
    if (n > 0) log(`deleted ${n} expired sessions`);
    const tokens = deleteExpiredEmailTokens();
    if (tokens.verification > 0) log(`deleted ${tokens.verification} expired email-verification tokens`);
    if (tokens.reset > 0)        log(`deleted ${tokens.reset} expired/used password-reset tokens`);
  } catch (e) {
    log(`session cleanup failed: ${e.message}`, 'error');
  }
}

function runTraceCleanup() {
  try {
    const tracesDeleted = deleteOldAgentTraces(TRACE_RETENTION_DAYS);
    const sugDeleted = deleteOldResolvedSuggestions(30);
    if (tracesDeleted > 0) log(`deleted ${tracesDeleted} old agent traces (>${TRACE_RETENTION_DAYS}d)`);
    if (sugDeleted    > 0) log(`deleted ${sugDeleted} old resolved suggestions (>30d)`);
  } catch (e) {
    log(`trace cleanup failed: ${e.message}`, 'error');
  }
}

function runVacuum() {
  try {
    log('starting VACUUM…');
    vacuumDb();
    log('VACUUM complete');
  } catch (e) {
    log(`VACUUM failed: ${e.message}`, 'error');
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Start all scheduled jobs. Called once from server/index.js after listen. */
export function startJobs() {
  if (process.env.DISABLE_JOBS === '1') {
    log('jobs disabled via DISABLE_JOBS=1');
    return;
  }

  // 03:00 daily — backup + rotate
  cron.schedule('0 3 * * *', runBackup, { timezone: 'UTC' });

  // 04:00 daily — session cleanup
  cron.schedule('0 4 * * *', runSessionCleanup, { timezone: 'UTC' });

  // 04:15 daily — trace + suggestion cleanup
  cron.schedule('15 4 * * *', runTraceCleanup, { timezone: 'UTC' });

  // 05:00 Sunday weekly — VACUUM
  cron.schedule('0 5 * * 0', runVacuum, { timezone: 'UTC' });

  log(`jobs scheduled (backup dir: ${BACKUP_DIR}, trace retention: ${TRACE_RETENTION_DAYS}d)`);
}

/** Expose individual runners for manual / test invocation. */
export const jobs = {
  runBackup,
  runSessionCleanup,
  runTraceCleanup,
  runVacuum,
};
