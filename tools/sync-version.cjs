#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const packageInfo = require('../package.json');
const appinfo = require('../assets/appinfo.json');

// Written where it is read from (next to this script), not in the working directory.
fs.writeFileSync(
  path.join(__dirname, '..', 'assets', 'appinfo.json'),
  `${JSON.stringify(
    {
      ...appinfo,
      version: packageInfo.version
    },
    null,
    2
  )}\n`
);
