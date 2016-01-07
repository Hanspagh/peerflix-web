#!/usr/bin/env node

var Hapi = require('hapi');
var Boom = require('boom');
var Good = require('good');
var opensubtitles = require("subtitler");
var GoodFile = require('good-file');
var GoodConsole = require('good-console');
var ip = require('ip');
var rimraf = require('rimraf');
var mkdirp = require('mkdirp');
var path = require('path');
var tempDir = require('os').tmpdir();
var readTorrent = require('read-torrent');
var uuid = require('node-uuid');
var fs = require('fs');
var kickass = require('kickass-torrent');
var peerflix = require('peerflix');
var omx = require('omxctrl');
var proc = require('child_process')
var Download = require('download');
 var AdmZip = require('adm-zip');
var path = require("path");
var VLC_ARGS = '-q --video-on-top --play-and-exit'
var OMX_EXEC = 'omxplayer -r -o hdmi'

// Configs
var PORT = process.env.PORT || process.argv[2] || 8080;
var LOG_ENABLED = true;

// Params
var connection;
var states = ['PLAYING', 'PAUSED', 'IDLE'];
var omxCtrlMap = {
  'pause': 'pause',
  'speedup': 'increaseSpeed',
  'speeddown': 'decreaseSpeed',
  'nextaudio': 'nextAudioStream',
  'prevaudio': 'previousAudioStream',
  'nextsubtitle': 'nextSubtitleStream',
  'prevsubtitle': 'previousSubtitleStream',
  'togglesubtitle': 'toggleSubtitles',
  'volumeup': 'increaseVolume',
  'volumedown': 'decreaseVolume',
  'forward': 'seekForward',
  'backward': 'seekBackward',
  'fastforward': 'seekFastForward',
  'fastbackward': 'seekFastBackward'
};

// Helper Methods
var clearTorrentCache = function() {
  fs.readdir(tempDir, function(err, files) {
    if (err) {
      console.log(err);
      return;
    }
    files.forEach(function(file) {
      if (file.substr(0, 9) === 'peerflix-') {
        console.log(path.join(tempDir, file));
        rimraf(path.join(tempDir, file), function(error) {
          console.log('Cache cleared' + error);
        });
      }
    });
  });
};

var stop = function() {
  if (!connection) { return; }
  connection.destroy();
  connection = null;
  omx.stop();
  clearTorrentCache();
};

function downloadSubs(movieName, callback) {
  opensubtitles.api.login()
  .done(function(token){
    console.log(token);
      opensubtitles.api.searchForTitle(token, "eng", movieName)
      .done(function(results){
        console.log(path.join(tempDir, 'peerflix-sub') + path.sep + results[0].SubFileName + '.zip');
        new Download()
        .get(results[0].ZipDownloadLink)
        .dest(path.join(tempDir, 'peerflix-sub'))
        .rename(results[0].SubFileName + '.zip')
        .run(function(err, files) {
          var zip = new AdmZip(path.join(tempDir, 'peerflix-sub') + path.sep + results[0].SubFileName + '.zip');
          zip.extractAllTo(path.join(tempDir, 'peerflix-sub'),true);
          callback(path.join(tempDir, 'peerflix-sub') + path.sep + results[0].SubFileName)
        });
      });
  });
}

function startPlayer(localHref) {
  if(/^win/.test(process.platform)) {
    var vlcPath = 'C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc'
    VLC_ARGS = VLC_ARGS.split(' ')
    VLC_ARGS.unshift(localHref)
    proc.execFile(vlcPath, VLC_ARGS)
  } else {
    omx.play(localHref);
    omx.on('ended', function() { stop(); });
}
}

// Server Setup
var server = new Hapi.Server();
server.connection({ port: PORT });

if (LOG_ENABLED) {
  var options = { logRequestPayload: true };
  var consoleReporter = new GoodConsole({ log: '*', response: '*' });
  options.reporters = [ consoleReporter];
  server.register({ register: Good, options: options}, function(err) { if (err) { throw(err); } });
}

server.start(function () {
  clearTorrentCache();
  console.log('Peerflix web running at: http://' + ip.address() + ':' + server.info.port);
});

// Routes
server.route({
  method: 'GET',
  path: '/',
  handler: function (request, reply) {
    return reply.file(path.join(__dirname, 'public/index.html'));
  }
});

server.route({
  method: 'GET',
  path: '/sub',
  handler: function (request, reply) {
    return reply(downloadSubs("Ice Age"));
  }
});

server.route({
  method: 'GET',
  path: '/assets/{param*}',
  handler: {
    directory: {
      path: path.join(__dirname,'public')
    }
  }
});

server.route({
  method: 'POST',
  path: '/play',
  handler: function (request, reply) {
    var torrentUrl = request.payload.url;
    var subs = request.payload.subs;
    if (torrentUrl) {
      readTorrent(torrentUrl, function(err, torrent) {
        if (err) { return reply(Boom.badRequest(err)); }
        if (connection) { stop(); }
        connection = peerflix(torrent, {
          connections: 100,
          path: path.join(tempDir, 'peerflix-' + uuid.v4()),
          buffer: (1.5 * 1024 * 1024).toString()
        });

        connection.server.on('listening', function() {
          if (!connection) { return reply(Boom.badRequest('Stream was interrupted')); }
          console.log('playing on http://127.0.0.1:' + connection.server.address().port + '/ with subs=' + subs)
          var localHref = 'http://127.0.0.1:' + connection.server.address().port + '/'
          if (subs === 'true') {
            downloadSubs(torrent.name, function(name) {
              VLC_ARGS += ' --sub-file=' + name
              OMX_EXEC += ' --subtitles ' + name
              startPlayer(localHref);
              return reply();
            });
          } else {
            startPlayer(localHref);
            return reply();
          }
      });
    });
    }
    else {
      return reply(Boom.badRequest('Torrent URL Required'));
    }
  }
});

server.route({
  method: 'POST',
  path: '/stop',
  handler: function (request, reply) {
    stop();
    return reply();
  }
});

server.route({
  method: 'GET',
  path: '/status',
  handler: function (request, reply) {
    return reply(states[omx.getState()]);
  }
});

server.route({
  method: 'GET',
  path: '/query',
  handler: function (request, reply) {
    var query = request.query.q;
    if (query) {
      kickass({q: query}, function(err, response){
        if (err) { return reply(Boom.badRequest(err)); }
        var filteredResults = [];
        response.list.forEach(function(result) {
          if (result.category === 'TV' || result.category === 'Movies') {
            filteredResults.push(result);
          }
        });
        return reply(filteredResults);
      });
    }
    else { return reply(Boom.badRequest('Torrent query string must be present')); }
  }
});

server.route({
  method: 'POST',
  path: '/{omx_command}',
  handler: function (request, reply) {
    var omxCommand = request.params.omx_command;
    var actualCommand = omxCtrlMap[omxCommand];
    if (actualCommand) {
      omx[actualCommand]();
      return reply();
    }
    else { return reply(Boom.badRequest('Invalid OMX Player command')); }
  }
});
