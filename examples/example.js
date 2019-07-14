'use strict';

process.env.NODE_ENV = 'development';

process.on('uncaughtException', (data) => {
  console.log('uncaughtException', data);
});

const FR = require('..');

const Mp4Frag = require('mp4frag');

const Pipe2Pam = require('pipe2pam');

const PamDiff = require('pam-diff');

const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

const pipe2pam = new Pipe2Pam();

let count = 0;

const { PassThrough } = require('stream');

const stderrLogs = new PassThrough({
  //objectMode: false,
  //writableObjectMode: true,
  transform(chunk, encoding, callback) {
    console.log('stderr: ', chunk.toString());
    if (this._readableState.pipesCount > 0) {
      this.push(chunk);
    }
    callback();
  }
});

pipe2pam.on('pam', (data) => {
  console.log('pam', data.width, data.height, data.depth, data.maxval, data.tupltype);
  //console.log(++count);
});

const region1 = {
  name: 'region1',
  difference: 6,
  percent: 1,
  polygon: [{ x: 0, y: 0 }, { x: 0, y: 273 }, { x: 100, y: 273 }, { x: 100, y: 0 }]
};

const region2 = {
  name: 'region2',
  difference: 6,
  percent: 1,
  polygon: [{ x: 100, y: 0 }, { x: 100, y: 273 }, { x: 200, y: 273 }, { x: 200, y: 0 }]
};

const region3 = {
  name: 'region3',
  difference: 6,
  percent: 1,
  polygon: [{ x: 200, y: 0 }, { x: 200, y: 273 }, { x: 300, y: 273 }, { x: 300, y: 0 }]
};

const region4 = {
  name: 'region4',
  difference: 6,
  percent: 1,
  polygon: [{ x: 300, y: 0 }, { x: 300, y: 273 }, { x: 400, y: 273 }, { x: 400, y: 0 }]
};

const regions = [region1, region2, region3, region4];

//const pamDiff = new PamDiff({grayscale: 'luminosity', regions : regions});

const pamDiff = new PamDiff({ difference: 6, percent: 1, regions: regions, mask: true });

pamDiff.on('diff', (data) => {
  console.log('diff', data.trigger[0].name, data.trigger[0].percent);
  //console.log(data);
});

pipe2pam.pipe(
  pamDiff,
  { end: false }
);

const mp4frag = new Mp4Frag();

mp4frag.on('initialized', (data) => {
  console.log('initialized', data);
});

mp4frag.on('segment', (segment) => {
  console.log('segment1', segment.length);
});

mp4frag.on('error', (error) => {
  console.log('error ', error);
});

const fr = new FR({
  debug: true,
  //path to ffmpeg, only needed if not in PATH
  path: ffmpegPath,
  //set loglevel, this value will get passed to ffmpeg -loglevel
  logLevel: 'panic',
  //pass writable pipe or callback function to receive ffmpeg logging as buffer
  stderrLogs: stderrLogs,
  //detecting no activity for n amount of seconds will cause ffmpeg to be killed
  killAfterStall: 10,
  //ffmpeg will automatically be re-spawned if exiting, delayed by n amount of seconds
  reSpawnDelay: 5,
  //number of time to re-spawn after exiting with no progress
  reSpawnLimit: Number.POSITIVE_INFINITY,
  //parameters that will be pass to spawned ffmpeg process
  params: [
    //input from rtsp cam
    '-rtsp_transport',
    'tcp',
    '-i',
    'rtsp://192.168.1.4:554/user=admin_password=pass_channel=1_stream=1.sdp',
    //output fragmented mp4 to pipe
    '-f',
    'mp4',
    '-an',
    '-c:v',
    'copy',
    '-movflags',
    '+frag_keyframe+empty_moov+default_base_moof+omit_tfhd_offset',
    'pipe:3',
    //output pam image to pipe
    '-f',
    'image2pipe',
    '-an',
    '-c:v',
    'pam',
    '-pix_fmt',
    'rgb24',
    '-vf',
    'fps=2,scale=640:-1',
    'pipe:4',
    //'-f', 'image2pipe', '-an', '-c:v', 'pam', '-pix_fmt', 'rgb24', '-vf', 'fps=2,scale=640:-1', 'pipe:5'
    '-f',
    'image2pipe',
    '-an',
    '-c:v',
    'mjpeg',
    '-huffman',
    'optimal',
    '-q:v',
    '7',
    '-vf',
    'fps=1,scale=320:-1',
    'pipe:5'
  ],
  //pipes should match the pipes used in params, can be a writable stream or callback function
  //todo allow array of stackable pipes to be passed
  pipes: [
    { stdioIndex: 3, destination: mp4frag },
    { stdioIndex: 4, destination: pipe2pam },
    {
      //use callback, but could have been a writable pipe
      stdioIndex: 5,
      destination: function(data) {
        console.log('callback with jpeg data', data.length);
      }
    }
  ],
  //function that is called when internal ffmpeg process exits, may be used for resetting some options, etc.
  exitCallback: (code, signal) => {
    console.log(`exitCallback code:${code} signal:${signal}`);
    mp4frag.resetCache();
    pipe2pam.resetCache();
    pamDiff.resetCache();
  }
})
  .on('fail', (data) => {
    console.log('fail', data);
  })
  .start();

//will not be called because exitCallback is being used
fr.on('exit', (code, signal) => {
  console.log('exit event', code, signal);
  mp4frag.resetCache();
  pipe2pam.resetCache();
  pamDiff.resetCache();
});

setTimeout(() => {
  console.log('time out triggering .stop()');
  fr.stop();
  //pamDiff.setDifference(2);
  //pamDiff.setPercent(3);
  //pamDiff.setRegions(regions);
  //pamDiff.resetCache();
}, 15000);

setTimeout(() => {
  console.log('time out triggering .start()');
  fr.start();
  //pamDiff.setDifference(2);
  //pamDiff.setPercent(3);
  //pamDiff.setRegions(regions);
  //pamDiff.resetCache();
}, 25000);
