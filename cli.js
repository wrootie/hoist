#!/usr/bin/env node
const path = require('path');
const args = process.argv.slice(2);
const dir = path.join(process.cwd(), args[1] || '');

console.log(dir, args);

if (args[0] === 'down') {
  require('./scripts/make-private')(dir);
}
else if (args[0] === 'up') {
  if (args[1]) {
    require('./scripts/deploy')(dir);
  }
  require('./scripts/make-public')(dir);
}