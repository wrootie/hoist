const { client } = require('google-cloud-bucket');

module.exports = async function initBucket(config, bucketName) {
  config.project_id = config.projectId = process.env.PROJECT_ID || config.project_id || config.projectId;

  const storage = client.new({
    clientEmail: config.client_email || config.clientEmail,
    privateKey: config.private_key || config.privateKey,
    projectId: config.projectId
  });

  if (!await storage.exists(bucketName)) {
    console.log(`🕐 Creating bucket ${bucketName}.`);
    await storage.bucket(bucketName).create({ location: 'us-west1' });
  }

  // CONFIGURE CORS ON A BUCKET (warning: Your service account must have the 'roles/storage.admin' role)
  const bucket = storage.bucket(bucketName);

  await bucket.cors.setup({
    origin: ['*'],
    method: ['GET', 'OPTIONS', 'HEAD', 'POST'],
    responseHeader: ['Authorization', 'Origin', 'X-Requested-With', 'Content-Type', 'Accept'],
    maxAgeSeconds: 3600
  });

  await bucket.website.setup({
    mainPageSuffix: 'index.html',
    notFoundPage: '404.html',
  });

  return [ storage, bucket ];
}
