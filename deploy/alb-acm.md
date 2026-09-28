# Path A — ALB + ACM cert deploy notes

Use this variant if you want zero-downtime deploys + automatic health-check
restarts. Costs ~$18/month more than the nginx route but you get a managed
load balancer that handles SSL, health checks, and graceful instance swap.

If you're going cheaper (single-EC2 + nginx + Let's Encrypt) use
[`deploy/nginx/knowl.conf`](nginx/knowl.conf) instead and ignore this file.

---

## One-time setup (click-ops or Terraform — pick one)

### Click-ops (faster the first time, 30 min)

1. **EC2 instance** — `t4g.small` (ARM, $13/mo). Ubuntu 22.04 LTS.
   - Security group: only port 22 from your IP, port 3001 from the ALB SG.
   - Attach EBS gp3 volume 20GB → mount at `/data`.
2. **ACM cert** — request a public cert for `api.knowl.com` (and `app.knowl.com`
   if same-origin). DNS validation via Route 53 is fully automated.
3. **ALB** — application load balancer, internet-facing, listeners on :80
   (redirect to 443) and :443 (forward to target group).
   - **Idle timeout: 600s** ← critical for SSE. Default 60s will kill the
     agent mid-stream.
4. **Target group** — IP target type, port 3001, HTTP protocol.
   - **Health check path: `/healthz`** (the deep check that pings DB).
   - Healthy threshold 2, unhealthy threshold 3, interval 30s, timeout 5s.
   - **Stickiness: enabled, app-based, 1 hour** ← required so confirm_with_user
     callbacks land on the instance that's holding `pendingConfirms`.
5. **Route 53** — `A ALIAS` record from `api.knowl.com` to the ALB.

### Terraform (better second time, 1-2 hours to write)

Minimal stack (~100 lines): `aws_instance`, `aws_eip`, `aws_ebs_volume`,
`aws_lb`, `aws_lb_target_group`, `aws_lb_listener`, `aws_acm_certificate`,
`aws_route53_record`. Not provided here — keep your `terraform/` dir under
the project root if you go this route.

---

## Critical settings (don't skip these or weird stuff happens)

| Setting | Value | Why |
|---|---|---|
| ALB idle timeout | **600s** | SSE streams die at default 60s mid-response |
| Target group health check path | `/healthz` | The deep check that pings SQLite |
| Target group stickiness | **App-based, 1 hour** | `pendingConfirms` Map is in-process; the user's confirm POST must reach the same instance |
| Express `TRUST_PROXY=1` | env var | So `req.ip` reflects the real client IP through the ALB, not the ALB's IP — rate limiter accuracy depends on this |
| Security group | port 3001 from ALB SG only | Don't expose Express directly |
| EBS volume | gp3 20GB at `/data` | SQLite lives here, NOT the ephemeral instance store. `DB_PATH=/data/knowl.db` |

---

## Deploy steps after the stack exists

```bash
# On dev machine — build and push
docker build --build-arg VITE_API_BASE=https://api.knowl.com -t knowl-api:latest .

# Easy variant: push to ECR, then have the EC2 pull it
aws ecr get-login-password | docker login --username AWS --password-stdin <acct>.dkr.ecr.us-east-1.amazonaws.com
docker tag knowl-api:latest <acct>.dkr.ecr.us-east-1.amazonaws.com/knowl-api:latest
docker push <acct>.dkr.ecr.us-east-1.amazonaws.com/knowl-api:latest

# On EC2 (or via GitHub Actions over SSH, see .github/workflows/deploy.yml)
docker pull <acct>.dkr.ecr.us-east-1.amazonaws.com/knowl-api:latest
docker stop knowl-api 2>/dev/null || true
docker rm knowl-api 2>/dev/null || true
docker run -d --name knowl-api --restart unless-stopped \
  -p 3001:3001 \
  -v /data:/data \
  -v /backups:/backups \
  --env-file /etc/knowl/env \
  <acct>.dkr.ecr.us-east-1.amazonaws.com/knowl-api:latest
```

Because the ALB has stickiness enabled and health checks every 30s, the
"old container down → new container up" window is invisible to active users
(other than a brief health-check blip on the affected instance — but with
N=1 instance there IS a brief window of 503s during the swap, ~3-10 seconds.
If you can't accept that, run N=2 instances + ALB will drain one at a time).

---

## Sticky session caveat

The app's `pendingConfirms` Map and the rate-limiter's in-memory store both
require **stickiness OR a single instance**. Path A is designed for single
instance. If you ever scale to N>1 instances on the same ALB:

- Sticky cookie keeps each user pinned, which solves it for ~95% of cases.
- The remaining 5% is when a user's session cookie crosses instances during
  a confirm round-trip — then their confirm gets 410 (no pending confirm
  found). Acceptable degradation.
- Real fix is Redis-backed `pendingConfirms` (Path B territory).

---

## Cost summary

| Item | $/mo |
|---|---|
| EC2 t4g.small | ~$13 |
| EBS gp3 20GB | ~$2 |
| ALB | ~$18 |
| ACM cert | $0 |
| S3 + CloudFront (SPA + backups) | ~$2 |
| Route 53 | $0.50 |
| Data transfer | ~$3 |
| **Total** | **~$40** |

Compare to the nginx route: ~$22 (no ALB). The $18 buys you health-check
auto-restart + zero-downtime swap when you eventually scale to 2 instances.
