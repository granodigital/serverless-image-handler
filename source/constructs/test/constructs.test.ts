// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Template } from "aws-cdk-lib/assertions";
import { App } from "aws-cdk-lib";

import { ServerlessImageHandlerStack } from "../lib/serverless-image-stack";

const SUPPORTED_RUNTIMES = ["nodejs24.x", "python3.13"];
const TEST_CUSTOM_DOMAIN = "thumb.example.com";
const TEST_CERTIFICATE_ARN = "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000";

describe("ServerlessImageHandlerStack", () => {
  let app: App;
  let stack: ServerlessImageHandlerStack;
  let template: Template;

  beforeEach(() => {
    app = new App({
      context: {
        solutionId: "SO0023",
        solutionName: "dynamic-image-transformation-for-amazon-cloudfront",
        solutionVersion: "v7.0.1",
        // Grano customization: the SVG cache behavior needs the source bucket list.
        sourceBuckets: "test-bucket-a, test-bucket-b",
        // Grano customization: the image distribution serves a custom domain.
        customDomain: TEST_CUSTOM_DOMAIN,
        certificateArn: TEST_CERTIFICATE_ARN,
      },
    });

    stack = new ServerlessImageHandlerStack(app, "TestStack", {
      solutionId: "S0ABC",
      solutionName: "dit",
      solutionVersion: "v7.0.1",
    });

    template = Template.fromStack(stack);
  });

  test("Dynamic Image Transformation for Amazon CloudFront Stack Snapshot", () => {
    const templateJson = template.toJSON();

    /**
     * iterate templateJson and for any attribute called S3Key, replace the value for that attribute with "Omitted to remove snapshot dependency on hash",
     * this is so that the snapshot can be saved and will not change because the hash has been regenerated
     */
    Object.keys(templateJson.Resources).forEach((key) => {
      if (templateJson.Resources[key].Properties?.Code?.S3Key) {
        templateJson.Resources[key].Properties.Code.S3Key = "Omitted to remove snapshot dependency on hash";
      }
      if (templateJson.Resources[key].Properties?.Content?.S3Key) {
        templateJson.Resources[key].Properties.Content.S3Key = "Omitted to remove snapshot dependency on hash";
      }
      if (templateJson.Resources[key].Properties?.SourceObjectKeys) {
        templateJson.Resources[key].Properties.SourceObjectKeys = [
          "Omitted to remove snapshot dependency on demo ui module hash",
        ];
      }
      if (templateJson.Resources[key].Properties?.Environment?.Variables?.SOLUTION_VERSION) {
        templateJson.Resources[key].Properties.Environment.Variables.SOLUTION_VERSION =
          "Omitted to remove snapshot dependency on solution version";
      }
    });

    expect.assertions(1);
    expect(templateJson).toMatchSnapshot();
  });

  /** The image handler distribution: the only one with the Grano custom domain. */
  function imageDistributionConfig() {
    const configs = Object.values(template.findResources("AWS::CloudFront::Distribution"))
      .map((d) => d.Properties.DistributionConfig)
      .filter((config) => config.Aliases !== undefined);
    expect(configs).toHaveLength(1);
    return configs[0];
  }

  test("Grano customization: image distribution serves the custom domain with its certificate", () => {
    const config = imageDistributionConfig();

    expect(config.Aliases).toEqual([TEST_CUSTOM_DOMAIN]);
    expect(config.ViewerCertificate.AcmCertificateArn).toEqual(TEST_CERTIFICATE_ARN);
  });

  test("Grano customization: serves SVGs directly from each source bucket", () => {
    const config = imageDistributionConfig();
    const behaviors = config.CacheBehaviors ?? [];
    const [removeBucketNameId, ...otherFunctions] = Object.keys(
      template.findResources("AWS::CloudFront::Function")
    ).filter((id) => id.includes("RemoveBucketName"));
    expect(removeBucketNameId).toBeDefined();
    expect(otherFunctions).toHaveLength(0);

    expect(behaviors.map((b: { PathPattern: string }) => b.PathPattern)).toEqual([
      "test-bucket-a/*.svg",
      "test-bucket-b/*.svg",
    ]);
    for (const behavior of behaviors) {
      const bucket = behavior.PathPattern.split("/")[0];

      // The function strips the bucket name from the path, so S3 gets /x.svg instead of /<bucket>/x.svg.
      expect(behavior.FunctionAssociations).toEqual([
        { EventType: "viewer-request", FunctionARN: { "Fn::GetAtt": [removeBucketNameId, "FunctionARN"] } },
      ]);

      // The behaviour goes to that bucket's S3 origin, not to API Gateway.
      const origin = config.Origins.find((o: { Id: string }) => o.Id === behavior.TargetOriginId);
      expect(origin.S3OriginConfig).toBeDefined();
      expect(JSON.stringify(origin.DomainName)).toContain(`"${bucket}.s3."`);
    }
  });

  test("All Lambda functions should use supported runtimes", () => {
    const lambdaFunctions = template.findResources("AWS::Lambda::Function");
    const functionNames = Object.keys(lambdaFunctions);

    expect(functionNames.length).toBeGreaterThan(0);

    functionNames.forEach((functionName) => {
      const runtime = lambdaFunctions[functionName].Properties.Runtime;
      expect(SUPPORTED_RUNTIMES).toContain(runtime);
    });
  });

  test("Demo UI distribution sends X-Frame-Options DENY from a per-stack, conditional policy", () => {
    const policies = template.findResources("AWS::CloudFront::ResponseHeadersPolicy");
    const policyIds = Object.keys(policies);
    expect(policyIds).toHaveLength(1);
    const [policyId] = policyIds;
    const policy = policies[policyId];
    const config = policy.Properties.ResponseHeadersPolicyConfig;

    expect(config.SecurityHeadersConfig).toEqual({ FrameOptions: { FrameOption: "DENY", Override: true } });
    expect(JSON.stringify(config.Name)).toContain('"Ref":"AWS::StackId"');

    const distributions = template.findResources("AWS::CloudFront::Distribution");
    const demoUi = Object.values(distributions).find((d) =>
      d.Properties.DistributionConfig.Comment?.startsWith("Demo UI Distribution")
    );
    expect(demoUi).toBeDefined();
    expect(demoUi?.Properties.DistributionConfig.DefaultCacheBehavior.ResponseHeadersPolicyId).toEqual({
      Ref: policyId,
    });
    expect(policy.Condition).toBeDefined();
    expect(policy.Condition).toEqual(demoUi?.Condition);
  });
});
