#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import { EmrEksCdkStack } from '../lib/emr-eks-cluster';
import { Eksnodegroups } from '../lib/emr-eks-nodegroup';
import { K8sBaselineStack } from '../lib/emr-eks-manifest';
import { EmrVirtualCluster } from '../lib/emr-virtual-cluster';

const DEFAULT_CONFIG = {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
};

const app = new cdk.App();
const prefix = stackPrefix(app);

const eks = new EmrEksCdkStack(app, 'EmrEksCdkStack', {
  env: DEFAULT_CONFIG.env,
  stackName: `${prefix}EKSStack`,
});

const nodegroups = new Eksnodegroups(app, 'EKSNodeGroups', ({
  env: DEFAULT_CONFIG.env,
  stackName: `${prefix}EKSNodeGroups`,
  eksCluster: eks.cluster,
  nodeGroupRole: eks.createNodegroupRole('emr-eks-workernode-role'),
}));

const k8sbase = new K8sBaselineStack(app, 'EKSK8sBaseline', ({
  env: DEFAULT_CONFIG.env,
  stackName: `${prefix}EKSK8sBaseline`,
  eksCluster: eks.cluster,
}));

const addEmrVirtualCluster = new EmrVirtualCluster(app, "EmrEKSVirtualCluster", eks.cluster, ({
  env: DEFAULT_CONFIG.env,
  stackName: `${prefix}EMRVirtualCluster`,
  name: eks.cluster.clusterName,
  eksNamespace: eks.createEKSNameSpace(eks)
}));


k8sbase.addDependency(nodegroups);
nodegroups.addDependency(eks);
addEmrVirtualCluster.addDependency(eks);

function stackPrefix (stack: cdk.Construct): string {
  const prefixValue = stack.node.tryGetContext('stack_prefix');

  if (prefixValue !== undefined) {
    return prefixValue.trim();
  }
  // if no stack_prefix return empty string
  return '';
}

app.synth();
