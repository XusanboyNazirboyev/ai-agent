#!/bin/sh
# One-time AWS setup for the GitHub Actions deploy (ADR 035 step 6). Run by
# the owner with an AWS profile that may manage IAM:
#   sh deploy/aws/github-deploy-role.sh <aws profile> <instance id>
# Creates (if missing) the GitHub OIDC identity provider and the role
# `tezda-github-deploy`, which only the `feat/production-pilot` branch of this
# repository can assume and which can only send a shell command to the given
# staging instance and read the result. No long-lived keys are created.
#
# The repository was created after 2026-07-15, so GitHub signs an immutable
# subject with numeric ids (read from GET repos/<repo>/actions/oidc/
# customization/sub on 2026-11-04).
set -eu

profile="${1:?usage: github-deploy-role.sh <aws profile> <instance id>}"
instance="${2:?usage: github-deploy-role.sh <aws profile> <instance id>}"
region=eu-central-1
role=tezda-github-deploy
subject='repo:XusanboyNazirboyev@244120293/ai-agent@1430650024:ref:refs/heads/feat/production-pilot'

aws() { command aws --profile "$profile" "$@"; }
account="$(aws sts get-caller-identity --query Account --output text)"
provider="arn:aws:iam::$account:oidc-provider/token.actions.githubusercontent.com"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

if ! aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$provider" >/dev/null 2>&1; then
  aws iam create-open-id-connect-provider \
    --url https://token.actions.githubusercontent.com \
    --client-id-list sts.amazonaws.com >/dev/null
  echo "created the GitHub OIDC provider"
fi

cat > "$work/trust.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "$provider" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        "token.actions.githubusercontent.com:sub": "$subject"
      }
    }
  }]
}
EOF

cat > "$work/permissions.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DeployToStagingHost",
      "Effect": "Allow",
      "Action": "ssm:SendCommand",
      "Resource": [
        "arn:aws:ec2:$region:$account:instance/$instance",
        "arn:aws:ssm:$region::document/AWS-RunShellScript"
      ]
    },
    {
      "Sid": "ReadCommandResult",
      "Effect": "Allow",
      "Action": ["ssm:GetCommandInvocation", "ssm:ListCommandInvocations"],
      "Resource": "*"
    }
  ]
}
EOF

if aws iam get-role --role-name "$role" >/dev/null 2>&1; then
  aws iam update-assume-role-policy --role-name "$role" \
    --policy-document "file://$work/trust.json"
else
  aws iam create-role --role-name "$role" --max-session-duration 3600 \
    --description 'GitHub Actions deploy to tezda staging (ADR 035 step 6)' \
    --assume-role-policy-document "file://$work/trust.json" >/dev/null
  echo "created the role $role"
fi
aws iam put-role-policy --role-name "$role" \
  --policy-name deploy-staging-via-ssm \
  --policy-document "file://$work/permissions.json"

echo "role ready: arn:aws:iam::$account:role/$role"
