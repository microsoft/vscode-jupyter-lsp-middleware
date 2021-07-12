const fs = require('fs');

fs.copyFile('./src/test/package.json', './out/test/package.json', (err) => {
  if (err) throw err;
  console.log('src/test/package.json was copied to out/test/package.json');
});