import { GatewayVpcEndpointAwsService, Vpc, FlowLogTrafficType, FlowLogDestination, InterfaceVpcEndpoint} from '@aws-cdk/aws-ec2';
import { Stack } from '@aws-cdk/core';
import * as ec2 from '@aws-cdk/aws-ec2';
  
  export function addEndpoints (stack: Stack, vpc: Vpc): void {
    // Additional VPC Endpoint for EKS https://docs.aws.amazon.com/eks/latest/userguide/private-clusters.html#vpc-endpoints-private-clusters
    (() => new InterfaceVpcEndpoint(stack, 'ecrVpcEndpoint', {
      open: true,
      vpc: vpc,
      service: {
        name: `com.amazonaws.${stack.region}.ecr.api`,
        port: 443,
      },
      privateDnsEnabled: true,
    }))();
  
    (() => new InterfaceVpcEndpoint(stack, 'dkrVpcEndpoint', {
      open: true,
      vpc: vpc,
      service: {
        name: `com.amazonaws.${stack.region}.ecr.dkr`,
        port: 443,
      },
      privateDnsEnabled: true,
    }))();
  }
  
  export const eksVpc = {
    cidr: '10.0.0.0/16',
    maxAzs: 3,
    subnetConfiguration: [
      {
        name: 'eks-vpc-private-sub',
        subnetType: ec2.SubnetType.PRIVATE_WITH_NAT,
        cidrMask: 18
      },

      {
        name: 'eks-vpc-public-sub',
        subnetType: ec2.SubnetType.PUBLIC,
        cidrMask: 20
      }
    ],
    // S3 https://docs.aws.amazon.com/vpc/latest/privatelink/vpce-gateway.html
    gatewayEndpoints: {
      // S3 Gateway  https://docs.aws.amazon.com/AmazonS3/latest/userguide/privatelink-interface-endpoints.html#types-of-vpc-endpoints-for-s3
      S3: {
        service: GatewayVpcEndpointAwsService.S3,
      },
  
    },
    flowLogs: {
      VpcFlowlogs: {
        destination: FlowLogDestination.toCloudWatchLogs(),
        trafficType: FlowLogTrafficType.ALL,
      },
    },
    natGateways: 2,
  };