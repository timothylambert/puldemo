import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

const inputBucketName = "innovation-pulumi-ser-sourcebucket";
const unpackerSinkBucketName = "innovation-pulumi-ser-unpacker-sinkbucket";
const logBucketName = "innovation-pulumi-ser-logs";

const region = aws.config.requireRegion();

const current = aws.getCallerIdentity({});
const inputBucket = new aws.s3.Bucket(inputBucketName);
const logBucket = new aws.s3.Bucket(logBucketName);
const unpackerSinkBucket = new aws.s3.Bucket(unpackerSinkBucketName);

const logBucketPolicy = new aws.s3.BucketPolicy("logBucketPolicy", {
    bucket: logBucket.id,
    policy: pulumi.all([logBucket.id, logBucket.id, current]).apply(([bucketId, bucketId1, current]) => pulumi.interpolate`  {
      "Version": "2012-10-17",
      "Statement": [
          {
              "Sid": "AWSCloudTrailAclCheck",
              "Effect": "Allow",
              "Principal": {
                "Service": "cloudtrail.amazonaws.com"
              },
              "Action": "s3:GetBucketAcl",
              "Resource": "arn:aws:s3:::${bucketId}"
          },
          {
              "Sid": "AWSCloudTrailWrite",
              "Effect": "Allow",
              "Principal": {
                "Service": "cloudtrail.amazonaws.com"
              },
              "Action": "s3:PutObject",
              "Resource": "arn:aws:s3:::${bucketId1}/logs/AWSLogs/${current.accountId}/*",
              "Condition": {
                  "StringEquals": {
                      "s3:x-amz-acl": "bucket-owner-full-control"
                  }
              }
          }
      ]
  }
`),
}, { dependsOn: [inputBucket, logBucket] });

const inputBucketPolicy = new aws.s3.BucketPolicy("inputBucketPolicy", {
    bucket: inputBucket.id,
    policy: pulumi.all([inputBucket.id, inputBucket.id, current]).apply(([bucketId, bucketId1, current]) => pulumi.interpolate`  {
      "Version": "2012-10-17",
      "Statement": [
          {
              "Sid": "AWSCloudTrailAclCheck",
              "Effect": "Allow",
              "Principal": {
                "Service": "cloudtrail.amazonaws.com"
              },
              "Action": "s3:GetBucketAcl",
              "Resource": "arn:aws:s3:::${bucketId}"
          },
          {
              "Sid": "AWSCloudTrailWrite",
              "Effect": "Allow",
              "Principal": {
                "Service": "cloudtrail.amazonaws.com"
              },
              "Action": "s3:PutObject",
              "Resource": "arn:aws:s3:::${bucketId1}/logs/AWSLogs/${current.accountId}/*",
              "Condition": {
                  "StringEquals": {
                      "s3:x-amz-acl": "bucket-owner-full-control"
                  }
              }
          }
      ]
  }
`),
}, { dependsOn: [inputBucket, logBucket] });

const inputTrail = new aws.cloudtrail.Trail("inputTrail", {
    s3BucketName: logBucket.bucket,
    s3KeyPrefix: "logs",
    includeGlobalServiceEvents: false,
    eventSelectors: [
        {
            readWriteType: "WriteOnly",
            includeManagementEvents: true,
            dataResources: [{
                type: "AWS::S3::Object",
                values: [pulumi.interpolate`${inputBucket.arn}/`],
            }]
        }
    ]
}, { dependsOn: [inputBucketPolicy] });

const inputRule = new aws.cloudwatch.EventRule("inputRule", {
    description: "Rule for triggering ser step function",
    eventPattern: pulumi.interpolate`{
        "source": ["aws.s3"],
        "detail-type": ["AWS API Call via CloudTrail"],
        "detail": {
          "eventSource": ["s3.amazonaws.com"],
          "eventName": ["PutObject"],
          "requestParameters": {
            "bucketName": ["${logBucket.bucket}"]
          }
        }
      }`
}, { dependsOn: [inputTrail] });

const lambdaRole = new aws.iam.Role("lambdaRole", {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: "lambda.amazonaws.com" }),
});

const unpackerRolePolicy = new aws.iam.RolePolicy("unpackerLambdaRolePolicy", {
    role: lambdaRole.id,
    policy: {
        Version: "2012-10-17",
        Statement: [{
            Sid: "logcontrol",
            Effect: "Allow",
            Action: [
                "logs:CreateLogGroup",
                "logs:CreateLogStream",
                "logs:PutLogEvents",
            ],
            Resource: "arn:aws:logs:*:*:*",
        },
        {
            Sid: "inputreadaccess",
            Effect: "Allow",
            Action: [
                "s3:*"
            ],
            Resource: pulumi.interpolate`${inputBucket.arn}/*`,
        },
        {
            Sid: "sinkreadaccess",
            Effect: "Allow",
            Action: [
                "s3:*"
            ],
            Resource: pulumi.interpolate`${unpackerSinkBucket.arn}/*`,
        }],
    }
}, { dependsOn: [inputBucket, unpackerSinkBucket] });

const unpacker = new aws.lambda.Function("unpackerFunction",
    {
        name: "Unpacker",
        role: lambdaRole.arn,
        runtime: "nodejs14.x",
        handler: "index.handler",
        environment: {
            variables: {
                SINK_BUCKET: unpackerSinkBucket.bucket
            }
        },
        code: new pulumi.asset.AssetArchive({
            ".": new pulumi.asset.FileArchive("./unpacker"),
        }),
    }, { dependsOn: [unpackerRolePolicy, unpackerSinkBucket] });


const sfnRole = new aws.iam.Role("sfnRole", {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: `states.${region}.amazonaws.com` }),
});

const sfnRolePolicy = new aws.iam.RolePolicy("sfnRolePolicy", {
    role: sfnRole.id,
    policy: {
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Action: [
                "lambda:InvokeFunction",
            ],
            Resource: "*",
        }],
    },
});

const stateMachine = new aws.sfn.StateMachine("stateMachine", {
    roleArn: sfnRole.arn,
    definition: pulumi.all([unpacker.arn])
        .apply(([unpackerArn]) => {
            return JSON.stringify({
                "Comment": "Serialiser demo",
                "StartAt": "Unpacker",
                "States": {
                    "Unpacker": {
                        "Type": "Task",
                        "Resource": unpackerArn,
                        "End": true
                    }
                },
            });
        }),
}, { dependsOn: sfnRolePolicy });

const ruleTriggerRole = new aws.iam.Role("ruleTriggerRole", {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: "states.amazonaws.com" }),
});

const ruleTriggerRolePolicy = new aws.iam.RolePolicy("ruleTriggerRolePolicy", {
    role: ruleTriggerRole.id,
    policy: {
        Version: "2012-10-17",
        Statement: [{
            Sid: "logcontrol",
            Effect: "Allow",
            Action: [
                "states:StartExecution"
            ],
            Resource: "arn:aws:states:*:*:*:*",
        }]
    }
});

const sfnTrigger = new aws.cloudwatch.EventTarget("sfnTrigger", {
    rule: inputRule.name,
    arn: stateMachine.arn,
    roleArn: ruleTriggerRole.arn
}, { dependsOn: [stateMachine, inputRule] });

export const stateMachineArn = stateMachine.id;