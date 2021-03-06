const fs = require('fs');
const path = require('path');
const findUp = require('find-up');
const { gzip } = require('node-gzip');
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

const initBucket = require('./initBucket');
const { cdnFileName, hoistCacheName } = require('./fileHash');

const HOIST_PRESERVE = '.hoist-preserve';
const DELETE_FILENAME = '.hoist-delete';
const CACHE_FILENAME = '.hoist-cache';
const CONFIG_FILENAME = 'gcloud.json';
const SYSTEM_FILES = new Set([DELETE_FILENAME, CACHE_FILENAME, CONFIG_FILENAME, HOIST_PRESERVE]);

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
  '.well-known': true,
}

const progress = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
let preserve = {};

async function generateWebp(file, input, BUCKET, root) {
  let remoteName = path.posix.parse(path.posix.join(BUCKET, file));
  const shouldRewrite = shouldRewriteUrl(root, path.posix.parse(file));
  remoteName.extname = '.webp';
  const filePath = path.posix.format(remoteName)
  const buffer = await imageminWebp({ quality: 75 })(input);
  if (shouldRewrite) {
    remoteName.base = cdnFileName(buffer);
    delete remoteName.extname;
  }
  remoteName = path.posix.format(remoteName);
  return {
    filePath,
    remoteName,
    buffer,
    contentType: 'image/webp',
    contentEncoding: undefined,
    cacheControl: 'public,max-age=31536000,immutable',
    contentSize: Buffer.byteLength(buffer),
  };
}

function generateSourceMapFile(filePath, remoteName, content, BUCKET) {
  remoteName = path.posix.join(BUCKET, remoteName) + '.map';
  const buffer = Buffer.from(content);
  return {
    filePath,
    remoteName,
    buffer,
    contentType: 'application/json',
    contentEncoding: undefined,
    cacheControl: 'public,max-age=31536000,immutable',
    contentSize: Buffer.byteLength(buffer),
  };
}

function shouldRewriteUrl(root, remoteName) {
  const filePath = path.posix.join(root, path.posix.format(remoteName));
  return !WELL_KNOWN[remoteName.base] && !preserve[filePath] && filePath.indexOf('.well-known') !== 0 && remoteName.ext !== '.json';
}

module.exports = async function deploy(root, directory='', userBucket=null, logger=false, autoDelete = false) {
  const NOW = Date.now();
  const jsonKeyFile = await findUp(CONFIG_FILENAME, { cwd: root });
  const preserveFile = await findUp(HOIST_PRESERVE, { cwd: root });
  const config = JSON.parse(fs.readFileSync(jsonKeyFile));
  const BUCKET = (userBucket || config.bucket).toLowerCase();
  const log = typeof logger !== 'boolean' ? logger : console;
  const isCli = logger === true;
  const [storage, bucket] = await initBucket(config, BUCKET)

  let toDelete = {};
  let fileCache = new Set();
  try {
    toDelete = await storage.get(path.posix.join(BUCKET, DELETE_FILENAME));
    fileCache = new Set(await storage.get(path.posix.join(BUCKET, CACHE_FILENAME)));
  } catch(_err) {}
  toDelete = toDelete || {};
  fileCache = fileCache && fileCache.size ? fileCache : new Set();

  const remoteObjects = new Map();
  for (let obj of await storage.list(BUCKET, { timeout: 520000 }) || []) {
    if (SYSTEM_FILES.has(obj.name)) { continue; }

    const remoteName = path.posix.join(BUCKET, obj.name);

    // Skip tracking remote files that aren't in our target upload directory.
    if (remoteName.indexOf(path.posix.join(BUCKET, directory)) !== 0) { continue; }

    const cacheName = hoistCacheName(remoteName, obj.md5Hash);

    toDelete[cacheName] = toDelete[cacheName] || NOW;

    remoteObjects.set(remoteName, {
      name: obj.name,
      remoteName,
      contentType: obj.contentType,
      cacheHash: cacheName,
    });
  }

  let iter = 0;
  const THREAD_COUNT = 12;
  const threads = [];
  for (let i=0;i<THREAD_COUNT;i++) { threads.push(Promise.resolve()); }

  const hashes = {};
  const buffers = {};
  try {
    let globs = [];
    try { globs = fs.readFileSync(preserveFile, 'utf8').split('\n') } catch(_) {};
    for (let globPath of globs) {
      for (let filePath of await glob(path.join(preserveFile, '..', globPath))) {
        if (fs.statSync(filePath).isDirectory()) { continue; }
        preserve[filePath] = true;
      }
    }
  } catch(_err) {
    log.error(_err)
    preserve = {};
  }

  // Fetch all our file buffers and content hashes, excluding Hoist system files.
  // Use platform specific separator for filesystem access.
  // We normalize this to posix paths for web below.
  for (let filePath of await glob(path.join(root, directory, '**', '*'))) {
    if (fs.statSync(filePath).isDirectory()) { continue; }
    if (SYSTEM_FILES.has(path.basename(filePath))) { continue; }
    // Normalize the path on windows for web use.
    const posixPath = path.posix.join(...filePath.split(path.sep));
    const posixRoot = path.posix.join(...root.split(path.sep));
    let file = path.posix.relative(posixRoot, posixPath);
    buffers[file] = fs.readFileSync(filePath);
    hashes[file] = cdnFileName(buffers[file]);
  }

  let noopCount = 0;
  let uploadCount = 0;
  let errorCount = 0;
  async function upload({ remoteName, buffer, contentType, contentEncoding, cacheControl, contentSize }) {
    const headers = {
      'Content-Type': contentType,
      'Content-Encoding': contentEncoding,
      'Cache-Control': cacheControl,
      'x-content-size': contentSize || 0,
    };

    if (!headers['Content-Type']) { delete headers['Content-Type']; }
    if (!headers['Content-Encoding']) { delete headers['Content-Encoding']; }
    if (!headers['Cache-Control']) { delete headers['Cache-Control']; }

    let opts = {
      timeout: 520000,
      headers,
    };

    const hash = hoistCacheName(remoteName, buffer);

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
      log.error(err.message);
      errorCount++;
    });

  }

  const entries = Object.entries(buffers);
  await new Promise((resolve) => {
    const oldNames = Object.keys(hashes).sort((a, b) => a.length > b.length ? -1 : 1);
    isCli && progress.start(entries.length, uploadCount + errorCount);

    for (let [filePath, buffer] of entries) {
      const hash = hashes[filePath];
      const extname = path.posix.extname(filePath);
      const contentType = CONTENT_TYPE[extname] || 'application/json'
      let contentEncoding = undefined;
      let cacheControl = 'public,max-age=31536000,immutable';

      threads[iter % THREAD_COUNT] = threads[iter % THREAD_COUNT].then(async () => {
        try {
          let remoteName = path.posix.parse(filePath);

          if (remoteName.ext === '.html') {
            // Never cache HTML files.
            cacheControl = 'public,max-age=0';

            // If an HTML file, but not the index.html, remove the `.html` for a bare URLs look in the browser.
            if (shouldRewriteUrl(root, remoteName)) {
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
          else if (shouldRewriteUrl(root, remoteName)) {
            remoteName.base = hash;
            delete remoteName.extname;
          }

          // If we're not rewriting this URL to a hash, we need the cache to revalidate every time.
          else {
            cacheControl = 'public,max-age=0';
          }

          // Replace all Hash names in CSS and HTML files.
          if (extname === '.css' || extname === '.html') {
            for (let oldName of oldNames ) {
              const hash = hashes[oldName];
              let hashName = path.posix.parse(oldName);
              hashName.base = hash;
              delete hashName.extname;
              hashName = path.posix.format(hashName);
              buffer = replace(buffer, `/${oldName}`, `/${hashName}`);
              const relativePath = path.posix.relative(path.posix.dirname(filePath), oldName);
              if (relativePath) {
                buffer = replace(buffer, `./${relativePath}`, `/${hashName}`);
                buffer = replace(buffer, relativePath, `/${hashName}`);
              }
            }
          }

          // Minify and upload sourcemaps for CSS resources.
          if (extname === '.css') {
            const bareRemoteName = path.posix.format(remoteName);
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
            const bareRemoteName = path.posix.format(remoteName);
            const res = await Terser.minify(buffer.toString(), {
              toplevel: true,
              ecma: '2017',
              sourceMap: {
                filename: filePath,
                url: `/${bareRemoteName}.map`,
              }
            });

            // TODO: Don't upload if a minification fails!
            if (res.error) {
              throw new Error(res.error);
            }

            const sourceMap = generateSourceMapFile(filePath, bareRemoteName, res.map, BUCKET);
            entries.push([sourceMap.filePath, sourceMap.buffer])
            await upload(sourceMap);
            buffer = Buffer.from(res.code);
          }

          // If is an image, minify it.
          // If not an image, we gzip it.
          let webp;
          let contentSize = 0;
          switch (extname) {
            // Minify JPEGs and make progressive. Generate webp.
            case '.jpg':
            case '.jpeg':
              buffer = await imageminMozjpeg({ quality: 70 })(buffer);
              contentSize = Buffer.byteLength(buffer);
              webp = await generateWebp(filePath, buffer, BUCKET, root);
              entries.push([webp.filePath, webp.buffer]);
              await upload(webp);
              break;

            // Minify PNGs. Generate webp.
            case '.png':
              buffer = await imageminPngquant({ quality: [.65, .80] })(buffer);
              contentSize = Buffer.byteLength(buffer);
              webp = await generateWebp(filePath, buffer, BUCKET, root);
              entries.push([webp.filePath, webp.buffer]);
              await upload(webp);
              break;

            // Minify GIFs.
            case '.gif':
              buffer = await imageminGifsicle({ optimizationLevel: 3 })(buffer);
              contentSize = Buffer.byteLength(buffer);
              break;

            // No-op for these image formats. We can't do any better than this.
            case '.ico':
            case '.bmp':
            case '.webp':
              contentSize = Buffer.byteLength(buffer);
              break;

            // If not an image, gzip the world!
            // TODO: When brotli support is high enough, or when Google automatically
            // deflates if not supported, switch to brotli.
            default:
              contentSize = Buffer.byteLength(buffer);
              buffer = await gzip(buffer, { level: 8 });
              contentEncoding = 'gzip';
              // buffer = await brotli.compress(buffer);
              // contentEncoding = 'br';
          }

          // We have successfully computed our remote name!
          remoteName = path.posix.format(remoteName);
          remoteName = path.posix.join(BUCKET, remoteName);
          await upload({
            filePath,
            remoteName,
            buffer,
            contentType,
            contentEncoding,
            cacheControl,
            contentSize,
          });

        } catch(err) {
          log.error(err);
        }

        // If this is the last to process, resolve.
        if ((uploadCount + errorCount + noopCount) === entries.length) { resolve(); }
      });
      iter++;
    }
  });

  // If file has been marked for deletion over three days ago, remove it from the server.
  let deletedCount = 0;
  if (autoDelete) {
    for (let [, obj] of remoteObjects) {
      const hashedName = obj.cacheHash;
      if (toDelete[hashedName] && toDelete[hashedName] < (NOW - (1000 * 60 * 60 * 24 * 3))) {
        const object = await bucket.object(obj.name);
        await object.delete();
        delete toDelete[hashedName];
        deletedCount++;
      }
    }
  }

  isCli && progress.stop();
  log.log(`✅ ${uploadCount} items uploaded.`);
  log.log(`⏺  ${noopCount} items already present.`);
  log.log(`⌛ ${Object.keys(toDelete).length} items queued for deletion.`);
  log.log(`🚫 ${deletedCount} items deleted.`);
  log.log(`❗ ${errorCount} items failed.`);

  const fileCacheBuffer = Buffer.from(JSON.stringify([...fileCache], null, 2));
  await upload({
    buffer: await gzip(fileCacheBuffer, { level: 8 }),
    filePath: CACHE_FILENAME,
    remoteName: path.posix.join(BUCKET, CACHE_FILENAME),
    contentType: 'application/json',
    contentEncoding: 'gzip',
    cacheControl: 'no-cache,no-store,max-age=0',
    contentSize: Buffer.byteLength(fileCacheBuffer),
  });

  const toDeleteBuffer = Buffer.from(JSON.stringify(toDelete, null, 2));
  await upload({
    buffer: await gzip(toDeleteBuffer, { level: 8 }),
    filePath: DELETE_FILENAME,
    remoteName: path.posix.join(BUCKET, DELETE_FILENAME),
    contentType: 'application/json',
    contentEncoding: 'gzip',
    cacheControl: 'no-cache,no-store,max-age=0',
    contentSize: Buffer.byteLength(toDeleteBuffer),
  });

  // Return the URL where we just uploaded everything to.
  return `https://${BUCKET}`;

}
