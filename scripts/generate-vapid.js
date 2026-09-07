#!/usr/bin/env node
// Generates a VAPID keypair for web-push.
// Usage: node scripts/generate-vapid.js
//
// Run this once and paste the output into your .env file:
//   VAPID_PUBLIC_KEY=...
//   VAPID_PRIVATE_KEY=...
//
// Requires `web-push` to be installed somewhere up the tree.
// After `npm install` in apps/api this works from repo root.

let webpush;
try {
  webpush = require('web-push');
} catch (_) {
  try {
    webpush = require('../apps/api/node_modules/web-push');
  } catch (e) {
    console.error('Cannot find web-push. Run `npm install` in apps/api first.');
    process.exit(1);
  }
}

const keys = webpush.generateVAPIDKeys();
console.log('# Add these to your .env file:');
console.log('VAPID_PUBLIC_KEY=' + keys.publicKey);
console.log('VAPID_PRIVATE_KEY=' + keys.privateKey);
console.log('VAPID_SUBJECT=mailto:broker@stmichael.ru');
