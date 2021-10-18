import { CfnLaunchTemplate, MultipartBody, MultipartUserData, UserData } from '@aws-cdk/aws-ec2';
import { Cluster, Nodegroup } from '@aws-cdk/aws-eks';
import { Role, ManagedPolicy, ServicePrincipal } from '@aws-cdk/aws-iam';
import * as cdk from '@aws-cdk/core';

import { CfnParameter, Fn } from '@aws-cdk/core';
interface eksNodegroupsProps extends cdk.StackProps {
  eksCluster: Cluster,
  nodeGroupRole: Role
}

export class Eksnodegroups extends cdk.Stack {
  constructor (scope: cdk.Construct,
    id: string,
    props: eksNodegroupsProps) {
    super(scope, id, props);
    const nodegroupMax = new CfnParameter(this, 'nodegroupMax', {
      type: 'Number',
      description: 'Max number of EKS worker nodes to scale up to',
      default: 450,
    });
    const nodegroupCount = new CfnParameter(this, 'nodegroupCount', {
      type: 'Number',
      description: 'Desired Count of EKS Worker Nodes to launch',
      default: 2,
    });
    const nodegroupMin = new CfnParameter(this, 'nodegroupMin', {
      type: 'Number',
      description: 'Min number of EKS worker nodes to scale down to',
      default: 1,
    });
    const nodeType = new CfnParameter(this, 'nodegroupInstanceType', {
      type: 'String',
      description: 'Instance Type to be used with nodegroup ng-1',
      default: 'r5d.24xlarge',
    });
    const nodeAMIVersion = new CfnParameter(this, 'nodeAMIVersion', {
      type: 'String',
      default: '1.20.10-20211008',
      description: 'AMI version used for EKS Worker nodes https://docs.aws.amazon.com/eks/latest/userguide/eks-linux-ami-versions.html',
    });

    const userdataCommands = UserData.forLinux();
    userdataCommands.addCommands(
      '/usr/bin/yum install -y mdadm',
      'nvmes=$(sudo lsblk | grep -v nvme0n1 | awk \'/^nvme/ {printf "/dev/%s ", $1}\')',
      '/usr/sbin/mdadm --create --verbose /dev/md0 --level=0 --name=MY_RAID --raid-devices=$(echo $nvmes | wc -w) $nvmes',
      '/usr/sbin/mkfs.xfs -L MY_RAID /dev/md0',
      '/usr/bin/mkdir -p /raid0',
      '/usr/bin/mount LABEL=MY_RAID /raid0',
      '/usr/bin/chmod 777 /raid0',
    );
    const multipart = new MultipartUserData();
    // const part = MultipartBody
    multipart.addPart(
      MultipartBody.fromUserData(userdataCommands),
    );

    const launchtemplate = new CfnLaunchTemplate(this, 'LaunchTemplate', {
      launchTemplateData: {
        instanceType: nodeType.valueAsString,
        userData: Fn.base64(multipart.render()),
        blockDeviceMappings: [
          {
            deviceName: '/dev/xvda',
            ebs: {
              volumeType: 'gp3',
            },
          },
        ],
        tagSpecifications: [{
          resourceType: 'instance',
          tags: [
            {
              key: 'Name',
              value: Fn.join('-', [props.eksCluster.clusterName, 'WorkerNodes']),
            },
          ],
        }],
      },
      launchTemplateName: Fn.join('-', ['ng-1', props.eksCluster.clusterName]),

    });

    new Nodegroup(this, 'ng-1', {
      cluster: props.eksCluster,
      // https://docs.aws.amazon.com/eks/latest/userguide/eks-linux-ami-versions.html
      releaseVersion: nodeAMIVersion.valueAsString,
      nodegroupName: 'ng-1',
      // Require specific order of max,desired,min or generated CDK Tokens fail desired>min check
      // https://github.com/aws/aws-cdk/issues/15485
      nodeRole: props.nodeGroupRole,
      maxSize: nodegroupMax.valueAsNumber,
      desiredSize: nodegroupCount.valueAsNumber,
      minSize: nodegroupMin.valueAsNumber,
      // LaunchTemplate for custom userdata to install SSM Agent
      launchTemplateSpec: {
        id: launchtemplate.ref,
        version: launchtemplate.attrLatestVersionNumber,
      },
      tags: {
        Name: Fn.join('-', [props.eksCluster.clusterName, 'WorkerNodes']),
      },
    });
    
  }
}