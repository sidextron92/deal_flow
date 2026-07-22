# deal_flow — Deploy Runbook (AWS graviton EC2, behind the Gateway)

Deploy the deal_flow Next.js app as a single container on a small graviton EC2
in the **same VPC as the prod gateway**, exposed to traders via the gateway at
`/g/deal-flow`. No K8s.

> Convention: lines prefixed `# RUN MANUALLY:` are **mutating** — copy/paste and
> run them yourself. Everything else is read-only verification. All commands use
> `--profile prod --region ap-south-1` (AWS prod account **554422457688**).

## Verified facts (this environment)
- Prod gateway runs on **AWS** (`api.bijnis.com` → AWS `ap-south-1`; EKS `bijnis-prod-eks`, private endpoint).
- Gateway VPC: **`vpc-9e875ff6`**
- Gateway/EKS cluster security group (the source of gateway→deal_flow calls): **`sg-07373311ce339650f`**
- App: basePath `/g/deal-flow`, listens on **:3000**, arm64 image ~215 MB, ~60 MB idle RAM.
- Health probe (DB-free): `GET /g/deal-flow/api/health`

## Inputs to fill before starting
| Placeholder | What it is |
|---|---|
| `<DB_HOST>` | prod DB **read-replica** endpoint (cart is read-only SELECTs) |
| `<DB_USER>` / `<DB_PASSWORD>` / `<DB_NAME>` | prod DB creds (least-priv, SELECT only if possible) |
| `<AUTH_KEY_VALUE>` | **must equal the gateway's `config.authKey`** — read it from the gateway prod config YAML |
| `<PRIVATE_SUBNET_ID>` | a private subnet inside `vpc-9e875ff6` |
| `<AL2023_ARM64_AMI>` | latest Amazon Linux 2023 **arm64** AMI id (see step 5) |
| `<DEAL_FLOW_SG_ID>` | created in step 3 |
| `<INSTANCE_ID>` / `<PRIVATE_IP>` | from step 5 |

---

## 1. Build + push the arm64 image to ECR

Build from the release branch (arm64 — matches graviton):

```
git -C ~/Documents/projects/bijnis/backend/node-services/deal_flow checkout release/deal-flow-gateway-integration
docker build --platform linux/arm64 -t deal-flow:v1 ~/Documents/projects/bijnis/backend/node-services/deal_flow
```

```
# RUN MANUALLY: create the ECR repo (once)
aws ecr create-repository --repository-name deal-flow --image-scanning-configuration scanOnPush=true --region ap-south-1 --profile prod
# RUN MANUALLY: authenticate docker to ECR
aws ecr get-login-password --region ap-south-1 --profile prod | docker login --username AWS --password-stdin 554422457688.dkr.ecr.ap-south-1.amazonaws.com
```

```
docker tag deal-flow:v1 554422457688.dkr.ecr.ap-south-1.amazonaws.com/deal-flow:v1
# RUN MANUALLY: push the image
docker push 554422457688.dkr.ecr.ap-south-1.amazonaws.com/deal-flow:v1
```

---

## 2. Store secrets in SSM Parameter Store

```
# RUN MANUALLY: non-secret params (String)
aws ssm put-parameter --name /deal-flow/prod/DB_HOST --type String --value "<DB_HOST>" --region ap-south-1 --profile prod
aws ssm put-parameter --name /deal-flow/prod/DB_PORT --type String --value "3306" --region ap-south-1 --profile prod
aws ssm put-parameter --name /deal-flow/prod/DB_USER --type String --value "<DB_USER>" --region ap-south-1 --profile prod
aws ssm put-parameter --name /deal-flow/prod/DB_NAME --type String --value "<DB_NAME>" --region ap-south-1 --profile prod
# RUN MANUALLY: secrets (SecureString)
aws ssm put-parameter --name /deal-flow/prod/DB_PASSWORD --type SecureString --value "<DB_PASSWORD>" --region ap-south-1 --profile prod
aws ssm put-parameter --name /deal-flow/prod/AUTH_KEY --type SecureString --value "<AUTH_KEY_VALUE>" --region ap-south-1 --profile prod
```

> Do **not** set `SELLER_ID` in prod — the seller must come from the gateway-injected
> `Seller-Id` header. A missing header then correctly yields 400, not a wrong seller.

---

## 3. Security group for deal_flow + ingress from the gateway

```
# RUN MANUALLY: create the app SG in the gateway VPC
aws ec2 create-security-group --group-name deal-flow-sg --description "deal_flow app (traders deal calculator)" --vpc-id vpc-9e875ff6 --region ap-south-1 --profile prod
# note the returned GroupId -> <DEAL_FLOW_SG_ID>
# RUN MANUALLY: allow ONLY the gateway (EKS cluster SG) to reach :3000 — SG-referencing-SG, no IP maintenance
aws ec2 authorize-security-group-ingress --group-id <DEAL_FLOW_SG_ID> --protocol tcp --port 3000 --source-group sg-07373311ce339650f --region ap-south-1 --profile prod
```

No public ingress. Egress stays default (needs outbound 443 to ECR/SSM + 3306 to the DB).

---

## 4. IAM instance role (ECR pull + SSM read)

Create an instance profile `deal-flow-ec2-role` with:
- managed policy **AmazonEC2ContainerRegistryReadOnly** (pull the image)
- an inline policy allowing `ssm:GetParameter*` on `arn:aws:ssm:ap-south-1:554422457688:parameter/deal-flow/prod/*` and `kms:Decrypt` for the SecureString key.
- (optional) **AmazonSSMManagedInstanceCore** for Session Manager shell access (no SSH key needed).

Create it via console, or:
```
# RUN MANUALLY: (console is simpler) create role deal-flow-ec2-role with the policies above, then an instance profile of the same name.
```

---

## 5. Launch the EC2 (t4g.small, arm64, private subnet)

```
# find the latest AL2023 arm64 AMI (read-only)
aws ssm get-parameter --name /aws/service/ami-al2023-latest/al2023-ami-kernel-default-arm64 --query Parameter.Value --output text --region ap-south-1 --profile prod
```

```
# RUN MANUALLY: launch (place in a PRIVATE subnet of vpc-9e875ff6)
aws ec2 run-instances --image-id <AL2023_ARM64_AMI> --instance-type t4g.small --subnet-id <PRIVATE_SUBNET_ID> --security-group-ids <DEAL_FLOW_SG_ID> --iam-instance-profile Name=deal-flow-ec2-role --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=deal-flow}]' --metadata-options 'HttpTokens=required' --region ap-south-1 --profile prod
```

Grab `<INSTANCE_ID>` and its `<PRIVATE_IP>` from the output (`aws ec2 describe-instances --instance-ids <INSTANCE_ID> --query 'Reservations[].Instances[].PrivateIpAddress'`).

---

## 6. On the instance — install Docker + run the container

Connect via SSM Session Manager (`aws ssm start-session --target <INSTANCE_ID> --profile prod`), then:

```
# RUN MANUALLY (on the instance): install + enable docker
sudo dnf install -y docker && sudo systemctl enable --now docker
```

Create `/opt/deal-flow/run.sh` (fetches secrets from SSM at start, runs the container):

```bash
#!/bin/bash
set -euo pipefail
REGION=ap-south-1
ACCOUNT=554422457688
IMAGE=$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/deal-flow:v1
get() { aws ssm get-parameter --name "$1" --with-decryption --region "$REGION" --query Parameter.Value --output text; }
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
docker pull "$IMAGE"
docker rm -f deal-flow 2>/dev/null || true
docker run -d --name deal-flow --restart=unless-stopped -p 3000:3000 \
  -e NODE_ENV=production \
  -e DB_HOST="$(get /deal-flow/prod/DB_HOST)" \
  -e DB_PORT="$(get /deal-flow/prod/DB_PORT)" \
  -e DB_USER="$(get /deal-flow/prod/DB_USER)" \
  -e DB_PASSWORD="$(get /deal-flow/prod/DB_PASSWORD)" \
  -e DB_NAME="$(get /deal-flow/prod/DB_NAME)" \
  -e AUTH_KEY="$(get /deal-flow/prod/AUTH_KEY)" \
  "$IMAGE"
```

Create `/etc/systemd/system/deal-flow.service` (re-runs on boot → fresh secrets/image; `--restart=unless-stopped` handles crash restarts):

```ini
[Unit]
Description=deal_flow container
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/opt/deal-flow/run.sh

[Install]
WantedBy=multi-user.target
```

```
# RUN MANUALLY (on the instance): enable + start
sudo chmod +x /opt/deal-flow/run.sh && sudo systemctl daemon-reload && sudo systemctl enable --now deal-flow.service
# verify locally on the instance
curl -s localhost:3000/g/deal-flow/api/health
```

To **redeploy** a new image later: push `:vN` to ECR, update `IMAGE` in `run.sh`, `sudo systemctl restart deal-flow`.

---

## 7. Stable endpoint — Route53 private DNS

Prefer a private DNS name over a raw IP (so replacing the instance doesn't force a gateway redeploy):

```
# RUN MANUALLY: in the internal private hosted zone, create an A record
#   deal-flow.internal.bijnis.co  ->  <PRIVATE_IP>
# (console, or aws route53 change-resource-record-sets with an UPSERT A record, TTL 60)
```

---

## 8. Wire the gateway (activates the feature)

The gateway change is **feature-gated on `config.dealFlowUrl`** — until this key is
added, the gateway is unchanged (proven: route table identical without it).

In each prod gateway env YAML, under `config:`:
```yaml
config:
  dealFlowUrl: "http://deal-flow.internal.bijnis.co:3000"   # or http://<PRIVATE_IP>:3000
  # authKey: already present — deal_flow AUTH_KEY (SSM) MUST equal this value
```

Then redeploy/restart the gateway so it re-reads config and mounts the `/g/deal-flow` group.

---

## 9. Rollout order (safe, staged)

1. **Merge + deploy the gateway** release branch first — with **no** `config.dealFlowUrl`. It's inert (existing routes byte-for-byte identical). Confirm existing endpoints unaffected.
2. **Deploy deal_flow** (steps 1–7). Verify on the instance: `curl localhost:3000/g/deal-flow/api/health` → 200.
3. **From a gateway pod**, confirm reachability (read-only):
   `kubectl exec <gateway-pod> -- curl -s http://deal-flow.internal.bijnis.co:3000/g/deal-flow/api/health`
4. **Add `config.dealFlowUrl`** to gateway config + restart gateway.
5. **End-to-end** with a real FOS token:
   - `curl https://api.bijnis.com/g/deal-flow/api/health` → 200 (public)
   - `curl -H "token: <FOS_JWT>" -H "User-Type: fos" "https://api.bijnis.com/g/deal-flow/api/cart?phone=<retailer>"` → 200 + items
   - no token → 401
6. Point the RN app webview at `https://api.bijnis.com/g/deal-flow`.

## 10. Rollback

- **Disable the feature instantly:** remove `config.dealFlowUrl` from gateway config + restart → `/g/deal-flow` 404, every other route unchanged. (No need to touch the EC2.)
- **App issue:** `sudo systemctl stop deal-flow` on the instance, or roll `run.sh` back to the previous `:vN` image and restart.

## Coordination checklist
- [ ] deal_flow `AUTH_KEY` (SSM) == gateway `config.authKey`
- [ ] deal_flow EC2 in `vpc-9e875ff6`, SG ingress `:3000` from `sg-07373311ce339650f` only
- [ ] `SELLER_ID` NOT set in prod (seller comes from gateway header)
- [ ] DB points at the read-replica
- [ ] gateway deployed inert first, `config.dealFlowUrl` added last
