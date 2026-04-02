module.exports = {
  apps: [{
    name: 'maquerade',
    script: 'dist/index.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 5000,
      SAM2_SERVICE_URL: 'http://172.31.6.85:8001'
    },
    env_production: {
      NODE_ENV: 'production',
      PORT: 5000,
      SAM2_SERVICE_URL: 'http://172.31.6.85:8001'
    },
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_file: './logs/combined.log',
    time: true
  }]
};