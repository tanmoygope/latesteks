import { Cluster, HelmChart, ServiceAccount } from '@aws-cdk/aws-eks';
import * as cdk from '@aws-cdk/core';
import * as eks from '@aws-cdk/aws-eks';
import { Policy, PolicyStatement, IRole } from '@aws-cdk/aws-iam';
import { CfnJson } from '@aws-cdk/core';

interface k8sBaselineProps extends cdk.StackProps {
  eksCluster: Cluster,
}

export class K8sBaselineStack extends cdk.Stack {
  constructor (scope: cdk.Construct,
    id: string,
    props: k8sBaselineProps) {
    super(scope, id, props);

    // k8s manifests
    const clusterAutoscalerSA = new ServiceAccount(this, 'clusterAutoscalerSA', {
      name: 'cluster-autoscaler-sa',
      cluster: props.eksCluster,
      namespace: 'kube-system',
    });
    
    const clusterAutoscalerDeploy = new HelmChart(this, 'clusterautoscaler-deploy', {
      repository: 'https://kubernetes.github.io/autoscaler',
      release: 'cluster-autoscaler',
      cluster: props.eksCluster,
      chart: 'cluster-autoscaler',
      namespace: 'kube-system',
      wait: true,
      // https://github.com/kubernetes/autoscaler/blob/gh-pages/index.yaml
      version: this.node.tryGetContext('cluster-autoscaler-helm-version'),
      // https://github.com/kubernetes/autoscaler/tree/master/charts/cluster-autoscaler#values
      values: {
        cloudProvider: 'aws',
        awsRegion: this.region,
        autoDiscovery: {
          clusterName: props.eksCluster.clusterName,
        },
        rbac: {
          serviceAccount: {
            create: false,
            name: clusterAutoscalerSA.serviceAccountName,
          },
        },
        extraArgs: {
          // https://github.com/kubernetes/autoscaler/blob/master/cluster-autoscaler/FAQ.md#what-are-the-parameters-to-ca
          'skip-nodes-with-system-pods': false,
          'skip-nodes-with-local-storage': false,
          'balance-similar-node-groups': true,
          // How long a node should be unneeded before it is eligible for scale down
          'scale-down-unneeded-time': '30s',
          // How long after scale up that scale down evaluation resumes
          'scale-down-delay-after-add': '30s',
        },

      },
    });
    // Generate IAM Policy with scoped permissions
    const clusterAutoscalerPolicy = this.createClusterAutoscalerPolicy(this, props.eksCluster.clusterName, clusterAutoscalerSA.role);
    
    const awsVpcCNI = new eks.KubernetesPatch(this, 'aws-vpc-cni', {
        cluster: props.eksCluster,
        resourceName: `daemonset.apps/aws-node`,
        resourceNamespace: 'kube-system',
        applyPatch: 
        { spec: 
            { template: 
                { spec: 
                    { containers: 
                        [ { 
                            "name": "aws-node", 
                            "env": [ 
                                {
                                    "name": "MINIMUM_IP_TARGET",
                                    "value": "20"
                                },
                                {
                                    "name": "WARM_ENI_TARGET",
                                    "value": "1"
                                }, 
                              ] 
                            } 
                        ] 
                    } 
                } 
            } 
        },
        restorePatch: { }
      });
  }


// Scope ClusterAutoscaler to read/write to tags with cluster-name
createClusterAutoscalerPolicy (scope: cdk.Construct, clusterName: string, roleSA: IRole) : Policy {
    const clusterAutoscalerSAPolicyStatementDescribe = new PolicyStatement({
      // https://docs.aws.amazon.com/eks/latest/userguide/cluster-autoscaler.html#ca-create-policy
      resources: [
        '*',
      ],
      actions: [
        'autoscaling:DescribeAutoScalingGroups',
        'autoscaling:DescribeAutoScalingInstances',
        'autoscaling:DescribeLaunchConfigurations',
        'autoscaling:DescribeTags',
        'ec2:DescribeLaunchTemplateVersions',
      ],
  
    });
    // Cluster Autoscaler tags resources using the tags below, so scope resources to those tags
    // Create CfnJson as variables are not allowed to be in keys for key:value pairs.
    const clusterAutoscalerPolicyStatementWriteJson = new CfnJson(scope, 'clusterAutoscalerPolicyStatementWriteJson', {
      value: {
        'autoscaling:ResourceTag/k8s.io/cluster-autoscaler/enabled': 'true',
        [`autoscaling:ResourceTag/kubernetes.io/cluster/${clusterName}`]: 'owned',
      },
    });
    const clusterAutoscalerPolicyStatementWrite = new PolicyStatement({
      resources: [
        '*',
      ],
      actions: [
        'autoscaling:SetDesiredCapacity',
        'autoscaling:TerminateInstanceInAutoScalingGroup',
        'autoscaling:UpdateAutoScalingGroup',
      ],
      conditions: {
        StringEquals: clusterAutoscalerPolicyStatementWriteJson,
      },
    },
    );
    return new Policy(scope, 'clusterAutoscalerPolicy', {
      statements: [
        clusterAutoscalerPolicyStatementWrite,
        clusterAutoscalerSAPolicyStatementDescribe,
      ],
      roles: [
        roleSA,
      ],
    });
  }
}
