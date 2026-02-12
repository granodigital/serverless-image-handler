#!/usr/bin/env bash
set -eo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ACTION=${1:-}

# Action needs to be a diff, deploy or synth
if [[ "$ACTION" != "diff" && "$ACTION" != "deploy" && "$ACTION" != "synth" ]]; then
	echo "Usage: $0 <diff|deploy|synth>"
	exit 1
fi

(
	cd source/constructs || exit 1
	npm run clean:install
)

# If AWS_PROFILE is set already, use it.
if [ -n "${AWS_PROFILE:-}" ]; then
	echo "Using the current AWS_PROFILE ($AWS_PROFILE)!"
else
	# shellcheck source=/dev/null
	source "$DIR/../../ecom-infrastructure/.active-profile"

	# Check that AWS Profile is not missing.
	[[ -z "${AWS_PROFILE:-}" ]] && {
		echo "AWS_PROFILE is not set"
		exit 1
	}

	echo "Using current active profile ($AWS_PROFILE)"
fi

cd "$DIR/../source/constructs" || exit 1

CERTIFICATE_ARN="arn:aws:acm:us-east-1:897068463773:certificate/5a7f1107-af4b-41b8-b428-7fed3ec17942"

# Validate that the ACM certificate exists and is issued before deploying.
# CloudFront will reject updates if the certificate is expired or deleted.
CERT_STATUS=$(aws acm describe-certificate \
	--certificate-arn "$CERTIFICATE_ARN" \
	--region us-east-1 \
	--profile "$AWS_PROFILE" \
	--query 'Certificate.Status' \
	--output text 2>&1) || {
	echo "ERROR: Could not describe certificate $CERTIFICATE_ARN"
	echo "$CERT_STATUS"
	exit 1
}

if [ "$CERT_STATUS" != "ISSUED" ]; then
	echo "ERROR: Certificate is not in ISSUED state (current status: $CERT_STATUS)"
	echo "       ARN: $CERTIFICATE_ARN"
	echo "       Check the certificate in ACM (us-east-1) before deploying."
	exit 1
fi

echo "Certificate is valid (status: $CERT_STATUS)"

SOURCE_BUCKETS="images-granoshop,images-mygrano-dev,images-mygrano-stg"

EXTRA_ARGS=""
if [ "$ACTION" = "diff" ]; then
	EXTRA_ARGS="--no-change-set"
fi

# v7-Stack is the upstream name for the Lambda architecture stack (v8-Stack is ECS)
overrideWarningsEnabled=false npx cdk "$ACTION" v7-Stack \
	$EXTRA_ARGS \
	--no-execute \
	--profile "$AWS_PROFILE" \
	--context sourceBuckets="$SOURCE_BUCKETS" \
	--context customDomain="thumb.mygrano.fi" \
	--context certificateArn="$CERTIFICATE_ARN" \
	--parameters SourceBucketsParameter="$SOURCE_BUCKETS" \
	--parameters DeployDemoUIParameter=No \
	--parameters LogRetentionPeriodParameter="365" \
	--parameters AutoWebPParameter=Yes \
	--parameters EnableSignatureParameter=Yes \
	--parameters EnableS3ObjectLambdaParameter=No \
	--parameters SecretsManagerSecretParameter=serverless-image-handler \
	--parameters SecretsManagerKeyParameter=SignatureKey \
	--parameters CloudFrontPriceClassParameter=PriceClass_100
