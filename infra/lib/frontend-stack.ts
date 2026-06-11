import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cloudfrontOrigins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import type { Construct } from 'constructs';
import { isPersistent } from './stage';

export interface CustomDomainConfig {
  hostedZoneId: string;
  zoneName: string;
  certificateArn: string;
  apexDomain: string;
  wwwDomain: string;
  apiDomain: string;
  /** Cookie Domain attribute for session cookies. Scoped per stage (e.g.
   *  `.test.drep.tools`) so a test session cookie can never be sent to prod. */
  cookieDomain: string;
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
      removalPolicy: isPersistent(stage) ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !isPersistent(stage),
      versioned: isPersistent(stage),
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

    // ---- Response headers policy (security + CSP) ----
    // CSP is required to mitigate XSS — the AWS-managed `SECURITY_HEADERS`
    // policy stamps HSTS / X-Frame / X-Content-Type / Referrer-Policy but
    // does NOT include a Content-Security-Policy directive. We add one
    // explicitly here.
    //
    // Allowed sources reflect what the SPA actually loads:
    //   - default 'self' (same-origin assets out of S3 via CloudFront)
    //   - 'unsafe-inline' on style-src (Tailwind ships utility classes
    //     fine, but the `style=` props we set per-component need it; can
    //     be tightened later with hash/nonce)
    //   - https://fonts.googleapis.com for the Inter <link rel="stylesheet">
    //   - https://fonts.gstatic.com for the @font-face binary fonts
    //   - https://api.drep.tools for XHR (api.drep.tools)
    //   - 'wasm-unsafe-eval' so MeshSDK can compile the CSL .wasm file
    //   - frame-ancestors 'none' belt-and-suspenders with X-Frame-Options
    const apiOriginsForCsp = customDomain ? `https://${customDomain.apiDomain}` : '';
    // NOTE on 'unsafe-eval': MeshSDK + vm-browserify bundle a runtime eval()
    // call (see vm-browserify/index.js:110 and @meshsdk/react). Removing
    // 'unsafe-eval' breaks wallet connect immediately. Documented as a
    // tightening target in QA_FINAL.md once we can shim or vendor those
    // call sites; until then a CSP with 'unsafe-eval' is *still* much
    // stronger than the (no-CSP) baseline that shipped before.
    //
    // NOTE on connect-src: Phase B (commit 118ea5a6) moved Blockfrost
    // server-side only; the frontend bundle contains zero `blockfrost`
    // references. Removing `https://*.blockfrost.io` from the allowlist
    // tightens the CSP without affecting any code path — every outbound
    // request from the SPA goes through `lib/api.ts` which hits
    // `api.drep.tools` exclusively. If a future feature ever needs the
    // browser to call Blockfrost directly (probably never — server-side
    // proxying is cheaper and gives us caching control), re-add this
    // entry then.
    const cspDirective = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: blob: https:",
      `connect-src 'self' ${apiOriginsForCsp}`.trim(),
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
      "upgrade-insecure-requests",
    ].join('; ');

    const responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(
      this,
      'FrontendResponseHeadersPolicy',
      {
        responseHeadersPolicyName: `drep-platform-${stage}-frontend-headers`,
        comment: 'Frontend security headers — adds CSP on top of the AWS managed defaults.',
        securityHeadersBehavior: {
          contentSecurityPolicy: {
            contentSecurityPolicy: cspDirective,
            override: true,
          },
          strictTransportSecurity: {
            accessControlMaxAge: cdk.Duration.days(365),
            includeSubdomains: true,
            preload: false,
            override: true,
          },
          contentTypeOptions: { override: true },
          frameOptions: {
            frameOption: cloudfront.HeadersFrameOption.DENY,
            override: true,
          },
          referrerPolicy: {
            referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
            override: true,
          },
          xssProtection: { protection: false, override: true },
        },
      },
    );

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
        responseHeadersPolicy,
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
