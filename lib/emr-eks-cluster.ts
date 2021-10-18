import { Vpc, IVpc, InstanceType, Port, BlockDeviceVolume, EbsDeviceVolumeType, Instance, MachineImage, AmazonLinuxGeneration, SecurityGroup, Peer } from '@aws-cdk/aws-ec2';
import { AwsAuth, Cluster, EndpointAccess, KubernetesVersion } from '@aws-cdk/aws-eks';
import { PolicyStatement, Effect, Role, ManagedPolicy, ServicePrincipal, OpenIdConnectPrincipal, CfnServiceLinkedRole } from '@aws-cdk/aws-iam';
import { CfnParameter, Stack } from '@aws-cdk/core';
import * as cdk from '@aws-cdk/core';
import { eksVpc, addEndpoints } from './emr-eks-vpc';
import { setupClusterLogging } from './eks-logging';
import * as K8sRoleBinding from './rbac/emr-containers-role-binding.json';
import * as K8sRole from './rbac/emr-containers-role.json'

interface ekstackprops extends cdk.StackProps {
}

export class EmrEksCdkStack extends cdk.Stack {
  public readonly cluster: Cluster
  public readonly awsauth: AwsAuth
  private readonly emrServiceRole: CfnServiceLinkedRole;

  constructor (scope: cdk.Construct, id: string, props: ekstackprops) {
    super(scope, id, props);
    const k8sversion = new CfnParameter(this, 'k8sVersion', {
      type: 'String',
      description: 'K8s Version',
      default: '1.20',
    });
    
    const vpc = this.getOrCreateVpc(this);

    // Locked Down Bastion Host Security Group to only allow outbound access to port 443.
    const bastionHostLinuxSecurityGroup = new SecurityGroup(this, 'bastionHostSecurityGroup', {
      allowAllOutbound: false,
      securityGroupName: this.getOrCreateEksName(this) + '-bastionSecurityGroup',
      vpc: vpc,
    });

    // Recommended to use connections to manage ingress/egress for security groups
    bastionHostLinuxSecurityGroup.connections.allowTo(Peer.anyIpv4(), Port.tcp(443), 'Outbound to 443 only');
    // Create Custom IAM Role and Policies for Bastion Host
    // https://docs.aws.amazon.com/eks/latest/userguide/security_iam_id-based-policy-examples.html#policy_example3
    const bastionHostPolicy = new ManagedPolicy(this, 'bastionHostManagedPolicy');
    bastionHostPolicy.addStatements(new PolicyStatement({
      resources: ['*'],
      actions: [
        'eks:DescribeNodegroup',
        'eks:ListNodegroups',
        'eks:DescribeCluster',
        'eks:ListClusters',
        'eks:AccessKubernetesApi',
        'eks:ListUpdates',
        'eks:ListFargateProfiles',
      ],
      effect: Effect.ALLOW,
      sid: 'EKSReadonly',
    }));


    const bastionHostRole = new Role(this, 'bastionHostRole', {
      roleName: this.getOrCreateEksName(this) + '-bastion-host',
      assumedBy: new ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        // SSM Manager Permissions
        ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        // Read only EKS Permissions
        bastionHostPolicy,
      ],
    });


    // Create Bastion Host, connect using Session Manager
    const bastionHostLinux = new Instance(this, 'BastionEKSHost', {
      // Defaults to private subnets https://docs.aws.amazon.com/cdk/api/latest/docs/@aws-cdk_aws-ec2.Instance.html#vpcsubnets
      vpc: vpc,
      instanceName: this.getOrCreateEksName(this) + '-EKSBastionHost',
      instanceType: new InstanceType('t3.small'),
      // Always use Latest Amazon Linux 2 instance, if new AMI is released will replace instance to keep it patched
      // If replaced with specific AMI, ensure SSM Agent is installed and running
      machineImage: MachineImage.latestAmazonLinux({
        generation: AmazonLinuxGeneration.AMAZON_LINUX_2,
      }),
      securityGroup: bastionHostLinuxSecurityGroup,
      role: bastionHostRole,
      // Ensure Bastion host EBS volume is encrypted
      blockDevices: [{
        deviceName: '/dev/xvda',
        volume: BlockDeviceVolume.ebs(30, {
          volumeType: EbsDeviceVolumeType.GP3,
        }),
      }],
    });

    this.cluster = new Cluster(this, 'EKSCluster', {
      version: KubernetesVersion.of(k8sversion.valueAsString),
      defaultCapacity: 0,
      endpointAccess: EndpointAccess.PUBLIC_AND_PRIVATE,
      vpc: vpc,
      mastersRole: bastionHostLinux.role,
      clusterName: this.getOrCreateEksName(this),
    });

    // Allow BastionHost security group access to EKS Control Plane
    bastionHostLinux.connections.allowTo(this.cluster, Port.tcp(443), 'Allow between BastionHost and EKS ');
    // Install kubectl version similar to EKS k8s version
    bastionHostLinux.userData.addCommands(
      `VERSION=$(aws --region ${this.region} eks describe-cluster --name ${this.cluster.clusterName} --query 'cluster.version' --output text)`,
      'echo \'K8s version is $VERSION\'',
      'curl -LO https://dl.k8s.io/release/v$VERSION.0/bin/linux/amd64/kubectl',
      'install -o root -g root -m 0755 kubectl /bin/kubectl',
      `aws eks update-kubeconfig --name ${this.cluster.clusterName} --region ${this.region}`
    );

    this.awsauth = new AwsAuth(this, 'EKS_AWSAUTH', {
      cluster: this.cluster,
    });

    this.awsauth.addMastersRole(bastionHostLinux.role, `${bastionHostLinux.role.roleArn}/{{SessionName}}`);

    // Create Amazon IAM ServiceLinkedRole for Amazon EMR and add to kubernetes configmap
    // required to add a dependency on the Amazon EMR virtual cluster
    this.emrServiceRole = new CfnServiceLinkedRole(this, 'EmrServiceIAMRole', {
      awsServiceName: 'emr-containers.amazonaws.com',
    });

    this.awsauth.addMastersRole(Role.fromRoleArn(
      this,
      'ServiceRoleForAmazonEMRContainers',
      `arn:aws:iam::${
        Stack.of(this).account
      }:role/AWSServiceRoleForAmazonEMRContainers`,
      ),
      'emr-containers',
    );

    //EKS loggging is not supported. Using CR
    //https://github.com/aws/aws-cdk/issues/4159
    setupClusterLogging(this, this.cluster)

  }

  // Create nodegroup IAM role in same stack as eks cluster to ensure there is not a circular dependency
  public createNodegroupRole (id: string): Role {
    const role = new Role(this, id, {
      assumedBy: new ServicePrincipal('ec2.amazonaws.com'),
    });
    role.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSWorkerNodePolicy'));
    role.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly'));
    role.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));
    role.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName('AmazonEKS_CNI_Policy'));

    return role;
  }
  
  public createEKSNameSpace (scope: cdk.Construct): string {
    const stack = cdk.Stack.of(scope)
    const eksNamespace = stack.node.tryGetContext('eksNamespace') ?? 'default';
    const ns = stack.node.tryGetContext('createNameSpace')
      ? this.cluster.addManifest('eksNamespace', {
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: { name: eksNamespace },
      })
      : null;
    
    K8sRole.metadata.namespace = eksNamespace;
    const role = this.cluster.addManifest('eksNamespaceRole', K8sRole);

    K8sRoleBinding.metadata.namespace = eksNamespace;
    const roleBinding = this.cluster.addManifest('eksNamespaceRoleBinding', K8sRoleBinding);

    return eksNamespace;  
  }

  private getOrCreateVpc (scope: cdk.Construct): IVpc {
    // create a new one using cdk context
    const stack = cdk.Stack.of(scope);
    // Able to choose default vpc but will error if EKS Cluster endpointAccess is set to be Private, need private subnets
    if (stack.node.tryGetContext('use_default_vpc') === '1') {
      return Vpc.fromLookup(stack, 'EKSNetworking', { isDefault: true });
    }
    if (stack.node.tryGetContext('use_vpc_id') !== undefined) {
      return Vpc.fromLookup(stack, 'EKSNetworking', { vpcId: stack.node.tryGetContext('use_vpc_id') });
    }
    const vpc = new Vpc(stack, stack.stackName + '-EKSNetworking', eksVpc);
    addEndpoints(stack, vpc);
    return vpc;
  }

  private getOrCreateEksName (scope: cdk.Construct): string {
    // pass or create a new one using cdk context
    const stack = cdk.Stack.of(scope);
    if (stack.node.tryGetContext('cluster_name') !== undefined) {
      return stack.node.tryGetContext('cluster_name');
    }
    return 'myekscluster';
  }
}
