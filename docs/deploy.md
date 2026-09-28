# Deploying knowl-app — AWS Path A

This is the end-to-end recipe for the cheap-ish single-instance deploy
(~$25–40/month, 1000-user capable). Picks up where
[project-state.md §10](project-state.md) leaves off.

Path A has two SSL variants:

- **nginx + Let's Encrypt** — ~$25/mo, simpler bill, brief downtime on deploy.
  Use [`deploy/nginx/knowl.conf`](../deploy/nginx/knowl.conf).
- **ALB + ACM cert** — ~$40/mo, zero-downtime swap, managed health checks.
  See [`deploy/alb-acm.md`](../deploy/alb-acm.md).

Below covers the nginx variant. ALB is in the linked doc.

---

## Provision the box (one-time, ~30 min)

1. **EC2 instance** — `t4g.small` ARM (~$13/mo), Ubuntu 22.04 LTS.
   Open ports 22 (SSH from your IP), 80, 443 to the world.
2. **EBS volume** — gp3 20 GB, mount at `/data`:
   ```bash
   sudo mkfs.ext4 /dev/nvme1n1
   echo '/dev/nvme1n1 /data ext4 defaults 0 0' | sudo tee -a /etc/fstab
   sudo mkdir -p /data /backups
   sudo mount -a
   sudo chown -R $USER /data /backups
   ```
3. **Software**:
   ```bash
   sudo apt update
   sudo apt install -y docker.io nginx certbot python3-certbot-nginx
   sudo usermod -aG docker $USER
   newgrp docker
   ```
4. **DNS** — point `api.knowl.com` (and `app.knowl.com` if same-origin) at
   the EC2 elastic IP via Route 53.
5. **TLS cert**:
   ```bash
   sudo certbot --nginx -d api.knowl.com -d app.knowl.com
   # certbot installs the cert and adds the auto-renew systemd timer
   ```
6. **nginx config**:
   ```bash
   sudo cp deploy/nginx/knowl.conf /etc/nginx/sites-available/
   sudo ln -s /etc/nginx/sites-available/knowl.conf /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   ```

## Set up runtime secrets

Drop the production env file at `/etc/knowl/env` (root-owned, 0600):

```bash
sudo mkdir -p /etc/knowl
sudo install -m 600 /dev/stdin /etc/knowl/env <<'EOF'
GEMINI_API_KEY=...
CORS_ORIGIN=https://app.knowl.com
TRUST_PROXY=1
DB_PATH=/data/knowl.db
BACKUP_DIR=/backups
LLM_DAILY_TOKEN_BUDGET=200000
SENTRY_DSN=https://...@sentry.io/...
SENTRY_ENVIRONMENT=production
S3_BACKUP_BUCKET=knowl-backups-prod
AWS_REGION=us-east-1
EOF
```

## First deploy

```bash
# On dev machine
docker build \
  --build-arg VITE_API_BASE=https://api.knowl.com \
  --build-arg VITE_SENTRY_DSN=https://...@sentry.io/... \
  -t knowl-api:latest .
docker save knowl-api:latest | gzip | ssh ubuntu@api.knowl.com 'gunzip | docker load'

# On EC2 (via SSH)
docker run -d --name knowl-api --restart unless-stopped \
  -p 127.0.0.1:3001:3001 \
  -v /data:/data \
  -v /backups:/backups \
  --env-file /etc/knowl/env \
  knowl-api:latest

# Verify
curl -fsS https://api.knowl.com/healthz
```

## Subsequent deploys

Use the GitHub Actions workflow at
[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml). Required
repo secrets:

| Secret | Purpose |
|---|---|
| `EC2_HOST`, `EC2_USER`, `EC2_SSH_KEY` | SSH into the box |
| `VITE_API_BASE`, `VITE_SENTRY_DSN` | Baked into the SPA bundle at build |
| `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` (optional) | release tagging |

Push to `main` → workflow builds the Docker image, ships it via `scp`,
restarts the container, and curls `/healthz` to verify.

## Day-2 ops

### Logs
```bash
docker logs --tail 200 -f knowl-api
sudo tail -f /var/log/nginx/access.log /var/log/nginx/error.log
```

### Backup verification
```bash
ls -lh /backups/knowl-*.db          # daily snapshots from the cron in jobs.js
aws s3 ls s3://knowl-backups-prod/  # if S3 backup configured

# Restore drill (run monthly)
docker stop knowl-api
sudo cp /backups/knowl-2026-05-20.db /data/knowl.db
docker start knowl-api
curl -fsS https://api.knowl.com/healthz   # verify
```

### Cost alarms
- AWS console → Billing → Budgets → create monthly budget $100, email alert
- Google Cloud console → APIs & Services → Quotas → set Gemini API quota
  alert
- Sentry → Settings → Quotas → set monthly cap on events

### Status / monitoring (free)
- UptimeRobot — monitor `https://api.knowl.com/healthz` every 5 min, alert
  to email on >2 consecutive failures
- Sentry — `SENTRY_DSN` already wired; just create the project

## Rollback

```bash
ssh ubuntu@api.knowl.com
docker images knowl-api      # list available image tags
docker stop knowl-api && docker rm knowl-api
docker run -d --name knowl-api --restart unless-stopped \
  -p 127.0.0.1:3001:3001 \
  -v /data:/data -v /backups:/backups \
  --env-file /etc/knowl/env \
  knowl-api:<previous-sha>
```

If the new release also wrote bad DB migrations, restore the latest
`/backups/knowl-*.db` snapshot before rolling the image back.

## Things still TODO before public launch (not in this doc's scope)

- Privacy Policy + Terms of Service copy (legal, not engineering)
- Cookie consent banner (only if you're certain you have EU users)
- Email verification + forgot password (needs SES / Resend / SendGrid pick)
- Rotating the Gemini API key that lived in early git history
- iOS Capacitor production build verification on real device
