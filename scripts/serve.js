#!/usr/bin/env node
const express = require('express');
const open = require('open');
const getPort = require('get-port');

module.exports = async function serve(root, usrPort=null, autoOpen=true){

  const app = express();
  app.use(express.static(root, {
    extensions: ['html', 'htm'],
  }));

  const port = await getPort({ port: usrPort || 3000 });
  const url = `http://localhost:${port}`;

  app.listen(port, () => console.log(`Static site serving on port ${port}!`));

  if (autoOpen) {
    await open(url);
  }

  return {
    url,
    port,
    root,
    stop: () => new Promise((resolve) => app.close(resolve)),
  };
}
