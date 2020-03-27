#!/usr/bin/env node
const express = require('express');
const open = require('open');
const getPort = require('get-port');

module.exports = async function serve(cwd, usrPort){

  const app = express();
  app.use(express.static(cwd, {
    extensions: ['html', 'htm'],
  }));

  const port = await getPort({ port: usrPort || 3000 });
  app.listen(port, () => console.log(`Static site serving on port ${port}!`));

  await open(`http://localhost:${port}`);

  return;

}
