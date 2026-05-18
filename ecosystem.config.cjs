module.exports = {
  apps: [
    {
      name: 'arena-server',
      script: 'dist/index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        WS_PORT: 3001,
      },
    },
  ],
};
