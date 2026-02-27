# Masquerade - AWS Deployment Package

## Quick Start: Choose Your Deployment Method

### 🚀 Option 1: CloudFormation (Recommended - One Click!)
**Best for**: Complete AWS setup with networking, database, load balancer

See [AWS-CLOUDFORMATION-DEPLOYMENT.md](./AWS-CLOUDFORMATION-DEPLOYMENT.md) for:
- One-click deployment via AWS Console
- Automatic VPC, RDS, EC2, ALB setup
- Complete production setup in 5-10 minutes

### 📦 Option 2: Manual EC2 Deployment
**Best for**: Custom configurations, existing infrastructure

```bash
# Install PM2 globally first
npm install -g pm2

# Full production deployment with PM2
npm run deploy

# OR manual step-by-step
./install-ffmpeg.sh  # Install FFmpeg
npm install          # Install dependencies
npm run build        # Build application
npm run pm2:start    # Start with PM2
```

### Updating Existing Deployment
```bash
# Safe update (stops existing processes first)
npm run update

# OR manual update steps
npm run pm2:stop     # Stop current process
npm install          # Update dependencies
npm run build        # Rebuild application
npm run pm2:restart  # Restart process
```

### Manual Setup
1. **Install FFmpeg (CRITICAL for .mp4/.mov/.avi)**
   ```bash
   # Easy automatic installation
   ./install-ffmpeg.sh
   
   # OR manual installation:
   # Amazon Linux 2
   sudo yum update -y
   sudo amazon-linux-extras install epel -y
   sudo yum install -y ffmpeg ffmpeg-devel
   
   # Ubuntu/Debian
   sudo apt update && sudo apt install -y ffmpeg
   ```

2. **Install Dependencies**
   ```bash
   npm install
   ```

3. **Set Environment Variables**
   ```bash
   # Database (PostgreSQL)
   DATABASE_URL=postgresql://username:password@host:port/database
   
   # Node Environment
   NODE_ENV=production
   PORT=5000
   ```

4. **Database Setup**
   ```bash
   npm run db:push
   ```

5. **Build Application**
   ```bash
   npm run build
   ```

6. **Start Production Server**
   ```bash
   npm start
   ```

## AWS Deployment Options

### Option 1: EC2 Instance
- Upload this package to your EC2 instance
- Install Node.js 20+ and PostgreSQL
- Follow Quick Start steps above

### Option 2: Elastic Beanstalk
- Create new Elastic Beanstalk application
- Upload this ZIP package
- Configure environment variables in EB console
- Set up RDS PostgreSQL database

### Option 3: ECS/Fargate
- Build Docker image from included files
- Deploy to ECS with appropriate task definition
- Connect to RDS PostgreSQL instance

## Required AWS Services

- **Compute**: EC2, Elastic Beanstalk, or ECS
- **Database**: RDS PostgreSQL
- **Storage**: EBS or EFS for processed files
- **Optional**: CloudFront for static assets

## Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://...` |
| `NODE_ENV` | Environment mode | `production` |
| `PORT` | Server port | `5000` |

## File Structure

```
├── client/          # React frontend (with Google Analytics)
├── server/          # Express backend
├── shared/          # Shared types/schemas
├── package.json     # Dependencies
├── vite.config.ts   # Build configuration
├── ecosystem.config.js  # PM2 configuration
├── deploy.sh        # Automated deployment script
└── ...config files  # TypeScript, Tailwind, etc.
```

## About Masquerade

Masquerade is a high-performance video processing application that enables interactive masking and frame extraction from video files. The application specializes in processing medical imaging files (including DICOM) and standard video formats with a focus on speed and efficiency.

## Google Analytics

This package includes Google Analytics tracking (ID: G-CHPVX85M0K) integrated into the application.