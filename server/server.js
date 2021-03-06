const express = require('express');
const exphbs = require('express-handlebars');
const busboy = require('connect-busboy');
const path = require('path');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const bytes = require('bytes');
const conf = require('./config.js');
const storage = require('./storage.js');
const Raven = require('raven');
const crypto = require('crypto');
const fs = require('fs');

if (conf.sentry_dsn) {
  Raven.config(conf.sentry_dsn).install();
}

const mozlog = require('./log.js');

const log = mozlog('send.server');

const STATIC_PATH = path.join(__dirname, '../public');

const app = express();

function allLangs() {
  return fs
    .readdirSync(path.join(STATIC_PATH, 'locales'))
    .map(function(f) {
      return f.split('.')[0];
    })
    .join(',');
}

function prodLangs() {
  return require(path.join(
    __dirname,
    '..',
    'package.json'
  )).availableLanguages.join(',');
}

const availableLanguages = conf.l10n_dev ? allLangs() : prodLangs();

app.engine(
  'handlebars',
  exphbs({
    defaultLayout: 'main',
    partialsDir: 'views/partials/',
    helpers: {
      availableLanguages,
      l10nDev: conf.l10n_dev
    }
  })
);
app.set('view engine', 'handlebars');

app.use(helmet());
app.use(
  helmet.hsts({
    maxAge: 31536000,
    force: conf.env === 'production'
  })
);
app.use(
  helmet.contentSecurityPolicy({
    directives: {
      defaultSrc: ["'self'"],
      connectSrc: [
        "'self'",
        'https://sentry.prod.mozaws.net',
        'https://www.google-analytics.com'
      ],
      imgSrc: ["'self'", 'https://www.google-analytics.com'],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", 'https://code.cdn.mozilla.net'],
      fontSrc: ["'self'", 'https://code.cdn.mozilla.net'],
      formAction: ["'none'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      reportUri: '/__cspreport__'
    }
  })
);
app.use(
  busboy({
    limits: {
      fileSize: conf.max_file_size
    }
  })
);
app.use(bodyParser.json());
app.use(express.static(STATIC_PATH));

app.get('/', (req, res) => {
  res.render('index');
});

app.get('/unsupported', (req, res) => {
  res.render('unsupported');
});

app.get('/legal', (req, res) => {
  res.render('legal');
});

app.get('/jsconfig.js', (req, res) => {
  res.set('Content-Type', 'application/javascript');
  res.render('jsconfig', {
    trackerId: conf.analytics_id,
    dsn: conf.sentry_id,
    maxFileSize: conf.max_file_size,
    expireSeconds: conf.expire_seconds,
    layout: false
  });
});

app.get('/exists/:id', (req, res) => {
  const id = req.params.id;
  if (!validateID(id)) {
    res.sendStatus(404);
    return;
  }

  storage
    .exists(id)
    .then(() => {
      res.sendStatus(200);
    })
    .catch(err => res.sendStatus(404));
});

app.get('/download/:id', (req, res) => {
  const id = req.params.id;
  if (!validateID(id)) {
    res.sendStatus(404);
    return;
  }

  storage
    .filename(id)
    .then(filename => {
      return storage.length(id).then(contentLength => {
        storage.ttl(id).then(timeToExpiry => {
          res.render('download', {
            filename: decodeURIComponent(filename),
            filesize: bytes(contentLength),
            sizeInBytes: contentLength,
            timeToExpiry: timeToExpiry
          });
        });
      });
    })
    .catch(() => {
      res.status(404).render('notfound');
    });
});

app.get('/assets/download/:id', (req, res) => {
  const id = req.params.id;
  if (!validateID(id)) {
    res.sendStatus(404);
    return;
  }

  storage
    .metadata(id)
    .then(meta => {
      storage
        .length(id)
        .then(contentLength => {
          res.writeHead(200, {
            'Content-Disposition': 'attachment; filename=' + meta.filename,
            'Content-Type': 'application/octet-stream',
            'Content-Length': contentLength,
            'X-File-Metadata': JSON.stringify(meta)
          });
          const file_stream = storage.get(id);

          file_stream.on('end', () => {
            storage
              .forceDelete(id)
              .then(err => {
                if (!err) {
                  log.info('Deleted:', id);
                }
              })
              .catch(err => {
                log.info('DeleteError:', id);
              });
          });

          file_stream.pipe(res);
        })
        .catch(err => {
          res.sendStatus(404);
        });
    })
    .catch(err => {
      res.sendStatus(404);
    });
});

app.post('/delete/:id', (req, res) => {
  const id = req.params.id;

  if (!validateID(id)) {
    res.sendStatus(404);
    return;
  }

  const delete_token = req.body.delete_token;

  if (!delete_token) {
    res.sendStatus(404);
    return;
  }

  storage
    .delete(id, delete_token)
    .then(err => {
      if (!err) {
        log.info('Deleted:', id);
        res.sendStatus(200);
      }
    })
    .catch(err => res.sendStatus(404));
});

app.post('/upload', (req, res, next) => {
  const newId = crypto.randomBytes(5).toString('hex');
  let meta;

  try {
    meta = JSON.parse(req.header('X-File-Metadata'));
  } catch (err) {
    res.sendStatus(400);
    return;
  }

  if (
    !meta.hasOwnProperty('aad') ||
    !meta.hasOwnProperty('id') ||
    !meta.hasOwnProperty('filename') ||
    !validateIV(meta.id)
  ) {
    res.sendStatus(404);
    return;
  }

  meta.delete = crypto.randomBytes(10).toString('hex');
  log.info('meta', meta);
  req.pipe(req.busboy);

  req.busboy.on('file', (fieldname, file, filename) => {
    log.info('Uploading:', newId);

    storage.set(newId, file, filename, meta).then(
      () => {
        const protocol = conf.env === 'production' ? 'https' : req.protocol;
        const url = `${protocol}://${req.get('host')}/download/${newId}/`;
        res.json({
          url,
          delete: meta.delete,
          id: newId
        });
      },
      err => {
        if (err.message === 'limit') {
          return res.sendStatus(413);
        }
        res.sendStatus(500);
      }
    );
  });

  req.on('close', err => {
    storage
      .forceDelete(newId)
      .then(err => {
        if (!err) {
          log.info('Deleted:', newId);
        }
      })
      .catch(err => {
        log.info('DeleteError:', newId);
      });
  });
});

app.get('/__lbheartbeat__', (req, res) => {
  res.sendStatus(200);
});

app.get('/__heartbeat__', (req, res) => {
  storage.ping().then(() => res.sendStatus(200), () => res.sendStatus(500));
});

app.get('/__version__', (req, res) => {
  res.sendFile(path.join(STATIC_PATH, 'version.json'));
});

const server = app.listen(conf.listen_port, () => {
  log.info('startServer:', `Send app listening on port ${conf.listen_port}!`);
});

const validateID = route_id => {
  return route_id.match(/^[0-9a-fA-F]{10}$/) !== null;
};

const validateIV = route_id => {
  return route_id.match(/^[0-9a-fA-F]{24}$/) !== null;
};

module.exports = {
  server: server,
  storage: storage
};
