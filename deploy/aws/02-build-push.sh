#!/usr/bin/env bash
# -------------------------------------------------------------------------
# 02 · Build the arm64 image and push it to ECR.
#   bash deploy/aws/02-build-push.sh            # build + push $IMAGE_TAG
#   bash deploy/aws/02-build-push.sh --dry-run  # print commands only
#
# Builds from the repo root Dockerfile (multi-stage, node:24-alpine,
# NEXT_PUBLIC_BASE_PATH=/g/deal-flow). Requires Docker with buildx/arm64
# (Docker Desktop on Apple Silicon builds arm64 natively).
# -------------------------------------------------------------------------
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"   # …/deal_flow

c_hdr "0. identity"
require_account

c_hdr "1. build (linux/arm64) → deal-flow:$IMAGE_TAG"
c_info "context: $REPO_ROOT"
mut docker build --platform linux/arm64 -t "deal-flow:$IMAGE_TAG" "$REPO_ROOT"

c_hdr "2. ECR login"
if [ "$DRY_RUN" -eq 1 ]; then
  printf '  \033[36m$\033[0m aws ecr get-login-password | docker login --username AWS --password-stdin %s\n' "$ECR_URI"
else
  aws ecr get-login-password --region "$AWS_REGION" \
    | docker login --username AWS --password-stdin "$ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com" \
    && c_ok "logged in to ECR"
fi

c_hdr "3. tag + push → $IMAGE"
mut docker tag "deal-flow:$IMAGE_TAG" "$IMAGE"
mut docker push "$IMAGE"

c_hdr "done"
c_ok "pushed $IMAGE"
c_info "next: bash deploy/aws/03-launch.sh"
