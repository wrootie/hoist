const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const findUp = require('find-up');
const { gzip } = require('node-gzip');
const { client } = require('google-cloud-bucket');
const { promisify } = require('util');
const glob = promisify(require('glob'));
const replace = require('buffer-replace');
const imageminMozjpeg = require('imagemin-mozjpeg');
const imageminPngquant = require('imagemin-pngquant');
const imageminGifsicle = require('imagemin-gifsicle');
const imageminWebp = require('imagemin-webp');
const postcss = require('postcss');
const cssnano = require('cssnano');
const autoprefixer = require('autoprefixer')
const Terser = require('terser');
const htmlMinifier = require('html-minifier')
const brotli = require('iltorb');
const cliProgress = require('cli-progress');

const progress = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);

const DELETE_FILENAME = '.hoist-delete';
const CACHE_FILENAME = '.hoist-cache';

const IMG_EXTS = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
};

const CONTENT_TYPE = {
  ...IMG_EXTS,
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.md': 'text/markdown',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
};

const WELL_KNOWN = {
  'favicon.ico': true,
  'robots.txt': true,
  'index.html': true,
}

// Compute the original file's base64url encoded hash
// https://tools.ietf.org/html/rfc4648#section-5
function fileHash(buffer) {
  let hash = crypto.createHash('md5');
  hash.update(buffer);
  hash = hash.digest('base64');
  return hash.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// Compute the original file's base64url encoded hash
// https://tools.ietf.org/html/rfc4648#section-5
function cacheHash(fileName, buffer) {
  let hash = crypto.createHash('md5');
  hash.update(Buffer.from(fileName));
  hash.update(buffer);
  hash = hash.digest('base64');
  return hash.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function generateWebp(file, input, BUCKET) {
  let remoteName = path.parse(path.join(BUCKET, file));
  remoteName.extname = '.webp';
  const filePath = path.format(remoteName)
  const buffer = await imageminWebp({ quality: 75 })(input);
  remoteName.base = fileHash(buffer);
  delete remoteName.extname;
  remoteName = path.format(remoteName);
  return {
    filePath,
    remoteName,
    buffer,
    contentType: 'image/webp',
    contentEncoding: undefined,
    cacheControl: 'public,max-age=31536000,immutable',
  };
}

function generateSourceMapFile(filePath, remoteName, content, BUCKET) {
  remoteName = path.join(BUCKET, remoteName) + '.map';
  const buffer = Buffer.from(content);
  return {
    filePath,
    remoteName,
    buffer,
    contentType: 'application/json',
    contentEncoding: undefined,
    cacheControl: 'public,max-age=31536000,immutable',
  };
}

module.exports = async function deploy(workingDir, bucket=null) {

  const jsonKeyFile = await findUp('gcloud.json', { cwd: workingDir });
  const config = JSON.parse(fs.readFileSync(jsonKeyFile));
  const storage = client.new({ jsonKeyFile });

  const BUCKET = bucket || config.bucket;

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

  await bucket.website.setup({
    mainPageSuffix: 'index.html',
    notFoundPage: '404.html',
  });

  const remoteObjects = new Map();
  for (let obj of await storage.list(BUCKET, { timeout: 520000 }) || []) {
    remoteObjects.set(`${obj.bucket}/${obj.name}`, {
      name: obj.name,
      contentType: obj.contentType,
      md5Hash: obj.md5Hash,
    });
  }

  const NOW = Date.now();
  let toDelete = {};
  let fileCache = new Set();
  try {
    toDelete = await storage.get(path.join(BUCKET, DELETE_FILENAME));
    fileCache = new Set(await storage.get(path.join(BUCKET, CACHE_FILENAME)));
  } catch(_err) {}
  toDelete = toDelete || {};
  fileCache = fileCache && fileCache.size ? fileCache : new Set();
  remoteObjects.delete(path.join(BUCKET, DELETE_FILENAME));

  const files = await glob(path.join(workingDir, '**/*'));
  let iter = 0;
  const THREAD_COUNT = 12;
  const threads = [];
  for (let i=0;i<THREAD_COUNT;i++) { threads.push(Promise.resolve()); }

  const hashes = {};
  const buffers = {};

  for (let filePath of files) {
    if (fs.statSync(filePath).isDirectory()) { continue; }
    let file = path.relative(workingDir, filePath);
    buffers[file] = fs.readFileSync(filePath);
    hashes[file] = fileHash(buffers[file]);
  }

  let uploadCount = 0;
  let errorCount = 0;
  const entries = Object.entries(buffers);

  async function upload({ remoteName, buffer, contentType, contentEncoding, cacheControl }) {
    const fileHashVal = fileHash(buffer);
    const headers = {
      'Content-Type': contentType,
      'Content-Encoding': contentEncoding,
      'Cache-Control': cacheControl,
    };

    if (!headers['Content-Type']) { delete headers['Content-Type']; }
    if (!headers['Content-Encoding']) { delete headers['Content-Encoding']; }
    if (!headers['Cache-Control']) { delete headers['Cache-Control']; }

    let opts = {
      timeout: 520000,
      headers,
    };

    const hash = cacheHash(remoteName, buffer);
    delete toDelete[fileHash(buffer)];

    // Only upload if the file does not exist on the server yet.
    if (fileCache.has(hash)) { return; }
    fileCache.add(hash);

    // Upload it!
    await storage.insert(buffer, remoteName, opts).then(() => {
      uploadCount++;
    }, (err) => {
      console.error(err.message);
      errorCount++;
    });

    progress.update(uploadCount + errorCount);

    // Remove this item from our remote objects map so we don't delete if we cleanup.
    if (remoteObjects.has(fileHashVal)) {
      remoteObjects.delete(fileHashVal);
    }
  }

  await new Promise((resolve) => {
    const oldNames = Object.keys(hashes).sort((a, b) => a.length > b.length ? -1 : 1);
    progress.start(entries.length, uploadCount + errorCount);

    for (let [filePath, buffer] of entries) {
      const hash = hashes[filePath];
      const extname = path.extname(filePath);
      const contentType = CONTENT_TYPE[extname] || 'application/json'
      let contentEncoding = undefined;
      let cacheControl = 'public,max-age=31536000,immutable';

      threads[iter % THREAD_COUNT] = threads[iter % THREAD_COUNT].then(async () => {
        try {
          let remoteName = filePath;
          remoteName = path.parse(remoteName);

          if (remoteName.ext === '.html') {
            // Never cache HTML files.
            cacheControl = 'no-cache,no-store,max-age=0';

            // If an HTML file, but not the index.html, remove the `.html` for a bare URLs look in the browser.
            if (!WELL_KNOWN[remoteName.base]) {
              remoteName.base = remoteName.name;
              delete remoteName.extname;
            }

            // Minify HTML
            buffer = Buffer.from(htmlMinifier.minify(buffer.toString(), {
              caseSensitive: true,
              collapseBooleanAttributes: true,
              collapseInlineTagWhitespace: false,
              continueOnParseError: true,
              collapseWhitespace: true,
              decodeEntities: true,
              minifyCSS: true,
              minifyJS: true,
              removeAttributeQuotes: true,
              quoteCharacter: `"`,
              removeAttributeQuotes: true,
              removeComments: true,
              removeScriptTypeAttributes: true,
              removeStyleLinkTypeAttributes: true,
              sortAttributes: true,
              sortClassName: true,
              useShortDoctype: true,
            }));
          }

          // Otherwise, if not a well known file, use the hash value as its name for CDN cache busting.
          else if (!WELL_KNOWN[remoteName.base] && filePath.indexOf('.well-known') !== 0 && extname !== '.json') {
            remoteName.base = hash;
            delete remoteName.extname;
          }

          // Replace all Hash names in CSS and HTML files.
          if (extname === '.css' || extname === '.html') {
            for (let oldName of oldNames ) {
              const hash = hashes[oldName];
              let hashName = path.parse(oldName);
              hashName.base = hash;
              delete hashName.extname;
              hashName = path.format(hashName);
              buffer = replace(buffer, `/${oldName}`, `/${hashName}`);
              const relativePath = path.relative(path.dirname(filePath), oldName);
              if (relativePath) {
                buffer = replace(buffer, `./${relativePath}`, `/${hashName}`);
                buffer = replace(buffer, relativePath, `/${hashName}`);
              }
            }
          }

          // Minify and upload sourcemaps for CSS resources.
          if (extname === '.css') {
            const bareRemoteName = path.format(remoteName);
            const res = await postcss([autoprefixer, cssnano]).process(buffer, {
              from: filePath,
              to: bareRemoteName,
              map: { inline: false },
            });
            const sourceMap = generateSourceMapFile(filePath, bareRemoteName, res.map.toString(), BUCKET);
            entries.push([sourceMap.filePath, sourceMap.buffer])
            await upload(sourceMap);
            buffer = Buffer.from(res.css);
          }

          // Minify and upload sourcemaps for JS resources.
          if (extname === '.js') {
            const bareRemoteName = path.format(remoteName);
            const res = Terser.minify(buffer.toString(), {
              toplevel: true,
              sourceMap: {
                filename: filePath,
                url: `/${bareRemoteName}.map`,
              }
            });
            const sourceMap = generateSourceMapFile(filePath, bareRemoteName, res.map, BUCKET);
            entries.push([sourceMap.filePath, sourceMap.buffer])
            await upload(sourceMap);
            buffer = Buffer.from(res.code);
          }

          // If is an image, minify it.
          // If not an image, we gzip it.
          let webp;
          switch (extname) {
            // Minify JPEGs and make progressive. Generate webp.
            case '.jpg':
            case '.jpeg':
              buffer = await imageminMozjpeg({ quality: 70 })(buffer);
              webp = await generateWebp(filePath, buffer, BUCKET);
              entries.push([webp.filePath, webp.buffer]);
              await upload(webp);
              break;

            // Minify PNGs. Generate webp.
            case '.png':
              buffer = await imageminPngquant({ quality: [.65, .80] })(buffer);
              webp = await generateWebp(filePath, buffer, BUCKET);
              entries.push([webp.filePath, webp.buffer]);
              await upload(webp);
              break;

            // Minify GIFs.
            case '.gif':
              buffer = await imageminGifsicle({ optimizationLevel: 3 })(buffer);
              break;

            // No-op for these image formats. We can't do any better than this.
            case '.ico':
            case '.bmp':
            case '.webp':
              break;

            // If not an image, gzip the world!
            default:
              buffer = await gzip(buffer, { level: 8 });
              contentEncoding = 'gzip';
              // TODO: When brotli support is high enough, or when Google automatically
              // deflates if not supported, switch to brotli.
              // buffer = await brotli.compress(buffer);
              // contentEncoding = 'br';
          }

          // We have successfully computed our remote name!
          remoteName = path.format(remoteName);
          remoteName = path.join(BUCKET, remoteName);
          await upload({
            filePath,
            remoteName,
            buffer,
            contentType,
            contentEncoding,
            cacheControl,
          });

        } catch(err) {
          console.log(err);
        }

        // If this is the last to process, resolve.
        if ((uploadCount + errorCount) === entries.length) { resolve(); }
      });
      iter++;
    }
  });

  let deletedCount = 0;
  for (let [_id, obj] of remoteObjects) {
    const hashedName = cacheHash(obj.name, obj.buffer);
    toDelete[hashedName] = toDelete[hashedName] || NOW;

    // If file has been marked for deletion over three days ago, remove it from the server.
    if (toDelete[hashedName] < (NOW - (1000 * 60 * 60 * 24 * 3))) {
      const object = await bucket.object(obj.name);
      await object.delete();
      deletedCount++;
      delete toDelete[hashedName];
    }
  }

  await upload({
    buffer: await gzip(Buffer.from(JSON.stringify([...fileCache], null, 2)), { level: 8 }),
    filePath: CACHE_FILENAME,
    remoteName: path.join(BUCKET, CACHE_FILENAME),
    contentType: 'application/json',
    contentEncoding: 'gzip',
    cacheControl: 'no-cache,no-store,max-age=0',
  });

  await upload({
    buffer: await gzip(Buffer.from(JSON.stringify(toDelete, null, 2)), { level: 8 }),
    filePath: DELETE_FILENAME,
    remoteName: path.join(BUCKET, DELETE_FILENAME),
    contentType: 'application/json',
    contentEncoding: 'gzip',
    cacheControl: 'no-cache,no-store,max-age=0',
  });

  progress.stop();
  console.log(`✅ ${uploadCount} items uploaded.`)
  console.log(`⌛ ${Object.keys(toDelete).length} items queued for deletion.`);
  console.log(`🚫 ${deletedCount} items deleted.`);
  console.log(`❗ ${errorCount} items failed.`);

  // Return the URL where we just uploaded everything to.
  return `https://${BUCKET}`;

}
