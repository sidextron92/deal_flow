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

## Redeploy a new build
```
# bump IMAGE_TAG in config.env (v2, v3…), then:
bash deploy/aws/02-build-push.sh
# on the instance (via SSM/bastion): update IMAGE in /opt/deal-flow/run.sh and:
sudo systemctl restart deal-flow
```
(Or terminate + re-launch: `03-launch.sh` reads the new `IMAGE_TAG`.)

## Cost (incremental, ~$15/mo)
t4g.small ~$13 · 20 GB gp3 ~$1.6 · ECR storage ~$0.10 · NAT/data $0 (reuses
existing NAT). A 1-yr Savings Plan cuts compute ~40%.

## Rollback
- **Feature off (instant):** remove `config.dealFlowUrl` from gateway + restart → `/g/deal-flow` 404, all else unchanged.
- **App issue:** `sudo systemctl stop deal-flow` on the box, or roll `run.sh` back to the previous `:vN` and restart.

## Access the box
- **SSM (no key, from laptop):** `aws ssm start-session --target <INSTANCE_ID> --profile prod`
- **SSH (via bastion/VPN):** `ssh -i .../pemfiles/bijnis-master.pem ec2-user@<PRIVATE_IP>` — the instance is launched with key pair `bijnis-master`; it has no public IP, so you must be on-network (jumpbox/OpenVPN).
