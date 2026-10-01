require('dotenv').config();

// Validar variáveis de ambiente críticas
const requiredEnvVars = ['TELEGRAM_BOT_TOKEN', 'ADMIN_ID', 'FIREBASE_CONFIG'];
const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);

if (missingEnvVars.length > 0) {
  console.error(`❌ Variáveis de ambiente faltosas: ${missingEnvVars.join(', ')}`);
  console.error('Por favor, configure o arquivo .env com todas as variáveis necessárias.');
  console.error('Veja .env.example para um modelo.');
  process.exit(1);
}

module.exports = {
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN,
    adminId: parseInt(process.env.ADMIN_ID),
    polling: {
      interval: 300,
      autoStart: true,
      params: {
        timeout: 10
      }
    }
  },
  firebase: {
    config: JSON.parse(process.env.FIREBASE_CONFIG)
  },
  bot: {
    banThreshold: parseInt(process.env.BAN_THRESHOLD) || 3,
    siteUrl: process.env.KANDA_SITE_URL || 'https://kandafreelancer.surge.sh',
    adminUsername: process.env.ADMIN_USERNAME || 'zuacassongo'
  },
  server: {
    port: parseInt(process.env.PORT) || 3000,
    nodeEnv: process.env.NODE_ENV || 'production'
  },
  debug: {
    enabled: process.env.DEBUG === 'true' || false,
    logLevel: process.env.LOG_LEVEL || 'info'
  }
};
