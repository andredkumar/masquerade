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
# Step 0 — deploy-hygiene pre-flight (REQUIRED before any build).
# A deployed build must always correspond to a known commit. Refuse to build
# if the tree is dirty or HEAD is unknown.
git rev-parse --short HEAD          # record the commit you are about to ship
git status --porcelain              # MUST print nothing (clean working tree)
# If `git status --porcelain` prints anything, STOP — commit or stash first.

# Safe update (stops existing processes first)
npm run update

# OR manual update steps
npm run pm2:stop     # Stop current process
npm install          # Update dependencies
npm run build        # Rebuild application
npm run pm2:restart  # Restart process
```

### Post-deploy verification — REQUIRED (Phase 4b-0 re-entrancy gate)

The Phase 4b-0 `processVideo` re-entrancy fix **cannot be reproduced from current
source** (the original `<jobId>/<jobId>` nesting / frame-deletion symptoms belong
to a replaced code variant). The **live redo loop, run twice on the real server,
is therefore the required verification** that the fix holds against whatever was
actually deployed. Run this immediately after `pm2:restart`, before declaring the
deploy good:

```bash
# 1. Upload a short test video; wait for status → ready.
# 2. Apply a template mask (redo loop run #1) → confirm it completes and the
#    output frames are correct.
# 3. WITHOUT re-uploading, re-mask and apply AGAIN for the SAME jobId
#    (redo loop run #2). This is the re-entrant path the fix targets.
# 4. Confirm run #2 also completes correctly AND the server log shows the
#    tripwire mkdir lines with NO doubled segment, e.g.:
pm2 logs --lines 200 | grep '🗂️'
#    Expect resolved paths like:
#      🗂️  [raw-frames]    mkdir .../temp_extracted/<jobId>
#      🗂️  [apply-staging] mkdir .../temp_extracted/<jobId>/_apply
#      🗂️  [ai-run]        mkdir .../spokes/ai/<jobId>/<runId>
#    A path-doubling tripwire error (process crash with "path-doubling tripwire")
#    or a <jobId>/<jobId> segment means the deploy is BAD — roll back.
# 5. Confirm the persistent raw frames under temp_extracted/<jobId>/ survived
#    both applies (re-mask still works without re-upload).
```

If run #2 fails, frames are missing, or any doubled-segment path appears, the
deploy does not pass the gate.

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