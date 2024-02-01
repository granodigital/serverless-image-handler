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

SOURCE_BUCKETS="images-granoshop, images-mygrano-dev"

overrideWarningsEnabled=false npx cdk "$ACTION" \
	--no-execute \
	--profile "$AWS_PROFILE" \
	--context sourceBuckets="$SOURCE_BUCKETS" \
	--context customDomain="thumb.mygrano.fi" \
	--context certificateArn="arn:aws:acm:us-east-1:897068463773:certificate/d895b448-7f94-4042-94c7-ef6e410c8afe" \
	--parameters SourceBucketsParameter="$SOURCE_BUCKETS" \
	--parameters DeployDemoUIParameter=No \
	--parameters LogRetentionPeriodParameter="365" \
	--parameters AutoWebPParameter=Yes \
	--parameters EnableSignatureParameter=Yes \
	--parameters SecretsManagerSecretParameter=serverless-image-handler \
	--parameters SecretsManagerKeyParameter=SignatureKey \
	--parameters CloudFrontPriceClassParameter=PriceClass_100
