#!/usr/bin/env node
const fs = require('fs');
const findUp = require('find-up');

const initBucket = require('./initBucket');

module.exports = async function down(cwd, userBucket=null){
  const jsonKeyFile = await findUp('gcloud.json', { cwd });
  const config = JSON.parse(fs.readFileSync(jsonKeyFile));
  const [_, bucket] = await initBucket(config, (userBucket || config.bucket).toLowerCase())
  await bucket.removePublicAccess();
  return;
}


