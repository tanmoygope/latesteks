# Welcome to your CDK TypeScript project!

This is a blank project for TypeScript development with CDK.

The `cdk.json` file tells the CDK Toolkit how to execute your app.

## Quick Start
git clone https://github.com/aws-samples/amazon-eks-using-cdk-typescript.git
# install dependant packages
npm install
# If you have not used cdk before, you may be advised to create cdk resources
export CDK_DEPLOY_ACCOUNT=`123456790123` 
export CDK_DEFAULT_REGION=`eu-west-1`
CDK_NEW_BOOTSTRAP=1 cdk bootstrap aws://ACCOUNT_ID/REGION
# check the diff before deployment to understand any changes, on first run all resources will created
cdk diff
# Deploy the stack, you will be prompted for confirmation for creation of IAM and Security Group resources
cdk -c cluster_name=`myfirstcluster` deploy --all

## Useful commands

 * `npm run build`   compile typescript to js
 * `npm run watch`   watch for changes and compile
 * `npm run test`    perform the jest unit tests
 * `cdk deploy`      deploy this stack to your default AWS account/region
 * `cdk diff`        compare deployed stack with current state
 * `cdk synth`       emits the synthesized CloudFormation template
