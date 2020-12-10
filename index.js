const deploy = require('./scripts/deploy');
const makePublic = require('./scripts/make-public');
const makePrivate = require('./scripts/make-private');
const serve = require('./scripts/serve');
const { cdnFileName } = require('./scripts/fileHash');

module.exports = {
  deploy,
  makePublic,
  makePrivate,
  serve,
  cdnFileName,
};
