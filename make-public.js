#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { gzip } = require('node-gzip');
const { client } = require('google-cloud-bucket');
const { promisify } = require('util');
const glob = promisify(require('glob'));

const BUCKET = 'petergallotta.org';
const jsonKeyFile = path.join(__dirname, './gcloud.json');
const storage = client.new({ jsonKeyFile });

const CWD = process.cwd();

const CACHE_PATH = path.join(__dirname, '.file-cache.json');
let cache = {};
if (fs.existsSync(CACHE_PATH)) {
  cache = JSON.parse(fs.readFileSync(CACHE_PATH));
}

module.exports = async function up(){

  let exists = await storage.exists(BUCKET);
  console.log(exists ? 'Bucket exists.' : 'Bucket does not exist.');
  if (!exists) { return; }

  // CONFIGURE CORS ON A BUCKET (warning: Your service account must have the 'roles/storage.admin' role)
  const bucket = storage.bucket(BUCKET);
  await bucket.cors.setup({
    origin: ['*'],
    method: ['GET', 'OPTIONS', 'HEAD', 'POST'],
    responseHeader: ['Authorization', 'Origin', 'X-Requested-With', 'Content-Type', 'Accept'],
    maxAgeSeconds: 3600
  });

  await bucket.addPublicAccess();
  return;

}
