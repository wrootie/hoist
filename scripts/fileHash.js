const crypto = require('crypto');
const fs = require('fs');

// https://tools.ietf.org/html/rfc4648#section-5
function md5toMd5url(hash) {
  return hash.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// Compute the original file's base64url encoded hash based on file contents.
exports.cdnFileName = function cdnFileName(buffer) {
  if (typeof buffer === 'string') { buffer = fs.readFileSync(buffer); }
  let hash = crypto.createHash('md5');
  hash.update(buffer);
  hash = hash.digest('base64');
  return md5toMd5url(hash);
}

// Compute the original file's base64url encoded hash, with the file name included.
exports.hoistCacheName = function hoistCacheName(fileName, buffer) {
  let contentHash;
  if (typeof buffer !== 'string') {
    contentHash = crypto.createHash('md5');
    contentHash.update(buffer);
    contentHash = md5toMd5url(contentHash.digest('base64'));
  }
  else {
    contentHash = md5toMd5url(buffer);
  }

  let hash = crypto.createHash('md5');
  hash.update(Buffer.from(fileName + contentHash));
  hash = hash.digest('base64');
  return md5toMd5url(hash);
}
