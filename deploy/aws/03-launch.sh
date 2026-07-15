#!/usr/bin/env bash
# -------------------------------------------------------------------------
# 03 · Launch the EC2 instance (self-deploys via user-data).
#   bash deploy/aws/03-launch.sh            # launch
#   bash deploy/aws/03-launch.sh --dry-run  # print the run-instances call
#
# GUARD: refuses to launch if an instance tagged Name=deal-flow is already
# pending/running (prevents accidental double-launch on re-run).
# Requires 01-provision (SG + role + SSM) and 02-build-push (image) first.
# -------------------------------------------------------------------------
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

c_hdr "0. identity"
require_account

# --- guard: no existing instance ----------------------------------------
c_hdr "1. duplicate-launch guard"
RUNNING="$(aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=$INSTANCE_NAME" "Name=instance-state-name,Values=pending,running" \
  --query 'Reservations[].Instances[].InstanceId' --output text --region "$AWS_REGION" 2>/dev/null || echo '')"
if [ -n "$RUNNING" ]; then
  c_err "instance tagged Name=$INSTANCE_NAME already exists: $RUNNING"
  c_err "reuse it, or terminate it first. Refusing to launch a duplicate."
  exit 1
fi
c_ok "none running — safe to launch"

# --- prerequisites: SG + image ------------------------------------------
c_hdr "2. prerequisites"
DEAL_SG="$(aws ec2 describe-security-groups \
  --filters "Name=group-name,Values=$DEAL_SG_NAME" "Name=vpc-id,Values=$VPC" \
  --query 'SecurityGroups[0].GroupId' --output text --region "$AWS_REGION" 2>/dev/null || echo None)"
if [ "$DEAL_SG" = "None" ] || [ -z "$DEAL_SG" ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    c_warn "SG $DEAL_SG_NAME not found (dry-run) — using placeholder sg-DRYRUN"; DEAL_SG="sg-DRYRUN"
  else
    c_err "SG $DEAL_SG_NAME not found — run 01-provision.sh first."; exit 1
  fi
else
  c_ok "SG $DEAL_SG"
fi
if aws ecr describe-images --repository-name "$ECR_REPO" --image-ids imageTag="$IMAGE_TAG" --region "$AWS_REGION" >/dev/null 2>&1; then
  c_ok "image present: $IMAGE"
else
  c_warn "image $IMAGE not found in ECR — run 02-build-push.sh first (continuing; --dry-run ok)"
  [ "$DRY_RUN" -eq 0 ] && { c_err "aborting: no image to run"; exit 1; }
fi

# --- render user-data ----------------------------------------------------
c_hdr "3. render user-data (self-deploy bootstrap)"
UD="$(mktemp)"
sed -e "s|__REGION__|$AWS_REGION|g" \
    -e "s|__ACCOUNT__|$ACCOUNT|g" \
    -e "s|__IMAGE__|$IMAGE|g" \
    -e "s|__SSM_PREFIX__|$SSM_PREFIX|g" \
    "$HERE/user-data.sh" > "$UD"
c_ok "user-data rendered ($UD) — installs docker+cli, pulls $IMAGE, reads SSM, runs :3000"

# --- launch --------------------------------------------------------------
c_hdr "4. run-instances (t4g.small arm64, private subnet)"
RUN_ARGS=(
  --image-id "$AMI"
  --instance-type "$INSTANCE_TYPE"
  --subnet-id "$SUBNET"
  --security-group-ids "$DEAL_SG"
  --key-name "$KEY_NAME"
  --iam-instance-profile "Name=$IAM_ROLE"
  --user-data "file://$UD"
  --metadata-options "HttpTokens=required,HttpEndpoint=enabled"
  --block-device-mappings "DeviceName=/dev/xvda,Ebs={VolumeSize=20,VolumeType=gp3,DeleteOnTermination=true,Encrypted=true}"
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$INSTANCE_NAME},{Key=app,Value=deal-flow}]"
  --region "$AWS_REGION"
)
if [ "$DRY_RUN" -eq 1 ]; then
  printf '  \033[36m$\033[0m aws ec2 run-instances %s --query Instances[0].InstanceId\n' "${RUN_ARGS[*]}"
  c_info "dry-run: not launching. Remove --dry-run to execute."
  rm -f "$UD"; exit 0
fi
IID="$(aws ec2 run-instances "${RUN_ARGS[@]}" --query 'Instances[0].InstanceId' --output text)"
rm -f "$UD"
[ -z "$IID" ] && { c_err "run-instances returned no InstanceId"; exit 1; }
c_ok "launched $IID"

c_hdr "5. wait for running + fetch private IP"
aws ec2 wait instance-running --instance-ids "$IID" --region "$AWS_REGION"
PRIV_IP="$(aws ec2 describe-instances --instance-ids "$IID" \
  --query 'Reservations[0].Instances[0].PrivateIpAddress' --output text --region "$AWS_REGION")"
c_ok "instance $IID is running · private IP = $PRIV_IP"

c_hdr "done"
cat <<EOF
  Instance : $IID
  Private  : $PRIV_IP  (no public IP — reach via bastion/VPN or SSM)
  App boots via user-data (~1–2 min): docker install → pull → run :3000.

  Verify (from a bastion/VPN host, or SSM):
    aws ssm start-session --target $IID --profile prod
    # then on the box:
    curl -s localhost:3000/g/deal-flow/api/health
    sudo tail -f /var/log/deal-flow-bootstrap.log   # if health is slow

  Then wire the gateway (see 05-wire-gateway.md):
    config.dealFlowUrl: "http://$PRIV_IP:3000"
    (config.authKey must equal deal_flow AUTH_KEY)
EOF
