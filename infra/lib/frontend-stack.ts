import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cloudfrontOrigins from 'aws-cdk-lib/aws-cloudfront-origins';
import { Construct } from 'constructs';

export interface FrontendStackProps extends cdk.StackProps {
  stage: string;
}

export class FrontendStack extends cdk.Stack {
  public readonly distributionUrl: string;
  public readonly bucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, props);

    const { stage } = props;

    // ---- S3 bucket (no public access — served exclusively via CloudFront OAC) ----
    this.bucket = new s3.Bucket(this, 'FrontendBucket', {
      bucketName: `drep-platform-${stage}-frontend-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      websiteIndexDocument: undefined, // OAC, not website hosting
      removalPolicy: stage === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: stage !== 'prod',
      versioned: stage === 'prod',
      encryption: s3.BucketEncryption.S3_MANAGED,
    });

    // ---- Origin Access Control ----
    const oac = new cloudfront.S3OriginAccessControl(this, 'FrontendOAC', {
      description: `OAC for drep-platform ${stage} frontend`,
    });

    // ---- CloudFront distribution ----
    this.distribution = new cloudfront.Distribution(this, 'FrontendDistribution', {
      comment: `drep-platform ${stage} frontend`,
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: cloudfrontOrigins.S3BucketOrigin.withOriginAccessControl(this.bucket, {
          originAccessControl: oac,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        compress: true,
      },
      // SPA fallback — route all 4xx back to index.html for React Router
      errorResponses: [
        {
          httpStatus: 403,
          responsePagePath: '/index.html',
          responseHttpStatus: 200,
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responsePagePath: '/index.html',
          responseHttpStatus: 200,
          ttl: cdk.Duration.seconds(0),
        },
      ],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });

    this.distributionUrl = `https://${this.distribution.distributionDomainName}`;

    new cdk.CfnOutput(this, 'FrontendBucketName', {
      value: this.bucket.bucketName,
      exportName: `${stage}-FrontendBucketName`,
    });

    new cdk.CfnOutput(this, 'DistributionUrl', {
      value: this.distributionUrl,
      exportName: `${stage}-DistributionUrl`,
    });

    new cdk.CfnOutput(this, 'DistributionId', {
      value: this.distribution.distributionId,
      exportName: `${stage}-DistributionId`,
    });
  }
}
