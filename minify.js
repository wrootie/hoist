const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const glob = promisify(require('glob'));
const { minify, subscribe } = require('@icon-magic/imagemin-farm');
const progress = require('cli-progress');
const encodePNG = require('png-chunks-encode');
const extractPNG = require('png-chunks-extract');
const { encode: encodeText, decode: decodeText } = require('png-chunk-text');


function encode(buffer, key, value) {
  const chunks = extractPNG(buffer);
  chunks.splice(-1, 0, encodeText(key, value));
  return new Buffer(encodePNG(chunks));
}

function decode(buffer, key) {
  const chunks = extractPNG(buffer);
  const textChunks = chunks.filter(function (chunk) {
    return chunk.name === 'tEXt';
  }).map(function (chunk) {
    return decodeText(chunk.data);
  });
  for (let chunk of textChunks) {
    if (chunk.keyword === key) { return chunk.text; }
  }
  return undefined;
}

async function run(){
  const minificationProgress = new progress.Bar({}, progress.Presets.shades_classic);
  const minificationPromises = [];
  minificationProgress.start(1, 0);
  subscribe((stat) => minificationProgress.update(stat.progress));

  let files = await glob(path.join(__dirname, './static/**/*.png'));
  for (let file of files) {
    if (decode(fs.readFileSync(file), 'minified') === 'true') { continue; }
    minificationPromises.push(minify(file).then(() => {
      let buff = fs.readFileSync(file);
      buff = encode(buff, 'minified', 'true');
      fs.writeFileSync(file, buff);
    }));
  }
  await Promise.all(minificationPromises);
}

run();
