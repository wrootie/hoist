#!/usr/bin/env node
const fs = require('fs');
const findUp = require('find-up');
const { client } = require('google-cloud-bucket');

module.exports = async function up(cwd){

  const jsonKeyFile = await findUp('gcloud.json', { cwd });
  const BUCKET = JSON.parse(fs.readFileSync(jsonKeyFile)).bucket;
  const storage = client.new({ jsonKeyFile });

  if (!await storage.exists(BUCKET)) {
    await storage.bucket(BUCKET).create({ location: 'us-west1' });
  }

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
