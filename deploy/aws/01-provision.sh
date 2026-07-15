#!/usr/bin/env bash
# -------------------------------------------------------------------------
# 01 · Provision supporting resources (idempotent). Safe to re-run.
#   - ECR repo            deal-flow
#   - Security group      deal-flow-sg  (+ ingress :3000 from the gateway SG)
#   - IAM role + profile  deal-flow-ec2-role  (ECR read · SSM read · SSM core)
#   - SSM params          /deal-flow/prod/*   (DB creds + AUTH_KEY)
#
#   bash deploy/aws/01-provision.sh            # apply
#   bash deploy/aws/01-provision.sh --dry-run  # print commands only
# -------------------------------------------------------------------------
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

c_hdr "0. identity"
require_account

# --- ECR repo ------------------------------------------------------------
c_hdr "1. ECR repo ($ECR_REPO)"
if aws ecr describe-repositories --repository-names "$ECR_REPO" --region "$AWS_REGION" >/dev/null 2>&1; then
  c_ok "repo exists: $ECR_URI"
else
  mut aws ecr create-repository --repository-name "$ECR_REPO" \
      --image-scanning-configuration scanOnPush=true \
      --image-tag-mutability IMMUTABLE --region "$AWS_REGION" >/dev/null
  c_ok "created $ECR_URI"
fi

# --- Security group ------------------------------------------------------
c_hdr "2. Security group ($DEAL_SG_NAME) + ingress :3000 from gateway"
DEAL_SG="$(aws ec2 describe-security-groups \
  --filters "Name=group-name,Values=$DEAL_SG_NAME" "Name=vpc-id,Values=$VPC" \
  --query 'SecurityGroups[0].GroupId' --output text --region "$AWS_REGION" 2>/dev/null || echo None)"
if [ "$DEAL_SG" = "None" ] || [ -z "$DEAL_SG" ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  \033[36m$\033[0m aws ec2 create-security-group --group-name %s --vpc-id %s ...\n' "$DEAL_SG_NAME" "$VPC"
    DEAL_SG="sg-DRYRUN"
  else
    DEAL_SG="$(aws ec2 create-security-group --group-name "$DEAL_SG_NAME" \
      --description "deal_flow app (traders deal calculator)" --vpc-id "$VPC" \
      --query GroupId --output text --region "$AWS_REGION")"
    aws ec2 create-tags --resources "$DEAL_SG" --tags Key=Name,Value="$DEAL_SG_NAME" --region "$AWS_REGION" >/dev/null 2>&1 || true
  fi
  c_ok "created SG $DEAL_SG"
else
  c_ok "SG exists: $DEAL_SG"
fi

HAS_RULE="$(aws ec2 describe-security-groups --group-ids "$DEAL_SG" --region "$AWS_REGION" \
  --query "length(SecurityGroups[0].IpPermissions[?FromPort==\`3000\` && ToPort==\`3000\`].UserIdGroupPairs[?GroupId=='$GATEWAY_SG'][])" \
  --output text 2>/dev/null || echo 0)"
if [ "${HAS_RULE:-0}" != "0" ]; then
  c_ok "ingress :3000 from $GATEWAY_SG already present"
else
  mut aws ec2 authorize-security-group-ingress --group-id "$DEAL_SG" \
      --protocol tcp --port 3000 --source-group "$GATEWAY_SG" --region "$AWS_REGION" >/dev/null 2>&1 \
    && c_ok "added ingress :3000 from $GATEWAY_SG (gateway only)" \
    || c_warn "authorize skipped (dry-run, or rule already exists)"
fi
c_info "no public ingress; egress default (443→ECR/SSM, 3306→DB via existing NAT)"

# --- IAM role + instance profile ----------------------------------------
c_hdr "3. IAM role + instance profile ($IAM_ROLE)"
TRUST="$(mktemp)"; INLINE="$(mktemp)"
cat > "$TRUST" <<'JSON'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}
JSON
cat > "$INLINE" <<JSON
{"Version":"2012-10-17","Statement":[
  {"Effect":"Allow","Action":["ssm:GetParameter","ssm:GetParameters","ssm:GetParametersByPath"],
   "Resource":"arn:aws:ssm:$AWS_REGION:$ACCOUNT:parameter$SSM_PREFIX/*"},
  {"Effect":"Allow","Action":["kms:Decrypt"],"Resource":"*",
   "Condition":{"StringEquals":{"kms:ViaService":"ssm.$AWS_REGION.amazonaws.com"}}}
]}
JSON

if aws iam get-role --role-name "$IAM_ROLE" >/dev/null 2>&1; then
  c_ok "role exists"
else
  mut aws iam create-role --role-name "$IAM_ROLE" \
      --assume-role-policy-document "file://$TRUST" \
      --description "deal_flow EC2: ECR pull + SSM read" >/dev/null
  c_ok "created role"
fi
mut aws iam attach-role-policy --role-name "$IAM_ROLE" --policy-arn arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly >/dev/null 2>&1 || true
mut aws iam attach-role-policy --role-name "$IAM_ROLE" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore >/dev/null 2>&1 || true
mut aws iam put-role-policy --role-name "$IAM_ROLE" --policy-name deal-flow-ssm-read --policy-document "file://$INLINE" >/dev/null 2>&1 || true
c_ok "policies attached (ECR read · SSM core · scoped SSM/kms read)"

if aws iam get-instance-profile --instance-profile-name "$IAM_ROLE" >/dev/null 2>&1; then
  c_ok "instance profile exists"
else
  mut aws iam create-instance-profile --instance-profile-name "$IAM_ROLE" >/dev/null
  c_ok "created instance profile"
fi
# add-role-to-instance-profile errors if already linked → tolerate
mut aws iam add-role-to-instance-profile --instance-profile-name "$IAM_ROLE" --role-name "$IAM_ROLE" >/dev/null 2>&1 || true
rm -f "$TRUST" "$INLINE"

# --- SSM params ----------------------------------------------------------
c_hdr "4. SSM parameters ($SSM_PREFIX/*)"
put_str()    { # name value  (value hidden in output)
  local n="$1" v="${2:-}"
  [ -z "$v" ] && { c_warn "skip $n — empty in config.env"; return 0; }
  printf '  \033[36m$\033[0m aws ssm put-parameter --name %s --type String --value *** --overwrite\n' "$n"
  [ "$DRY_RUN" -eq 1 ] && return 0
  aws ssm put-parameter --name "$n" --type String --value "$v" --overwrite --region "$AWS_REGION" >/dev/null && c_ok "$n"
}
put_secret() { # name value  (value hidden)
  local n="$1" v="${2:-}"
  [ -z "$v" ] && { c_warn "skip $n — empty in config.env"; return 0; }
  printf '  \033[36m$\033[0m aws ssm put-parameter --name %s --type SecureString --value *** --overwrite\n' "$n"
  [ "$DRY_RUN" -eq 1 ] && return 0
  aws ssm put-parameter --name "$n" --type SecureString --value "$v" --overwrite --region "$AWS_REGION" >/dev/null && c_ok "$n (encrypted)"
}
put_str    "$SSM_PREFIX/DB_HOST"     "${DB_HOST:-}"
put_str    "$SSM_PREFIX/DB_PORT"     "${DB_PORT:-3306}"
put_str    "$SSM_PREFIX/DB_USER"     "${DB_USER:-}"
put_str    "$SSM_PREFIX/DB_NAME"     "${DB_NAME:-}"
put_secret "$SSM_PREFIX/DB_PASSWORD" "${DB_PASSWORD:-}"
put_secret "$SSM_PREFIX/AUTH_KEY"    "${AUTH_KEY:-}"

c_hdr "done"
c_ok "provision complete. SG=$DEAL_SG · role=$IAM_ROLE · repo=$ECR_URI"
c_info "next: bash deploy/aws/02-build-push.sh"
