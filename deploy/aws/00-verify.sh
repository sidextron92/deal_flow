#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# deal_flow deploy — READ-ONLY pre-flight verifier.
# Confirms every precondition the launch/deploy depends on. Mutates NOTHING
# (only aws ec2/ecr/sts describe|list + local openssl + gcloud dns list).
# Safe to run as many times as you like.
#
#   bash deploy/aws/00-verify.sh
#
# Exit 0 = all HARD checks passed. Exit 1 = a blocker is missing.
# INFO/WARN lines never fail the run — they tell provision/launch what to do.
# ---------------------------------------------------------------------------
set +e   # a missing resource must print a FAIL line, not abort the script

# --- config (edit only if you change the target) ---------------------------
export AWS_PROFILE="${AWS_PROFILE:-prod}"
export AWS_REGION="${AWS_REGION:-ap-south-1}"
ACCOUNT_EXPECTED="554422457688"
VPC="vpc-9e875ff6"
GATEWAY_SG="sg-07373311ce339650f"          # source allowed to reach :3000
SUBNET="${SUBNET:-subnet-02d50562903e96e1e}"   # private, ap-south-1a
AMI="${AMI:-ami-027f2df6eaf3477f9}"        # AL2023 arm64 (2026-07-10)
KEY_NAME="bijnis-master"
PEM="${PEM:-/Users/learningsclub/Documents/projects/bijnis/backend/pemfiles/bijnis-master.pem}"
ECR_REPO="deal-flow"
IAM_ROLE="deal-flow-ec2-role"
DNS_FQDN="deal-flow.internal.bijnis.co"
GCP_DNS_ZONE="internal-bijnis-co"
INSTANCE_TAG="deal-flow"

FAILS=0
pass() { printf '  \033[32m✓ PASS\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31m✗ FAIL\033[0m  %s\n' "$1"; FAILS=$((FAILS+1)); }
info() { printf '  \033[36mℹ INFO\033[0m  %s\n' "$1"; }
warn() { printf '  \033[33m! WARN\033[0m  %s\n' "$1"; }
hdr()  { printf '\n\033[1m%s\033[0m\n' "$1"; }

AWS() { aws --region "$AWS_REGION" "$@"; }

# ---------------------------------------------------------------------------
hdr "0. AWS identity — must be the PROD account"
ACCT="$(AWS sts get-caller-identity --query Account --output text 2>/dev/null)"
if [ "$ACCT" = "$ACCOUNT_EXPECTED" ]; then
  pass "authenticated to prod ($ACCT) via AWS_PROFILE=$AWS_PROFILE, region $AWS_REGION"
else
  fail "wrong/absent account: got '${ACCT:-<none>}', expected $ACCOUNT_EXPECTED. Run: adev? no — export AWS_PROFILE=prod"
  echo; echo "Aborting further checks — fix credentials first."; exit 1
fi

# ---------------------------------------------------------------------------
hdr "1. AMI — AL2023 arm64 available"
STATE="$(AWS ec2 describe-images --image-ids "$AMI" --query 'Images[0].State' --output text 2>/dev/null)"
NAME="$(AWS ec2 describe-images --image-ids "$AMI" --query 'Images[0].Name' --output text 2>/dev/null)"
if [ "$STATE" = "available" ]; then pass "$AMI available ($NAME)"; else fail "$AMI not available (state=${STATE:-none})"; fi

# ---------------------------------------------------------------------------
hdr "2. Network — VPC + private subnet + egress route"
VPC_STATE="$(AWS ec2 describe-vpcs --vpc-ids "$VPC" --query 'Vpcs[0].State' --output text 2>/dev/null)"
[ "$VPC_STATE" = "available" ] && pass "VPC $VPC available" || fail "VPC $VPC not available (${VPC_STATE:-none})"

SUB_VPC="$(AWS ec2 describe-subnets --subnet-ids "$SUBNET" --query 'Subnets[0].VpcId' --output text 2>/dev/null)"
SUB_AZ="$(AWS ec2 describe-subnets --subnet-ids "$SUBNET" --query 'Subnets[0].AvailabilityZone' --output text 2>/dev/null)"
SUB_PUB="$(AWS ec2 describe-subnets --subnet-ids "$SUBNET" --query 'Subnets[0].MapPublicIpOnLaunch' --output text 2>/dev/null)"
if [ "$SUB_VPC" = "$VPC" ]; then
  pass "subnet $SUBNET in $VPC ($SUB_AZ)"
  [ "$SUB_PUB" = "False" ] && pass "subnet is private (MapPublicIpOnLaunch=False)" \
                           || warn "subnet auto-assigns public IP (=$SUB_PUB) — expected private"
else
  fail "subnet $SUBNET not in $VPC (vpc=${SUB_VPC:-none})"
fi

# egress: the subnet's route table must have a default route via a NAT gateway
RTB="$(AWS ec2 describe-route-tables --filters "Name=association.subnet-id,Values=$SUBNET" --query 'RouteTables[0].RouteTableId' --output text 2>/dev/null)"
[ "$RTB" = "None" -o -z "$RTB" ] && RTB="$(AWS ec2 describe-route-tables --filters "Name=vpc-id,Values=$VPC" "Name=association.main,Values=true" --query 'RouteTables[0].RouteTableId' --output text 2>/dev/null)"
NAT="$(AWS ec2 describe-route-tables --route-table-ids "$RTB" --query "RouteTables[0].Routes[?DestinationCidrBlock=='0.0.0.0/0'].NatGatewayId | [0]" --output text 2>/dev/null)"
if [ -n "$NAT" ] && [ "$NAT" != "None" ]; then
  pass "outbound egress OK — $RTB routes 0.0.0.0/0 → $NAT (ECR/SSM/DB reachable, no new NAT cost)"
else
  warn "no NAT default-route found on $RTB — instance may not reach ECR/SSM. Verify VPC endpoints exist, or pick another subnet."
fi

# ---------------------------------------------------------------------------
hdr "3. Gateway security group (the only allowed source to :3000)"
SG_OK="$(AWS ec2 describe-security-groups --group-ids "$GATEWAY_SG" --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null)"
[ "$SG_OK" = "$GATEWAY_SG" ] && pass "gateway SG $GATEWAY_SG exists" || fail "gateway SG $GATEWAY_SG not found"

# ---------------------------------------------------------------------------
hdr "4. SSH key — bijnis-master.pem matches the AWS key pair"
AWS_FP="$(AWS ec2 describe-key-pairs --key-names "$KEY_NAME" --query 'KeyPairs[0].KeyFingerprint' --output text 2>/dev/null)"
if [ -z "$AWS_FP" ] || [ "$AWS_FP" = "None" ]; then
  fail "AWS key pair '$KEY_NAME' not found in $AWS_REGION"
elif [ ! -f "$PEM" ]; then
  fail "pem not found at $PEM (AWS key pair '$KEY_NAME' exists, fp=$AWS_FP)"
else
  PEM_FP="$(openssl pkcs8 -in "$PEM" -nocrypt -topk8 -outform DER 2>/dev/null | openssl sha1 -c 2>/dev/null | awk '{print $2}')"
  if [ "$PEM_FP" = "$AWS_FP" ]; then
    pass "pem matches key pair '$KEY_NAME' (fp=$AWS_FP) → launch with --key-name $KEY_NAME"
  else
    fail "pem fingerprint ($PEM_FP) != AWS key pair '$KEY_NAME' ($AWS_FP)"
  fi
fi
info "instance is private-subnet only — SSH reaches it via bastion/VPN, not directly from laptop (SSM Session Manager also available)"

# ---------------------------------------------------------------------------
hdr "5. ECR repo (provision will CREATE it if absent)"
ECR_URI="$(AWS ecr describe-repositories --repository-names "$ECR_REPO" --query 'repositories[0].repositoryUri' --output text 2>/dev/null)"
if [ -n "$ECR_URI" ] && [ "$ECR_URI" != "None" ]; then
  info "ECR repo already exists: $ECR_URI (reuse it)"
else
  info "ECR repo '$ECR_REPO' does NOT exist yet → 01-provision.sh will create it (free; storage only)"
fi

# ---------------------------------------------------------------------------
hdr "6. IAM instance role (provision will CREATE it if absent)"
ROLE_OK="$(aws iam get-role --role-name "$IAM_ROLE" --query 'Role.RoleName' --output text 2>/dev/null)"
if [ -n "$ROLE_OK" ] && [ "$ROLE_OK" != "None" ]; then
  info "IAM role '$IAM_ROLE' already exists (reuse it)"
else
  info "IAM role '$IAM_ROLE' does NOT exist yet → 01-provision.sh will create it (ECR read + SSM read + SSM core)"
fi

# ---------------------------------------------------------------------------
hdr "7. No duplicate instance already running (guard against double-launch)"
RUNNING="$(AWS ec2 describe-instances --filters "Name=tag:Name,Values=$INSTANCE_TAG" "Name=instance-state-name,Values=pending,running" --query 'Reservations[].Instances[].InstanceId' --output text 2>/dev/null)"
if [ -z "$RUNNING" ]; then
  pass "no running instance tagged Name=$INSTANCE_TAG — safe to launch a fresh one"
else
  warn "an instance tagged Name=$INSTANCE_TAG is ALREADY running: $RUNNING — 03-launch.sh will refuse. Reuse or terminate it first."
fi

# ---------------------------------------------------------------------------
hdr "8. DNS — no collision for $DNS_FQDN (GCP Cloud DNS, not Route53)"
if command -v gcloud >/dev/null 2>&1; then
  HIT="$(gcloud dns record-sets list --zone="$GCP_DNS_ZONE" --name="${DNS_FQDN}." --format='value(name)' 2>/dev/null)"
  if [ -z "$HIT" ]; then
    pass "no existing record for $DNS_FQDN in GCP zone '$GCP_DNS_ZONE' — safe to create (if you choose the DNS path)"
  else
    warn "record already exists for $DNS_FQDN — 04-dns.sh would UPSERT (overwrite) it: $HIT"
  fi
  info "reminder: AWS→GCP resolution of internal.bijnis.co from $VPC is UNVERIFIED — IP-first config.dealFlowUrl avoids this dependency for v1"
else
  info "gcloud not on PATH — skipping DNS collision check (DNS lives in GCP Cloud DNS zone '$GCP_DNS_ZONE')"
fi

# ---------------------------------------------------------------------------
hdr "Summary"
if [ "$FAILS" -eq 0 ]; then
  printf '  \033[32mAll hard checks passed.\033[0m Provision/launch preconditions are met.\n'
  exit 0
else
  printf '  \033[31m%d hard check(s) FAILED.\033[0m Resolve them before running 01-provision.sh.\n' "$FAILS"
  exit 1
fi
