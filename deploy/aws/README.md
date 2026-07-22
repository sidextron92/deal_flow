# deal_flow — AWS deploy suite (IP-first v1)

Launches deal_flow as a single container on a small graviton EC2 in the prod
gateway VPC, reachable only by the gateway, exposed to traders at
`https://api.bijnis.com/g/deal-flow`. No K8s.

> **Safety:** these scripts create **production** resources. Run them yourself.
> Every script accepts `--dry-run` to print its commands without executing.
> All fixed infra IDs were verified read-only on 2026-07-16 by `00-verify.sh`.

## Files
| File | What it does | Mutates? |
|---|---|---|
| `00-verify.sh` | Read-only pre-flight — checks account, AMI, subnet, SG, key pair, ECR/IAM state, no dup instance | no |
| `config.env.example` | Template for your inputs → copy to `config.env` (gitignored) | no |
| `_common.sh` | Shared infra IDs + helpers (sourced) | no |
| `01-provision.sh` | ECR repo · SG + ingress · IAM role/profile · SSM secrets (idempotent) | **yes** |
| `02-build-push.sh` | `docker build --platform linux/arm64` + push to ECR | **yes** |
| `user-data.sh` | EC2 first-boot bootstrap (docker + cli + run.sh + systemd) | — (runs on the box) |
| `03-launch.sh` | `run-instances` (self-deploys), waits, prints private IP; guards against double-launch | **yes** |
| `04-dns.sh` | *Optional, not v1* — GCP Cloud DNS name; gated behind a resolution check | prints only |
| `05-wire-gateway.md` | Manual: add `config.dealFlowUrl` + verify end-to-end | manual |

## Run order
```
cp deploy/aws/config.env.example deploy/aws/config.env   # then fill DB creds + AUTH_KEY
bash deploy/aws/00-verify.sh                              # all green?
bash deploy/aws/01-provision.sh --dry-run                 # review
bash deploy/aws/01-provision.sh                           # ECR·SG·IAM·SSM
bash deploy/aws/02-build-push.sh                          # image → ECR
bash deploy/aws/03-launch.sh                              # launch + print PRIVATE_IP
# follow 05-wire-gateway.md to set config.dealFlowUrl = http://<PRIVATE_IP>:3000
```

## Redeploy a change (day-to-day) — `deploy.sh`

Once the instance exists, shipping a code change is a **one-liner** anyone on the
team can run from their laptop. It needs only **prod AWS creds + Docker + this
repo** — no `config.env`, no secrets (DB creds + AUTH_KEY already live in SSM),
no SSH/bastion (it rolls the box via SSM Run Command).

```
git pull                                  # get the change
export AWS_PROFILE=prod                    # prod creds
bash deploy/aws/deploy.sh                  # build HEAD (arm64) → push → roll the box → health-check
```

What it does: builds an arm64 image tagged with the **git short SHA**, pushes to
ECR, pins it in SSM (`/deal-flow/prod/IMAGE`), then via SSM (re)installs a
self-healing `run.sh` that pulls the SSM-pinned image + re-reads secrets, restarts
the container, and polls `/g/deal-flow/api/health` until green. Prints the deployed
image and a ready-to-paste rollback command.

| Flag | Effect |
|---|---|
| `--dry-run` | print the plan (instance, image, build?), touch nothing |
| `--tag <sha>` | **rollback / redeploy an existing ECR tag** (no build) |
| `--yes` / `-y` | skip the confirm prompt (CI) |
| `--allow-dirty` | build from an uncommitted tree (tag gets `-dirty-<ts>`) |
| `--force-build` | rebuild even if the SHA tag is already in ECR |

**Rollback** (instant, no build): re-point at the previous image. `deploy.sh` prints
the exact command on every deploy, e.g.
```
bash deploy/aws/deploy.sh --tag <previous-sha> --yes
```

Guards: refuses to run outside the prod account, refuses a dirty tree unless
`--allow-dirty`, and if the health check fails it says so and leaves the previous
container's rollback command — the old container keeps serving until you act.

> First run migrates the box from the launch-time hardcoded image to the
> SSM-pinned one; every deploy/reboot after that uses the SSM `IMAGE`. Prereq on
> your IAM user: `ssm:SendCommand` + `ssm:GetCommandInvocation` (read).

(Full rebuild-from-scratch — new instance — still uses `01`→`02`→`03`.)

## Cost (incremental, ~$15/mo)
t4g.small ~$13 · 20 GB gp3 ~$1.6 · ECR storage ~$0.10 · NAT/data $0 (reuses
existing NAT). A 1-yr Savings Plan cuts compute ~40%.

## Rollback
- **Feature off (instant):** remove `config.dealFlowUrl` from gateway + restart → `/g/deal-flow` 404, all else unchanged.
- **App issue:** `sudo systemctl stop deal-flow` on the box, or roll `run.sh` back to the previous `:vN` and restart.

## Access the box
- **SSM (no key, from laptop):** `aws ssm start-session --target <INSTANCE_ID> --profile prod`
- **SSH (via bastion/VPN):** `ssh -i .../pemfiles/bijnis-master.pem ec2-user@<PRIVATE_IP>` — the instance is launched with key pair `bijnis-master`; it has no public IP, so you must be on-network (jumpbox/OpenVPN).
