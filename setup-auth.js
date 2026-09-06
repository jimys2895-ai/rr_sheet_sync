/**
 * Credential test for v1.0 auth.
 * Usage: node setup-auth.js
 * Verifies that the env vars in .env produce a valid access token.
 */
require('dotenv').config();
const { getToken } = require('./src/auth');

async function run() {
  console.log('Testing RoseRocket v1.0 credentials...');
  console.log(`  ORG_URL  : ${process.env.ROSEROCKET_ORG_URL}`);
  console.log(`  USERNAME : ${process.env.ROSEROCKET_USERNAME}`);
  console.log(`  CLIENT_ID: ${process.env.ROSEROCKET_CLIENT_ID}`);
  console.log('');

  try {
    const token = await getToken();
    console.log('✓ Authentication successful!');
    console.log(`  Token (first 40 chars): ${token.slice(0, 40)}...`);
    console.log('\nYou can now run: npm run sync');
  } catch (err) {
    const detail = err.response?.data ?? err.message;
    console.error('✗ Authentication failed:', JSON.stringify(detail, null, 2));
    console.error('\nCheck:');
    console.error('  1. ROSEROCKET_ORG_URL is correct (e.g. https://yourorg.roserocket.com)');
    console.error('  2. ROSEROCKET_USERNAME / ROSEROCKET_PASSWORD match your RoseRocket login');
    console.error('  3. ROSEROCKET_CLIENT_ID is the Org App Key UUID from Settings → Org Apps');
    console.error('  4. ROSEROCKET_CLIENT_SECRET is correct');
    console.error('  5. If the token URL is wrong, set ROSEROCKET_TOKEN_URL in .env to override');
    process.exit(1);
  }
}

run();
