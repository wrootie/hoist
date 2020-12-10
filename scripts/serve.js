#!/usr/bin/env node
const express = require('express');
const open = require('open');
const getPort = require('get-port');
const https = require('https');
const devcert = require('devcert');
const findUp = require('find-up');
const fs = require('fs');

const CONFIG_FILENAME = 'gcloud.json';

module.exports = async function serve(root, usrPort=null, autoOpen=true){

  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(await findUp(CONFIG_FILENAME, { cwd: root })));
  } catch {}

  const app = express();
  app.use(express.static(root, {
    extensions: ['html', 'htm'],
  }));

  const domain = settings.testDomain || settings['test_domain'] || 'hoist.test';

  if (!devcert.hasCertificateFor(domain)){
    console.log('Installing SSL Cert, This May Take a Moment');
  }

  const ssl = await devcert.certificateFor(domain);
  const port = await getPort({ port: usrPort ? parseInt(usrPort) : 443 });
  const url = `https://${domain}${port === 443 ? '' : `:${port}`}`;
  const server = https.createServer(ssl, app).listen(port, () => console.log(`Static site serving on port ${port}!`));

  if (autoOpen) {
    await open(`${url}${typeof autoOpen === 'string' ? autoOpen : ''}`);
  }

  return {
    url,
    port,
    root,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}
