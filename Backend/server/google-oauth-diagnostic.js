#!/usr/bin/env node

/**
 * Google OAuth Configuration Diagnostic Script
 * Vérifie que tous les prérequis sont en place pour la connexion Google Calendar
 * 
 * Usage:
 *   node google-oauth-diagnostic.js
 */

const fs = require('fs');
const path = require('path');

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

const icons = {
  check: '✅',
  cross: '❌',
  warn: '⚠️',
  info: 'ℹ️',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function section(title) {
  console.log(`\n${colors.cyan}${'='.repeat(60)}${colors.reset}`);
  log(title, 'cyan');
  console.log(`${colors.cyan}${'='.repeat(60)}${colors.reset}\n`);
}

function checkEnvFile() {
  section('1️⃣  Vérification du fichier .env');

  const envPath = path.join(__dirname, '.env');
  const envExamplePath = path.join(__dirname, '.env.example');

  if (!fs.existsSync(envPath)) {
    log(`${icons.cross} Fichier .env non trouvé à: ${envPath}`, 'red');
    log('    ↳ Crée un fichier .env dans Backend/server/', 'yellow');
    return null;
  }

  log(`${icons.check} Fichier .env trouvé`, 'green');

  // Read .env
  const envContent = fs.readFileSync(envPath, 'utf-8');
  const envVars = {};
  
  envContent.split('\n').forEach(line => {
    const match = line.match(/^([^=]+)=(.*)$/);
    if (match) {
      envVars[match[1].trim()] = match[2].trim();
    }
  });

  return envVars;
}

function checkOAuthVars(envVars) {
  section('2️⃣️  Vérification des variables OAuth');

  const requiredVars = [
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GOOGLE_CALENDAR_REDIRECT_URI',
  ];

  const results = {};
  let allPresent = true;

  requiredVars.forEach(varName => {
    const value = envVars[varName];
    if (value && value.length > 0) {
      const displayValue = varName === 'GOOGLE_CLIENT_SECRET' 
        ? value.substring(0, 10) + '...' 
        : value;
      log(`${icons.check} ${varName}`, 'green');
      log(`    ↳ ${displayValue}`, 'cyan');
      results[varName] = true;
    } else {
      log(`${icons.cross} ${varName} est vide ou manquant`, 'red');
      results[varName] = false;
      allPresent = false;
    }
  });

  return { results, allPresent };
}

function checkRedirectUri(envVars) {
  section('3️⃣️  Vérification du Redirect URI');

  const redirectUri = envVars['GOOGLE_CALENDAR_REDIRECT_URI'];
  const expectedUri = 'http://localhost:3001/auth/google/callback';

  if (redirectUri === expectedUri) {
    log(`${icons.check} Redirect URI est correct`, 'green');
    log(`    ↳ ${redirectUri}`, 'cyan');
    return true;
  } else {
    log(`${icons.warn} Redirect URI ne correspond pas exactement`, 'yellow');
    log(`    Attendu: ${expectedUri}`, 'cyan');
    log(`    Réel:    ${redirectUri}`, 'cyan');
    
    if (redirectUri && redirectUri.includes('localhost:3001') && redirectUri.includes('callback')) {
      log(`    ↳ URL valide mais légèrement différente (devrait quand même fonctionner)`, 'yellow');
      return true;
    }
    
    return false;
  }
}

function checkClientIdFormat(clientId) {
  section('4️⃣️  Vérification du format Client ID');

  // Expected format: ###-##########.apps.googleusercontent.com
  const googleClientIdPattern = /^\d+-[a-z0-9]{24}\.apps\.googleusercontent\.com$/;

  if (googleClientIdPattern.test(clientId)) {
    log(`${icons.check} Format Client ID est valide`, 'green');
    log(`    ↳ ${clientId}`, 'cyan');
    return true;
  } else {
    log(`${icons.cross} Format Client ID semble invalide`, 'red');
    log(`    Fourni: ${clientId}`, 'cyan');
    log(`    ↳ Attend le format: ###-##########.apps.googleusercontent.com`, 'yellow');
    return false;
  }
}

function checkClientSecretFormat(secret) {
  section('5️⃣️  Vérification du format Client Secret');

  // Expected format: GOCSPX-############
  const googleClientSecretPattern = /^GOCSPX-[a-zA-Z0-9_-]{30,}$/;

  if (googleClientSecretPattern.test(secret)) {
    log(`${icons.check} Format Client Secret est valide`, 'green');
    log(`    ↳ ${secret.substring(0, 15)}...`, 'cyan');
    return true;
  } else {
    log(`${icons.cross} Format Client Secret semble invalide`, 'red');
    log(`    ↳ Attend le format: GOCSPX-############`, 'yellow');
    return false;
  }
}

function checkBackendServer() {
  section('6️⃣️  Vérification du code backend');

  const routesPath = path.join(__dirname, 'routes', 'recruiterCalendarRoute.js');
  
  if (!fs.existsSync(routesPath)) {
    log(`${icons.warn} Route fichier non trouvé: ${routesPath}`, 'yellow');
    log(`    ↳ Le endpoint /recruiter-calendar/ peut ne pas être disponible`, 'yellow');
    return false;
  }

  log(`${icons.check} Route fichier trouvé`, 'green');
  log(`    ↳ ${routesPath}`, 'cyan');

  // Check if route is mounted in main server file
  const indexPath = path.join(__dirname, 'index.js');
  if (fs.existsSync(indexPath)) {
    const indexContent = fs.readFileSync(indexPath, 'utf-8');
    if (indexContent.includes('recruiterCalendarRoute') || indexContent.includes('/recruiter-calendar')) {
      log(`${icons.check} Route est montée dans le serveur principal`, 'green');
      return true;
    } else {
      log(`${icons.warn} Route n'est peut-être pas montée dans index.js`, 'yellow');
      log(`    ↳ Ajoute cette ligne à Backend/server/index.js:`, 'yellow');
      log(`    const recruiterCalendarRoute = require('./routes/recruiterCalendarRoute');`, 'cyan');
      log(`    app.use('/recruiter-calendar', recruiterCalendarRoute);`, 'cyan');
      return false;
    }
  }

  return true;
}

function generateTestCommand(envVars) {
  section('7️⃣️  Commande de test');

  log(`${icons.info} Une fois la configuration Google Cloud Console terminée:`, 'yellow');
  log('', 'reset');
  log('1. Redémarre le serveur Node:');
  log('   cd Backend/server && npm start', 'cyan');
  log('', 'reset');
  log('2. Vide le cache du navigateur (Ctrl+Shift+Delete)', 'cyan');
  log('', 'reset');
  log('3. Va à http://localhost:5173 et teste la connexion Google Calendar', 'cyan');
  log('', 'reset');
  log('4. Ou teste directement avec cURL:', 'yellow');
  log('   curl "http://localhost:3001/recruiter-calendar/connect-url/[RECRUITER_ID]"', 'cyan');
}

function generateReport(results) {
  section('📊 Rapport de diagnostic');

  const checks = [
    { name: 'Fichier .env existe', status: results.envExists },
    { name: 'Variables OAuth présentes', status: results.oauthVarsPresent },
    { name: 'Redirect URI correct', status: results.redirectUriOk },
    { name: 'Format Client ID valide', status: results.clientIdValid },
    { name: 'Format Client Secret valide', status: results.clientSecretValid },
    { name: 'Route backend présente', status: results.backendOk },
  ];

  const passed = checks.filter(c => c.status).length;
  const total = checks.length;

  checks.forEach(check => {
    const icon = check.status ? icons.check : icons.cross;
    const color = check.status ? 'green' : 'red';
    log(`${icon} ${check.name}`, color);
  });

  console.log('');
  
  if (passed === total) {
    log(`✅ Tous les checks sont validés! (${passed}/${total})`, 'green');
    log('', 'reset');
    log(`${icons.info} Configuration locale terminée! Procède à la configuration Google Cloud Console:`, 'cyan');
    log('    1. Ouvre: https://console.cloud.google.com/', 'cyan');
    log('    2. Ajoute hamouda.chekir@esprit.tn aux Test users', 'cyan');
    log('    3. Attends 1-3 minutes', 'cyan');
    log('    4. Redémarre le serveur Node', 'cyan');
    log('    5. Vide le cache du navigateur', 'cyan');
    log('    6. Teste la connexion', 'cyan');
  } else {
    log(`⚠️  ${passed}/${total} checks validés. ${total - passed} problèmes détectés.`, 'yellow');
    log('', 'reset');
    log('Corrige les erreurs marquées en rouge avant de continuer.', 'yellow');
  }
}

// Main execution
function main() {
  console.clear();
  log('🔐 Google OAuth Configuration Diagnostic', 'blue');
  log('CI-DESSOUS: Vérification complète de la configuration OAuth', 'blue');
  console.log('');

  // Check .env
  const envVars = checkEnvFile();
  if (!envVars) {
    log('\n❌ Impossible de continuer sans .env', 'red');
    process.exit(1);
  }

  // Check OAuth vars
  const { results: oauthResults, allPresent } = checkOAuthVars(envVars);
  
  // Check redirect URI
  const redirectUriOk = checkRedirectUri(envVars);

  // Check Client ID format
  const clientIdValid = checkClientIdFormat(envVars['GOOGLE_CLIENT_ID'] || '');

  // Check Client Secret format
  const clientSecretValid = checkClientSecretFormat(envVars['GOOGLE_CLIENT_SECRET'] || '');

  // Check backend
  const backendOk = checkBackendServer();

  // Test command
  generateTestCommand(envVars);

  // Generate report
  generateReport({
    envExists: true,
    oauthVarsPresent: allPresent,
    redirectUriOk,
    clientIdValid,
    clientSecretValid,
    backendOk,
  });

  console.log('');
}

main();
