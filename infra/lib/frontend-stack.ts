import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cloudfrontOrigins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';

export interface CustomDomainConfig {
  hostedZoneId: string;
  zoneName: string;
  certificateArn: string;
  apexDomain: string;
  wwwDomain: string;
  apiDomain: string;
}

export interface FrontendStackProps extends cdk.StackProps {
  stage: string;
  customDomain?: CustomDomainConfig;
}

export class FrontendStack extends cdk.Stack {
  public readonly distributionUrl: string;
  public readonly bucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, props);

    const { stage, customDomain } = props;

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

    // ---- Custom domain (optional) ----
    let viewerCertificate: acm.ICertificate | undefined;
    let domainNames: string[] | undefined;
    if (customDomain) {
      viewerCertificate = acm.Certificate.fromCertificateArn(
        this,
        'FrontendCert',
        customDomain.certificateArn,
      );
      domainNames = [customDomain.apexDomain, customDomain.wwwDomain];
    }

    // ---- CloudFront distribution ----
    this.distribution = new cloudfront.Distribution(this, 'FrontendDistribution', {
      comment: `drep-platform ${stage} frontend`,
      defaultRootObject: 'index.html',
      ...(domainNames && viewerCertificate
        ? { domainNames, certificate: viewerCertificate }
        : {}),
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

    // ---- Route 53 alias records ----
    if (customDomain) {
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'FrontendZone', {
        hostedZoneId: customDomain.hostedZoneId,
        zoneName: customDomain.zoneName,
      });
      const target = route53.RecordTarget.fromAlias(
        new route53Targets.CloudFrontTarget(this.distribution),
      );

      new route53.ARecord(this, 'ApexAliasA', {
        zone,
        recordName: customDomain.apexDomain,
        target,
      });
      new route53.AaaaRecord(this, 'ApexAliasAAAA', {
        zone,
        recordName: customDomain.apexDomain,
        target,
      });
      new route53.ARecord(this, 'WwwAliasA', {
        zone,
        recordName: customDomain.wwwDomain,
        target,
      });
      new route53.AaaaRecord(this, 'WwwAliasAAAA', {
        zone,
        recordName: customDomain.wwwDomain,
        target,
      });
    }

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

    if (customDomain) {
      new cdk.CfnOutput(this, 'PrimaryUrl', {
        value: `https://${customDomain.apexDomain}`,
        exportName: `${stage}-PrimaryUrl`,
      });
    }
  }
}
