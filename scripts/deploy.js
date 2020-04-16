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
const cliProgress = require('cli-progress');

const progress = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);

const DELETE_FILENAME = '.hoist-delete';
const CACHE_FILENAME = '.hoist-cache';
const CONFIG_FILENAME = 'gcloud.json';
const SYSTEM_FILES = new Set([DELETE_FILENAME, CACHE_FILENAME, CONFIG_FILENAME]);

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

// https://tools.ietf.org/html/rfc4648#section-5
function md5toMd5url(hash) {
  return hash.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// Compute the original file's base64url encoded hash based on file contents.
function fileHash(buffer) {
  let hash = crypto.createHash('md5');
  hash.update(buffer);
  hash = hash.digest('base64');
  return md5toMd5url(hash);
}

// Compute the original file's base64url encoded hash, with the file name included.
function cacheHash(fileName, buffer) {
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

module.exports = async function deploy(root, directory='', userBucket=null, isCli=false) {

  const jsonKeyFile = await findUp(CONFIG_FILENAME, { cwd: root });
  const config = JSON.parse(fs.readFileSync(jsonKeyFile));
  const storage = client.new({ jsonKeyFile });

  const BUCKET = userBucket || config.bucket;
  const NOW = Date.now();

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

  await bucket.website.setup({
    mainPageSuffix: 'index.html',
    notFoundPage: '404.html',
  });

  let toDelete = {};
  let fileCache = new Set();
  try {
    toDelete = await storage.get(path.join(BUCKET, DELETE_FILENAME));
    fileCache = new Set(await storage.get(path.join(BUCKET, CACHE_FILENAME)));
  } catch(_err) {}
  toDelete = toDelete || {};
  fileCache = fileCache && fileCache.size ? fileCache : new Set();

  const remoteObjects = new Map();
  for (let obj of await storage.list(BUCKET, { timeout: 520000 }) || []) {

    if (SYSTEM_FILES.has(obj.name)) { continue; }

    const remoteName = path.join(BUCKET, obj.name);

    // Skip tracking remote files that aren't in our target upload directory.
    if (remoteName.indexOf(path.join(BUCKET, directory)) !== 0) { continue; }

    const cacheName = cacheHash(remoteName, obj.md5Hash);

    toDelete[cacheName] = toDelete[cacheName] || NOW;

    remoteObjects.set(remoteName, {
      name: obj.name,
      remoteName,
      contentType: obj.contentType,
      fileHash: md5toMd5url(obj.md5Hash),
      cacheHash: cacheName,
    });
  }

  const files = await glob(path.join(root, directory, '**', '*'));
  let iter = 0;
  const THREAD_COUNT = 12;
  const threads = [];
  for (let i=0;i<THREAD_COUNT;i++) { threads.push(Promise.resolve()); }

  const hashes = {};
  const buffers = {};

  // Fetch all our file buffers and content hashes, excluding Hoist system files.
  for (let filePath of files) {
    if (fs.statSync(filePath).isDirectory()) { continue; }
    if (SYSTEM_FILES.has(path.basename(filePath))) { continue; }
    let file = path.relative(root, filePath);
    buffers[file] = fs.readFileSync(filePath);
    hashes[file] = fileHash(buffers[file]);
  }

  let noopCount = 0;
  let uploadCount = 0;
  let errorCount = 0;
  async function upload({ remoteName, buffer, contentType, contentEncoding, cacheControl }) {
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

    // Remove this item from our remote objects map so we don't delete if we cleanup.
    delete toDelete[hash];

    // Do nothing if the file is already on the server, in the correct location, and unchanged.
    if (fileCache.has(hash)) {
      noopCount++;
      isCli && progress.update(uploadCount + errorCount + noopCount);
      return;
    }
    fileCache.add(hash);

    // Upload it!
    await storage.insert(buffer, remoteName, opts).then(() => {
      uploadCount++;
      isCli && progress.update(uploadCount + errorCount + noopCount);
    }, (err) => {
      console.error(err.message);
      errorCount++;
    });

  }

  const entries = Object.entries(buffers);
  await new Promise((resolve) => {
    const oldNames = Object.keys(hashes).sort((a, b) => a.length > b.length ? -1 : 1);
    isCli && progress.start(entries.length, uploadCount + errorCount);

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
            // TODO: When brotli support is high enough, or when Google automatically
            // deflates if not supported, switch to brotli.
            default:
              buffer = await gzip(buffer, { level: 8 });
              contentEncoding = 'gzip';
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
        if ((uploadCount + errorCount + noopCount) === entries.length) { resolve(); }
      });
      iter++;
    }
  });

  // If file has been marked for deletion over three days ago, remove it from the server.
  let deletedCount = 0;
  for (let [, obj] of remoteObjects) {
    const hashedName = obj.cacheHash;
    if (toDelete[hashedName] && toDelete[hashedName] < (NOW - (1000 * 60 * 60 * 24 * 3))) {
      const object = await bucket.object(obj.name);
      await object.delete();
      delete toDelete[hashedName];
      deletedCount++;
    }
  }

  isCli && progress.stop();
  console.log(`✅ ${uploadCount} items uploaded.`);
  console.log(`⏺  ${noopCount} items already present.`);
  console.log(`⌛ ${Object.keys(toDelete).length} items queued for deletion.`);
  console.log(`🚫 ${deletedCount} items deleted.`);
  console.log(`❗ ${errorCount} items failed.`);

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

  // Return the URL where we just uploaded everything to.
  return `https://${BUCKET}`;

}
