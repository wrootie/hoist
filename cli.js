#!/usr/bin/env node
const path = require('path');
const args = process.argv.slice(2);
const dir = path.join(process.cwd(), args[1] || '');

if (args[0] === 'down') {
  require('./scripts/make-private')(dir, args[1]);
}
else if (args[0] === 'up') {
  if (args[1]) {
    require('./scripts/deploy')(dir, args[2], '', true);
  }
  require('./scripts/make-public')(dir, args[2]);
}
else if (args[0] === 'serve') {
  if (!dir) {
    return console.error('Directory required.');
  }
  require('./scripts/serve')(dir, args[2]);
}