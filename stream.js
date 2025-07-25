const express = require('express');
const { spawn } = require('child_process');
const { PassThrough } = require('stream');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 8085;

const bodyParser = require('body-parser');
app.use(bodyParser.json());

let gphotoProc = null;
let ffmpegPreview = null;
let streamBuffer = new PassThrough(); // untuk preview
let recordingBuffer = new PassThrough(); // untuk rekaman

app.get('/stream', (req, res) => {
  if (gphotoProc || ffmpegPreview) {
    res.status(409).send('Stream already running');
    return;
  }

  // Start gphoto2 (sekali saja)
  gphotoProc = spawn('gphoto2', ['--stdout', '--capture-movie']);

  // Salurkan output gphoto2 ke 2 buffer stream
  gphotoProc.stdout.on('data', (chunk) => {
    streamBuffer.write(chunk);
    recordingBuffer.write(chunk);
  });

  // Setup MJPEG live preview
  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Pragma': 'no-cache',
          'Access-Control-Allow-Origin': '*'
  });
        //res.set('Access-Control-Allow-Origin', '*');

  ffmpegPreview = spawn('ffmpeg', [
    '-f', 'mjpeg',
    '-i', 'pipe:0',
    '-vf', 'scale=640:480',
    '-r', '30',
    '-probesize', '32',
    '-analyzeduration', '0',
    '-q:v', '5',
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg',
    'pipe:1',
  ]);

  streamBuffer.pipe(ffmpegPreview.stdin);

  ffmpegPreview.stdout.on('data', (chunk) => {
    res.write('--frame\r\n');
    res.write('Content-Type: image/jpeg\r\n');
    res.write(`Content-Length: ${chunk.length}\r\n\r\n`);
    res.write(chunk);
    res.write('\r\n');
  });

  req.on('close', () => {
    stopProcesses();
  });
});

app.get('/record', (req, res) => {
  if (!gphotoProc) {
    return res.status(400).send('Stream not running');
  }

  const outputDir = req.query?.dir || '.';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = req.query?.filename || `clip_${timestamp}.mp4`;
  const fullPath = `${outputDir}/${filename}`;

  // Gunakan buffer kedua untuk rekam
  const ffmpegRecord = spawn('ffmpeg', [
    '-f', 'mjpeg',
    '-i', 'pipe:0',
    '-t', '5',
    '-c:v', 'libx264',
    '-preset', 'veryslow',
    '-crf', '10',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-y',
    fullPath
  ]);

  recordingBuffer.pipe(ffmpegRecord.stdin, { end: false });
  ffmpegRecord.stdin.on('error', (err) => {
    console.error('🛑 Error on record stdin:', err.message);
  });
  ffmpegRecord.on('close', () => {
    res.send('🎥 Rekaman 5 detik disimpan ke recorded_clip.mp4');
  });
});

app.post('/snapshot', async(req, res) => {
  if (gphotoProc) {
    return res.status(409).json({
      status: 'error',
      message: 'Tidak bisa ambil foto saat streaming aktif.'
    });
  }

  const outputDir = req.body?.dir || '.';
  const config = req.body?.config || {};

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = req.body?.filename || `snapshot-${timestamp}.jpg`;
  const fullPath = `${outputDir}/${filename}`;

  const allowedConfigs = ['iso', 'shutterspeed', 'aperture', 'viewfinder', 'whitebalance', 'imageformat'];
  const appliedConfigs = {};

  // Set all valid camera settings
  for (const key of allowedConfigs) {
    if (config[key]) {
      await new Promise((resolve) => {
        const setProc = spawn('gphoto2', ['--set-config', `${key}=${config[key]}`]);

        setProc.stderr.on('data', (data) => {
          console.warn(`[WARN] Setting ${key} failed: ${data.toString()}`);
        });

        setProc.on('close', () => resolve());
      });
      appliedConfigs[key] = config[key];
    }
  }

  const gphotoSnap = spawn('gphoto2', [
    '--capture-image-and-download',
    '--filename', fullPath,
    '--force-overwrite'
  ]);

  let errLog = '';
  gphotoSnap.stderr.on('data', data => {
    errLog += data.toString();
  });

  gphotoSnap.on('close', code => {
    if (code === 0) {
      res.json({
        status: 'ok',
        saved_to: fullPath
      });
    } else {
      res.status(500).json({
        status: 'error',
        message: errLog || 'Unknown error taking snapshot'
      });
    }
  });
});

app.post('/gif', (req, res) => {
  const { dir, pattern } = req.body;

  if (!dir || !pattern) {
    return res.status(400).json({ status: 'error', message: 'Parameter "dir" and "pattern" required .' });
  }

  if (!fs.existsSync(dir)) {
    return res.status(404).json({ status: 'error', message: 'Folder tidak ditemukan.' });
  }

  const outputFile = path.join(dir, `gif.mp4`);

  const ffmpegArgs = [
    '-framerate', '1',
    '-pattern_type', 'glob',
    '-i', pattern,
    // '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    outputFile
  ];

  const ffmpeg = spawn('ffmpeg', ffmpegArgs, { cwd: dir });

  let stderr = '';
  ffmpeg.stderr.on('data', data => {
    stderr += data.toString();
  });

  ffmpeg.on('close', code => {
    if (code === 0) {
      res.json({
        status: 'ok',
        output: outputFile
      });
    } else {
      res.status(500).json({
        status: 'error',
        message: stderr || 'Gagal membuat video.'
      });
    }
  });
});

app.get('/stop', (req, res) => {
  stopProcesses();
  res.send('🛑 Stream dan proses dihentikan.');
});

app.post('/build-video', async (req, res) => {
  const { dir, pattern, duration, output, overlay, coords } = req.body;

  if (!dir || !pattern || !duration || !output) {
    return res.status(400).json({ status: 'error', message: 'Param dir, pattern, duration, output wajib diisi' });
  }

  if (!fs.existsSync(dir)) return res.status(404).json({ status: 'error', message: `Folder tidak ditemukan: ${dir}` });

  const files = fs.readdirSync(dir).filter(file => file.match(new RegExp(pattern.replace('*', '.*'))));
  files.sort(); // urutkan alfanumerik

  if (coords && coords.length !== files.length) {
    return res.status(400).json({ status: 'error', message: 'Jumlah coords tidak sama dengan jumlah file gambar' });
  }

  const framerate = (1 / parseFloat(duration)).toFixed(4);
  const filterInputs = files.map((_, i) => `-loop 1 -t ${duration} -i ${files[i]}`).join(' ');
  const inputArgs = files.flatMap(filename => ['-loop', '1', '-t', duration.toString(), '-i', filename]);

  const inputOverlay = overlay ? ['-i', overlay] : [];
  const totalInputs = files.length + (overlay ? 1 : 0);

  const filterSteps = [];
  const overlaySteps = [];

  files.forEach((_, i) => {
    const { width, height } = coords?.[i] || { width: 256, height: 256 };
    filterSteps.push(`[${i}:v] scale=${width}:${height} [v${i}]`);
  });

  filterSteps.push(`nullsrc=size=1144x1712 [base]`);
  overlaySteps.push(`[base][v0] overlay=${coords[0].x}:${coords[0].y} [tmp1]`);

  for (let i = 1; i < files.length; i++) {
    const prev = i === 1 ? 'tmp1' : `tmp${i}`;
    overlaySteps.push(`[${prev}][v${i}] overlay=${coords[i].x}:${coords[i].y} [tmp${i + 1}]`);
  }

  const lastStep = `tmp${files.length}`;
  const finalOverlay = overlay ? `[${lastStep}][${files.length}:v] overlay=0:0` : `${lastStep}`;

  const filterComplex = [...filterSteps, ...overlaySteps, finalOverlay].join('; ');

  const ffmpegArgs = [
    ...inputArgs,
    ...inputOverlay,
    '-filter_complex', filterComplex,
    '-frames:v', '1', // gambar diam, tapi bisa diganti -shortest untuk video durasi `duration`
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    output
  ];

  const ffmpeg = spawn('ffmpeg', ffmpegArgs, { cwd: dir });

  let stderr = '';
  ffmpeg.stderr.on('data', data => stderr += data.toString());

  ffmpeg.on('close', code => {
    if (code === 0) {
      res.json({ status: 'ok', output });
    } else {
      res.status(500).json({ status: 'error', message: 'FFmpeg error', detail: stderr });
    }
  });
});

app.post('/merge-videos', (req, res) => {
  const { videos, overlay, canvasWidth, canvasHeight, output } = req.body;

  if (!videos || !Array.isArray(videos) || videos.length === 0 || !canvasWidth || !canvasHeight || !output) {
    return res.status(400).json({ status: 'error', message: 'Parameter tidak lengkap' });
  }

  const inputArgs = videos.map(v => ['-i', v.path]).flat();
  if (overlay) inputArgs.push('-i', overlay);

  const filterInputs = videos.map((v, i) => `[${i}:v] scale=${v.width}:${v.height} [v${i}]`);
  const canvasInit = `nullsrc=size=${canvasWidth}x${canvasHeight} [base]`;

  const overlays = [`[base][v0] overlay=${videos[0].x}:${videos[0].y} [tmp1]`];

  for (let i = 1; i < videos.length; i++) {
    const prev = i === 1 ? 'tmp1' : `tmp${i}`;
    overlays.push(`[${prev}][v${i}] overlay=${videos[i].x}:${videos[i].y} [tmp${i + 1}]`);
  }

  const last = `tmp${videos.length}`;
  const final = overlay
    ? `[${last}][${videos.length}:v] overlay=0:0`
    : last;

  const filterComplex = [...filterInputs, canvasInit, ...overlays, final].join('; ');

  const ffmpegArgs = [
    ...inputArgs,
    '-filter_complex', filterComplex,
    //'-shortest',
          '-t', '5',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    output
  ];

  const ffmpeg = spawn('ffmpeg', ffmpegArgs);

  let stderr = '';
  ffmpeg.stderr.on('data', data => stderr += data.toString());

  ffmpeg.on('close', code => {
    if (code === 0) {
      res.json({ status: 'ok', output });
    } else {
      res.status(500).json({ status: 'error', message: 'FFmpeg error', detail: stderr });
    }
  });
});

app.get('/media', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) {
    return res.status(400).send('Missing "path" query parameter');
  }

  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    return res.status(404).send('Video file not found');
  }

  const stat = fs.statSync(resolvedPath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;
    const file = fs.createReadStream(resolvedPath, { start, end });

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'video/mp4',
    });

    file.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4',
    });

    fs.createReadStream(resolvedPath).pipe(res);
  }
});

function stopProcesses() {
  if (gphotoProc) {
    gphotoProc.kill('SIGINT');
    gphotoProc = null;
  }
  if (ffmpegPreview) {
    ffmpegPreview.kill('SIGINT');
    ffmpegPreview = null;
  }

  // Reset buffer (flush)
  streamBuffer = new PassThrough();
  recordingBuffer = new PassThrough();
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎥 Live Preview: http://localhost:${PORT}/stream`);
  console.log(`🎬 Rekam 5s:     http://localhost:${PORT}/record`);
  console.log(`🛑 Stop:         http://localhost:${PORT}/stop`);
});
