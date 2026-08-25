const http = require('http');
const fs = require('fs/promises');
const path = require('path');

const PORT = 8787;

const SONGS_DIR = path.join(
  __dirname,
  'songs'
);

function allowCors(req, res) {
  const origin = req.headers.origin;

  if (!origin) return;

  try {
    const url = new URL(origin);

    const isLocal =
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname.startsWith('192.168.') ||
      url.hostname.startsWith('10.');

    if (isLocal) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
  } catch {}
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';

    req.on('data', chunk => {
      data += chunk;

      if (data.length > 2_000_000) {
        reject(new Error('Bestand is te groot'));
        req.destroy();
      }
    });

    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function updateSongIndex(filename) {
  const indexPath = path.join(SONGS_DIR, 'index.json');

  let index = {
    files: []
  };

  try {
    index = JSON.parse(
      await fs.readFile(indexPath, 'utf8')
    );
  } catch {
    // Als index.json niet bestaat, maken we hem aan.
  }

  if (!Array.isArray(index.files)) {
    index.files = [];
  }

  if (!index.files.includes(filename)) {
    index.files.push(filename);

    await fs.writeFile(
      indexPath,
      JSON.stringify(index, null, 2) + '\n',
      'utf8'
    );
  }
}

const server = http.createServer(async (req, res) => {
  allowCors(req, res);

  if (req.method === 'OPTIONS') {
    res.setHeader(
      'Access-Control-Allow-Methods',
      'POST, OPTIONS'
    );

    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type'
    );

    res.writeHead(204);
    res.end();

    return;
  }

  if (
    req.method !== 'POST' ||
    req.url !== '/save-song'
  ) {
    res.writeHead(404, {
      'Content-Type': 'application/json'
    });

    res.end(
      JSON.stringify({
        error: 'Not found'
      })
    );

    return;
  }

  try {
    const body = JSON.parse(
      await readBody(req)
    );

    const filename = String(body.filename || '');
    const song = body.song;

    if (!song || typeof song !== 'object') {
      throw new Error('Song-data ontbreekt');
    }

    if (!song.id) {
      throw new Error('Song ID ontbreekt');
    }

    if (!filename.endsWith('.json')) {
      throw new Error('Bestandsnaam moet eindigen op .json');
    }

    /*
     * Voorkom dat BandSet buiten /songs kan schrijven.
     */
    if (path.basename(filename) !== filename) {
      throw new Error('Ongeldige bestandsnaam');
    }

    await fs.mkdir(
      SONGS_DIR,
      { recursive: true }
    );

    const targetPath = path.join(
      SONGS_DIR,
      filename
    );

    await fs.writeFile(
      targetPath,
      JSON.stringify(song, null, 2) + '\n',
      'utf8'
    );

    /*
     * Bij een nieuw nummer wordt het automatisch
     * aan songs/index.json toegevoegd.
     */
    await updateSongIndex(filename);

    console.log(
      `✓ ${filename} opgeslagen`
    );

    res.writeHead(200, {
      'Content-Type': 'application/json'
    });

    res.end(
      JSON.stringify({
        ok: true,
        filename,
        path: targetPath
      })
    );

  } catch (error) {
    console.error(error);

    res.writeHead(500, {
      'Content-Type': 'application/json'
    });

    res.end(
      JSON.stringify({
        error: error.message
      })
    );
  }
});

server.listen(
  PORT,
  '127.0.0.1',
  () => {
    console.log('');
    console.log('BandSet save-server draait.');
    console.log(`http://127.0.0.1:${PORT}`);
    console.log('');
    console.log(`Songs-map:`);
    console.log(SONGS_DIR);
    console.log('');
  }
);