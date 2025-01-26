import fs from 'fs';
import path from 'path';

const distPath = path.resolve(__dirname, './../dist');

fs.rm(distPath, { recursive: true, force: true }, (err) => {
    if (err) {
      console.error(err);
    }
  });