# Masquerade - AWS CloudFormation Deployment Guide

## Quick Start: One-Click AWS Deployment

Deploy Masquerade directly to AWS with CloudFormation in under 10 minutes.

### Prerequisites
- AWS Account with appropriate permissions
- AWS CLI installed (optional, can use AWS Console)
- EC2 Key Pair created in your AWS region

### Deploy with AWS Console (Easiest)

1. **Open CloudFormation Console**
   - Go to https://console.aws.amazon.com/cloudformation
   - Click "Create Stack"
   - Select "Upload a template file"
   - Upload `cloudformation-template.yaml`

2. **Configure Stack Parameters**
   - **Stack Name**: e.g., `maquerade-production`
   - **KeyName**: Select your EC2 Key Pair
   - **InstanceType**: Choose based on workload (default: t3.xlarge for video processing)
   - **DBName**: PostgreSQL database name (default: maquerade)
   - **DBUsername**: Database username (default: postgres)
   - **DBPassword**: Strong database password (min 8 chars)
   - **DBAllocatedStorage**: Database size in GB (default: 100GB)

3. **Review and Create**
   - Review settings
   - Check "I acknowledge that AWS CloudFormation might create IAM resources"
   - Click "Create Stack"

4. **Monitor Deployment**
   - Stack creation typically takes 5-10 minutes
   - View progress in "Events" tab
   - Once status shows "CREATE_COMPLETE", deployment is ready

5. **Access Your Application**
   - Go to "Outputs" tab
   - Copy the "LoadBalancerURL"
   - Open in browser to access Masquerade

### Deploy with AWS CLI

```bash
# Set your parameters
export STACK_NAME="maquerade-production"
export KEY_NAME="your-ec2-key-pair"
export DB_PASSWORD="your-secure-password"

# Deploy
aws cloudformation create-stack \
  --stack-name $STACK_NAME \
  --template-body file://cloudformation-template.yaml \
  --parameters \
    ParameterKey=KeyName,ParameterValue=$KEY_NAME \
    ParameterKey=DBPassword,ParameterValue=$DB_PASSWORD \
    ParameterKey=InstanceType,ParameterValue=t3.xlarge \
  --capabilities CAPABILITY_IAM

# Wait for completion
aws cloudformation wait stack-create-complete --stack-name $STACK_NAME

# Get outputs
aws cloudformation describe-stacks \
  --stack-name $STACK_NAME \
  --query 'Stacks[0].Outputs'
```

## What Gets Created

### Compute
- **EC2 Instance**: Ubuntu 22.04 with Node.js 20, FFmpeg, Nginx
- **Application Load Balancer**: Distributes traffic to EC2 instance
- **Auto-scaling**: Can be added for multiple instances

### Database
- **RDS PostgreSQL**: Managed database with automated backups
- **Database Subnet Group**: Private subnets for database security

### Networking
- **VPC**: Custom VPC with public and private subnets
- **Internet Gateway**: Public internet access
- **Security Groups**: Configured for web traffic, EC2, and database access
- **NAT Gateway**: (Optional) For private subnet internet access

### Security
- **IAM Role**: For EC2 instance with Systems Manager access
- **Encryption**: RDS database encrypted at rest
- **Backups**: Automated daily backups with 7-day retention

## Instance Types and Performance

| Instance Type | vCPU | Memory | Network | Cost/Month | Best For |
|---|---|---|---|---|---|
| t3.large | 2 | 8GB | Up to 5 Gbps | ~$60 | Small workloads, testing |
| t3.xlarge | 4 | 16GB | Up to 5 Gbps | ~$150 | Medium workloads, production |
| t3.2xlarge | 8 | 32GB | Up to 5 Gbps | ~$300 | Large workloads |
| m5.2xlarge | 8 | 32GB | 10 Gbps | ~$350 | Sustained workloads |
| c5.2xlarge | 8 | 16GB | 10 Gbps | ~$320 | CPU-intensive video processing |

## Database Sizing

| Size | Storage | Cost/Month | Suitable For |
|---|---|---|---|
| Small | 20-50 GB | ~$20-40 | Development, testing |
| Medium | 50-200 GB | ~$50-150 | Production, small team |
| Large | 200-500 GB | ~$150-350 | Enterprise, high volume |
| Extra Large | 500-1000 GB | ~$350-600 | Archive, large scale |

## Post-Deployment Configuration

### 1. Access SSH
```bash
ssh -i /path/to/your-key.pem ubuntu@<EC2-PUBLIC-IP>
```

### 2. Configure Application Environment
```bash
# SSH into the instance
cd /opt/maquerade

# Create custom .env file
sudo nano .env.production

# Add custom configurations as needed
# Then restart PM2
pm2 restart maquerade
```

### 3. Enable SSL/TLS (Optional but Recommended)
```bash
# Install Certbot for Let's Encrypt
sudo apt-get install certbot python3-certbot-nginx

# Get certificate
sudo certbot --nginx -d your-domain.com

# Auto-renewal is enabled by default
```

### 4. Monitor Application
```bash
# SSH into instance
pm2 logs maquerade          # View logs
pm2 status                  # Check process status
pm2 monit                   # Real-time monitoring
```

## Scaling and Updates

### Scale Up Instance
1. Stop current instance
2. Create AMI from current instance
3. Launch new instance with larger instance type
4. Update Load Balancer target group

### Update Application
```bash
# SSH into instance
cd /opt/maquerade
git pull origin main
npm install
npm run build
pm2 restart maquerade
```

## Cost Optimization

### Recommended Savings
1. **Spot Instances**: Save 70% on compute (for non-critical workloads)
2. **Reserved Instances**: Save 30-50% for 1-3 year commitments
3. **RDS Multi-AZ Disabled**: By default, only single AZ (no redundancy cost)
4. **Database Automated Backups**: 7 days retention included

### Estimated Monthly Costs
- **Small Setup** (t3.large + 50GB DB): ~$100-120
- **Medium Setup** (t3.xlarge + 100GB DB): ~$180-210
- **Production Setup** (c5.2xlarge + 200GB DB): ~$450-500

## Troubleshooting

### Application Not Responding
```bash
# SSH into instance
ssh -i /path/to/key.pem ubuntu@<IP>

# Check PM2 status
pm2 status

# View logs
pm2 logs maquerade

# Restart if needed
pm2 restart maquerade
```

### Database Connection Issues
```bash
# Check security group inbound rules allow EC2 to RDS (port 5432)
# Verify DATABASE_URL in .env.production is correct
# Test connection:
psql postgresql://username:password@endpoint:5432/maquerade
```

### Out of Disk Space
```bash
# Check disk usage
df -h

# If uploads full, clean old processed files
rm -rf /opt/maquerade/uploads/*

# Or upgrade EBS volume size in AWS console
```

## Backup and Restore

### Automatic RDS Backups
- Created daily (default 7-day retention)
- View in RDS console → Databases → Backups
- Restore from backup: RDS console → Backups → Restore DB Instance

### Manual Database Backup
```bash
# Dump database
pg_dump postgresql://username:password@endpoint:5432/maquerade > backup.sql

# Upload to S3
aws s3 cp backup.sql s3://your-bucket/backups/
```

## Monitoring with CloudWatch

### Set Up Alarms
1. Go to CloudWatch Console
2. Create alarms for:
   - EC2 CPU Utilization > 80%
   - EC2 Disk Usage > 85%
   - RDS CPU > 80%
   - RDS Free Storage Space < 10GB
   - Load Balancer Unhealthy Target Count > 0

## Security Best Practices

1. **SSH Access**: Restrict security group to specific IPs
   ```bash
   # Instead of 0.0.0.0/0, use your IP:
   # 203.0.113.0/32
   ```

2. **Database Password**: Use strong, unique password
   - Minimum 8 characters
   - Mix upper/lowercase, numbers, special characters
   - Store securely (AWS Secrets Manager recommended)

3. **SSL/TLS**: Enable HTTPS
   - Use ACM certificate or Let's Encrypt
   - Redirect HTTP to HTTPS

4. **Regular Updates**: Keep instance updated
   ```bash
   sudo apt-get update && sudo apt-get upgrade -y
   ```

5. **Backup Strategy**: Regular automated backups
   - RDS automated backups: 7 days
   - Additional manual backups to S3

## Next Steps

- Configure custom domain name with Route 53
- Set up CloudWatch monitoring and alerts
- Enable RDS Multi-AZ for high availability
- Implement auto-scaling for variable workloads
- Set up CI/CD pipeline for automated deployments

## Support

For issues with:
- **AWS CloudFormation**: AWS Support
- **Masquerade Application**: Check logs at `/opt/maquerade/logs/`
- **FFmpeg**: Verify installation with `ffmpeg -version`

## Cleanup

To delete all resources and avoid charges:

```bash
# Option 1: AWS Console
# CloudFormation → Stacks → Select Stack → Delete

# Option 2: AWS CLI
aws cloudformation delete-stack --stack-name maquerade-production
```

⚠️ **Warning**: This will delete all resources including the database. Create a backup first if needed.
